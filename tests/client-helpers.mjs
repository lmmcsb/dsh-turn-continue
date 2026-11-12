import fs from 'node:fs';
import vm from 'node:vm';

// Minimal deterministic hook renderer. Tests execute the unmodified client bundle;
// effects, request promises and component state are observable without a browser.
export function clientHarness(t, fetch) {
  let current;
  const components = new Map();
  const focus = new Set();
  const intervals = new Set();
  let exports;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat() } }),
    useState(init) {
      const r = current;
      const i = r.cursor++;
      if (!(i in r.hooks)) r.hooks[i] = typeof init === 'function' ? init() : init;
      return [r.hooks[i], (next) => {
        r.hooks[i] = typeof next === 'function' ? next(r.hooks[i]) : next;
        if (r.alive) r.render();
      }];
    },
    useRef(init) {
      const r = current;
      const i = r.cursor++;
      if (!(i in r.hooks)) r.hooks[i] = { current: init };
      return r.hooks[i];
    },
    useMemo(fn, deps) {
      const r = current;
      const i = r.cursor++;
      if (!same(r.hooks[i]?.deps, deps)) r.hooks[i] = { deps, value: fn() };
      return r.hooks[i].value;
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const r = current;
      const i = r.cursor++;
      if (same(r.hooks[i]?.deps, deps)) return;
      const old = r.hooks[i];
      r.hooks[i] = { deps, cleanup: old?.cleanup };
      r.effects.push(() => {
        r.hooks[i].cleanup?.();
        r.hooks[i].cleanup = fn();
      });
    },
  };
  const window = {
    __ModuleLoader__: { load({ factory }) { exports = factory((name) => {
      if (name === 'react') return React;
      throw new Error(`Unexpected client dependency ${name}`);
    }); } },
    setTimeout, clearTimeout,
    setInterval(fn) { intervals.add(fn); return fn; },
    clearInterval(fn) { intervals.delete(fn); },
    addEventListener(name, fn) { if (name === 'focus') focus.add(fn); },
    removeEventListener(name, fn) { if (name === 'focus') focus.delete(fn); },
  };
  const document = { baseURI: 'http://localhost:3508/', getElementById: () => ({}), createElement: () => ({}), head: { appendChild() {} } };
  const context = vm.createContext({ window, document, fetch, URL, AbortController, setTimeout, clearTimeout, console });
  vm.runInContext(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), context);
  exports.apply({ slots: {
    inject: (_name, fn) => fn(),
    register: (meta, fn) => components.set(meta.id, fn),
  } });
  const runners = [];
  function mountComponent(fn, props = {}) {
    const r = {
      hooks: [], effects: [], cursor: 0, tree: null, rendering: false, rerender: false, alive: true,
      render() {
        if (r.rendering) { r.rerender = true; return; }
        r.rendering = true;
        do {
          r.rerender = false;
          r.cursor = 0;
          current = r;
          r.tree = fn(props);
          current = null;
          for (const effect of r.effects.splice(0)) effect();
        } while (r.rerender);
        r.rendering = false;
      },
      unmount() { r.alive = false; for (const hook of r.hooks) hook?.cleanup?.(); },
    };
    runners.push(r);
    r.render();
    return r;
  }
  function mount(id) {
    const wrapper = components.get(id)();
    return mountComponent(wrapper.type, wrapper.props);
  }
  t.after(() => { for (const r of runners) r.unmount(); });
  return { mount, mountComponent, focus: () => { for (const f of focus) f(); }, poll: () => { for (const f of intervals) f(); }, intervalCount: () => intervals.size };
}
export function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...(tree.props?.children ?? []).flatMap(nodes)];
}
export function text(tree) {
  if (tree === null || tree === undefined || tree === false) return '';
  if (typeof tree !== 'object') return String(tree);
  return (tree.props?.children ?? []).map(text).join('');
}
export const button = (r, label) => nodes(r.tree).find((n) => n.type === 'button' && text(n) === label);
export const response = (body, ok = true, status = ok ? 200 : 500) => ({ ok, status, json: async () => body });
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
