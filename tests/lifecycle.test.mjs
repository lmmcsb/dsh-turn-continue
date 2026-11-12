import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, flush } from './helpers.mjs';

async function advance(t, ms = 1000) { t.mock.timers.tick(ms); await flush(); }

for (const action of ['disable', 'dispose', 'new-input', 'new-turn', 'stop', 'archive', 'agent-replaced']) {
  test(`pending terminal continuation is cancelled by ${action}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness(t);
    const a = h.agent();
    await h.preStep(a);
    await h.end(a, { kind: 'max-tokens' });
    if (action === 'disable') await h.http('/state', 'POST', { enabled: false });
    if (action === 'dispose') h.dispose();
    if (action === 'new-input') await h.emit('agent/inbox/inserted', { agent: a, message: { source: { kind: 'user' } } });
    if (action === 'new-turn') {
      a.session.boundary = { lastTurn: 2, openTurnStartSeq: 2 };
      await h.emit('session/event', a.session, a.session.append('turn/start', { turn: 2 }));
    }
    if (action === 'stop') await h.end(a, { kind: 'aborted', reason: { kind: 'user' } });
    if (action === 'archive') await h.emit('workspace/session-stop', { sessionId: a.id });
    if (action === 'agent-replaced') h.agent(a.id);
    await advance(t);
    assert.equal(a.followups.length, 0);
  });
}

test('duplicate turn/end delivers one continuation at configured cooldown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, { continueCooldownMs: 500 });
  const a = h.agent();
  await h.end(a, { kind: 'max-tokens' });
  await h.end(a, { kind: 'max-tokens' });
  await advance(t, 499);
  assert.equal(a.followups.length, 0);
  await advance(t, 1);
  assert.equal(a.followups.length, 1);
});

test('zero per-turn budget disables terminal continuation too', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, { maxContinuePerTurn: 0 });
  const a = h.agent();
  await h.end(a, { kind: 'max-tokens' });
  await advance(t);
  assert.equal(a.followups.length, 0);
});

test('turn-stopping rechecks off switch and lifetime during cooldown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t);
  const a = h.agent();
  a.session.append('assistant/message', { turn: 1, message: { content: [{ type: 'reasoning', text: '想'.repeat(80) }] } });
  const waiting = h.emit('agent/turn-stopping', { agent: a, turn: 1, signal: new AbortController().signal });
  await h.http('/state', 'POST', { enabled: false });
  await advance(t);
  await waiting;
  assert.equal(a.steers.length, 0);
});

test('a stale prior-turn stop cannot cancel a newer turn recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t);
  const a = h.agent();
  await h.end(a, { kind: 'completed' });
  a.session.boundary = { lastTurn: 2, openTurnStartSeq: 2 };
  await h.emit('session/event', a.session, a.session.append('turn/start', { turn: 2 }));
  await h.end(a, { kind: 'max-tokens' }, 2);
  await h.emit('session/event', a.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } });
  await advance(t);
  assert.equal(a.followups.length, 1);
});

test('terminal recovery supersedes a pending empty-turn steer without sending into a closed turn', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, { fallbacks: [{ provider: 'backup', model: 'backup-model' }] });
  const a = h.agent();
  await h.preStep(a);
  a.session.append('assistant/message', { turn: 1, message: { content: [{ type: 'reasoning', text: '想'.repeat(80) }] } });
  const waiting = h.emit('agent/turn-stopping', { agent: a, turn: 1, signal: new AbortController().signal });
  await h.end(a);
  await advance(t);
  await waiting;
  assert.equal(a.steers.length, 0);
  assert.equal(a.followups.length, 1);
  assert.equal(a.selected.at(-1)?.provider, 'backup');
});

test('terminal errors outside tripCodes are left for the user', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t);
  const a = h.agent();
  await h.end(a, { kind: 'error', error: { code: 'AUTH', message: 'credentials required' } });
  await advance(t);
  assert.equal(a.followups.length, 0);
  assert.equal(a.selected.length, 0);
});
