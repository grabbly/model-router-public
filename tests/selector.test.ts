import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PoolEntry, LogicalModelConfig } from '../src/types.js';
import {
  selectBestCandidate,
  rankCandidates,
  getOrderedCandidates,
} from '../src/core/selector.js';
import { resetCooldowns, recordFailure } from '../src/core/cooldown.js';
import { setProbeMetrics } from '../src/core/prober.js';
import { clearRetirementAlerts, markEntryRetired } from '../src/core/retirement.js';

describe('Selector & Pre-selection Engine', () => {
  beforeEach(() => {
    resetCooldowns();
    clearRetirementAlerts();
  });

  const sampleConfig: LogicalModelConfig = {
    id: 'text-high',
    description: 'Smart model',
    modality: 'text',
    tier: 'high',
    censored: true,
    timeoutMs: 60000,
    cooldownSec: 120,
    pool: [
      {
        id: 'candidate-primary',
        provider: 'custom',
        model: 'primary-model',
        baseUrl: 'http://upstream-1',
        priority: 1,
        enabled: true,
        tier: 'high',
        modality: 'text',
        censored: true,
      },
      {
        id: 'candidate-fallback',
        provider: 'ollama-cloud',
        model: 'fallback-model',
        baseUrl: 'http://upstream-2',
        priority: 2,
        enabled: true,
        tier: 'high',
        modality: 'text',
        censored: true,
      },
    ],
  };

  it('selects highest priority candidate when both are healthy', () => {
    const best = selectBestCandidate('text-high', sampleConfig);
    assert.equal(best?.id, 'candidate-primary');
  });

  it('switches to fallback when primary is in cooldown', () => {
    recordFailure('text-high', 'candidate-primary', 120, 'HTTP 500');
    const best = selectBestCandidate('text-high', sampleConfig);
    assert.equal(best?.id, 'candidate-fallback');
  });

  it('selects faster candidate when priority is equal and TTFB is measured', () => {
    const equalPrioConfig: LogicalModelConfig = {
      ...sampleConfig,
      pool: [
        {
          id: 'model-slow',
          provider: 'custom',
          model: 'slow',
          baseUrl: 'http://upstream-1',
          priority: 1,
          enabled: true,
          tier: 'high',
          modality: 'text',
          censored: true,
        },
        {
          id: 'model-fast',
          provider: 'custom',
          model: 'fast',
          baseUrl: 'http://upstream-2',
          priority: 1,
          enabled: true,
          tier: 'high',
          modality: 'text',
          censored: true,
        },
      ],
    };

    setProbeMetrics('model-slow', {
      entryId: 'model-slow',
      lastChecked: Date.now(),
      healthy: true,
      ttfbMs: 850,
      totalMs: 1200,
      throughputTokensSec: 50,
      consecutiveSuccesses: 5,
      consecutiveFailures: 0,
    });

    setProbeMetrics('model-fast', {
      entryId: 'model-fast',
      lastChecked: Date.now(),
      healthy: true,
      ttfbMs: 120,
      totalMs: 300,
      throughputTokensSec: 100,
      consecutiveSuccesses: 5,
      consecutiveFailures: 0,
    });

    const best = selectBestCandidate('text-high', equalPrioConfig);
    assert.equal(best?.id, 'model-fast');
  });

  it('excludes retired models from selection', () => {
    markEntryRetired('candidate-primary', 'primary-model', 'Decommissioned by provider');
    const best = selectBestCandidate('text-high', sampleConfig);
    assert.equal(best?.id, 'candidate-fallback');
  });

  it('returns oldest failed candidate when all candidates are in cooldown', () => {
    recordFailure('text-high', 'candidate-primary', 10, 'failed first');
    recordFailure('text-high', 'candidate-fallback', 120, 'failed second');

    const best = selectBestCandidate('text-high', sampleConfig);
    assert.equal(best?.id, 'candidate-primary');
  });
});
