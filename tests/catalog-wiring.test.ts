import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// End-to-end wiring, the way src/index.ts starts it: the poller gets the RAW
// configs (rule entries intact), fetches the catalog from a fake ollama.com,
// admits models, and the hot-path configs then contain concrete entries. A
// poller fed expanded configs finds no rules and never fetches anything.
const models = new Map<string, { created: number; caps: string[] }>([
  ['deepseek-v4.1-flash', { created: 1789009200, caps: ['completion', 'tools', 'vision', 'thinking'] }],
  ['glm-5.3-flash', { created: 1787752800, caps: ['completion', 'tools'] }],
  ['minimax-m3', { created: 1780272000, caps: ['completion', 'tools', 'vision'] }],
]);

const paywalled = new Set<string>();

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') {
      return res.end(JSON.stringify({ object: 'list', data: [...models.keys()].map((id) => ({ id, object: 'model', created: models.get(id)!.created })) }));
    }
    if (req.url === '/api/show') {
      const m = models.get(JSON.parse(body).model);
      if (!m) { res.statusCode = 404; return res.end('{"error":"model not found"}'); }
      return res.end(JSON.stringify({ capabilities: m.caps, model_info: { 'x.context_length': 262144 } }));
    }
    if (req.url === '/v1/chat/completions') {
      const b = JSON.parse(body);
      if (paywalled.has(b.model)) {
        res.statusCode = 402;
        return res.end('{"error":{"message":"this model is not included in your free usage"}}');
      }
      const msg = b.tools
        ? { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_time', arguments: '{}' } }] }
        : { role: 'assistant', content: 'ok red' };
      return res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: b.model, choices: [{ index: 0, message: msg, finish_reason: 'stop' }] }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});

describe('Catalog wiring (raw configs → poller → expanded pools)', () => {
  let stateDir: string;
  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-catalog-wiring-'));
    process.env.ROUTER_STATE_DIR = stateDir;
    process.env.ROUTER_CLOUD_BASE_URL = `http://127.0.0.1:${port}/v1`;
    process.env.OLLAMA_API_KEY = 'fake-ollama-key';
  });
  after(() => {
    server.close();
  });

  it('resolves the text-high rule to today\'s model and switches when it disappears', async () => {
    const { loadLogicalModelConfigs, loadRawLogicalModelConfigs } = await import('../src/config.js');
    const { startCatalogPoller, stopCatalogPoller } = await import('../src/core/catalog.js');
    const { admissionProbeQueue } = await import('../src/core/admission.js');

    const idle = async () => {
      for (let i = 0; i < 200 && (admissionProbeQueue.pendingCount || admissionProbeQueue.runningCount); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const ruleModel = (id: string) =>
      loadLogicalModelConfigs()['text-high'].pool.filter((e) => e.fromRule === id).map((e) => e.model);

    const poller = startCatalogPoller(() => loadRawLogicalModelConfigs(), 0);
    await poller.refreshNow();
    await idle();
    assert.deepEqual(ruleModel('ollama-cloud-deepseek-flash-high'), ['deepseek-v4.1-flash', 'glm-5.3-flash']);

    models.delete('deepseek-v4.1-flash');
    await poller.refreshNow();
    await idle();
    assert.deepEqual(ruleModel('ollama-cloud-deepseek-flash-high'), ['glm-5.3-flash']);

    // Listed but not in this key's plan: a 402 in real traffic rejects it and
    // the rule moves on; the next refresh must not re-admit it.
    const { forwardChat } = await import('../src/core/forwarder.js');
    paywalled.add('glm-5.3-flash');
    const cfg = loadLogicalModelConfigs()['text-high'];
    cfg.pool = cfg.pool.filter((e) => e.fromRule);
    const r = await forwardChat('text-high', cfg, { model: 'text-high', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.ok, false);
    await poller.refreshNow();
    await idle();
    assert.ok(!ruleModel('ollama-cloud-deepseek-flash-high').includes('glm-5.3-flash'));

    poller.stop();
    stopCatalogPoller();
  });
});
