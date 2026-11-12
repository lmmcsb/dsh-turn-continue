import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness } from './helpers.mjs';

const boundaries = {
  maxContinuePerTurn: [0, 20], maxContinuePerSession: [0, 500],
  continueCooldownMs: [0, 60000], minReasoningChars: [0, 4000],
  modelCircuitThreshold: [1, 20], modelCooldownMs: [0, 3600000],
  platformCircuitThreshold: [1, 50], platformCooldownMs: [0, 3600000],
  burstWindowMs: [1, 3600000], probeMaxTokens: [1, 64], probeTimeoutMs: [1000, 120000],
};

test('HTTP settings enforce all numeric boundaries and deduplicate ordered fallbacks', async (t) => {
  const h = harness(t);
  for (const edge of [0, 1]) {
    const settings = Object.fromEntries(Object.keys(boundaries).map((key) => [key, edge === 0 ? -100 : 1e15]));
    const saved = await h.http('/settings', 'POST', { settings, fallbacks: [
      { provider: ' p ', model: ' m ' }, { provider: 'p', model: 'm' }, { provider: '', model: 'ignored' },
    ] });
    assert.equal(saved.status, 200);
    for (const [key, limits] of Object.entries(boundaries)) assert.equal(saved.body.config[key], limits[edge], key);
    assert.deepEqual(saved.body.fallbacks, [{ provider: 'p', model: 'm' }]);
  }
});

test('disk overrides are validated instead of bypassing HTTP validation', async (t) => {
  const h = harness(t);
  fs.writeFileSync(path.join(h.home, 'turn-continue.json'), JSON.stringify({
    enabled: 'false', settings: { enableProbe: 'false', probeTimeoutMs: -100, maxContinuePerTurn: 'unlimited', tripCodes: null },
    fallbacks: [{ provider: 42, model: {} }, { provider: ' p ', model: ' m ' }],
  }));
  const { body } = await h.http();
  assert.equal(body.config.enableProbe, false);
  assert.equal(body.config.probeTimeoutMs, 1000);
  assert.equal(body.config.maxContinuePerTurn, 3);
  assert.ok(Array.isArray(body.config.tripCodes));
  assert.deepEqual(body.fallbacks, [{ provider: 'p', model: 'm' }]);
});

test('corrupt persisted state fails closed instead of silently enabling automatic actions', async (t) => {
  const h = harness(t);
  fs.writeFileSync(path.join(h.home, 'turn-continue.json'), '{broken');
  assert.equal((await h.http()).body.enabled, false);
});

test('non-object persisted JSON also fails closed', async (t) => {
  const h = harness(t);
  for (const text of ['null', '[]', 'true', '42']) {
    fs.writeFileSync(path.join(h.home, 'turn-continue.json'), text);
    assert.equal((await h.http()).body.enabled, false, text);
  }
});

test('a failed atomic replacement preserves the last saved settings and removes its temporary file', async (t) => {
  const h = harness(t);
  const file = path.join(h.home, 'turn-continue.json');
  const previous = JSON.stringify({ enabled: true, unrelated: 'retained' });
  fs.writeFileSync(file, previous);
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('replacement unavailable'), { code: 'EIO' }); };
  let reply;
  try { reply = await h.http('/state', 'POST', { enabled: false }); }
  finally { fs.renameSync = rename; }
  assert.equal(reply.status, 500);
  assert.equal(fs.readFileSync(file, 'utf8'), previous);
  assert.deepEqual(fs.readdirSync(h.home), ['turn-continue.json']);
});

test('settings writes valid JSON and survives reread without losing other fields', async (t) => {
  const h = harness(t);
  const file = path.join(h.home, 'turn-continue.json');
  fs.writeFileSync(file, JSON.stringify({ enabled: true, unrelated: { retained: true } }));
  const off = await h.http('/state', 'POST', { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.enabled, false);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.enabled, false);
  assert.deepEqual(stored.unrelated, { retained: true });
  const saved = await h.http('/settings', 'POST', { settings: { steerText: '接着完成', maxContinuePerTurn: 5 } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.enabled, false);
  const back = await h.http();
  assert.equal(back.body.steerText, '接着完成');
  assert.equal(back.body.config.maxContinuePerTurn, 5);
});
