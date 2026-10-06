import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearRetirementAlerts,
  getRetirementAlerts,
  isModelRetired,
  markEntryRetired,
  checkRetirements,
} from '../src/core/retirement.js';
import { LogicalModelConfig } from '../src/types.js';

describe('Retirement Engine & Alerts', () => {
  beforeEach(() => {
    clearRetirementAlerts();
  });

  it('marks models as retired and produces alerts', () => {
    assert.equal(isModelRetired('entry-old'), false);

    const alert = markEntryRetired('entry-old', 'old-model:v1', 'Model removed upstream');
    assert.equal(isModelRetired('entry-old'), true);
    assert.equal(alert.physicalModel, 'old-model:v1');
    assert.equal(alert.active, true);

    const allAlerts = getRetirementAlerts();
    assert.equal(allAlerts.length, 1);
    assert.equal(allAlerts[0].entryId, 'entry-old');
  });

  it('detects models past configured retirement date', async () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const routes: Record<string, LogicalModelConfig> = {
      'text-low': {
        id: 'text-low',
        description: 'test',
        modality: 'text',
        tier: 'low',
        censored: true,
        timeoutMs: 10000,
        cooldownSec: 60,
        pool: [
          {
            id: 'candidate-retiring',
            provider: 'ollama-cloud',
            model: 'deepseek-v4-flash:0731',
            baseUrl: 'http://localhost',
            priority: 1,
            enabled: true,
            tier: 'low',
            modality: 'text',
            censored: true,
            retirementDate: pastDate,
          },
        ],
      },
    };

    const alerts = await checkRetirements(routes);
    assert.ok(alerts.length >= 1);
    assert.equal(isModelRetired('candidate-retiring'), true);
  });
});
