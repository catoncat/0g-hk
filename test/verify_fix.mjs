import assert from 'node:assert';
import { test } from 'node:test';
import worker from '../src/index.js';

test('verify fix: go=1 NO LONGER bypasses isAllowedTarget', async () => {
  const env = {
    NOTES: {
      get: async (key) => {
        if (key === 'n:malicious') return 'https://malicious.com';
        if (key === 'm:malicious') return JSON.stringify({ v: 1, t: '1d', ct: Date.now() });
        return null;
      }
    }
  };

  // Test case 1: malicious target without go=1 -> should NOT redirect (returns interstitial page)
  const req1 = new Request('https://malicious.0g.hk/');
  const res1 = await worker.fetch(req1, env);
  assert.notStrictEqual(res1.status, 302, 'Should not redirect malicious target by default');
  const body1 = await res1.text();
  assert.ok(body1.includes('即将离开'), 'Should show interstitial page');

  // Test case 2: malicious target WITH go=1 -> SHOULD NO LONGER redirect
  const req2 = new Request('https://malicious.0g.hk/?go=1');
  const res2 = await worker.fetch(req2, env);
  assert.notStrictEqual(res2.status, 302, 'FIX: go=1 should NO LONGER bypass and redirect');
  const body2 = await res2.text();
  assert.ok(body2.includes('即将离开'), 'Should show interstitial page even with go=1');

  // Test case 3: allowed target -> should still redirect
  env.NOTES.get = async (key) => {
    if (key === 'n:safe') return 'https://github.com/catoncat/0g-hk';
    if (key === 'm:safe') return JSON.stringify({ v: 1, t: '1d', ct: Date.now() });
    return null;
  };
  const req3 = new Request('https://safe.0g.hk/');
  const res3 = await worker.fetch(req3, env);
  assert.strictEqual(res3.status, 302, 'Allowed target should still redirect');
  assert.strictEqual(res3.headers.get('location'), 'https://github.com/catoncat/0g-hk');
});
