/**
 * dsh-turn-continue — Host 半部。
 *
 * 三件事：
 *   1. 兜住「会话停了但任务没做完」：空回合（只思考、没正文也没工具调用）、
 *      输出额度耗尽、模型报错中断，都自动补一句「继续」把循环接上。
 *   2. 接管模型熔断与回退：provider/model 连续失败就切到备用路由，
 *      冷却期过后用一次极小的真实请求探活，恢复则切回主路由。
 *   3. 给 Client 半部（输入框左侧的指示灯、设置页）提供本地 HTTP 接口，
 *      开关与配置落在 $DSH_HOME/turn-continue.json，改完立即生效。
 *
 * 不做的事：不碰 profile 的 cordis.patch.yml，不改别的插件，不拦用户的主动取消。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { defineConfig, z } from './schema.js';

import { CircuitBreaker, modelKey } from './circuit.js';

export const name = 'turn-continue';

/** llm 是核心依赖：没有它就没有探活，也就谈不上熔断恢复。 */
export const inject = ['llm'];

export const Config = defineConfig({
  // --- 续跑 ---------------------------------------------------------------
  /** 运行时开关的默认值；用户点指示灯或改设置后，以状态文件为准。 */
  enabled: z.boolean().default(true),
  /** 补发的那句话。 */
  steerText: z.string().default('继续'),
  /** 同一轮最多补几次，防止原地打转。 */
  maxContinuePerTurn: z.number().default(3).min(0),
  /** 同一会话十分钟内最多补几次，防止跨轮无限续命。 */
  maxContinuePerSession: z.number().default(30).min(0),
  /** 空回合（只思考、没正文也没工具调用）是否补。 */
  continueOnEmptyTurn: z.boolean().default(true),
  /** 输出额度被思考吃光时是否补。 */
  continueOnMaxTokens: z.boolean().default(true),
  /** 模型报错导致中断时是否补。 */
  continueOnModelError: z.boolean().default(true),
  /** 用户主动停止后是否补（默认不补：那是人的意思）。 */
  continueOnAbort: z.boolean().default(false),
  /** 思考少于这么多字就当作模型本来就不打算说话，不补。 */
  minReasoningChars: z.number().default(40),
  /** 两次补发之间的最小间隔。 */
  continueCooldownMs: z.number().default(1200).min(0),
  /** 补发后是否在会话里留一条可见说明。 */
  notifyContinue: z.boolean().default(false),

  // --- 熔断与回退（语义与 dsh-model-failover 一致） -------------------------
  /** 备用路由，按顺序取第一个健康的。 */
  fallbacks: z
    .array(
      z.object({
        provider: z.string().required(),
        model: z.string().required(),
      }),
    )
    .default([]),
  /** 哪些失败码算「模型不行了」。 */
  tripCodes: z
    .array(z.string())
    .default(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'QUOTA', 'EMPTY_RESPONSE']),
  modelCircuitThreshold: z.number().default(2).min(1),
  modelCooldownMs: z.number().default(60_000).min(0),
  platformCircuitThreshold: z.number().default(2).min(1),
  platformCooldownMs: z.number().default(120_000).min(0),
  burstWindowMs: z.number().default(300_000).min(1),
  /** 冷却期过后用一次极小的真实请求探活。 */
  enableProbe: z.boolean().default(true),
  probeMaxTokens: z.number().default(8).min(1).max(64),
  probeTimeoutMs: z.number().default(20_000).min(1000).max(120_000),
  /** 切到备用模型时是否丢掉原模型的思考强度设置。 */
  stripReasoningEffort: z.boolean().default(true),
  /** 切换时是否在会话里留一条可见说明。 */
  notifySwitch: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// 状态文件
// ---------------------------------------------------------------------------

const STATE_FILE = 'turn-continue.json';

function dshHome() {
  const fromEnv = process.env.DSH_HOME?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return path.join(os.homedir(), '.dsh');
}

function statePath() {
  return path.join(dshHome(), STATE_FILE);
}

/** 读状态文件；不存在或坏了都当空对象，绝不让插件因为读不到文件而挂掉。 */
function readStateFile() {
  try {
    const text = fs.readFileSync(statePath(), 'utf8');
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return { enabled: false };
  } catch (error) {
    // 首次安装可以使用默认值；已有文件损坏或不可读时暂停自动操作。
    return error?.code === 'ENOENT' ? {} : { enabled: false };
  }
}

/** 写状态文件；失败返回 false，调用方据此告诉界面「没存上」。 */
function writeStateFile(patch) {
  const target = statePath();
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const next = { ...readStateFile(), ...patch, updatedAt: new Date().toISOString() };
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
    return true;
  } catch {
    return false;
  } finally {
    // 仅清理本次创建的同目录临时文件，写入失败也不截断旧设置。
    try { fs.unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

/**
 * 把 Config 默认值、状态文件里的覆盖值合并成一份运行时配置。
 * 文件里的值优先，这样用户在设置页改完不用重启。
 */
const NUMBER_LIMITS = {
  maxContinuePerTurn: [0, 20], maxContinuePerSession: [0, 500],
  continueCooldownMs: [0, 60000], minReasoningChars: [0, 4000],
  modelCircuitThreshold: [1, 20], modelCooldownMs: [0, 3600000],
  platformCircuitThreshold: [1, 50], platformCooldownMs: [0, 3600000],
  burstWindowMs: [1, 3600000], probeMaxTokens: [1, 64], probeTimeoutMs: [1000, 120000],
};
const BOOLEAN_KEYS = new Set([
  'enabled', 'continueOnEmptyTurn', 'continueOnMaxTokens', 'continueOnModelError',
  'continueOnAbort', 'enableProbe', 'stripReasoningEffort', 'notifySwitch', 'notifyContinue',
]);

function sanitizeSettings(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    if (key === 'steerText') {
      if (typeof value === 'string' && value.trim()) out.steerText = value.trim().slice(0, 200);
    } else if (key === 'tripCodes') {
      if (Array.isArray(value)) out.tripCodes = [...new Set(value
        .filter((item) => typeof item === 'string' && item.trim())
        .map((item) => item.trim().toUpperCase()))].slice(0, 24);
    } else if (BOOLEAN_KEYS.has(key)) {
      if (typeof value === 'boolean') out[key] = value;
    } else if (Object.hasOwn(NUMBER_LIMITS, key) && typeof value === 'number' && Number.isFinite(value)) {
      const [min, max] = NUMBER_LIMITS[key];
      out[key] = Math.min(max, Math.max(min, Math.round(value)));
    }
  }
  return out;
}

function sanitizeFallbacks(input) {
  if (!Array.isArray(input)) return undefined;
  const out = [];
  for (const item of input) {
    const provider = typeof item?.provider === 'string' ? item.provider.trim() : '';
    const model = typeof item?.model === 'string' ? item.model.trim() : '';
    if (!provider || !model || out.some((route) => route.provider === provider && route.model === model)) continue;
    out.push({ provider, model });
    if (out.length === 8) break;
  }
  return out;
}

function resolveConfig(raw) {
  const stored = readStateFile();
  const merged = { ...Config({}), ...sanitizeSettings(raw), ...sanitizeSettings(stored.settings) };
  merged.fallbacks = sanitizeFallbacks(stored.fallbacks) ?? sanitizeFallbacks(raw?.fallbacks) ?? [];
  if (typeof stored.enabled === 'boolean') merged.enabled = stored.enabled;
  return merged;
}

// ---------------------------------------------------------------------------
// HTTP 工具（照 dsh-task-db 的写法：先挡跨站，再兜异常）
// ---------------------------------------------------------------------------

const ROUTE_PREFIX = '/api/dsh-turn-continue';

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function fromAnotherSite(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return false;
  const host = req.headers.host;
  if (typeof host !== 'string' || host === '') return true;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

function readJson(req, maxBytes = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function guarded(handler) {
  return async (req, res) => {
    if (fromAnotherSite(req)) {
      sendJson(res, 403, { ok: false, code: 'cross-site', message: '拒绝跨站请求' });
      return;
    }
    try {
      await handler(req, res);
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        code: 'internal',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

// ---------------------------------------------------------------------------
// 一轮的形态判定（纯函数，可单测）
// ---------------------------------------------------------------------------

/**
 * 数一数某一轮到底产出了什么。只认 assistant/message 里属于这一轮的那些事件。
 */
export function analyzeTurn(events, turn) {
  let text = 0;
  let toolCalls = 0;
  let reasoning = 0;
  let messages = 0;
  for (const event of events ?? []) {
    if (event?.type !== 'assistant/message') continue;
    const data = event.data;
    if (data === null || typeof data !== 'object' || data.turn !== turn) continue;
    messages += 1;
    const content = data.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      const body = typeof block.text === 'string' ? block.text.trim().length : 0;
      if (block.type === 'text') text += body;
      else if (block.type === 'tool-call') toolCalls += 1;
      else if (block.type === 'reasoning') reasoning += body;
    }
  }
  return { text, toolCalls, reasoning, messages };
}

/**
 * 轮次结束前该不该补一条「继续」。
 * @returns {{continue: boolean, why: string}}
 */
export function decideContinue(analysis, flags, config) {
  if (flags.aborted && !config.continueOnAbort) return { continue: false, why: 'aborted-by-user' };
  if (flags.modelError && config.continueOnModelError) return { continue: true, why: 'model-error' };
  if (!config.continueOnEmptyTurn) return { continue: false, why: 'disabled' };
  if (analysis.text > 0 || analysis.toolCalls > 0) return { continue: false, why: 'has-output' };
  if (analysis.reasoning < config.minReasoningChars) {
    return { continue: false, why: 'too-little-reasoning' };
  }
  return { continue: true, why: 'empty-turn' };
}

// ---------------------------------------------------------------------------
// 用户消息（内核版本不同，拿不到工厂函数就手搓一个同形状的）
// ---------------------------------------------------------------------------

let cachedCreateUserMessage = null;

function fallbackUserMessage(spec) {
  return {
    role: 'user',
    content: spec.content,
    source: spec.source,
    time: Date.now(),
  };
}

async function getCreateUserMessage() {
  if (cachedCreateUserMessage !== null) return cachedCreateUserMessage;
  try {
    const mod = await import('@deepseek-ai/dsh-llm');
    cachedCreateUserMessage = mod.createUserMessage ?? fallbackUserMessage;
  } catch {
    cachedCreateUserMessage = fallbackUserMessage;
  }
  return cachedCreateUserMessage;
}

// ---------------------------------------------------------------------------
// agent.model 的运行时鸭子类型检查（Agent 接口本身只承诺 id）
// ---------------------------------------------------------------------------

function agentModelApi(agent) {
  const candidate = agent?.model;
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  if (typeof candidate.current !== 'function') return undefined;
  if (typeof candidate.select !== 'function') return undefined;
  return candidate;
}

function sameRoute(left, right) {
  return (
    left !== undefined
    && right !== undefined
    && left.provider === right.provider
    && left.model === right.model
  );
}

function selectAgentModel(agent, route, stripReasoningEffort) {
  const model = agentModelApi(agent);
  if (model === undefined) return false;
  const current = model.current();
  model.select({
    ...route,
    ...(!stripReasoningEffort && current?.reasoningEffort !== undefined
      ? { reasoningEffort: current.reasoningEffort }
      : {}),
  });
  return true;
}

/** 换掉一个已解析请求配置里的路由，可选地丢掉思考强度。 */
function switchedConfig(base, target, stripReasoningEffort) {
  if (!stripReasoningEffort) return { ...base, provider: target.provider, model: target.model };
  const { reasoningEffort, ...rest } = base;
  return { ...rest, provider: target.provider, model: target.model };
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/**
 * @param ctx - 暴露 llm 与 Agent 生命周期的上下文。
 * @param rawConfig - 由 schema 校验过的插件配置。
 */
export function apply(ctx, rawConfig) {
  const config = { ...rawConfig };

  // 运行时状态：这些不进配置文件，进程重启即清空。
  const breaker = new CircuitBreaker({
    modelCircuitThreshold: config.modelCircuitThreshold,
    modelCooldownMs: config.modelCooldownMs,
    platformCircuitThreshold: config.platformCircuitThreshold,
    platformCooldownMs: config.platformCooldownMs,
    burstWindowMs: config.burstWindowMs,
    requireProbeSuccess: config.enableProbe,
  });
  const lastRoute = new WeakMap();
  const primaryRoutes = new WeakMap();
  const selectedByFailover = new WeakMap();
  const observedSelections = new WeakMap();
  const probeTimers = new Map();
  const probeRoutes = new Map();
  const activeProbes = new Map();
  const lifetime = new AbortController();
  const pendingContinues = new Map();
  const sessions = new Map();
  const turnSignals = new WeakMap();
  const failedRequests = new WeakMap();

  function sessionState(session) {
    let state = sessions.get(session.id);
    if (state?.session !== session) {
      state = { session, generation: 0, endedTurn: -1, blocked: false };
      sessions.set(session.id, state);
    }
    return state;
  }

  function cancelSession(sessionId, block = false) {
    const state = sessions.get(sessionId);
    if (state) {
      state.generation += 1;
      if (block) state.blocked = true;
    }
    for (const job of pendingContinues.values()) {
      if (job.agent.id === sessionId) job.controller.abort();
    }
  }

  function cancelContinues() {
    for (const job of pendingContinues.values()) job.controller.abort();
  }

  function waitFor(ms, signal) {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(false);
      const finish = (ok) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancelled);
        resolve(ok);
      };
      const cancelled = () => finish(false);
      const timer = setTimeout(() => finish(true), ms);
      signal.addEventListener('abort', cancelled, { once: true });
    });
  }

  function reserveContinue(agent, turn, terminal, signal) {
    const key = `${agent.id}:${turn}`;
    const state = sessionState(agent.session);
    if (lifetime.signal.aborted || state.blocked) return undefined;
    const held = pendingContinues.get(key);
    if (held) {
      if (!terminal || held.terminal) return undefined;
      held.controller.abort();
    }
    const controller = new AbortController();
    const job = { key, agent, turn, terminal, controller, generation: state.generation };
    const cancelled = () => controller.abort();
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) controller.abort();
    job.release = () => {
      signal?.removeEventListener('abort', cancelled);
      if (pendingContinues.get(key) === job) pendingContinues.delete(key);
    };
    pendingContinues.set(key, job);
    return job;
  }

  function canContinue(job, cfg) {
    const { agent, turn } = job;
    const state = sessions.get(agent.id);
    if (!cfg.enabled || lifetime.signal.aborted || job.controller.signal.aborted
      || state?.session !== agent.session || state.blocked || state.generation !== job.generation
      || agentsOf()?.get?.(agent.id) !== agent) return false;
    const boundary = agentsOf()?.turnBoundaryOf?.(agent.session);
    if (boundary && (boundary.lastTurn !== turn
      || (job.terminal ? boundary.openTurnStartSeq !== null : boundary.openTurnStartSeq === null))) return false;
    return (turnSpent.get(job.key) ?? 0) < cfg.maxContinuePerTurn
      && sessionBudget(agent.id).count < cfg.maxContinuePerSession;
  }

  /** 每一轮的错误标记：key = `${sessionId}:${turn}`。 */
  const turnErrors = new Map();
  /** 每一轮已经补了几次。 */
  const turnSpent = new Map();
  /** 每个会话的补发预算（带十分钟时间窗）。 */
  const sessionSpent = new Map();
  /** 补发后的事件计数快照，用来判断上一次补发有没有产生新内容。 */
  const turnProbe = new Map();
  /** 连续多少次「模型报错续跑」都没换成备用路由；换成功就清零。 */
  const errorStreak = new Map();
  /** 最近动作统计，给指示灯和设置页看。 */
  const stats = { continues: 0, fallbacks: 0, lastAction: null };

  const log = (msg) => ctx.logger?.info?.(`[${name}] ${msg}`);
  const warn = (msg) => ctx.logger?.warn?.(`[${name}] ${msg}`);

  /** 每次判定都重新合并一次，保证设置页改完立刻生效。 */
  function liveConfig() {
    const merged = resolveConfig(config);
    if (!merged.enabled) cancelContinues();
    breaker.options = {
      modelCircuitThreshold: merged.modelCircuitThreshold,
      modelCooldownMs: merged.modelCooldownMs,
      platformCircuitThreshold: merged.platformCircuitThreshold,
      platformCooldownMs: merged.platformCooldownMs,
      burstWindowMs: merged.burstWindowMs,
      requireProbeSuccess: merged.enableProbe,
    };
    syncProbes(merged);
    return merged;
  }

  const agentsOf = () => ctx.get('agents');

  function sessionBudget(sessionId) {
    const now = Date.now();
    const held = sessionSpent.get(sessionId);
    if (held === undefined || now - held.at > 600_000) {
      const fresh = { count: 0, at: now };
      sessionSpent.set(sessionId, fresh);
      return fresh;
    }
    return held;
  }

  function noteAction(kind, detail) {
    stats.lastAction = { kind, at: new Date().toISOString(), ...detail };
    if (kind === 'continue') stats.continues += 1;
    if (kind === 'fallback') stats.fallbacks += 1;
  }

  // --- 熔断探测 -----------------------------------------------------------

  function cancelProbes() {
    for (const timer of probeTimers.values()) clearTimeout(timer);
    probeTimers.clear();
    for (const controller of activeProbes.values()) controller.abort(new Error('probe cancelled'));
  }

  function syncProbes(cfg) {
    if (!cfg.enabled || !cfg.enableProbe || lifetime.signal.aborted) {
      cancelProbes();
      return;
    }
    for (const route of probeRoutes.values()) queueProbe(route.provider, route.model);
  }

  function disownProbes(sessionId) {
    for (const [key, route] of probeRoutes) {
      for (const owner of route.owners) if (owner.id === sessionId) route.owners.delete(owner);
      if (route.owners.size > 0) continue;
      probeRoutes.delete(key);
      clearTimeout(probeTimers.get(key));
      probeTimers.delete(key);
      activeProbes.get(key)?.abort(new Error('probe has no session owners'));
    }
  }

  function scheduleProbe(provider, model, session) {
    const key = modelKey(provider, model);
    let route = probeRoutes.get(key);
    if (!route) {
      route = { provider, model, owners: new Set() };
      probeRoutes.set(key, route);
    }
    if (session) route.owners.add(session);
    syncProbes(resolveConfig(config));
  }

  function queueProbe(provider, model) {
    const key = modelKey(provider, model);
    if (!probeRoutes.get(key)?.owners.size || probeTimers.has(key) || activeProbes.has(key) || lifetime.signal.aborted) return;
    // 零冷却也至少隔一秒，防止失败后形成紧循环。
    const delay = Math.max(1000, breaker.openUntil(provider, model) - breaker.now());
    const timer = setTimeout(() => {
      probeTimers.delete(key);
      void runProbe(provider, model).catch((error) => warn(`探活失败：${String(error)}`));
    }, delay);
    timer.unref?.();
    probeTimers.set(key, timer);
  }

  /** 同一路由只有一个探活，超时也能退出不响应取消的迭代器。 */
  async function runProbe(provider, model) {
    const key = modelKey(provider, model);
    const cfg = resolveConfig(config);
    const route = probeRoutes.get(key);
    if (!cfg.enabled || !cfg.enableProbe || lifetime.signal.aborted || !route?.owners.size || activeProbes.has(key)) return;
    // 其他模型可能在旧计时器建立后延长了整个平台的冷却。
    if (breaker.openUntil(provider, model) > breaker.now()) {
      queueProbe(provider, model);
      return;
    }
    const controller = new AbortController();
    activeProbes.set(key, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('probe timeout'));
    }, cfg.probeTimeoutMs);
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(controller.signal.reason ?? new Error('probe cancelled'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    let iterator;
    let ok = false;
    let message = '';
    try {
      const createUserMessage = await Promise.race([getCreateUserMessage(), aborted]);
      if (controller.signal.aborted) throw controller.signal.reason;
      iterator = ctx.llm.stream({
        provider, model,
        messages: [createUserMessage({ content: [{ type: 'text', text: 'ping' }], source: { kind: 'model-selection' } })],
        maxTokens: cfg.probeMaxTokens,
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      let hasOutput = false;
      while (true) {
        const result = await Promise.race([iterator.next(), aborted]);
        if (result.done) break;
        const chunk = result.value;
        if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text?.trim()) hasOutput = true;
        if (chunk.type === 'block-end' && chunk.block?.text?.trim()) hasOutput = true;
        if (chunk.type !== 'finish') continue;
        if (!['stop', 'max-tokens'].includes(chunk.reason?.kind)) {
          throw new Error(chunk.reason?.failure?.message ?? 'probe failed');
        }
        if (!hasOutput) throw new Error('probe returned no content');
        ok = true;
        break;
      }
      if (!ok) throw new Error('probe stream ended without a finish');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      if (iterator?.return) {
        try { void Promise.resolve(iterator.return()).catch(() => {}); } catch { /* cleanup only */ }
      }
      activeProbes.delete(key);
    }
    const current = resolveConfig(config);
    if (lifetime.signal.aborted || (controller.signal.aborted && !timedOut)
      || !current.enabled || !current.enableProbe) {
      syncProbes(current);
      return;
    }
    if (ok) {
      probeRoutes.delete(key);
      breaker.recordProbeSuccess(provider, model);
      ctx.emit('turn-continue/probe', { provider, model, ok: true });
      log(`${provider}/${model} 探测通过，熔断关闭`);
    } else {
      breaker.recordProbeFailure(provider, model);
      ctx.emit('turn-continue/probe', { provider, model, ok: false, message });
      warn(`${provider}/${model} 仍然不可用：${message}`);
      scheduleProbe(provider, model);
    }
  }

  /** 往会话里追加一条可见的 user 角色说明（切换、补发提示都走这里）。 */
  async function appendNotice(agent, text) {
    try {
      const createUserMessage = await getCreateUserMessage();
      agent.session.append(
        'user/message',
        createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'model-selection' } }),
        { surfaceOp: 'append' },
      );
    } catch (error) {
      warn(`写会话说明失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 切到备用路由并在会话里说明；返回是否真的切了。 */
  function failoverTo(agent, from, target, cfg) {
    if (target === undefined || sameRoute(from, target)) return false;
    if (!selectAgentModel(agent, target, cfg.stripReasoningEffort)) return false;
    selectedByFailover.set(agent, target);
    ctx.emit('turn-continue/fallback', { from, to: target, agentId: agent?.id });
    noteAction('fallback', { from, to: target });
    if (cfg.notifySwitch) {
      void appendNotice(
        agent,
        `⚠️ 模型熔断：${from.provider}/${from.model} 不可用，已切换到 ${target.provider}/${target.model}`,
      );
    }
    return true;
  }

  /**
   * 模型错误时先把路由切到备用，再补一句「继续」。
   * 路由来源按可靠性排：本插件记的 → agent 当前选择 → 会话最近一次请求上下文。
   */
  function failoverForAgent(agent, cfg) {
    const fallbackList = Array.isArray(cfg.fallbacks) ? cfg.fallbacks : [];
    if (fallbackList.length === 0) return false;

    const known = lastRoute.get(agent) ?? primaryRoutes.get(agent);
    const live = agentModelApi(agent)?.current?.();
    const context = agent?.session?.requestContext?.();
    const route =
      known
      ?? (live?.provider !== undefined && live?.model !== undefined
        ? { provider: live.provider, model: live.model }
        : undefined)
      ?? (context?.provider !== undefined && context?.model !== undefined
        ? { provider: context.provider, model: context.model }
        : undefined);
    if (route === undefined) return false;

    if (!primaryRoutes.has(agent)) primaryRoutes.set(agent, route);
    const primary = primaryRoutes.get(agent) ?? route;
    const target = breaker.routeFor(primary, fallbackList);
    return failoverTo(agent, route, target, cfg);
  }

  // --- 事件：路由修正 -----------------------------------------------------

  ctx.on('agent/pre-step', async ({ agent, modelSelection, turn, signal }, next) => {
    const state = sessionState(agent.session);
    if (turn !== undefined) turnSignals.set(agent, { turn, signal });
    const cfg = liveConfig();
    if (!cfg.enabled || modelSelection === undefined || agentModelApi(agent) === undefined) {
      return next();
    }
    const current = { provider: modelSelection.provider, model: modelSelection.model };
    lastRoute.set(agent, current);
    if (breaker.isOpen(current.provider, current.model)) scheduleProbe(current.provider, current.model, agent.session);

    const observed = observedSelections.get(agent);
    const priorFailover = selectedByFailover.get(agent);
    if (!primaryRoutes.has(agent)) {
      primaryRoutes.set(agent, current);
    } else if (
      observed !== undefined
      && !sameRoute(current, observed)
      && (priorFailover === undefined || !sameRoute(current, priorFailover))
    ) {
      // 用户自己换了模型：以新模型为主路由，别把它当成熔断切换。
      primaryRoutes.set(agent, current);
      selectedByFailover.delete(agent);
    }
    observedSelections.set(agent, current);

    const primary = primaryRoutes.get(agent) ?? current;
    const target = breaker.routeFor(primary, cfg.fallbacks ?? []);
    failoverTo(agent, current, target, cfg);
    return next();
  });

  // --- 事件：请求失败 -----------------------------------------------------

  ctx.on('agent/request-error', async (payload, next) => {
    const cfg = liveConfig();
    if (!cfg.enabled) return next();
    const codes = Array.isArray(cfg.tripCodes) ? cfg.tripCodes : [];
    if (!codes.includes(payload.failure?.code)) return next();

    const agent = payload.agent;
    if (payload.signal?.aborted || lifetime.signal.aborted) return next();
    const context = agent?.session?.requestContext?.();
    const captured = lastRoute.get(agent);
    const route = context?.provider === payload.provider && context?.model
      ? { provider: payload.provider, model: context.model }
      : captured?.provider === payload.provider ? captured : undefined;
    if (!route) return next();
    failedRequests.set(agent, { turn: payload.turn, route, code: payload.failure.code });
    const level = breaker.recordFailure(route.provider, route.model);
    if (level !== undefined) {
      ctx.emit('turn-continue/circuit-opened', {
        provider: route.provider,
        model: route.model,
        level,
      });
      warn(`${route.provider}/${route.model} 熔断打开（${level}），触发码 ${payload.failure.code}`);
      scheduleProbe(route.provider, route.model, agent.session);
    }

    // 当前步骤的模型已冻结。把切换留到终止恢复，其他监听器仍可重试原请求。
    return next();
  });

  // --- 事件：错误记录 -----------------------------------------------------

  ctx.on('agent/error', ({ agent, turn, error }) => {
    const sessionId = agent?.id;
    if (sessionId === undefined || turn === undefined) return;
    const key = `${sessionId}:${turn}`;
    const held = turnErrors.get(key) ?? { count: 0, code: undefined };
    turnErrors.set(key, {
      count: held.count + 1,
      code: error?.code ?? held.code,
    });
  });

  // --- 事件：轮次结束（错误 / 额度耗尽） ----------------------------------

  function clearTurnState(sessionId) {
    for (const map of [turnErrors, turnSpent, turnProbe]) {
      for (const key of map.keys()) if (key.startsWith(`${sessionId}:`)) map.delete(key);
    }
  }

  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message?.source?.kind === `plugin:${name}` || message?.source?.kind === 'model-selection') return;
    const state = sessionState(agent.session);
    cancelSession(agent.id);
    disownProbes(agent.id);
    state.blocked = false;
  });
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') cancelSession(agent.id);
  });
  ctx.on('agent/disposed', ({ agent }) => {
    if (sessions.get(agent.id)?.session !== agent.session) return;
    cancelSession(agent.id, true);
    disownProbes(agent.id);
    clearTurnState(agent.id);
    sessions.delete(agent.id);
    sessionSpent.delete(agent.id);
    errorStreak.delete(agent.id);
  });
  ctx.on('session/disposed', (session) => {
    if (sessions.get(session.id)?.session !== session) return;
    cancelSession(session.id, true);
    disownProbes(session.id);
    clearTurnState(session.id);
    sessions.delete(session.id);
    sessionSpent.delete(session.id);
    errorStreak.delete(session.id);
  });
  ctx.on('workspace/session-stop', ({ sessionId }) => {
    cancelSession(sessionId, true);
    disownProbes(sessionId);
  });

  ctx.on('session/event', (session, event) => {
    if (!session?.id) return;
    const state = sessionState(session);
    if (event?.type === 'turn/start') {
      cancelSession(session.id);
      state.blocked = false;
      clearTurnState(session.id);
      return;
    }
    if (event?.type === 'user/message' && event.data?.source?.kind !== `plugin:${name}`
      && event.data?.source?.kind !== 'model-selection') {
      cancelSession(session.id);
      disownProbes(session.id);
      return;
    }
    if (event?.type !== 'turn/end') return;
    const turn = event.data?.turn;
    if (turn === undefined) return;
    const boundary = agentsOf()?.turnBoundaryOf?.(session);
    // 同轮停止仍需取消已排的补发；严格旧轮次不能修改新轮的状态。
    if (turn < state.endedTurn || (boundary && turn < boundary.lastTurn)) return;
    const reason = event.data?.reason;
    const kind = reason?.kind;
    if (kind === 'aborted' || kind === 'blocked' || kind === 'interrupted' || kind === 'forked') {
      cancelSession(session.id, true);
      disownProbes(session.id);
    }
    if (turn <= state.endedTurn) return;
    state.endedTurn = turn;
    const errorMark = turnErrors.get(`${session.id}:${turn}`);
    turnErrors.delete(`${session.id}:${turn}`);
    if (kind === 'completed') errorStreak.delete(session.id);
    let detail;
    if (kind === 'error') detail = { why: 'model-error', code: reason.error?.code ?? errorMark?.code };
    if (kind === 'max-tokens') detail = { why: 'max-tokens' };
    if (kind === 'aborted' && reason.reason?.kind === 'user' && liveConfig().continueOnAbort) {
      state.blocked = false;
      detail = { why: 'user-abort' };
    }
    if (detail) void resumeTurn(session, turn, detail).catch((error) => warn(`续跑失败：${String(error)}`));
  });

  /**
   * 这一轮已经关掉了，steer 进不去，改用 followup 排下一轮。
   * 模型错误时先切备用路由，再排「继续」——用户要的顺序就是这个。
   */
  function continuationEnabled(detail, cfg) {
    if (detail.why === 'model-error') return cfg.continueOnModelError && cfg.tripCodes.includes(detail.code);
    if (detail.why === 'user-abort') return cfg.continueOnAbort;
    return detail.why === 'max-tokens' && cfg.continueOnMaxTokens;
  }

  async function resumeTurn(session, turn, detail) {
    let cfg = liveConfig();
    if (!cfg.enabled || !continuationEnabled(detail, cfg)) return;
    const sessionId = session.id;
    const agent = agentsOf()?.get?.(sessionId);
    if (!agent || agent.session !== session) return;
    const heldSignal = turnSignals.get(agent);
    const signal = detail.why !== 'user-abort' && heldSignal?.turn === turn ? heldSignal.signal : undefined;
    const job = reserveContinue(agent, turn, true, signal);
    if (!job) return;
    try {
      if (!canContinue(job, cfg)) return;
      if (!await waitFor(cfg.continueCooldownMs, job.controller.signal)) return;
      const createUserMessage = await getCreateUserMessage();
      cfg = liveConfig();
      if (!canContinue(job, cfg) || !continuationEnabled(detail, cfg)) return;

      if (detail.why === 'model-error') {
        const failure = failedRequests.get(agent);
        const context = session.requestContext?.();
        const route = failure?.turn === turn && failure.code === detail.code ? failure.route
          : context?.provider && context?.model ? { provider: context.provider, model: context.model }
            : lastRoute.get(agent);
        if (!route) return;
        if (!primaryRoutes.has(agent)) primaryRoutes.set(agent, route);
        const wasOpen = breaker.isOpen(route.provider, route.model);
        breaker.trip(route.provider, route.model);
        scheduleProbe(route.provider, route.model, agent.session);
        if (!wasOpen) ctx.emit('turn-continue/circuit-opened', { ...route, level: 'model' });
        const primary = primaryRoutes.get(agent);
        const target = breaker.routeFor(primary, cfg.fallbacks);
        const selected = agentModelApi(agent)?.current?.();
        const switched = !sameRoute(route, target) && !breaker.isOpen(target.provider, target.model)
          && (sameRoute(selected, target) || failoverTo(agent, selected ?? route, target, cfg));
        if (switched) errorStreak.delete(sessionId);
        else {
          const streak = (errorStreak.get(sessionId) ?? 0) + 1;
          errorStreak.set(sessionId, streak);
          if (streak >= 3) {
            noteAction('halt', { sessionId, turn, why: 'no-fallback' });
            warn(`会话 ${sessionId} 连续 3 次模型报错且无可用备用路由，停止续跑`);
            return;
          }
        }
      }
      const message = createUserMessage({
        content: [{ type: 'text', text: cfg.steerText }], source: { kind: `plugin:${name}` },
      });
      agent.followup(message);
      turnSpent.set(job.key, (turnSpent.get(job.key) ?? 0) + 1);
      sessionBudget(sessionId).count += 1;
      noteAction('continue', { sessionId, turn, why: detail.why, code: detail.code ?? null });
      if (cfg.notifyContinue) void appendNotice(agent, `↻ 上一轮因 ${detail.code ?? detail.why} 中断，已自动续跑`);
      log(`会话 ${sessionId} 第 ${turn} 轮因 ${detail.code ?? detail.why} 中断，已补发「${cfg.steerText}」`);
    } catch (error) {
      warn(`补发失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      job.release();
    }
  }

  // --- 事件：轮次即将结束（空回合） ---------------------------------------

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    let cfg = liveConfig();
    if (!cfg.enabled || signal?.aborted || !agent || turn === undefined) return;
    const job = reserveContinue(agent, turn, false, signal);
    if (!job) return;
    try {
      if (!canContinue(job, cfg)) return;
      const events = readEvents(agent.session);
      // 错误结束在 turn/end 统一处理，避免同一故障补发两次。
      if (turnErrors.has(job.key)) return;
      const flags = { aborted: false, modelError: false };
      const decision = decideContinue(analyzeTurn(events, turn), flags, cfg);
      if (!decision.continue) return;
      const probeAt = turnProbe.get(job.key);
      if (probeAt !== undefined && events.length <= probeAt) {
        turnSpent.set(job.key, cfg.maxContinuePerTurn);
        warn(`第 ${turn} 轮上一次补发没有产生新内容，停止补发`);
        return;
      }
      if (!await waitFor(cfg.continueCooldownMs, job.controller.signal)) return;
      const createUserMessage = await getCreateUserMessage();
      cfg = liveConfig();
      if (!canContinue(job, cfg)
        || !decideContinue(analyzeTurn(readEvents(agent.session), turn), flags, cfg).continue) return;
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: cfg.steerText }], source: { kind: `plugin:${name}` },
      }));
      const used = (turnSpent.get(job.key) ?? 0) + 1;
      turnSpent.set(job.key, used);
      turnProbe.set(job.key, events.length);
      sessionBudget(agent.id).count += 1;
      noteAction('continue', { sessionId: agent.id, turn, why: decision.why });
      if (cfg.notifyContinue) void appendNotice(agent, `↻ ${decision.why}，已自动补发「${cfg.steerText}」`);
      log(`会话 ${agent.id} 第 ${turn} 轮命中 ${decision.why}，第 ${used} 次补发`);
    } catch (error) {
      warn(`补发失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      job.release();
    }
  });

  // --- HTTP 路由（给指示灯与设置页） --------------------------------------

  function stateView() {
    const cfg = liveConfig();
    return {
      ok: true,
      enabled: cfg.enabled === true,
      steerText: cfg.steerText,
      fallbacks: Array.isArray(cfg.fallbacks) ? cfg.fallbacks : [],
      circuit: breaker.snapshot(),
      stats: {
        continues: stats.continues,
        fallbacks: stats.fallbacks,
        lastAction: stats.lastAction,
      },
      config: {
        maxContinuePerTurn: cfg.maxContinuePerTurn,
        maxContinuePerSession: cfg.maxContinuePerSession,
        continueOnEmptyTurn: cfg.continueOnEmptyTurn,
        continueOnMaxTokens: cfg.continueOnMaxTokens,
        continueOnModelError: cfg.continueOnModelError,
        continueOnAbort: cfg.continueOnAbort,
        continueCooldownMs: cfg.continueCooldownMs,
        minReasoningChars: cfg.minReasoningChars,
        tripCodes: cfg.tripCodes,
        modelCircuitThreshold: cfg.modelCircuitThreshold,
        modelCooldownMs: cfg.modelCooldownMs,
        platformCircuitThreshold: cfg.platformCircuitThreshold,
        platformCooldownMs: cfg.platformCooldownMs,
        burstWindowMs: cfg.burstWindowMs,
        enableProbe: cfg.enableProbe,
        probeMaxTokens: cfg.probeMaxTokens,
        probeTimeoutMs: cfg.probeTimeoutMs,
        stripReasoningEffort: cfg.stripReasoningEffort,
        notifySwitch: cfg.notifySwitch,
        notifyContinue: cfg.notifyContinue,
      },
    };
  }

  /**
   * 备用模型清单：把「宿主能枚举到的」和「profile 里声明过的」合成一份。
   *
   * 三个来源，缺一个都可能让用户在下拉里看不到自己配过的模型：
   *   1. llm.listConfigurableProviders() —— 声明过但可能还没激活的供应商；
   *   2. llm.listProviders()            —— 已经挂上适配器的供应商；
   *   3. configEditor 里各 llm-* 插件的 config.providers —— 用户手写在 cordis.patch.yml
   *      里的模型定义（接口枚举不到时这是唯一的兜底）。
   */
  async function catalogGroups(ctx) {
    const groups = new Map();

    const ensure = (provider, name, source) => {
      const id = String(provider ?? '').trim();
      if (id === '') return null;
      let group = groups.get(id);
      if (group === undefined) {
        group = { provider: id, name: '', sources: [], models: new Map() };
        groups.set(id, group);
      }
      if (name !== undefined && name !== '' && group.name === '') group.name = String(name);
      if (source !== undefined && !group.sources.includes(source)) group.sources.push(source);
      return group;
    };

    const addModel = (group, id, name, source) => {
      if (group === null) return;
      const key = String(id ?? '').trim();
      if (key === '') return;
      let row = group.models.get(key);
      if (row === undefined) {
        row = { id: key, name: '', sources: [] };
        group.models.set(key, row);
      }
      if (name !== undefined && name !== '' && row.name === '') row.name = String(name);
      if (source !== undefined && !row.sources.includes(source)) row.sources.push(source);
    };

    // 1) 声明过的可配置供应商
    try {
      for (const item of ctx.llm.listConfigurableProviders?.() ?? []) {
        ensure(item?.provider, item?.displayName, 'declared');
      }
    } catch {
      /* 老宿主没有这个方法，忽略 */
    }

    // 2) 已挂适配器的供应商
    try {
      for (const item of ctx.llm.listProviders?.() ?? []) {
        const id = typeof item === 'string' ? item : (item?.id ?? item?.provider ?? '');
        const name = typeof item === 'string' ? item : (item?.name ?? '');
        ensure(id, name, 'active');
      }
    } catch {
      /* 枚举失败就当没有 */
    }

    // 3) profile 里手写的模型定义
    try {
      const editor = ctx.get('configEditor');
      const rows = typeof editor?.configuration === 'function' ? editor.configuration() : [];
      for (const row of Array.isArray(rows) ? rows : []) {
        const name = String(row?.entry?.options?.name ?? '');
        if (!name.includes('llm')) continue;
        for (const layer of [row?.inherited, row?.override]) {
          const providers = layer?.providers;
          if (providers === null || typeof providers !== 'object') continue;
          for (const [provider, spec] of Object.entries(providers)) {
            const group = ensure(provider, spec?.displayName, 'profile');
            for (const model of Array.isArray(spec?.models) ? spec.models : []) {
              addModel(group, model?.id, model?.name, 'profile');
            }
          }
        }
      }
    } catch {
      /* 读不到 profile 就只靠接口枚举 */
    }

    // 4) 接口实盘枚举（最权威，覆盖前面的名字）
    for (const [provider, group] of groups) {
      let models = [];
      try {
        models = (await ctx.llm.listModels(provider)) ?? [];
      } catch {
        models = [];
      }
      for (const model of Array.isArray(models) ? models : []) {
        addModel(group, model?.id, model?.name, 'live');
      }
      if (group.name === '' && Array.isArray(models) && models.length > 0) {
        group.name = provider;
      }
    }

    return [...groups.values()]
      .map((group) => ({
        provider: group.provider,
        name: group.name === '' ? group.provider : group.name,
        sources: group.sources,
        models: [...group.models.values()]
          .map((row) => ({
            id: row.id,
            name: row.name === '' ? row.id : row.name,
            sources: row.sources,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      }))
      .filter((group) => group.models.length > 0 || group.sources.includes('declared'))
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }

  function buildRoutes() {
    return [
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/state`,
        handler: guarded(async (req, res) => {
          if (req.method === 'GET') {
            sendJson(res, 200, stateView());
            return;
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, code: 'method', message: '只支持 GET / POST' });
            return;
          }
          const body = await readJson(req, 4096);
          if (typeof body?.enabled !== 'boolean') {
            sendJson(res, 400, { ok: false, code: 'bad-request', message: '需要布尔值 enabled' });
            return;
          }
          if (!writeStateFile({ enabled: body.enabled })) {
            sendJson(res, 500, {
              ok: false,
              code: 'persist',
              message: '状态没写进磁盘，开关只在本进程有效',
            });
            return;
          }
          log(`守护已${body.enabled ? '开启' : '关闭'}`);
          sendJson(res, 200, stateView());
        }),
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/settings`,
        handler: guarded(async (req, res) => {
          if (req.method === 'GET') {
            sendJson(res, 200, stateView());
            return;
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, code: 'method', message: '只支持 GET / POST' });
            return;
          }
          const body = await readJson(req, 64 * 1024);
          const settings = sanitizeSettings(body?.settings);
          const fallbacks = sanitizeFallbacks(body?.fallbacks);
          const patch = {};
          if (Object.keys(settings).length > 0) {
            const stored = readStateFile();
            const held =
              stored?.settings !== null && typeof stored?.settings === 'object' ? stored.settings : {};
            patch.settings = { ...held, ...settings };
          }
          if (fallbacks !== undefined) patch.fallbacks = fallbacks;
          if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled;
          if (Object.keys(patch).length === 0) {
            sendJson(res, 400, { ok: false, code: 'bad-request', message: '没有可保存的字段' });
            return;
          }
          if (!writeStateFile(patch)) {
            sendJson(res, 500, { ok: false, code: 'persist', message: '配置没写进磁盘' });
            return;
          }
          log('设置已保存');
          sendJson(res, 200, stateView());
        }),
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/models`,
        handler: guarded(async (req, res) => {
          const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
          const only = (url.searchParams.get('provider') ?? '').trim();
          const groups = await catalogGroups(ctx);
          if (only !== '') {
            const hit = groups.find((item) => item.provider === only);
            sendJson(res, 200, { ok: true, provider: only, models: hit ? hit.models : [] });
            return;
          }
          sendJson(res, 200, { ok: true, providers: groups });
        }),
      },
    ];
  }

  ctx.inject(['webServer'], (webCtx) => {
    for (const route of buildRoutes()) {
      webCtx.effect(
        () => webCtx.webServer.register(route),
        `dsh-turn-continue: ${route.path}`,
      );
    }
  });

  ctx.effect(
    () => () => {
      lifetime.abort(new Error('dsh-turn-continue plugin disposed'));
      cancelContinues();
      sessions.clear();
      cancelProbes();
      probeRoutes.clear();
    },
    'dsh-turn-continue: cancel background work',
  );

  log(
    `已加载（守护${resolveConfig(config).enabled ? '开启' : '关闭'}，`
      + `备用路由 ${Array.isArray(config.fallbacks) ? config.fallbacks.length : 0} 个）`,
  );
}

/** 从 session 上取事件数组，兼容不同内核版本。 */
function readEvents(session) {
  if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents();
  if (session && Array.isArray(session.events)) return session.events;
  return [];
}
