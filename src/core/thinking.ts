import { ChatCompletionRequest } from '../types.js';

// Clients ask for model "thinking" in whatever dialect their SDK taught them.
// The router reads all of them, reduces them to one intent (on / off), and
// hands MiniMax the only form it accepts: thinking.type 'adaptive' | 'disabled'
// (anything else is a 400). Recognised, first match wins:
//   thinking: {type: enabled|adaptive|disabled, budget_tokens}   Anthropic / MiniMax
//   thinking: true | false | "on" | "off" | ...                   loose forms
//   reasoning_effort: none|minimal|low|medium|high|xhigh           OpenAI
//   reasoning: {effort, enabled, max_tokens, exclude}              OpenAI Responses / OpenRouter
//   enable_thinking / chat_template_kwargs.enable_thinking         Qwen, vLLM
//   think: true | false | low | medium | high                      Ollama
//   extra_body.google.thinking_config.thinking_budget (0 = off)    Gemini
//   include_reasoning: true                                        OpenRouter (legacy)

export type ThinkingIntent = 'on' | 'off';

const OFF = new Set(['none', 'off', 'disabled', 'disable', 'false', 'no', 'minimal', '0']);
const ON = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'on', 'enabled', 'enable', 'adaptive', 'auto', 'true', 'yes', 'dynamic']);

function fromScalar(v: unknown): ThinkingIntent | undefined {
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'number' && Number.isFinite(v)) return v === 0 ? 'off' : 'on'; // -1 = dynamic budget
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (OFF.has(s)) return 'off';
    if (ON.has(s)) return 'on';
    const n = Number(s);
    if (s !== '' && Number.isFinite(n)) return n === 0 ? 'off' : 'on';
  }
  return undefined;
}

function fromObject(v: unknown): ThinkingIntent | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fromScalar(v);
  const o = v as Record<string, unknown>;
  for (const k of ['type', 'effort', 'enabled', 'mode']) {
    const r = fromScalar(o[k]);
    if (r) return r;
  }
  for (const k of ['budget_tokens', 'max_tokens', 'thinking_budget', 'budget']) {
    const r = fromScalar(o[k]);
    if (r) return r;
  }
  return undefined;
}

function geminiConfig(body: Record<string, unknown>): unknown {
  const pick = (g: unknown) =>
    g && typeof g === 'object' ? (g as Record<string, unknown>).thinking_config : undefined;
  const extra = body.extra_body as Record<string, unknown> | undefined;
  return pick(extra?.google) ?? pick(body.google);
}

export function resolveThinkingIntent(body: ChatCompletionRequest): ThinkingIntent | undefined {
  const b = body as Record<string, unknown>;
  const ctk = b.chat_template_kwargs as Record<string, unknown> | undefined;
  const reasoning = b.reasoning;
  const candidates: Array<() => ThinkingIntent | undefined> = [
    () => fromObject(b.thinking),
    () => fromScalar(b.reasoning_effort),
    () => fromObject(reasoning),
    // OpenRouter: `reasoning: {}` (present, no knobs) means "on"
    () => (reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning) ? 'on' : undefined),
    () => fromScalar(b.enable_thinking),
    () => fromScalar(ctk?.enable_thinking),
    () => fromScalar(b.think),
    () => fromObject(geminiConfig(b)),
    () => (b.include_reasoning === true ? 'on' : undefined),
  ];
  for (const c of candidates) {
    const r = c();
    if (r) return r;
  }
  return undefined;
}

/** The client asked to *see* reasoning in the answer (besides x-router-reasoning). */
export function wantsReasoningShown(body: ChatCompletionRequest): boolean {
  const b = body as Record<string, unknown>;
  if (b.include_reasoning === true) return true;
  const r = b.reasoning as Record<string, unknown> | undefined;
  return !!r && typeof r === 'object' && r.exclude === false;
}

// Dialect fields that are not plain OpenAI Chat Completions. Never forwarded as-is:
// a backend that does not know them may 400 the whole request.
export const THINKING_ALIAS_FIELDS = [
  'thinking',
  'reasoning',
  'enable_thinking',
  'chat_template_kwargs',
  'think',
  'include_reasoning',
] as const;
