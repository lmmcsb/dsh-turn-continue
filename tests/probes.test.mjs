import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, flush } from './helpers.mjs';

async function open(h) {
  const a = h.agent();
  await h.preStep(a);
  await h.emit('agent/request-error', { agent: a, turn: 1, provider: 'primary', failure: { code: 'SERVER' } }, async () => {});
  return a;
}
async function advance(t, ms) { t.mock.timers.tick(ms); await flush(); }
const options = { enableProbe: true, modelCircuitThreshold: 1, modelCooldownMs: 10, platformCircuitThreshold: 50, probeTimeoutMs: 1000 };

for (const event of ['workspace/session-stop', 'agent/disposed', 'session/disposed', 'agent/inbox/inserted']) {
  test(`last probe owner leaving via ${event} cancels scheduled and in-flight work`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
    const h = harness(t, options, () => ({
      [Symbol.asyncIterator]() { return this; },
      next: () => new Promise(() => {}),
      return: async () => ({ done: true }),
    }));
    const a = await open(h);
    const leave = () => event === 'workspace/session-stop'
      ? h.emit(event, { sessionId: a.id })
      : event === 'session/disposed' ? h.emit(event, a.session)
        : h.emit(event, { agent: a, message: { source: { kind: 'user' } } });
    await leave();
    await advance(t, 1000);
    assert.equal(h.requests.length, 0);
    // A later real failure can take ownership again.
    await h.preStep(a);
    await h.emit('agent/request-error', { agent: a, turn: 1, provider: 'primary', failure: { code: 'SERVER' } }, async () => {});
    await advance(t, 1000);
    assert.equal(h.requests.length, 1);
    await leave();
    assert.equal(h.requests[0].signal.aborted, true);
    await advance(t, 10000);
    assert.equal(h.requests.length, 1);
    assert.equal(h.emitted.some(([e]) => e === 'turn-continue/probe'), false);
  });
}

test('a shared probe survives one owner stopping and stops when the final owner leaves', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const h = harness(t, options);
  const a = await open(h);
  const b = h.agent('session-2');
  await h.preStep(b);
  await h.emit('agent/request-error', { agent: b, turn: 1, provider: 'primary', failure: { code: 'SERVER' } }, async () => {});
  await h.emit('workspace/session-stop', { sessionId: a.id });
  await advance(t, 1000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.emitted.some(([e, p]) => e === 'turn-continue/probe' && p.ok), true);
});

test('an existing model probe waits for a subsequently extended provider cooldown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const h = harness(t, { ...options, modelCooldownMs: 1000, platformCircuitThreshold: 2, platformCooldownMs: 5000 });
  await open(h);
  const b = h.agent('session-2');
  b.model.select({ provider: 'primary', model: 'second-model' });
  b.session.context = b.model.current();
  await h.preStep(b);
  await h.emit('agent/request-error', { agent: b, turn: 1, provider: 'primary', failure: { code: 'SERVER' } }, async () => {});
  await advance(t, 1000);
  assert.equal(h.requests.length, 0);
  await advance(t, 3999);
  assert.equal(h.requests.length, 0);
  await advance(t, 1);
  assert.equal(h.requests.length, 2);
});

for (const off of ['global', 'probe']) {
  test(`${off} switch cancels scheduled probes and re-enable schedules one`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
    const h = harness(t, options);
    await open(h);
    const path = off === 'global' ? '/state' : '/settings';
    const payload = (on) => off === 'global' ? { enabled: on } : { settings: { enableProbe: on } };
    await h.http(path, 'POST', payload(false));
    await advance(t, 10000);
    assert.equal(h.requests.length, 0);
    await h.http(path, 'POST', payload(true));
    await advance(t, 1000);
    assert.equal(h.requests.length, 1);
    assert.equal(h.emitted.filter(([e, p]) => e === 'turn-continue/probe' && p.ok).length, 1);
  });
}

test('turning off aborts an in-flight probe and suppresses late success', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  let finish;
  const h = harness(t, options, () => (async function* () {
    await new Promise((resolve) => { finish = resolve; });
    yield { type: 'text-delta', text: 'pong' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })());
  await open(h);
  await advance(t, 1000);
  assert.equal(h.requests.length, 1);
  await h.http('/state', 'POST', { enabled: false });
  assert.equal(h.requests[0].signal.aborted, true);
  finish();
  await flush();
  assert.equal(h.emitted.some(([e]) => e === 'turn-continue/probe'), false);
});

test('empty stream is not a successful probe and retries have a minimum spacing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const h = harness(t, { ...options, modelCooldownMs: 0 }, () => (async function* () {})());
  await open(h);
  await advance(t, 999);
  assert.equal(h.requests.length, 0);
  await advance(t, 1);
  const probes = h.emitted.filter(([e]) => e === 'turn-continue/probe');
  assert.equal(probes.length, 1);
  assert.equal(probes[0][1].ok, false);
  await advance(t, 999);
  assert.equal(h.requests.length, 1);
  await advance(t, 1);
  assert.equal(h.requests.length, 2);
});

test('probe timeout releases an uncooperative stream and never overlaps requests', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  const h = harness(t, options, () => ({
    [Symbol.asyncIterator]() { return this; },
    next: () => new Promise(() => {}),
    return: async () => ({ done: true }),
  }));
  await open(h);
  await advance(t, 1000);
  assert.equal(h.requests.length, 1);
  await h.http();
  await advance(t, 999);
  assert.equal(h.requests.length, 1);
  await advance(t, 1);
  assert.equal(h.requests[0].signal.aborted, true);
  const result = h.emitted.find(([e]) => e === 'turn-continue/probe');
  assert.equal(result?.[1].ok, false);
  await advance(t, 1000);
  assert.equal(h.requests.length, 2);
});
