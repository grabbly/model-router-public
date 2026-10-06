import { PoolEntry } from '../types.js';

/**
 * Returns a human-friendly provider label for a given pool entry.
 * Used for x-router-provider response headers and audit logging.
 *
 * Rules (evaluated in order):
 * 1. entry.budgetGroup === 'minimax' or baseUrl contains 'minimax' -> 'minimax'
 * 2. entry.provider === 'ollama-cloud' -> 'ollama-cloud'
 * 3. baseUrl contains '/gemini/' -> 'backend2-gemini'
 * 4. entry.provider === 'ollama' -> 'local-gpu'
 * 5. otherwise the URL hostname (fallback 'custom' if missing or unparseable)
 */
export function providerLabel(entry: PoolEntry): string {
  if (entry.budgetGroup === 'minimax' || entry.baseUrl.includes('minimax')) {
    return 'minimax';
  }

  if (entry.provider === 'ollama-cloud') {
    return 'ollama-cloud';
  }

  if (entry.baseUrl.includes('/gemini/')) {
    return 'backend2-gemini';
  }

  if (entry.provider === 'ollama') {
    return 'local-gpu';
  }

  try {
    const url = new URL(entry.baseUrl);
    return url.hostname || 'custom';
  } catch {
    return 'custom';
  }
}
