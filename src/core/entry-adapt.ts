import sharp from 'sharp';
import { ChatMessage, PoolEntry } from '../types.js';

// Weak local vision models (such as qwen2.5vl:7b) need request adaptation:
// - replyInEnglish: qwen2.5vl produces garbled text in non-English languages
//   (e.g. Russian food names), so we append an instruction to reply in English.
// - imageMaxSide: high-resolution images severely degrade latency and memory
//   on consumer GPUs (RTX 3060), so inline images are downscaled to <= N px.

export const ENGLISH_REPLY_SUFFIX =
  '\n\n[The user may write in any language. Reply in English only.]';

async function adaptImagePart(
  part: { type: string; text?: string; image_url?: { url: string; [key: string]: unknown } },
  maxSide: number,
  entryId: string
): Promise<{ type: string; text?: string; image_url?: { url: string; [key: string]: unknown } }> {
  if (part.type !== 'image_url' || !part.image_url?.url) {
    return part;
  }

  const url = part.image_url.url;
  if (!url.startsWith('data:image/')) {
    return part;
  }

  try {
    const commaIdx = url.indexOf(',');
    if (commaIdx === -1) {
      throw new Error('invalid data URL: missing comma');
    }

    const base64Data = url.slice(commaIdx + 1);
    const buffer = Buffer.from(base64Data, 'base64');

    const image = sharp(buffer);
    const metadata = await image.metadata();
    const longestSide = Math.max(metadata.width ?? 0, metadata.height ?? 0);

    if (longestSide <= maxSide) {
      return part;
    }

    const resizedBuffer = await sharp(buffer)
      .rotate()
      .resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    return {
      ...part,
      image_url: {
        ...part.image_url,
        url: `data:image/jpeg;base64,${resizedBuffer.toString('base64')}`,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[entry-adapt] resize failed for ${entryId}: ${msg}`);
    return part;
  }
}

/**
 * Adapts messages for a specific pool entry, applying image downscaling and/or
 * English reply suffix if requested. Does not mutate the input array.
 */
export async function adaptMessagesForEntry(
  entry: PoolEntry,
  messages: ChatMessage[]
): Promise<ChatMessage[]> {
  if (!entry.replyInEnglish && (!entry.imageMaxSide || entry.imageMaxSide <= 0)) {
    return messages;
  }

  // Find the index of the last user message if replyInEnglish is active
  let lastUserIndex = -1;
  if (entry.replyInEnglish) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        lastUserIndex = i;
        break;
      }
    }
  }

  const out: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    let adaptedMsg = msg;

    // imageMaxSide: downscale inline data: images in array content
    if (entry.imageMaxSide && entry.imageMaxSide > 0 && Array.isArray(msg.content)) {
      let partsChanged = false;
      const newParts: Array<{ type: string; text?: string; image_url?: { url: string; [key: string]: unknown } }> = [];

      for (const part of msg.content) {
        if (part.type === 'image_url' && part.image_url?.url?.startsWith('data:image/')) {
          const adaptedPart = await adaptImagePart(part, entry.imageMaxSide, entry.id);
          if (adaptedPart !== part) {
            partsChanged = true;
          }
          newParts.push(adaptedPart);
        } else {
          newParts.push(part);
        }
      }

      if (partsChanged) {
        adaptedMsg = { ...adaptedMsg, content: newParts };
      }
    }

    // replyInEnglish: append suffix to the LAST user message
    if (i === lastUserIndex) {
      if (typeof adaptedMsg.content === 'string') {
        if (!adaptedMsg.content.includes(ENGLISH_REPLY_SUFFIX.trim())) {
          adaptedMsg = {
            ...adaptedMsg,
            content: `${adaptedMsg.content}${ENGLISH_REPLY_SUFFIX}`,
          };
        }
      } else if (Array.isArray(adaptedMsg.content)) {
        const alreadyHasSuffix = adaptedMsg.content.some(
          (p) => p.type === 'text' && p.text && p.text.includes(ENGLISH_REPLY_SUFFIX.trim())
        );

        if (!alreadyHasSuffix) {
          const parts = [...adaptedMsg.content];
          let lastTextIdx = -1;
          for (let j = parts.length - 1; j >= 0; j--) {
            if (parts[j].type === 'text') {
              lastTextIdx = j;
              break;
            }
          }

          if (lastTextIdx !== -1) {
            const targetPart = parts[lastTextIdx];
            parts[lastTextIdx] = {
              ...targetPart,
              text: `${targetPart.text ?? ''}${ENGLISH_REPLY_SUFFIX}`,
            };
          } else {
            parts.push({
              type: 'text',
              text: ENGLISH_REPLY_SUFFIX.trim(),
            });
          }

          adaptedMsg = { ...adaptedMsg, content: parts };
        }
      }
    }

    out.push(adaptedMsg);
  }

  return out;
}
