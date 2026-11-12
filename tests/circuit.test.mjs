import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../lib/circuit.js';

function breaker(extra = {}) {
  let now = 10000;
  const b = new CircuitBreaker({
    modelCircuitThreshold: 2, modelCooldownMs: 100,
    platformCircuitThreshold: 2, platformCooldownMs: 500,
    burstWindowMs: 1000, now: () => now, ...extra,
  });
  return { b, tick: (ms) => { now += ms; } };
}

test('with probes enabled cooling alone never certifies a route as healthy', () => {
  const { b, tick } = breaker({ requireProbeSuccess: true });
  b.trip('primary', 'model');
  tick(101);
  assert.equal(b.isOpen('primary', 'model'), true);
  assert.equal(b.snapshot().routes[0].waitingProbe, true);
  b.recordProbeSuccess('primary', 'model');
  assert.equal(b.isOpen('primary', 'model'), false);
});

test('terminal trips honour the provider cooldown after model cooldown expires', () => {
  const { b, tick } = breaker();
  b.trip('primary', 'a');
  b.trip('primary', 'b');
  tick(101);
  assert.equal(b.isOpen('primary', 'other'), true);
  tick(400);
  assert.equal(b.isOpen('primary', 'other'), false);
});

test('one successful model probe cannot shorten an active provider cooldown', () => {
  const { b, tick } = breaker({ requireProbeSuccess: true });
  b.trip('p', 'a');
  b.trip('p', 'b');
  tick(100);
  b.recordProbeSuccess('p', 'a');
  assert.equal(b.isOpen('p', 'unfailed-model'), true);
  tick(400);
  assert.equal(b.isOpen('p', 'unfailed-model'), false);
  assert.equal(b.isOpen('p', 'b'), true);
});

test('zero cooldown still opens and probes a failed route when enabled', () => {
  const { b } = breaker({ requireProbeSuccess: true, modelCooldownMs: 0, modelCircuitThreshold: 1 });
  assert.equal(b.recordFailure('p', 'm'), 'model');
  assert.equal(b.isOpen('p', 'm'), true);
});

test('model identifiers round trip and fallback order stays stable', () => {
  const { b } = breaker();
  b.trip('provider', 'model-with/slash');
  assert.equal(b.snapshot().routes[0].model, 'model-with/slash');
  assert.deepEqual(b.routeFor({ provider: 'provider', model: 'model-with/slash' }, [
    { provider: 'healthy', model: 'first' }, { provider: 'healthy', model: 'second' },
  ]), { provider: 'healthy', model: 'first' });
});
