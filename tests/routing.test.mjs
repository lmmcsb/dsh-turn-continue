import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, flush } from './helpers.mjs';

const backup = { provider: 'backup', model: 'backup-model' };
const failure = { code: 'SERVER', message: 'server failed' };
const advance = async (t) => { t.mock.timers.tick(100); await flush(); };

test('failed captured route opens its circuit and selects backup before followup', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, { fallbacks: [backup], modelCircuitThreshold: 1 });
  const a = h.agent();
  await h.preStep(a);
  await h.emit('agent/request-error', { agent: a, turn: 1, provider: 'primary', failure }, async () => {});
  assert.equal(a.selected.length, 0, 'do not pretend to change the frozen failed request');
  await h.end(a);
  await advance(t);
  assert.deepEqual(a.model.current(), backup);
  assert.equal(a.followups.length, 1);
  const state = (await h.http()).body;
  assert.equal(state.circuit.routes.some((r) => r.provider === 'backup'), false);
  assert.equal(state.circuit.routes.some((r) => r.provider === 'primary'), true);
});

test('pending backup selection never becomes the attribution of a failed primary request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, { fallbacks: [backup], modelCircuitThreshold: 1 });
  const a = h.agent();
  await h.preStep(a);
  a.model.select(backup);
  await h.emit('agent/request-error', { agent: a, turn: 1, provider: 'primary', failure }, async () => {});
  await h.end(a);
  await advance(t);
  assert.equal(a.followups.length, 1);
  assert.equal((await h.http()).body.circuit.routes.some((r) => r.provider === 'backup'), false);
});

test('an in-flight turn signal cancels a pending terminal recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t);
  const a = h.agent();
  const controller = new AbortController();
  await h.emit('agent/pre-step', { agent: a, turn: 1, modelSelection: a.model.current(), signal: controller.signal }, async () => {});
  await h.end(a, { kind: 'max-tokens' });
  controller.abort();
  await advance(t);
  assert.equal(a.followups.length, 0);
});

test('user abort only resumes on explicit setting; parent and disposal never resume', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, { continueOnAbort: true });
  for (const kind of ['user', 'parent', 'disposed', 'hook']) {
    const a = h.agent(kind);
    await h.end(a, { kind: 'aborted', reason: { kind } });
    await advance(t);
    assert.equal(a.followups.length, kind === 'user' ? 1 : 0, kind);
  }
});
