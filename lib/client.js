/**
 * dsh-turn-continue — Client 半部。
 *
 * 两处界面：
 *   1. `conversation.input.left`：输入框工具行左侧的指示灯胶囊（对标 Computer Use）。
 *      绿灯=守护开启，灰灯=已关闭，黄灯=开关读写失败。点一下切换。
 *   2. `settings.section`：设置页里的完整配置面板。
 *
 * 三条纪律（与 dsh-windows-mcp 一致）：
 *   - 绝不弄坏 composer：任何异常都 fail-open 渲染成 off，不抛。
 *   - 绝不谎报状态：胶囊显示宿主真实答案，写失败要回滚并在 tooltip 说明。
 *   - 只用主题 token（--dsw-*）上色，不写死 hex。
 *
 * 注意：不要写「已注册就跳过」的幂等守卫 —— HMR 会让新 factory 永远注册不上。
 */

;(function () {
  window.__ModuleLoader__.load({
    id: 'dsh-turn-continue',
    factory: (require) => {
      const module = { exports: {} };

      const React = require('react');
      const h = React.createElement;
      const { useState, useEffect, useCallback, useRef, useMemo } = React;

      const NS = 'dsh-turn-continue';
      const API = '/api/dsh-turn-continue';
      const PILL_SLOT = 'conversation.input.left';
      const PILL_ID = 'turn-continue-indicator';
      const PILL_ORDER = 26;
      const SETTINGS_SLOT = 'settings.section';
      const SETTINGS_ID = 'turn-continue-settings';
      const SETTINGS_ORDER = 66;
      const STYLE_ID = 'dsh-turn-continue-styles';
      const LABEL = '会话守护';

      let hostCtx = null;

      // ---------------------------------------------------------------------
      // 样式
      // ---------------------------------------------------------------------

      const CSS = `
.dsg-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 7px 0 5px;
  border: none;
  background: none;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  border-radius: 6px;
  transition: color .15s ease;
}
.dsg-pill:hover { color: var(--dsw-alias-label-primary); }
.dsg-pill:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent);
  outline-offset: 1px;
}
.dsg-pill[data-busy='1'] { opacity: .65; cursor: progress; }
.dsg-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  flex: none;
  background: var(--dsw-alias-state-idle-primary);
  transition: background-color .18s ease, box-shadow .18s ease;
}
.dsg-pill[data-state='on'] .dsg-dot {
  background: var(--dsw-alias-state-success-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 22%, transparent);
}
.dsg-pill[data-state='warn'] .dsg-dot {
  background: var(--dsw-alias-state-warn-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 22%, transparent);
}
.dsg-count {
  font-variant-numeric: tabular-nums;
  opacity: .7;
}
@media (max-width: 860px) {
  .dsg-label { display: none; }
  .dsg-pill { padding: 0 5px; }
}
@media (prefers-reduced-motion: reduce) {
  .dsg-pill, .dsg-dot { transition: none; }
}

.dsg-set {
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 760px;
}
.dsg-set-head { display: flex; flex-direction: column; gap: 6px; }
.dsg-set-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsg-set-desc { font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dsg-card {
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dsg-card-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsg-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
}
.dsg-field-text { display: flex; flex-direction: column; gap: 2px; min-width: 180px; flex: 1; }
.dsg-field-hint { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.dsg-input, .dsg-select {
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  padding: 5px 8px;
  min-width: 120px;
  font-family: inherit;
}
.dsg-input:focus, .dsg-select:focus {
  outline: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, transparent);
  outline-offset: 0;
}
.dsg-input[data-num='1'] { width: 110px; min-width: 0; text-align: right; }
.dsg-btn {
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  border-radius: 8px;
  padding: 5px 12px;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
}
.dsg-btn:hover { border-color: var(--dsw-alias-border-l2); }
.dsg-btn[data-primary='1'] {
  background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-on-brand, #fff);
}
.dsg-btn[data-danger='1'] { color: var(--dsw-alias-state-error-primary); }
.dsg-btn:disabled { opacity: .5; cursor: not-allowed; }
.dsg-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsg-fb {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border: 1px dashed var(--dsw-alias-border-l1);
  border-radius: 8px;
}
.dsg-fb-idx {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  min-width: 18px;
  font-variant-numeric: tabular-nums;
}
.dsg-fb-id {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  margin-left: auto;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsg-fb .dsg-select[data-role='provider'] { min-width: 190px; max-width: 240px; }
.dsg-fb .dsg-select[data-role='model'] { min-width: 190px; max-width: 260px; }
.dsg-empty { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsg-note {
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
  border-left: 2px solid var(--dsw-alias-border-l1);
  padding-left: 10px;
}
.dsg-status {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  min-height: 16px;
}
.dsg-status[data-kind='error'] { color: var(--dsw-alias-state-error-primary); }
.dsg-status[data-kind='ok'] { color: var(--dsw-alias-state-success-primary); }
.dsg-toggle {
  position: relative;
  width: 38px;
  height: 22px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  cursor: pointer;
  padding: 0;
  flex: none;
  transition: background-color .16s ease, border-color .16s ease;
}
.dsg-toggle::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 999px;
  background: var(--dsw-alias-label-secondary);
  transition: transform .16s ease, background-color .16s ease;
}
.dsg-toggle[data-on='1'] {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 22%, transparent);
  border-color: var(--dsw-alias-state-success-primary);
}
.dsg-toggle[data-on='1']::after {
  transform: translateX(16px);
  background: var(--dsw-alias-state-success-primary);
}
.dsg-toggle:disabled { opacity: .5; cursor: progress; }
`;

      function installStyles() {
        try {
          if (document.getElementById(STYLE_ID) !== null) return;
          const el = document.createElement('style');
          el.id = STYLE_ID;
          el.textContent = CSS;
          document.head.appendChild(el);
        } catch {
          // 样式挂了也不能影响 composer 渲染。
        }
      }

      // ---------------------------------------------------------------------
      // HTTP
      // ---------------------------------------------------------------------

      /**
       * 宿主不用 path routing，锚点必须是 document.baseURI；
       * 同时保留 query string —— 只取 pathname 会把 ?all=1 丢掉。
       */
      function apiUrl(path) {
        try {
          const raw = String(path);
          let i = 0;
          while (i < raw.length && raw[i] === '/') i += 1;
          const url = new URL(raw.slice(i), document.baseURI);
          return url.pathname + url.search;
        } catch {
          return String(path);
        }
      }

      async function requestJson(path, payload) {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 15000);
        try {
          const res = await fetch(apiUrl(path), {
            method: payload === undefined ? 'GET' : 'POST',
            cache: 'no-store',
            signal: controller.signal,
            headers: payload === undefined
              ? { accept: 'application/json' }
              : { 'content-type': 'application/json', accept: 'application/json' },
            ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
          });
          const body = await res.json().catch(() => null);
          if (!res.ok || body?.ok !== true) throw new Error(body?.message ?? `HTTP ${res.status}：响应无效`);
          return body;
        } catch (error) {
          if (controller.signal.aborted) throw new Error('请求超时，请重新读取状态');
          throw error;
        } finally {
          window.clearTimeout(timer);
        }
      }

      const getJson = (path) => requestJson(path);
      const postJson = (path, payload) => requestJson(path, payload);

      // ---------------------------------------------------------------------
      // 共享状态：胶囊与设置页读同一份宿主答案
      // ---------------------------------------------------------------------

      let guardView = { phase: 'loading', enabled: false, busy: false, error: null, data: null };
      const guardSubscribers = new Map();
      let guardRevision = 0;
      let guardRead = null;
      let guardWriting = false;
      let guardTimer = null;

      function publishGuard(view) {
        guardView = view;
        for (const listener of guardSubscribers.keys()) listener(view);
      }

      function commitGuard(body) {
        publishGuard({ phase: 'ready', enabled: body.enabled === true, busy: false, error: null, data: body });
      }

      function reloadGuard() {
        if (guardWriting) return Promise.resolve(null);
        if (guardRead) return guardRead;
        const revision = ++guardRevision;
        const pending = getJson(`${API}/state`)
          .then((body) => {
            if (revision !== guardRevision) return null;
            commitGuard(body);
            return body;
          })
          .catch((error) => {
            if (revision === guardRevision) publishGuard({ ...guardView, phase: 'error', error: error instanceof Error ? error.message : String(error) });
            return null;
          })
          .finally(() => { if (guardRead === pending) guardRead = null; });
        guardRead = pending;
        return pending;
      }

      async function writeGuard(path, payload) {
        if (guardWriting) throw new Error('另一项设置正在保存，请稍后再试');
        guardWriting = true;
        guardRevision += 1;
        guardRead = null;
        publishGuard({ ...guardView, busy: true, error: null });
        try {
          const body = await postJson(path, payload);
          guardWriting = false;
          commitGuard(body);
          return body;
        } catch (error) {
          guardWriting = false;
          publishGuard({ ...guardView, phase: 'error', busy: false, error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      }

      function syncGuardPolling() {
        const poll = [...guardSubscribers.values()].some(Boolean);
        if (poll && guardTimer === null) {
          guardTimer = window.setInterval(() => void reloadGuard(), 5000);
          window.addEventListener('focus', reloadGuard);
        } else if (!poll && guardTimer !== null) {
          window.clearInterval(guardTimer);
          guardTimer = null;
          window.removeEventListener('focus', reloadGuard);
        }
      }

      async function setGuardEnabled(next) {
        try { await writeGuard(`${API}/state`, { enabled: next }); return true; }
        catch { return false; }
      }

      const saveGuardSettings = (payload) => writeGuard(`${API}/settings`, payload);

      function useGuardState(options) {
        const poll = options?.poll !== false;
        const [view, setView] = useState(guardView);
        useEffect(() => {
          const first = guardSubscribers.size === 0;
          guardSubscribers.set(setView, poll);
          setView(guardView);
          syncGuardPolling();
          if (first) void reloadGuard();
          return () => {
            guardSubscribers.delete(setView);
            syncGuardPolling();
          };
        }, [poll]);
        return { view, reload: reloadGuard, setEnabled: setGuardEnabled, saveSettings: saveGuardSettings };
      }

      // ---------------------------------------------------------------------
      // 指示灯胶囊
      // ---------------------------------------------------------------------

      function tooltipFor(view) {
        if (view.phase === 'loading') return '会话守护：正在读取状态…';
        if (view.phase === 'error') {
          return `会话守护：读取失败（${view.error ?? '未知原因'}）。点击重试 / click to retry`;
        }
        const continues = view.data?.stats?.continues ?? 0;
        const fallbacks = view.data?.stats?.fallbacks ?? 0;
        const lines = [];
        if (view.enabled) {
          lines.push('会话守护：已开启');
          lines.push('空回合、输出截断或指定模型错误中断时自动补「继续」；有健康备用模型时先切换。此开关对所有会话生效。');
        } else {
          lines.push('会话守护：已关闭');
          lines.push('关闭后不再自动补「继续」，也不做模型熔断切换。');
        }
        if (continues > 0 || fallbacks > 0) {
          lines.push(`本次进程：自动续跑 ${continues} 次，模型切换 ${fallbacks} 次。`);
        }
        lines.push('点击切换 / click to toggle');
        return lines.join('\n');
      }

      function GuardPill() {
        const { view, reload, setEnabled } = useGuardState({ poll: true });
        const state =
          view.phase === 'error' ? 'warn' : view.enabled ? 'on' : 'off';
        const onClick = () => {
          if (view.phase === 'error') {
            void reload();
            return;
          }
          if (view.busy) return;
          void setEnabled(!view.enabled);
        };
        const continues = view.data?.stats?.continues ?? 0;
        return h(
          'button',
          {
            type: 'button',
            className: 'dsg-pill',
            'data-state': state,
            'data-busy': view.busy ? '1' : '0',
            title: tooltipFor(view),
            'aria-label': `会话守护${view.enabled ? '已开启' : '已关闭'}`,
            'aria-pressed': view.enabled ? 'true' : 'false',
            onClick,
          },
          h('span', { className: 'dsg-dot', 'aria-hidden': 'true' }),
          h('span', { className: 'dsg-label' }, LABEL),
          continues > 0
            ? h('span', { className: 'dsg-count' }, `+${continues}`)
            : null,
        );
      }

      function registerPill(ctx) {
        try {
          ctx.slots.inject(PILL_SLOT, () =>
            ctx.slots.register(
              {
                name: PILL_SLOT,
                id: PILL_ID,
                order: PILL_ORDER,
                label: () => LABEL,
                inject: (sessionId) => ({ sessionId }),
              },
              function SessionGuardPill() {
                return h(GuardPill, null);
              },
            ),
          );
        } catch (error) {
          console.error('[turn-continue] 注册指示灯失败', error);
        }
      }

      // ---------------------------------------------------------------------
      // 设置页
      // ---------------------------------------------------------------------

      const NUMERIC_FIELDS = [
        {
          key: 'maxContinuePerTurn',
          label: '单轮最多续跑',
          hint: '同一轮里最多补几次「继续」，防止原地打转。',
          min: 0,
          max: 20,
        },
        {
          key: 'maxContinuePerSession',
          label: '单会话上限（十分钟）',
          hint: '一个会话在十分钟窗口内最多续跑几次。',
          min: 0,
          max: 500,
        },
        {
          key: 'minReasoningChars',
          label: '空回合判定门槛',
          hint: '思考字数低于这个值就认为模型本来没打算说话，不补发。',
          min: 0,
          max: 4000,
        },
        {
          key: 'continueCooldownMs',
          label: '补发间隔（毫秒）',
          hint: '两次补发之间至少等这么久。',
          min: 0,
          max: 60000,
        },
        {
          key: 'modelCircuitThreshold',
          label: '模型熔断阈值',
          hint: '同一个模型连续失败几次就熔断。',
          min: 1,
          max: 20,
        },
        {
          key: 'modelCooldownMs',
          label: '模型冷却（毫秒）',
          hint: '熔断后多久开始探活。',
          min: 0,
          max: 3600000,
        },
        {
          key: 'platformCircuitThreshold',
          label: '平台熔断阈值',
          hint: '同一供应商下有几个模型熔断，就把整个供应商判为不可用。',
          min: 1,
          max: 50,
        },
        {
          key: 'platformCooldownMs',
          label: '平台冷却（毫秒）',
          hint: '整个平台至少等待这么久，再按探活结果恢复。',
          min: 0,
          max: 3600000,
        },
        {
          key: 'probeMaxTokens',
          label: '探活输出上限',
          hint: '探活只发一个 ping，输出上限越小越省。',
          min: 1,
          max: 64,
        },
        {
          key: 'probeTimeoutMs',
          label: '探活超时（毫秒）',
          hint: '单次探活最多等待这么久，超时后结束本次等待。',
          min: 1000,
          max: 120000,
        },
      ];

      const BOOLEAN_FIELDS = [
        { key: 'continueOnEmptyTurn', label: '空回合自动续跑', hint: '只思考、没有正文也没有工具调用时补「继续」。' },
        { key: 'continueOnMaxTokens', label: '输出截断自动续跑', hint: '单次输出达到 token 上限时补「继续」；这不代表账户余额或套餐额度用尽。' },
        { key: 'continueOnModelError', label: '模型报错自动续跑', hint: '模型报错中断时，先切备用模型再补「继续」。' },
        { key: 'continueOnAbort', label: '手动停止后也续跑', hint: '默认关闭：你按停止就是不想让它继续。' },
        { key: 'enableProbe', label: '冷却后自动探活', hint: '冷却后发送会计费的小请求，成功后解除熔断；关闭总开关或探活开关会取消待执行和在途探活。' },
        { key: 'stripReasoningEffort', label: '切换时重置思考强度', hint: '备用模型不一定支持同样的思考档位，默认清空。' },
        { key: 'notifySwitch', label: '切换时写入会话', hint: '在会话里留一条可见说明，方便回看。' },
        { key: 'notifyContinue', label: '续跑时写入会话', hint: '每次补「继续」都留一条可见说明。' },
      ];

      function Toggle(props) {
        return h('button', {
          type: 'button',
          className: 'dsg-toggle',
          'data-on': props.on ? '1' : '0',
          'aria-pressed': props.on ? 'true' : 'false',
          'aria-label': props.label,
          disabled: props.disabled === true,
          onClick: () => props.onChange(!props.on),
        });
      }

      function Field(props) {
        return h(
          'div',
          { className: 'dsg-field' },
          h(
            'div',
            { className: 'dsg-field-text' },
            h('span', null, props.label),
            props.hint ? h('span', { className: 'dsg-field-hint' }, props.hint) : null,
          ),
          props.children,
        );
      }

      /**
       * 备用路由编辑器：先选供应商，再选这个供应商下的模型，跟 Hermes 的备用模型一个路子。
       *
       * 供应商清单由 Host 侧合成（声明过的 + 已激活的 + profile 里手写的），
       * 所以即使某个渠道当前枚举不出模型，用户配过的那些也不会从下拉里消失。
       */
      function FallbackEditor(props) {
        const [catalog, setCatalog] = useState({ phase: 'loading', groups: [] });
        const [retry, setRetry] = useState(0);
        const list = props.value;

        useEffect(() => {
          let alive = true;
          setCatalog((previous) => ({ ...previous, phase: 'loading' }));
          void getJson(`${API}/models`)
            .then((body) => {
              if (!alive) return;
              const groups = (Array.isArray(body?.providers) ? body.providers : [])
                .map((item) => ({
                  provider: String(item?.provider ?? ''),
                  name: String(item?.name ?? item?.provider ?? ''),
                  models: (Array.isArray(item?.models) ? item.models : [])
                    .map((model) => ({ id: String(model?.id ?? ''), name: String(model?.name ?? model?.id ?? '') }))
                    .filter((model) => model.id !== ''),
                }))
                .filter((group) => group.provider !== '' && group.models.length > 0);
              setCatalog({ phase: 'ready', groups });
            })
            .catch(() => {
              if (alive) setCatalog({ phase: 'error', groups: [] });
            });
          return () => {
            alive = false;
          };
        }, [retry, props.reloadKey]);

        const groupOf = (provider) => catalog.groups.find((group) => group.provider === provider);
        const modelsOf = (provider) => {
          const group = groupOf(provider);
          return group === undefined ? [] : group.models;
        };

        const update = (index, patch) => {
          const next = list.map((item, i) => (i === index ? { ...item, ...patch } : item));
          props.onChange(next);
        };

        const remove = (index) => {
          props.onChange(list.filter((_, i) => i !== index));
        };

        const add = () => {
          if (list.length >= 8) return;
          const first = catalog.groups[0];
          const model = first === undefined ? undefined : first.models[0];
          props.onChange([
            ...list,
            first === undefined
              ? { provider: '', model: '' }
              : { provider: first.provider, model: model === undefined ? '' : model.id },
          ]);
        };

        const empty = catalog.phase === 'ready' && catalog.groups.length === 0;

        return h(
          'div',
          { className: 'dsg-card' },
          h('div', { className: 'dsg-card-title' }, '备用模型'),
          h(
            'div',
            { className: 'dsg-field-hint' },
            '主模型连续失败时，按顺序取第一个健康的备用路由；全都不健康就留在主模型继续试。'
              + '先选供应商，再选它下面的模型。',
          ),
          catalog.phase === 'loading' ? h('div', { className: 'dsg-empty' }, '正在读取可用模型…') : null,
          catalog.phase === 'error'
            ? h('div', { className: 'dsg-row' },
                h('span', { className: 'dsg-empty' }, '模型清单读取失败，已保存的选择会保留。'),
                h('button', { type: 'button', className: 'dsg-btn', onClick: () => setRetry((value) => value + 1) }, '重试读取模型'))
            : null,
          empty
            ? h(
              'div',
              { className: 'dsg-empty' },
              '模型设置里还没有配置任何供应商，先去「设置 → 模型」加一个。',
            )
            : null,
          list.length === 0
            ? h(
              'div',
              { className: 'dsg-empty' },
              '还没配置备用模型。主模型熔断后只会自动补「继续」，不会换路由。',
            )
            : null,
          ...list.map((item, index) => {
            const models = modelsOf(item.provider);
            const group = groupOf(item.provider);
            const providerKnown = group !== undefined;
            const modelKnown = models.some((model) => model.id === item.model);
            return h(
              'div',
              { className: 'dsg-fb', key: `fb-${index}` },
              h('span', { className: 'dsg-fb-idx' }, String(index + 1)),
              h(
                'select',
                {
                  className: 'dsg-select',
                  'data-role': 'provider',
                  value: item.provider,
                  onChange: (event) => {
                    const provider = String(event.target.value);
                    const pool = modelsOf(provider);
                    update(index, { provider, model: pool.length === 0 ? '' : pool[0].id });
                  },
                },
                h('option', { value: '' }, '选择供应商'),
                ...catalog.groups.map((option) =>
                  h('option', { value: option.provider, key: `p-${option.provider}` }, option.name),
                ),
                providerKnown || item.provider === ''
                  ? null
                  : h('option', { value: item.provider, key: 'p-custom' }, `${item.provider}（当前不在清单）`),
              ),
              h(
                'select',
                {
                  className: 'dsg-select',
                  'data-role': 'model',
                  value: item.model,
                  disabled: !providerKnown,
                  onChange: (event) => update(index, { model: String(event.target.value) }),
                },
                h('option', { value: '' }, providerKnown ? '选择模型' : '先选供应商'),
                ...models.map((option) =>
                  h('option', { value: option.id, key: `m-${option.id}` }, option.name),
                ),
                modelKnown || item.model === ''
                  ? null
                  : h('option', { value: item.model, key: 'm-custom' }, `${item.model}（当前不可枚举）`),
              ),
              h(
                'span',
                { className: 'dsg-fb-id' },
                item.provider === '' ? '' : `${item.provider} / ${item.model}`,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsg-btn',
                  'data-danger': '1',
                  onClick: () => remove(index),
                },
                '移除',
              ),
            );
          }),
          h(
            'div',
            { className: 'dsg-row' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsg-btn',
                onClick: add,
                disabled: list.length >= 8 || catalog.groups.length === 0,
              },
              '添加备用模型',
            ),
          ),
        );
      }

      function SettingsPage() {
        const { view, reload, setEnabled, saveSettings } = useGuardState({ poll: false });
        const [draft, setDraft] = useState(null);
        const [fallbacks, setFallbacks] = useState([]);
        const [steerText, setSteerText] = useState('继续');
        const [status, setStatus] = useState({ kind: 'idle', text: '' });
        const [saving, setSaving] = useState(false);
        const hydrated = useRef(false);
        const currentForm = useRef(null);
        currentForm.current = { draft, fallbacks, steerText };
        const [catalogVersion, setCatalogVersion] = useState(0);
        const hydrate = useCallback((body) => {
          if (!body) return;
          hydrated.current = true;
          setDraft({ ...(body.config ?? {}) });
          setFallbacks(Array.isArray(body.fallbacks) ? body.fallbacks : []);
          setSteerText(typeof body.steerText === 'string' ? body.steerText : '继续');
        }, []);

        // 每次进入等待新读回，避免共享缓存覆盖用户在其他页面保存的设置。
        useEffect(() => {
          let alive = true;
          void reload().then((body) => { if (alive && body) hydrate(body); });
          return () => { alive = false; };
        }, [reload, hydrate]);
        // 初次请求失败后，重试成功仍能填入草稿；轮询不覆盖正在编辑的内容。
        useEffect(() => {
          if (!hydrated.current && view.phase === 'ready' && !view.busy && !guardWriting && !guardRead) hydrate(view.data);
        }, [view, hydrate]);

        const reloadForm = useCallback(async () => {
          const started = JSON.stringify(currentForm.current);
          const body = await reload();
          if (!body) return;
          const unchanged = JSON.stringify(currentForm.current) === started;
          if (unchanged) hydrate(body);
          setCatalogVersion((value) => value + 1);
          setStatus({ kind: 'ok', text: unchanged ? '已重新读取已保存的设置。' : '已读取宿主状态；读取期间的新修改尚未保存，已保留。' });
        }, [reload, hydrate]);

        const save = useCallback(async () => {
          if (draft === null) return;
          setSaving(true);
          setStatus({ kind: 'idle', text: '保存中…' });
          const submitted = JSON.stringify({ draft, fallbacks, steerText });
          try {
            const body = await saveSettings({ settings: { ...draft, steerText }, fallbacks });
            const unchanged = JSON.stringify(currentForm.current) === submitted;
            if (unchanged) hydrate(body);
            setStatus({ kind: 'ok', text: unchanged ? '已保存，立即生效。' : '上一版已保存；保存期间的新修改尚未保存。' });
          } catch (error) {
            setStatus({
              kind: 'error',
              text: `保存失败：${error instanceof Error ? error.message : String(error)}`,
            });
          } finally {
            setSaving(false);
          }
        }, [draft, fallbacks, steerText, saveSettings, hydrate]);

        if (view.phase === 'loading' || (view.phase === 'ready' && draft === null)) {
          return h('div', { className: 'dsg-set' }, h('div', { className: 'dsg-status' }, '读取配置…'));
        }
        if (view.phase === 'error') {
          return h(
            'div',
            { className: 'dsg-set' },
            h('div', { className: 'dsg-status', 'data-kind': 'error' }, `读取失败：${view.error}`),
            h(
              'div',
              { className: 'dsg-row' },
              h('button', { type: 'button', className: 'dsg-btn', onClick: () => void reload() }, '重试'),
            ),
          );
        }

        const config = draft ?? view.data?.config ?? {};
        const stats = view.data?.stats ?? {};
        const circuit = view.data?.circuit ?? {};
        const openRoutes = Array.isArray(circuit.routes) ? circuit.routes : [];

        return h(
          'div',
          { className: 'dsg-set' },
          h(
            'div',
            { className: 'dsg-set-head' },
            h('div', { className: 'dsg-set-title' }, '会话守护'),
            h(
              'div',
              { className: 'dsg-set-desc' },
              '在空回合、输出截断或指定模型错误后自动补「继续」，有可用备用模型时先切换。根据回合事件判断，不判断任务是否真正完成。',
            ),
          ),

          h(
            'div',
            { className: 'dsg-card' },
            h('div', { className: 'dsg-card-title' }, '总开关'),
            h(
              Field,
              { label: '启用会话守护', hint: '关闭后既不自动续跑，也不做模型熔断切换。' },
              h(Toggle, {
                on: view.enabled,
                label: '启用会话守护',
                disabled: view.busy,
                onChange: (next) => void setEnabled(next),
              }),
            ),
            h(
              Field,
              { label: '补发内容', hint: '自动发出去的那句话。' },
              h('input', {
                className: 'dsg-input',
                value: steerText,
                maxLength: 200,
                onChange: (event) => setSteerText(event.target.value),
              }),
            ),
          ),

          h(
            'div',
            { className: 'dsg-card' },
            h('div', { className: 'dsg-card-title' }, '什么时候补「继续」'),
            ...BOOLEAN_FIELDS.slice(0, 4).map((item) =>
              h(
                Field,
                { key: item.key, label: item.label, hint: item.hint },
                h(Toggle, {
                  on: config[item.key] === true,
                  label: item.label,
                  onChange: (next) => setDraft({ ...config, [item.key]: next }),
                }),
              ),
            ),
            ...NUMERIC_FIELDS.slice(0, 4).map((item) =>
              h(
                Field,
                { key: item.key, label: item.label, hint: item.hint },
                h('input', {
                  className: 'dsg-input',
                  'data-num': '1',
                  type: 'number',
                  min: item.min,
                  max: item.max,
                  value: config[item.key] ?? 0,
                  onChange: (event) => {
                    const raw = Number(event.target.value);
                    if (!Number.isFinite(raw)) return;
                    const clamped = Math.min(item.max, Math.max(item.min, Math.round(raw)));
                    setDraft({ ...config, [item.key]: clamped });
                  },
                }),
              ),
            ),
          ),

          h(FallbackEditor, { value: fallbacks, onChange: setFallbacks, reloadKey: catalogVersion }),

          h(
            'div',
            { className: 'dsg-card' },
            h('div', { className: 'dsg-card-title' }, '熔断与恢复'),
            ...NUMERIC_FIELDS.slice(4).map((item) =>
              h(
                Field,
                { key: item.key, label: item.label, hint: item.hint },
                h('input', {
                  className: 'dsg-input',
                  'data-num': '1',
                  type: 'number',
                  min: item.min,
                  max: item.max,
                  value: config[item.key] ?? 0,
                  onChange: (event) => {
                    const raw = Number(event.target.value);
                    if (!Number.isFinite(raw)) return;
                    const clamped = Math.min(item.max, Math.max(item.min, Math.round(raw)));
                    setDraft({ ...config, [item.key]: clamped });
                  },
                }),
              ),
            ),
            ...BOOLEAN_FIELDS.slice(4).map((item) =>
              h(
                Field,
                { key: item.key, label: item.label, hint: item.hint },
                h(Toggle, {
                  on: config[item.key] === true,
                  label: item.label,
                  onChange: (next) => setDraft({ ...config, [item.key]: next }),
                }),
              ),
            ),
            h(
              'div',
              { className: 'dsg-note' },
              '触发熔断的失败码：',
              Array.isArray(config.tripCodes) ? config.tripCodes.join('、') : '—',
            ),
          ),

          h(
            'div',
            { className: 'dsg-card' },
            h('div', { className: 'dsg-card-title' }, '运行状态'),
            h(
              'div',
              { className: 'dsg-field-hint' },
              `本次进程：自动续跑 ${stats.continues ?? 0} 次，模型切换 ${stats.fallbacks ?? 0} 次。`,
            ),
            openRoutes.length === 0
              ? h('div', { className: 'dsg-empty' }, '当前没有处于熔断状态的路由。')
              : h(
                  'div',
                  { className: 'dsg-field-hint' },
                  '熔断中：',
                  openRoutes
                    .map((route) => `${route.provider}/${route.model}（还剩 ${Math.max(0, Math.round((route.remainingMs ?? 0) / 1000))} 秒）`)
                    .join('；'),
                ),
            stats.lastAction
              ? h(
                  'div',
                  { className: 'dsg-field-hint' },
                  `最近一次：${
                    stats.lastAction.kind === 'continue'
                      ? '自动续跑'
                      : stats.lastAction.kind === 'halt'
                        ? '已停止续跑（无可用备用模型）'
                        : '模型切换'
                  }（${stats.lastAction.at ?? ''}）`,
                )
              : null,
          ),

          h(
            'div',
            { className: 'dsg-row' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsg-btn',
                'data-primary': '1',
                disabled: saving || draft === null,
                onClick: () => void save(),
              },
              saving ? '保存中…' : '保存设置',
            ),
            h(
              'button',
              { type: 'button', className: 'dsg-btn', disabled: saving || view.busy, onClick: () => void reloadForm() },
              '重新读取',
            ),
          ),
          h('div', { className: 'dsg-status', 'data-kind': status.kind }, status.text),
        );
      }

      function registerSettings(ctx) {
        try {
          ctx.slots.inject(SETTINGS_SLOT, () =>
            ctx.slots.register(
              {
                name: SETTINGS_SLOT,
                id: SETTINGS_ID,
                order: SETTINGS_ORDER,
                label: () => LABEL,
              },
              function SessionGuardSettings() {
                return h(SettingsPage, null);
              },
            ),
          );
        } catch (error) {
          console.error('[turn-continue] 注册设置页失败', error);
        }
      }

      // ---------------------------------------------------------------------
      // 入口
      // ---------------------------------------------------------------------

      function apply(ctx) {
        hostCtx = ctx;
        installStyles();
        registerPill(ctx);
        registerSettings(ctx);
      }

      module.exports = {
        name: NS,
        inject: ['slots'],
        apply,
        __internals: {
          analyzeGuardState: (body) => body,
          LABEL,
          PILL_ID,
          SETTINGS_ID,
        },
      };
      return module.exports;
    },
  });
})();
