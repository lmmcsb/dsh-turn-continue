/**
 * 两级断路器（模型级 + 平台级），纯状态机，时钟可注入，便于单测。
 * 所有时间戳都是注入时钟给出的 epoch 毫秒。
 * 开启探活时，冷却结束只允许探测；收到成功响应后才恢复正常路由。
 */

/** 一个 provider/model 路由的稳定 key。 */
export function modelKey(provider, model) {
  return `${provider}\u0000${model}`;
}

export class CircuitBreaker {
  models = new Map();
  providers = new Map();
  options;
  clock;

  constructor(options) {
    this.options = {
      modelCircuitThreshold: options.modelCircuitThreshold,
      modelCooldownMs: options.modelCooldownMs,
      platformCircuitThreshold: options.platformCircuitThreshold,
      platformCooldownMs: options.platformCooldownMs,
      burstWindowMs: options.burstWindowMs,
      requireProbeSuccess: options.requireProbeSuccess ?? false,
    };
    this.clock = options.now ?? Date.now;
  }

  /** 当前时钟读数，供调用方按同一个时钟排探测任务。 */
  now() {
    return this.clock();
  }

  /** 某条路由在任一层级是否处于打开状态。 */
  isOpen(provider, model) {
    const now = this.clock();
    return this.providerOpen(provider, now) || this.modelOpen(provider, model, now);
  }

  /** 某条模型路由的打开截止时间（关闭时为 0），用于排探测。 */
  openUntil(provider, model) {
    return Math.max(this.models.get(modelKey(provider, model))?.openUntil ?? 0, this.providers.get(provider) ?? 0);
  }

  /**
   * 选下一次请求该走的路由：健康的主路由 → 第一个健康的备用路由 →
   * 全部打开时回主路由（让真实失败暴露出来，而不是静默死掉）。
   */
  routeFor(primary, fallbacks) {
    if (!this.isOpen(primary.provider, primary.model)) return primary;
    for (const fallback of fallbacks) {
      if (!this.isOpen(fallback.provider, fallback.model)) return fallback;
    }
    return primary;
  }

  /**
   * 记一次失败。burstWindowMs 内的失败累加，超窗从 1 重新计。
   * 返回本次因此打开的熔断层（'model' | 'platform'），没打开则 undefined。
   */
  recordFailure(provider, model) {
    const now = this.clock();
    const key = modelKey(provider, model);
    const state = this.models.get(key) ?? { failures: 0, lastFailureAt: 0, openUntil: 0 };
    state.failures = now - state.lastFailureAt > this.options.burstWindowMs ? 1 : state.failures + 1;
    state.lastFailureAt = now;
    const modelWasOpen = this.modelOpen(provider, model, now);
    const platformWasOpen = this.providerOpen(provider, now);
    if (state.failures >= this.options.modelCircuitThreshold) {
      state.openUntil = Math.max(state.openUntil, now + this.options.modelCooldownMs);
      state.waitingProbe = true;
    }
    this.models.set(key, state);
    this.holdProvider(provider, now);
    if (!platformWasOpen && this.providerOpen(provider, now)) return 'platform';
    if (!modelWasOpen && this.modelOpen(provider, model, now)) return 'model';
    return undefined;
  }

  /** 成功模型解除隔离；其他故障模型保留，平台仍按阈值与冷却判断。 */
  recordProbeSuccess(provider, model) {
    this.models.delete(modelKey(provider, model));
    const now = this.clock();
    if ((this.providers.get(provider) ?? 0) <= now
      && this.openModelCount(provider, now) < this.options.platformCircuitThreshold) {
      this.providers.delete(provider);
    }
  }

  /** 探测失败：再开一个冷却周期。 */
  recordProbeFailure(provider, model) {
    const now = this.clock();
    const key = modelKey(provider, model);
    const state = this.models.get(key) ?? {
      failures: this.options.modelCircuitThreshold,
      lastFailureAt: now,
      openUntil: 0,
    };
    state.lastFailureAt = now;
    state.openUntil = Math.max(state.openUntil, now + this.options.modelCooldownMs);
    state.waitingProbe = true;
    this.models.set(key, state);
    this.holdProvider(provider, now);
  }

  /**
   * 立刻打开这条路由的熔断，不看阈值。
   * 用于「这一轮就是被模型错误打断的」——继续在同一路由上重试没有意义。
   */
  trip(provider, model) {
    const now = this.clock();
    const key = modelKey(provider, model);
    const state = this.models.get(key) ?? { failures: 0, lastFailureAt: 0, openUntil: 0 };
    state.failures = Math.max(state.failures, this.options.modelCircuitThreshold);
    state.lastFailureAt = now;
    state.openUntil = Math.max(state.openUntil, now + this.options.modelCooldownMs);
    state.waitingProbe = true;
    this.models.set(key, state);
    this.holdProvider(provider, now);
    return this.openUntil(provider, model);
  }

  holdProvider(provider, now) {
    if (this.openModelCount(provider, now) >= this.options.platformCircuitThreshold) {
      this.providers.set(provider, Math.max(this.providers.get(provider) ?? 0, now + this.options.platformCooldownMs));
    }
  }

  stateOpen(state, now) {
    return Boolean(state && (state.openUntil > now || (this.options.requireProbeSuccess && state.waitingProbe)));
  }

  modelOpen(provider, model, now) {
    return this.stateOpen(this.models.get(modelKey(provider, model)), now);
  }

  providerOpen(provider, now) {
    if ((this.providers.get(provider) ?? 0) > now) return true;
    return this.openModelCount(provider, now) >= this.options.platformCircuitThreshold;
  }

  openModelCount(provider, now) {
    const prefix = `${provider}\u0000`;
    let open = 0;
    for (const [key, state] of this.models) {
      if (key.startsWith(prefix) && this.stateOpen(state, now)) open += 1;
    }
    return open;
  }

  /** 给设置页看的一张快照：哪些路由正开着、还剩多久。 */
  snapshot() {
    const now = this.clock();
    const routes = [];
    for (const [key, state] of this.models) {
      if (!this.stateOpen(state, now)) continue;
      const at = key.indexOf('\u0000');
      routes.push({
        provider: key.slice(0, at),
        model: key.slice(at + 1),
        until: state.openUntil,
        remainingMs: Math.max(0, state.openUntil - now),
        waitingProbe: Boolean(this.options.requireProbeSuccess && state.waitingProbe),
      });
    }
    const providers = [];
    for (const [provider, until] of this.providers) {
      if (until <= now) continue;
      providers.push({ provider, until, remainingMs: until - now });
    }
    return { routes, providers, at: now };
  }
}
