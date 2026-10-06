import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';

type Transporter = ReturnType<typeof nodemailer.createTransport>;
import { RouterEvent, onRouterEvent } from './events.js';
import { getTenant } from './tenants.js';

export interface NotificationLogRecord {
  ts: string;
  tenantId?: string;
  type: string;
  channel: 'email' | 'telegram';
  to: string; // masked
  ok: boolean;
  error?: string;
}

export interface RenderedMessage {
  subject: string;
  text: string;
}

export interface NotifyTransportsOverride {
  email?: (msg: { to: string; subject: string; text: string }) => Promise<void>;
  telegram?: (chatId: string, text: string) => Promise<void>;
}

interface NotifyJob {
  channel: 'email' | 'telegram';
  rawTo: string;
  maskedTo: string;
  tenantId?: string;
  type: string;
  subject: string;
  text: string;
  attempt: number;
  scheduledAt: number;
}

// Map of notification-eligible event types
const NOTIFY_EVENT_TYPES = new Set([
  'limit.reached',
  'limit.warning',
  'loop.blocked',
  'budget.exceeded',
  'budget.warning',
]);

export function shouldNotifyEvent(eventType: string): boolean {
  if (NOTIFY_EVENT_TYPES.has(eventType)) return true;
  if (eventType.startsWith('byok.') || eventType.startsWith('catalog.') || eventType.startsWith('watch.')) return true;
  return false;
}

export function isOff(): boolean {
  return process.env.ROUTER_NOTIFY?.toLowerCase() === 'off';
}

export function maskRecipient(to: string, channel: 'email' | 'telegram'): string {
  if (!to) return '';
  if (channel === 'email') {
    const at = to.indexOf('@');
    if (at > 0) {
      const local = to.slice(0, at);
      const domain = to.slice(at + 1);
      return `${local[0]}***@${domain}`;
    }
    return '***';
  } else {
    const s = String(to).trim();
    if (s.length <= 4) {
      return `***${s}`;
    }
    return `***${s.slice(-4)}`;
  }
}

export function getAdminEmails(): string[] {
  const raw = process.env.ROUTER_ADMIN_EMAIL || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function getAdminTelegramChats(): string[] {
  const raw = process.env.ROUTER_ADMIN_TELEGRAM_CHAT_ID || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function getNotificationLogPath(customDir?: string): string {
  const base = customDir || process.env.ROUTER_STATE_DIR || './data';
  return path.join(base, 'notifications.jsonl');
}

export function logDelivery(rec: NotificationLogRecord, customDir?: string): void {
  try {
    const filePath = getNotificationLogPath(customDir);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(filePath, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    console.error('[notify] Failed to write notification log:', err);
  }
}

export function cleanOldNotificationLogs(retentionDays = 30, customDir?: string): void {
  try {
    const filePath = getNotificationLogPath(customDir);
    if (!fs.existsSync(filePath)) return;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000).toISOString();
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const kept: string[] = [];
    let trimmed = false;
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (rec.ts >= cutoff) {
          kept.push(line);
        } else {
          trimmed = true;
        }
      } catch {
        trimmed = true;
      }
    }
    if (trimmed) {
      fs.writeFileSync(filePath, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
    }
  } catch (err) {
    console.error('[notify] Failed to clean old notifications log:', err);
  }
}

export function getRecentNotifications(limit = 50, customDir?: string): NotificationLogRecord[] {
  try {
    const filePath = getNotificationLogPath(customDir);
    if (!fs.existsSync(filePath)) return [];

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const records: NotificationLogRecord[] = [];
    const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

    for (let i = lines.length - 1; i >= 0 && records.length < limit; i--) {
      try {
        const rec = JSON.parse(lines[i]);
        if (rec.ts >= cutoff) {
          records.push(rec);
        }
      } catch {
        // ignore malformed line
      }
    }
    return records;
  } catch (err) {
    console.error('[notify] Failed to read notifications log:', err);
    return [];
  }
}

// Transports management
let testTransports: NotifyTransportsOverride | null = null;
let cachedTransporter: Transporter | null = null;
let lastTransporterConfig = '';

export function isEmailConfigured(): boolean {
  if (testTransports?.email) return true;
  return Boolean(process.env.ROUTER_SMTP_HOST);
}

export function isTelegramConfigured(): boolean {
  if (testTransports?.telegram) return true;
  return Boolean(process.env.ROUTER_TELEGRAM_BOT_TOKEN);
}

export function getNotificationStatus(): {
  transports: {
    email: 'configured' | 'not-configured';
    telegram: 'configured' | 'not-configured';
  };
  admin: {
    email: string[];
    telegram: string[];
  };
} {
  const adminEmails = getAdminEmails();
  const adminTelegrams = getAdminTelegramChats();

  return {
    transports: {
      email: isEmailConfigured() ? 'configured' : 'not-configured',
      telegram: isTelegramConfigured() ? 'configured' : 'not-configured',
    },
    admin: {
      email: adminEmails.map((e) => maskRecipient(e, 'email')),
      telegram: adminTelegrams.map((t) => maskRecipient(t, 'telegram')),
    },
  };
}

export function getSmtpOptions() {
  const host = process.env.ROUTER_SMTP_HOST || '';
  const port = Number(process.env.ROUTER_SMTP_PORT || 465);
  const secureEnv = process.env.ROUTER_SMTP_SECURE;
  const secure = secureEnv !== undefined ? (secureEnv === 'true' || secureEnv === '1') : port === 465;
  const user = process.env.ROUTER_SMTP_USER || '';
  const pass = process.env.ROUTER_SMTP_PASS || '';
  return {
    host,
    port,
    secure,
    // Without implicit TLS (587 — some cloud hosts block outbound 465 and 25)
    // insist on STARTTLS: nodemailer would otherwise send the password in
    // clear text to a server that does not offer it.
    requireTLS: !secure,
    auth: user && pass ? { user, pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
  };
}

function getEmailTransporter(): Transporter {
  const opts = getSmtpOptions();
  const cfgKey = `${opts.host}:${opts.port}:${opts.secure}:${opts.auth?.user}:${opts.auth?.pass}`;
  if (!cachedTransporter || cfgKey !== lastTransporterConfig) {
    cachedTransporter = nodemailer.createTransport(opts);
    lastTransporterConfig = cfgKey;
  }
  return cachedTransporter;
}

async function sendEmailTransport(msg: { to: string; subject: string; text: string }): Promise<void> {
  if (testTransports?.email) {
    await testTransports.email(msg);
    return;
  }
  const transporter = getEmailTransporter();
  const from = process.env.ROUTER_SMTP_FROM || process.env.ROUTER_SMTP_USER || 'router@example.com';
  await transporter.sendMail({
    from,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
  });
}

async function sendTelegramTransport(chatId: string, text: string): Promise<void> {
  if (testTransports?.telegram) {
    await testTransports.telegram(chatId, text);
    return;
  }
  const token = process.env.ROUTER_TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('Telegram bot token not configured');
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Telegram API responded with ${res.status}: ${errText}`);
  }
}

// Templates rendering
export function renderNotificationMessage(
  ev: RouterEvent,
  lang: 'ru' | 'en' = 'ru',
  tenantName?: string
): RenderedMessage {
  const isEn = lang === 'en';
  const tid = ev.tenantId || (isEn ? 'system' : 'система');
  const nameSuffix = tenantName ? ` (${tenantName})` : '';

  switch (ev.type) {
    case 'limit.reached': {
      const limitType = String(ev.limit || '');
      let limitNameRu = limitType;
      let limitNameEn = limitType;
      let resetInfoRu = 'в ближайшее время';
      let resetInfoEn = 'shortly';

      if (limitType === 'day') {
        limitNameRu = 'в сутки (dayRequests)';
        limitNameEn = 'per day (dayRequests)';
        resetInfoRu = 'в 00:00 UTC';
        resetInfoEn = 'at 00:00 UTC';
      } else if (limitType === 'concurrent') {
        limitNameRu = 'одновременных запросов (concurrent)';
        limitNameEn = 'concurrent requests';
        resetInfoRu = 'по завершении текущих активных запросов';
        resetInfoEn = 'when active requests complete';
      } else if (limitType === 'rpm') {
        const agentSuffix = ev.agent ? ` [agent: ${ev.agent}]` : '';
        limitNameRu = `в минуту (RPM)${agentSuffix}`;
        limitNameEn = `per minute (RPM)${agentSuffix}`;
        resetInfoRu = 'в течение 1 минуты';
        resetInfoEn = 'within 1 minute';
      }

      const subject = isEn
        ? `[AI Router] Limit reached: ${tid}${nameSuffix}`
        : `[AI Router] Достигнут лимит: ${tid}${nameSuffix}`;

      const text = isEn
        ? [
            `Client: ${tid}${nameSuffix}`,
            `Event: Request limit reached (${limitNameEn})`,
            `Limit: ${ev.max ?? 'unknown'}`,
            `Current usage: ${ev.current ?? 'unknown'}`,
            `Reset: ${resetInfoEn}`,
            `Action: contact the administrator to increase the limit.`,
          ].join('\n')
        : [
            `Клиент: ${tid}${nameSuffix}`,
            `Событие: Превышен лимит запросов (${limitNameRu})`,
            `Лимит: ${ev.max ?? 'не указан'}`,
            `Текущее использование: ${ev.current ?? 'не указано'}`,
            `Сброс: ${resetInfoRu}`,
            `Что делать: при необходимости поднимите лимит в дашборде («Клиенты и лимиты») или свяжитесь с клиентом.`,
          ].join('\n');

      return { subject, text };
    }

    case 'limit.warning': {
      const percent = ev.percent ?? 80;
      const subject = isEn
        ? `[AI Router] Warning: ${percent}% limit reached: ${tid}${nameSuffix}`
        : `[AI Router] Предупреждение: ${percent}% лимита: ${tid}${nameSuffix}`;

      const text = isEn
        ? [
            `Client: ${tid}${nameSuffix}`,
            `Event: Daily request limit reached ${percent}%`,
            `Limit: ${ev.max ?? 'unknown'} requests per day`,
            `Current usage: ${ev.current ?? 'unknown'} (${percent}%)`,
            `Reset: at 00:00 UTC`,
            `Action: contact the administrator to increase the limit if needed.`,
          ].join('\n')
        : [
            `Клиент: ${tid}${nameSuffix}`,
            `Событие: Достигнуто ${percent}% дневного лимита запросов`,
            `Лимит: ${ev.max ?? 'не указан'} запросов в сутки`,
            `Текущее использование: ${ev.current ?? 'не указано'} (${percent}%)`,
            `Сброс: в 00:00 UTC`,
            `Что делать: если клиенту нужно больше, поднимите лимит в дашборде («Клиенты и лимиты»).`,
          ].join('\n');

      return { subject, text };
    }

    case 'loop.blocked': {
      const subject = isEn
        ? `[AI Router] Session blocked by Loop Guard: ${tid}${nameSuffix}`
        : `[AI Router] Сессия заблокирована Loop Guard: ${tid}${nameSuffix}`;

      const until = ev.until ? String(ev.until) : 'specified time';
      const retryAfter = ev.retryAfterSec ? (isEn ? `${ev.retryAfterSec}s` : `${ev.retryAfterSec} с`) : '';

      const text = isEn
        ? [
            `Client: ${tid}${nameSuffix}`,
            `Event: Session blocked by Loop Guard`,
            `Rule: ${ev.rule ?? 'unknown'} (${ev.details ?? ''})`,
            `Session key: ${ev.key ?? 'unknown'}`,
            `Blocked until: ${until}${retryAfter ? ` (${retryAfter})` : ''}`,
            `Action: contact the administrator to unblock or investigate client loop.`,
          ].join('\n')
        : [
            `Клиент: ${tid}${nameSuffix}`,
            `Событие: Сессия заблокирована защитой от зацикливания (Loop Guard)`,
            `Правило: ${ev.rule ?? 'не указано'} (${ev.details ?? ''})`,
            `Ключ сессии: ${ev.key ?? 'не указан'}`,
            `Блокировка до: ${until}${retryAfter ? ` (${retryAfter})` : ''}`,
            `Что делать: проверьте агента клиента на зацикливание; снять блокировку можно в дашборде («Клиенты и лимиты» → «Снять блокировку»).`,
          ].join('\n');

      return { subject, text };
    }

    case 'budget.exceeded': {
      const reason = String(ev.reason ?? '');
      const subject = isEn
        ? `[AI Router] Budget exceeded: ${tid}${nameSuffix}`
        : `[AI Router] Превышен бюджет MiniMax: ${tid}${nameSuffix}`;

      const text = isEn
        ? [
            `Client: ${tid}${nameSuffix}`,
            `Event: MiniMax budget exceeded`,
            `Reason: ${reason}`,
            `Current usage: 100% of allocated budget`,
            `Reset: next budget window (hourly/daily UTC)`,
            `Action: contact the administrator to increase the budget.`,
          ].join('\n')
        : [
            `Клиент: ${tid}${nameSuffix}`,
            `Событие: Превышен бюджет MiniMax`,
            `Причина: ${reason}`,
            `Текущее использование: 100% выделенного бюджета`,
            `Сброс: в начале следующего окна (каждый час / 00:00 UTC)`,
            `Что делать: при необходимости поднимите лимит MiniMax клиента в дашборде или свяжитесь с клиентом.`,
          ].join('\n');

      return { subject, text };
    }

    case 'budget.warning': {
      const percent = ev.percent ?? 80;
      const windowStr = ev.window ? ` (${ev.window})` : '';
      const subject = isEn
        ? `[AI Router] Warning: ${percent}% budget reached: ${tid}${nameSuffix}`
        : `[AI Router] Предупреждение: ${percent}% бюджета: ${tid}${nameSuffix}`;

      const text = isEn
        ? [
            `Client: ${tid}${nameSuffix}`,
            `Event: MiniMax budget reached ${percent}%${windowStr}`,
            `Current usage: ${percent}%`,
            `Reset: next budget window (00:00 UTC)`,
            `Action: contact the administrator to increase the budget if needed.`,
          ].join('\n')
        : [
            `Клиент: ${tid}${nameSuffix}`,
            `Событие: Достигнуто ${percent}% бюджета MiniMax${windowStr}`,
            `Текущее использование: ${percent}%`,
            `Сброс: в начале следующего окна (00:00 UTC)`,
            `Что делать: если клиенту нужно больше, поднимите лимит MiniMax в дашборде.`,
          ].join('\n');

      return { subject, text };
    }

    case 'byok.key-invalid': {
      const prov = String(ev.provider || 'ollama-cloud');
      const hint = String(ev.hint || '');
      const subject = isEn
        ? `[AI Router] Upstream key invalid: ${tid}${nameSuffix}`
        : `[AI Router] Ключ провайдера недействителен: ${tid}${nameSuffix}`;

      const text = isEn
        ? [
            `Client: ${tid}${nameSuffix}`,
            `Provider: ${prov}`,
            `Key: ${hint}`,
            `Event: Upstream returned 401/403 (key is invalid)`,
            `Action: update the client key in the dashboard.`,
          ].join('\n')
        : [
            `Клиент: ${tid}${nameSuffix}`,
            `Провайдер: ${prov}`,
            `Ключ: ${hint}`,
            `Событие: Upstream вернул 401/403 (ключ недействителен)`,
            `Что делать: обновите ключ клиента в дашборде («Клиенты и лимиты» → «Ключ Ollama»).`,
          ].join('\n');

      return { subject, text };
    }

    case 'byok.key-exhausted': {
      const prov = String(ev.provider || 'ollama-cloud');
      const hint = String(ev.hint || '');
      const until = String(ev.exhaustedUntil || 'specified time');
      const subject = isEn
        ? `[AI Router] Key quota exhausted: ${tid}${nameSuffix}`
        : `[AI Router] Исчерпана квота ключа: ${tid}${nameSuffix}`;

      const text = isEn
        ? [
            `Client: ${tid}${nameSuffix}`,
            `Provider: ${prov}`,
            `Key: ${hint}`,
            `Event: Upstream returned 429 (key quota exhausted)`,
            `Blocked until: ${until}`,
            `Action: check quota with provider or update key.`,
          ].join('\n')
        : [
            `Клиент: ${tid}${nameSuffix}`,
            `Провайдер: ${prov}`,
            `Ключ: ${hint}`,
            `Событие: Upstream вернул 429 (исчерпана квота ключа)`,
            `Заблокирован до: ${until}`,
            `Что делать: проверьте баланс/квоту ключа у провайдера или обновите ключ.`,
          ].join('\n');

      return { subject, text };
    }

    case 'byok.key-recovered': {
      const prov = String(ev.provider || 'ollama-cloud');
      const hint = String(ev.hint || '');
      const subject = isEn
        ? `[AI Router] Key recovered: ${tid}${nameSuffix}`
        : `[AI Router] Ключ провайдера восстановлен: ${tid}${nameSuffix}`;

      const text = isEn
        ? [
            `Client: ${tid}${nameSuffix}`,
            `Provider: ${prov}`,
            `Key: ${hint}`,
            `Event: Key request succeeded and status reset to ok`,
          ].join('\n')
        : [
            `Клиент: ${tid}${nameSuffix}`,
            `Провайдер: ${prov}`,
            `Ключ: ${hint}`,
            `Событие: Запрос успешно выполнен, статус ключа сброшен в ok`,
          ].join('\n');

      return { subject, text };
    }

    case 'watch.report': {
      return {
        subject: typeof ev.subject === 'string' ? ev.subject : `[AI Router] Watch report: ${ev.level || 'info'}`,
        text: typeof ev.text === 'string' ? ev.text : JSON.stringify(ev, null, 2),
      };
    }

    default: {
      if (ev.type.startsWith('watch.')) {
        return {
          subject: typeof ev.subject === 'string' ? ev.subject : `[AI Router] Watch report: ${ev.level || 'info'}`,
          text: typeof ev.text === 'string' ? ev.text : JSON.stringify(ev, null, 2),
        };
      }

      const subject = isEn
        ? `[AI Router] Event ${ev.type}: ${tid}${nameSuffix}`
        : `[AI Router] Событие ${ev.type}: ${tid}${nameSuffix}`;

      const detailsObj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(ev)) {
        if (k !== 'type' && k !== 'tenantId' && k !== 'ts') {
          detailsObj[k] = v;
        }
      }
      const details = JSON.stringify(detailsObj);

      const text = isEn
        ? [
            `Client: ${tid}${nameSuffix}`,
            `Event: ${ev.type}`,
            `Details: ${details}`,
            `Action: contact the administrator if needed.`,
          ].join('\n')
        : [
            `Клиент: ${tid}${nameSuffix}`,
            `Событие: ${ev.type}`,
            `Детали: ${details}`,
            `Что делать: проверьте детали в дашборде.`,
          ].join('\n');

      return { subject, text };
    }
  }
}

// Deduplication
const dedupMap = new Map<string, number>();
const sentTimestamps: number[] = [];
let lastCapWarnAt = 0;

export function getEventDedupKey(ev: RouterEvent): string {
  const tenant = ev.tenantId || '*';
  // Per report date for watch.* reports so a restart never sends the same day twice
  if (ev.type.startsWith('watch.')) {
    return `${ev.type}:${ev.date || (ev.ts ? ev.ts.slice(0, 10) : 'today')}`;
  }
  // Per tenant + rule, not per session: a fleet of looping sessions must not
  // flood the admin's inbox; the message names the first blocked session.
  if (ev.type === 'loop.blocked') {
    return `loop.blocked:${tenant}:${ev.rule || ''}`;
  }
  if (ev.type === 'limit.reached') {
    return `limit.reached:${tenant}:${ev.limit || ''}:${ev.agent || ''}`;
  }
  if (ev.type === 'limit.warning') {
    return `limit.warning:${tenant}:${ev.limit || ''}:${ev.percent || ''}`;
  }
  if (ev.type === 'budget.exceeded') {
    return `budget.exceeded:${tenant}:${ev.reason || ''}`;
  }
  if (ev.type === 'budget.warning') {
    return `budget.warning:${tenant}:${ev.window || ''}:${ev.percent || ''}`;
  }
  if (ev.type.startsWith('byok.')) {
    return `${ev.type}:${tenant}:${ev.provider || ''}`;
  }
  return `${ev.type}:${tenant}:${ev.key || ev.reason || ev.limit || ''}`;
}

// Queue & Worker
const queue: NotifyJob[] = [];
let activeWorkers = 0;
const CONCURRENCY = 2;
let customBackoffSchedule: number[] | null = null;
let nextWakeupTimer: NodeJS.Timeout | null = null;
let nextWakeupTime: number | null = null;

function getBackoffSchedule(): number[] {
  if (customBackoffSchedule) return customBackoffSchedule;
  if (process.env.NODE_ENV === 'test') {
    return [10, 20, 30];
  }
  return [5_000, 30_000, 120_000];
}

function scheduleNextTimer(): void {
  if (queue.length === 0) {
    if (nextWakeupTimer) {
      clearTimeout(nextWakeupTimer);
      nextWakeupTimer = null;
      nextWakeupTime = null;
    }
    return;
  }

  const earliest = Math.min(...queue.map((j) => j.scheduledAt));
  const now = Date.now();
  const delay = Math.max(0, earliest - now);

  if (nextWakeupTimer && nextWakeupTime !== null && nextWakeupTime <= earliest) {
    return;
  }

  if (nextWakeupTimer) {
    clearTimeout(nextWakeupTimer);
  }

  nextWakeupTime = earliest;
  nextWakeupTimer = setTimeout(() => {
    nextWakeupTimer = null;
    nextWakeupTime = null;
    pumpQueue();
  }, delay);

  if (typeof nextWakeupTimer.unref === 'function') {
    nextWakeupTimer.unref();
  }
}

async function executeJob(job: NotifyJob): Promise<void> {
  try {
    if (job.channel === 'email') {
      await sendEmailTransport({ to: job.rawTo, subject: job.subject, text: job.text });
    } else if (job.channel === 'telegram') {
      await sendTelegramTransport(job.rawTo, job.text);
    }
    logDelivery({
      ts: new Date().toISOString(),
      tenantId: job.tenantId,
      type: job.type,
      channel: job.channel,
      to: job.maskedTo,
      ok: true,
    });
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    if (job.attempt < 3) {
      job.attempt++;
      const backoffDelays = getBackoffSchedule();
      const delayMs = backoffDelays[job.attempt - 1] ?? 120_000;
      job.scheduledAt = Date.now() + delayMs;
      queue.push(job);
      scheduleNextTimer();
    } else {
      console.error(`[notify] Delivery failed permanently to ${job.maskedTo} (${job.channel}):`, errorMsg);
      logDelivery({
        ts: new Date().toISOString(),
        tenantId: job.tenantId,
        type: job.type,
        channel: job.channel,
        to: job.maskedTo,
        ok: false,
        error: errorMsg,
      });
    }
  }
}

function pumpQueue(): void {
  if (isOff()) return;

  const now = Date.now();
  while (activeWorkers < CONCURRENCY) {
    const readyIndex = queue.findIndex((j) => j.scheduledAt <= now);
    if (readyIndex === -1) {
      scheduleNextTimer();
      break;
    }

    const [job] = queue.splice(readyIndex, 1);
    activeWorkers++;
    executeJob(job).finally(() => {
      activeWorkers--;
      pumpQueue();
    });
  }
}

function enqueueJob(job: Omit<NotifyJob, 'attempt' | 'scheduledAt'>): void {
  queue.push({
    ...job,
    attempt: 0,
    scheduledAt: Date.now(),
  });
  pumpQueue();
}

// Router Event Handler
export function handleRouterEvent(ev: RouterEvent): void {
  if (isOff()) return;
  if (!shouldNotifyEvent(ev.type)) return;

  const dedupKey = getEventDedupKey(ev);
  const now = Date.now();
  const dedupSec = Number(process.env.ROUTER_NOTIFY_DEDUP_SEC || 3600);
  const last = dedupMap.get(dedupKey);
  if (last !== undefined && now - last < dedupSec * 1000) {
    return;
  }
  dedupMap.set(dedupKey, now);
  if (dedupMap.size > 1000) {
    for (const [k, t] of dedupMap) {
      if (now - t >= dedupSec * 1000) dedupMap.delete(k);
    }
  }

  // Hard cap on messages per hour across all events, so a storm of distinct
  // events cannot get the SMTP mailbox flagged as a spammer.
  // watch.report has a reserved slot (at most once per day) so it is not dropped by the hourly cap.
  const isWatchReport = ev.type === 'watch.report';
  const maxPerHour = Number(process.env.ROUTER_NOTIFY_MAX_PER_HOUR || 30);
  while (sentTimestamps.length && now - sentTimestamps[0] >= 3_600_000) sentTimestamps.shift();
  if (!isWatchReport && maxPerHour > 0 && sentTimestamps.length >= maxPerHour) {
    if (now - lastCapWarnAt >= 3_600_000) {
      lastCapWarnAt = now;
      console.warn(`[notify] hourly cap ${maxPerHour} reached, dropping notifications (see /admin/api/events)`);
    }
    return;
  }
  sentTimestamps.push(now);

  const tenant = ev.tenantId ? getTenant(ev.tenantId) : null;
  const tenantName = tenant?.name;
  const notifyTenants = process.env.ROUTER_NOTIFY_TENANTS === 'true' || process.env.ROUTER_NOTIFY_TENANTS === '1';

  const adminEmails = getAdminEmails();
  const adminTelegrams = getAdminTelegramChats();

  const adminLang: 'ru' | 'en' = 'ru';
  const adminMsg = renderNotificationMessage(ev, adminLang, tenantName);

  if (isEmailConfigured()) {
    for (const email of adminEmails) {
      enqueueJob({
        channel: 'email',
        rawTo: email,
        maskedTo: maskRecipient(email, 'email'),
        tenantId: ev.tenantId,
        type: ev.type,
        subject: adminMsg.subject,
        text: adminMsg.text,
      });
    }
  }

  if (isTelegramConfigured()) {
    for (const chatId of adminTelegrams) {
      enqueueJob({
        channel: 'telegram',
        rawTo: chatId,
        maskedTo: maskRecipient(chatId, 'telegram'),
        tenantId: ev.tenantId,
        type: ev.type,
        subject: adminMsg.subject,
        text: adminMsg.text,
      });
    }
  }

  if (notifyTenants && tenant && !ev.type.startsWith('catalog.') && !ev.type.startsWith('byok.') && !ev.type.startsWith('watch.')) {
    const tenantLang: 'ru' | 'en' = tenant.notify?.lang === 'en' ? 'en' : 'ru';
    const tenantMsg = tenantLang === adminLang ? adminMsg : renderNotificationMessage(ev, tenantLang, tenantName);

    const tenantEmails = tenant.notify?.email || [];
    const tenantTelegrams = tenant.notify?.telegram || [];

    if (isEmailConfigured()) {
      for (const email of tenantEmails) {
        if (adminEmails.includes(email.trim())) continue;
        enqueueJob({
          channel: 'email',
          rawTo: email.trim(),
          maskedTo: maskRecipient(email.trim(), 'email'),
          tenantId: ev.tenantId,
          type: ev.type,
          subject: tenantMsg.subject,
          text: tenantMsg.text,
        });
      }
    }

    if (isTelegramConfigured()) {
      for (const chatId of tenantTelegrams) {
        if (adminTelegrams.includes(String(chatId).trim())) continue;
        enqueueJob({
          channel: 'telegram',
          rawTo: String(chatId).trim(),
          maskedTo: maskRecipient(String(chatId).trim(), 'telegram'),
          tenantId: ev.tenantId,
          type: ev.type,
          subject: tenantMsg.subject,
          text: tenantMsg.text,
        });
      }
    }
  }
}

// Test send
export async function sendTestNotification(): Promise<{
  ok: boolean;
  count: number;
  results: Array<{ channel: 'email' | 'telegram'; to: string; ok: boolean; error?: string }>;
}> {
  const adminEmails = getAdminEmails();
  const adminTelegrams = getAdminTelegramChats();

  const results: Array<{ channel: 'email' | 'telegram'; to: string; ok: boolean; error?: string }> = [];

  const subject = '[AI Router] Тестовое уведомление';
  const text = [
    subject,
    '',
    'Это тестовое уведомление от AI Router.',
    'Настройки каналов оповещения настроены корректно.',
    `Время отправки: ${new Date().toISOString()}`,
  ].join('\n');

  if (isEmailConfigured()) {
    for (const email of adminEmails) {
      const masked = maskRecipient(email, 'email');
      try {
        await sendEmailTransport({ to: email, subject, text });
        logDelivery({
          ts: new Date().toISOString(),
          type: 'test',
          channel: 'email',
          to: masked,
          ok: true,
        });
        results.push({ channel: 'email', to: masked, ok: true });
      } catch (err: any) {
        const errorMsg = err?.message || String(err);
        logDelivery({
          ts: new Date().toISOString(),
          type: 'test',
          channel: 'email',
          to: masked,
          ok: false,
          error: errorMsg,
        });
        results.push({ channel: 'email', to: masked, ok: false, error: errorMsg });
      }
    }
  }

  if (isTelegramConfigured()) {
    for (const chatId of adminTelegrams) {
      const masked = maskRecipient(chatId, 'telegram');
      try {
        await sendTelegramTransport(chatId, text);
        logDelivery({
          ts: new Date().toISOString(),
          type: 'test',
          channel: 'telegram',
          to: masked,
          ok: true,
        });
        results.push({ channel: 'telegram', to: masked, ok: true });
      } catch (err: any) {
        const errorMsg = err?.message || String(err);
        logDelivery({
          ts: new Date().toISOString(),
          type: 'test',
          channel: 'telegram',
          to: masked,
          ok: false,
          error: errorMsg,
        });
        results.push({ channel: 'telegram', to: masked, ok: false, error: errorMsg });
      }
    }
  }

  const ok = results.length > 0 && results.some((r) => r.ok);
  return { ok, count: results.length, results };
}

// Lifecycle
let unsubscribeNotifier: (() => void) | null = null;

export function startNotifier(): void {
  if (unsubscribeNotifier) return;
  if (isOff()) return;
  cleanOldNotificationLogs();
  unsubscribeNotifier = onRouterEvent(handleRouterEvent);
}

export function stopNotifier(): void {
  if (unsubscribeNotifier) {
    unsubscribeNotifier();
    unsubscribeNotifier = null;
  }
  if (nextWakeupTimer) {
    clearTimeout(nextWakeupTimer);
    nextWakeupTimer = null;
    nextWakeupTime = null;
  }
}

// Testing hooks
export function setNotifyTransportsForTests(transports: NotifyTransportsOverride | null): void {
  testTransports = transports;
}

export function setNotifyBackoffForTests(delays: number[] | null): void {
  customBackoffSchedule = delays;
}

export async function flushNotifyQueueForTests(): Promise<void> {
  while (true) {
    const hasPendingTimers = nextWakeupTimer !== null;
    if (activeWorkers === 0 && queue.length === 0 && !hasPendingTimers) {
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function resetNotifyForTests(): void {
  stopNotifier();
  if (nextWakeupTimer) {
    clearTimeout(nextWakeupTimer);
    nextWakeupTimer = null;
    nextWakeupTime = null;
  }
  queue.length = 0;
  activeWorkers = 0;
  dedupMap.clear();
  sentTimestamps.length = 0;
  lastCapWarnAt = 0;
  testTransports = null;
  customBackoffSchedule = null;
  cachedTransporter = null;
  lastTransporterConfig = '';
}
