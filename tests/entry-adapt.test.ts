import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import sharp from 'sharp';
import { ChatMessage, LogicalModelConfig, PoolEntry } from '../src/types.js';
import { adaptMessagesForEntry, ENGLISH_REPLY_SUFFIX } from '../src/core/entry-adapt.js';
import { getDefaultLogicalModelConfigs, loadLogicalModelConfigs } from '../src/config.js';
import { forwardChat } from '../src/core/forwarder.js';

function makeEntry(overrides: Partial<PoolEntry> = {}): PoolEntry {
  return {
    id: 'test-entry',
    provider: 'ollama',
    model: 'qwen2.5vl:7b',
    baseUrl: 'http://localhost:11434/v1',
    priority: 1,
    enabled: true,
    tier: 'high',
    modality: 'vision',
    censored: true,
    ...overrides,
  };
}

describe('PoolEntry request adaptation (entry-adapt)', () => {
  it('no flags -> returns same reference', async () => {
    const entry = makeEntry();
    const msgs: ChatMessage[] = [{ role: 'user', content: 'hello' }];
    const res = await adaptMessagesForEntry(entry, msgs);
    assert.equal(res, msgs);
  });

  describe('replyInEnglish', () => {
    const entry = makeEntry({ replyInEnglish: true });

    it('appends suffix to string content', async () => {
      const msgs: ChatMessage[] = [{ role: 'user', content: 'What is this dish?' }];
      const res = await adaptMessagesForEntry(entry, msgs);
      assert.equal(res.length, 1);
      assert.equal(res[0].role, 'user');
      assert.equal(
        res[0].content,
        `What is this dish?${ENGLISH_REPLY_SUFFIX}`
      );
    });

    it('appends to last text part with array content', async () => {
      const msgs: ChatMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this picture' },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } },
            { type: 'text', text: 'Be concise' },
          ],
        },
      ];
      const res = await adaptMessagesForEntry(entry, msgs);
      assert.equal(res.length, 1);
      const parts = res[0].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
      assert.equal(parts.length, 3);
      assert.equal(parts[0].text, 'Describe this picture');
      assert.equal(parts[2].text, `Be concise${ENGLISH_REPLY_SUFFIX}`);
    });

    it('adds text part to array with only image part', async () => {
      const msgs: ChatMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'https://example.com/photo.jpg' } },
          ],
        },
      ];
      const res = await adaptMessagesForEntry(entry, msgs);
      assert.equal(res.length, 1);
      const parts = res[0].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
      assert.equal(parts.length, 2);
      assert.equal(parts[0].type, 'image_url');
      assert.equal(parts[1].type, 'text');
      assert.equal(parts[1].text, ENGLISH_REPLY_SUFFIX.trim());
    });

    it('modifies only the LAST user message', async () => {
      const msgs: ChatMessage[] = [
        { role: 'user', content: 'first prompt' },
        { role: 'assistant', content: 'first reply' },
        { role: 'user', content: 'second prompt' },
      ];
      const res = await adaptMessagesForEntry(entry, msgs);
      assert.equal(res.length, 3);
      assert.equal(res[0].content, 'first prompt');
      assert.equal(res[1].content, 'first reply');
      assert.equal(res[2].content, `second prompt${ENGLISH_REPLY_SUFFIX}`);
    });

    it('does not double append if suffix is already present', async () => {
      // String content
      const msgsStr: ChatMessage[] = [
        { role: 'user', content: `What is this?${ENGLISH_REPLY_SUFFIX}` },
      ];
      const resStr = await adaptMessagesForEntry(entry, msgsStr);
      assert.equal(resStr[0].content, `What is this?${ENGLISH_REPLY_SUFFIX}`);

      // Array content with text part
      const msgsArr: ChatMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: `Explain${ENGLISH_REPLY_SUFFIX}` },
          ],
        },
      ];
      const resArr = await adaptMessagesForEntry(entry, msgsArr);
      const partsArr = resArr[0].content as Array<{ type: string; text?: string }>;
      assert.equal(partsArr.length, 1);
      assert.equal(partsArr[0].text, `Explain${ENGLISH_REPLY_SUFFIX}`);

      // Array content where text part had trimmed suffix
      const msgsTrim: ChatMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } },
            { type: 'text', text: ENGLISH_REPLY_SUFFIX.trim() },
          ],
        },
      ];
      const resTrim = await adaptMessagesForEntry(entry, msgsTrim);
      const partsTrim = resTrim[0].content as Array<{ type: string; text?: string }>;
      assert.equal(partsTrim.length, 2);
      assert.equal(partsTrim[1].text, ENGLISH_REPLY_SUFFIX.trim());
    });

    it('does not mutate input messages or objects', async () => {
      const originalParts = [
        { type: 'image_url', image_url: { url: 'https://example.com/pic.jpg' } },
        { type: 'text', text: 'Original text' },
      ];
      const originalUser: ChatMessage = {
        role: 'user',
        content: originalParts,
      };
      const msgs: ChatMessage[] = [
        { role: 'system', content: 'System instruction' },
        originalUser,
      ];

      // Deep copy snapshot
      const snapshot = JSON.stringify(msgs);

      await adaptMessagesForEntry(entry, msgs);

      // Verify input unchanged
      assert.equal(JSON.stringify(msgs), snapshot);
      assert.equal(originalParts.length, 2);
      assert.equal(originalParts[1].text, 'Original text');
    });
  });

  describe('imageMaxSide', () => {
    const entry = makeEntry({ imageMaxSide: 1024 });

    it('downscales 2000x1000 PNG to 1024x512 JPEG', async () => {
      const pngBuf = await sharp({
        create: {
          width: 2000,
          height: 1000,
          channels: 3,
          background: { r: 255, g: 0, b: 0 },
        },
      })
        .png()
        .toBuffer();

      const inputUrl = `data:image/png;base64,${pngBuf.toString('base64')}`;
      const msgs: ChatMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: inputUrl } },
          ],
        },
      ];

      const res = await adaptMessagesForEntry(entry, msgs);
      const parts = res[0].content as Array<{ type: string; image_url?: { url: string } }>;
      const outputUrl = parts[0].image_url!.url;

      assert.ok(outputUrl.startsWith('data:image/jpeg;base64,'));

      const outputB64 = outputUrl.replace('data:image/jpeg;base64,', '');
      const outputBuf = Buffer.from(outputB64, 'base64');
      const meta = await sharp(outputBuf).metadata();

      assert.equal(meta.format, 'jpeg');
      assert.equal(meta.width, 1024);
      assert.equal(meta.height, 512);
    });

    it('leaves 500x300 image byte-for-byte unchanged', async () => {
      const pngBuf = await sharp({
        create: {
          width: 500,
          height: 300,
          channels: 3,
          background: { r: 0, g: 255, b: 0 },
        },
      })
        .png()
        .toBuffer();

      const inputUrl = `data:image/png;base64,${pngBuf.toString('base64')}`;
      const msgs: ChatMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: inputUrl } },
          ],
        },
      ];

      const res = await adaptMessagesForEntry(entry, msgs);
      const parts = res[0].content as Array<{ type: string; image_url?: { url: string } }>;
      assert.equal(parts[0].image_url!.url, inputUrl);
    });

    it('leaves http URL unchanged', async () => {
      const httpUrl = 'https://example.com/photo.png';
      const msgs: ChatMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: httpUrl } },
          ],
        },
      ];

      const res = await adaptMessagesForEntry(entry, msgs);
      const parts = res[0].content as Array<{ type: string; image_url?: { url: string } }>;
      assert.equal(parts[0].image_url!.url, httpUrl);
    });

    it('leaves invalid base64 data URL unchanged and does not throw', async () => {
      const invalidUrl = 'data:image/png;base64,this-is-not-valid-base64-image-data!!!';
      const msgs: ChatMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: invalidUrl } },
          ],
        },
      ];

      const res = await adaptMessagesForEntry(entry, msgs);
      const parts = res[0].content as Array<{ type: string; image_url?: { url: string } }>;
      assert.equal(parts[0].image_url!.url, invalidUrl);
    });
  });

  describe('config setup for local-qwen-vl entries', () => {
    it('sets imageMaxSide and replyInEnglish on local-qwen-vl entries in default configs', () => {
      const configs = getDefaultLogicalModelConfigs();

      const highEntry = configs['vision-high'].pool.find((e) => e.id === 'local-qwen-vl-high');
      assert.ok(highEntry, 'local-qwen-vl-high should be in vision-high pool');
      assert.equal(highEntry.imageMaxSide, 1024);
      assert.equal(highEntry.replyInEnglish, true);

      const lowEntry = configs['vision-low'].pool.find((e) => e.id === 'local-qwen-vl-low');
      assert.ok(lowEntry, 'local-qwen-vl-low should be in vision-low pool');
      assert.equal(lowEntry.imageMaxSide, 1024);
      assert.equal(lowEntry.replyInEnglish, true);
    });

    it('preserves adaptation fields in loadLogicalModelConfigs', () => {
      const configs = loadLogicalModelConfigs();
      const highEntry = configs['vision-high'].pool.find((e) => e.id === 'local-qwen-vl-high');
      assert.ok(highEntry);
      assert.equal(highEntry.imageMaxSide, 1024);
      assert.equal(highEntry.replyInEnglish, true);
    });
  });

  describe('forwarder integration', () => {
    it('adapts messages before forwarding to candidate upstream', async () => {
      let receivedMessages: unknown = null;

      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}');
          receivedMessages = parsed.messages;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-test',
              object: 'chat.completion',
              created: 1700000000,
              model: 'test-model',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'test response' },
                  finish_reason: 'stop',
                },
              ],
            })
          );
        });
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as { port: number }).port;

      try {
        const testConfig: LogicalModelConfig = {
          id: 'vision-high',
          description: 'test',
          modality: 'vision',
          tier: 'high',
          censored: true,
          timeoutMs: 5000,
          cooldownSec: 60,
          pool: [
            makeEntry({
              id: 'test-local-vl',
              baseUrl: `http://localhost:${port}/v1`,
              replyInEnglish: true,
            }),
          ],
        };

        await forwardChat('vision-high', testConfig, {
          model: 'vision-high',
          messages: [{ role: 'user', content: 'Translate this' }],
        });

        assert.ok(Array.isArray(receivedMessages));
        assert.equal(
          (receivedMessages as ChatMessage[])[0].content,
          `Translate this${ENGLISH_REPLY_SUFFIX}`
        );
      } finally {
        server.close();
      }
    });
  });
});
