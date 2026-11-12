import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { apply, Config } from '../lib/index.js';

export async function flush() {
  await setImmediate();
  await setImmediate();
}

export function harness(t, overrides = {}, stream) {
  const previousHome = process.env.DSH_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-regression-'));
  process.env.DSH_HOME = home;
  const handlers = new Map();
  const effects = [];
  const routes = [];
  const agents = new Map();
  const emitted = [];
  const requests = [];
  const logs = [];
  const registry = {
    get: (id) => agents.get(id),
    list: () => [...agents.values()],
    turnBoundaryOf: (session) => session.boundary,
  };
  const ctx = {
    logger: { info: (s) => logs.push(s), warn: (s) => logs.push(s) },
    on(event, fn) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      return () => {};
    },
    emit: (...args) => emitted.push(args),
    effect(factory) {
      const dispose = factory();
      if (typeof dispose === 'function') effects.push(dispose);
      return () => {};
    },
    get: (key) => key === 'agents' ? registry : undefined,
    inject(_names, fn) {
      fn({ effect: ctx.effect, webServer: { register: (r) => { routes.push(r); return () => {}; } } });
    },
    llm: {
      listProviders: () => ['primary', 'backup'],
      listModels: async (provider) => [{ id: `${provider}-model`, name: provider }],
      stream(options) {
        requests.push(options);
        return stream ? stream(options) : (async function* () {
          yield { type: 'text-delta', index: 0, text: 'pong' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
  };
  apply(ctx, { ...Config({}), enableProbe: false, notifySwitch: false, continueCooldownMs: 100, ...overrides });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const fn of effects.reverse()) fn();
  };
  t.after(() => {
    dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const emit = async (event, ...args) => {
    for (const fn of handlers.get(event) ?? []) await fn(...args);
  };
  async function http(suffix = '/state', method = 'GET', payload, extraHeaders = {}) {
    const route = routes.find((r) => r.path === `/api/dsh-turn-continue${suffix.split('?')[0]}`);
    if (!route) throw new Error(`Missing ${suffix}`);
    const res = { statusCode: 0, setHeader() {}, end(s) { this.body = JSON.parse(s); } };
    const req = {
      method, url: `/api/dsh-turn-continue${suffix}`,
      headers: { host: 'localhost:3508', origin: 'http://localhost:3508', ...extraHeaders },
      on(event, fn) {
        if (event === 'data' && payload !== undefined) fn(Buffer.from(JSON.stringify(payload)));
        if (event === 'end') fn();
      },
      destroy() {},
    };
    await route.handler(req, res);
    return { status: res.statusCode, body: res.body };
  }
  function agent(id = 'session-1') {
    const events = [];
    let selection = { provider: 'primary', model: 'primary-model' };
    const selected = [];
    const followups = [];
    const steers = [];
    const session = {
      id, boundary: { lastTurn: 1, openTurnStartSeq: 0 },
      get seq() { return events.length; },
      snapshotEvents: () => [...events],
      requestContext: () => session.context ?? { provider: 'primary', model: 'primary-model' },
      append(type, data) { const event = { type, data, seq: events.length }; events.push(event); return event; },
    };
    const a = {
      id, session, events, selected, followups, steers,
      model: { current: () => ({ ...selection }), select: (r) => { selected.push(r); selection = { ...r }; } },
      followup: (msg) => followups.push(msg), steer: (msg) => steers.push(msg),
    };
    agents.set(id, a);
    return a;
  }
  async function end(a, reason = { kind: 'error', error: { code: 'SERVER', message: 'server failed' } }, turn = 1) {
    a.session.boundary = { lastTurn: turn, openTurnStartSeq: null };
    const e = a.session.append('turn/end', { turn, reason });
    await emit('session/event', a.session, e);
  }
  const preStep = (a, turn = 1) => emit('agent/pre-step', {
    agent: a, turn, step: 1, modelSelection: a.model.current(), signal: new AbortController().signal,
  }, async () => {});
  return { home, http, agent, end, preStep, emit, dispose, agents, emitted, requests, logs };
}
