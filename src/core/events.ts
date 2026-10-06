export interface RouterEvent {
  type: string;
  tenantId?: string;
  ts: string;
  [key: string]: unknown;
}

export type RouterEventListener = (ev: RouterEvent) => void;

const MAX_EVENTS = 200;
const eventBuffer: RouterEvent[] = [];
const listeners = new Set<RouterEventListener>();

/**
 * Emits an event to all registered listeners and stores it in the recent events buffer.
 * Listener exceptions are caught and logged so they never break the caller's request flow.
 */
export function emitRouterEvent(
  ev: { type: string; tenantId?: string; ts?: string; [key: string]: unknown }
): RouterEvent {
  const fullEvent: RouterEvent = {
    ...ev,
    type: ev.type,
    ts: ev.ts || new Date().toISOString(),
  };

  eventBuffer.push(fullEvent);
  if (eventBuffer.length > MAX_EVENTS) {
    eventBuffer.shift();
  }

  for (const listener of listeners) {
    try {
      listener(fullEvent);
    } catch (err) {
      console.error('[events] Router event listener threw an error:', err);
    }
  }

  return fullEvent;
}

/**
 * Registers an event listener and returns an unsubscribe function.
 */
export function onRouterEvent(fn: RouterEventListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Returns recent router events (up to limit, newest first).
 */
export function getRecentRouterEvents(limit = 50): RouterEvent[] {
  const clampedLimit = Math.max(1, Math.min(limit, MAX_EVENTS));
  const recent = [...eventBuffer].reverse().slice(0, clampedLimit);
  return recent;
}

/**
 * Resets the event buffer and clears listeners (for tests).
 */
export function resetRouterEventsForTests(): void {
  eventBuffer.length = 0;
  listeners.clear();
}
