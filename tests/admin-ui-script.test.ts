import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderDashboardHtml } from '../src/routes/admin-ui.js';

// The dashboard's JS lives inside a TS template literal, where '\n' and \' are
// consumed by TypeScript: one bad escape breaks the whole page with no test
// failing. Parse every inline script (without running it).
describe('Admin dashboard inline scripts', () => {
  it('parse as valid JavaScript', () => {
    const scripts = [...renderDashboardHtml().matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0);
    for (const src of scripts) {
      assert.doesNotThrow(() => new Function(src));
    }
  });
});
