import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { clientHarness, nodes, text, button, response, deferred } from './client-helpers.mjs';
const flush = async () => { await setImmediate(); await setImmediate(); };
const state = (extra = {}) => ({ ok: true, enabled: false, steerText: '继续', fallbacks: [], config: { maxContinuePerTurn: 3 }, stats: { continues: 0 }, ...extra });

test('toggle shows only committed host state while a write is pending or fails', async (t) => {
  const pending = deferred();
  const h = clientHarness(t, async (_url, opts) => opts.method === 'POST' ? pending.promise : response(state()));
  const pill = h.mount('turn-continue-indicator');
  await flush();
  pill.tree.props.onClick();
  assert.equal(pill.tree.props['aria-pressed'], 'false');
  assert.equal(pill.tree.props['data-busy'], '1');
  pending.resolve(response({ message: 'disk unavailable' }, false));
  await flush();
  assert.equal(pill.tree.props['aria-pressed'], 'false');
  assert.equal(pill.tree.props['data-state'], 'warn');
});

test('an old read cannot overwrite a newer successful toggle', async (t) => {
  const old = deferred();
  let reads = 0;
  const h = clientHarness(t, async (_url, opts) => {
    if (opts.method === 'POST') return response(state({ enabled: true }));
    reads += 1;
    return reads === 1 ? response(state()) : old.promise;
  });
  const pill = h.mount('turn-continue-indicator');
  await flush();
  h.focus();
  pill.tree.props.onClick();
  await flush();
  assert.equal(pill.tree.props['aria-pressed'], 'true');
  old.resolve(response(state()));
  await flush();
  assert.equal(pill.tree.props['aria-pressed'], 'true');
});

test('pills share one status poll and receive committed toggle together', async (t) => {
  let reads = 0;
  const h = clientHarness(t, async (_url, opts) => {
    if (opts.method !== 'POST') reads += 1;
    return response(state({ enabled: opts.method === 'POST' }));
  });
  const first = h.mount('turn-continue-indicator');
  const second = h.mount('turn-continue-indicator');
  await flush();
  assert.equal(h.intervalCount(), 1);
  assert.equal(reads, 1);
  first.tree.props.onClick();
  await flush();
  assert.equal(second.tree.props['aria-pressed'], 'true');
});

test('explicit settings reload replaces form fields with current host values', async (t) => {
  let body = state();
  const h = clientHarness(t, async () => response(body));
  const page = h.mount('turn-continue-settings');
  await flush();
  body = state({ steerText: '接着完成', config: { maxContinuePerTurn: 7 } });
  button(page, '重新读取').props.onClick();
  await flush();
  const inputs = nodes(page.tree).filter((n) => n.type === 'input');
  assert.equal(inputs.find((n) => n.props.maxLength === 200).props.value, '接着完成');
  assert.equal(inputs.find((n) => n.props.max === 20).props.value, 7);
});

test('settings save updates shared runtime statistics and the saved form', async (t) => {
  const h = clientHarness(t, async (_url, opts) => response(opts.method === 'POST'
    ? state({ steerText: '已存内容', stats: { continues: 9 } }) : state()));
  const page = h.mount('turn-continue-settings');
  await flush();
  button(page, '保存设置').props.onClick();
  await flush();
  assert.match(text(page.tree), /自动续跑 9 次/);
  assert.equal(nodes(page.tree).find((n) => n.type === 'input' && n.props.maxLength === 200).props.value, '已存内容');
});

test('remounting settings hydrates the fresh host reply rather than an old shared cache', async (t) => {
  let body = state({ steerText: 'old' });
  const fresh = deferred();
  let wait = false;
  const h = clientHarness(t, async () => wait ? fresh.promise : response(body));
  const first = h.mount('turn-continue-settings');
  await flush();
  first.unmount();
  wait = true;
  const second = h.mount('turn-continue-settings');
  body = state({ steerText: 'new-host', config: { maxContinuePerTurn: 7 } });
  fresh.resolve(response(body));
  await flush();
  assert.equal(nodes(second.tree).find((n) => n.type === 'input' && n.props.maxLength === 200).props.value, 'new-host');
  assert.equal(nodes(second.tree).find((n) => n.type === 'input' && n.props.max === 20).props.value, 7);
});

test('settings cannot edit stale cached fields while a fresh mount read is pending', async (t) => {
  const fresh = deferred();
  let wait = false;
  const h = clientHarness(t, async () => wait ? fresh.promise : response(state()));
  const first = h.mount('turn-continue-settings');
  await flush();
  first.unmount();
  wait = true;
  const second = h.mount('turn-continue-settings');
  assert.equal(nodes(second.tree).some((node) => node.type === 'input'), false);
  assert.equal(button(second, '保存设置'), undefined);
  fresh.resolve(response(state({ steerText: 'fresh-host' })));
  await flush();
  assert.equal(nodes(second.tree).find((node) => node.type === 'input' && node.props.maxLength === 200).props.value, 'fresh-host');
});

test('remounting during a pending save waits for committed settings instead of stale cache', async (t) => {
  const saved = deferred();
  let reads = 0;
  const h = clientHarness(t, async (_url, opts) => {
    if (opts.method === 'POST') return saved.promise;
    reads += 1;
    return response(state({ steerText: 'old-host' }));
  });
  const first = h.mount('turn-continue-settings');
  await flush();
  nodes(first.tree).find((node) => node.type === 'input' && node.props.maxLength === 200)
    .props.onChange({ target: { value: 'new-saved' } });
  button(first, '保存设置').props.onClick();
  first.unmount();
  const second = h.mount('turn-continue-settings');
  const hasStaleInputs = nodes(second.tree).some((node) => node.type === 'input');
  const hasStaleSave = button(second, '保存设置') !== undefined;
  saved.resolve(response(state({ steerText: 'new-saved', config: { maxContinuePerTurn: 7 } })));
  await flush();
  assert.equal(hasStaleInputs, false);
  assert.equal(hasStaleSave, false);
  assert.equal(nodes(second.tree).find((node) => node.type === 'input' && node.props.maxLength === 200).props.value, 'new-saved');
  assert.equal(nodes(second.tree).find((node) => node.type === 'input' && node.props.max === 20).props.value, 7);
  assert.equal(reads, 1);
});

test('edits typed while saving remain unsaved draft after the prior save returns', async (t) => {
  const saved = deferred();
  const h = clientHarness(t, async (_url, opts) => opts.method === 'POST' ? saved.promise : response(state()));
  const page = h.mount('turn-continue-settings');
  await flush();
  const field = () => nodes(page.tree).find((n) => n.type === 'input' && n.props.maxLength === 200);
  field().props.onChange({ target: { value: 'first-save' } });
  button(page, '保存设置').props.onClick();
  field().props.onChange({ target: { value: 'second-edit' } });
  saved.resolve(response(state({ steerText: 'first-save' })));
  await flush();
  assert.equal(field().props.value, 'second-edit');
  assert.match(text(page.tree), /尚未保存/);
});

test('edits typed during explicit reload survive the older read response', async (t) => {
  let reads = 0;
  const reading = deferred();
  const h = clientHarness(t, async () => ++reads === 1 ? response(state()) : reading.promise);
  const page = h.mount('turn-continue-settings');
  await flush();
  button(page, '重新读取').props.onClick();
  const field = () => nodes(page.tree).find((n) => n.type === 'input' && n.props.maxLength === 200);
  field().props.onChange({ target: { value: 'new-draft' } });
  reading.resolve(response(state({ steerText: 'older-host' })));
  await flush();
  assert.equal(field().props.value, 'new-draft');
  assert.match(text(page.tree), /尚未保存/);
});

test('unknown saved fallback identifiers remain visible and distinct from placeholders', async (t) => {
  const h = clientHarness(t, async () => response({ ok: true, providers: [] }));
  const page = h.mount('turn-continue-settings');
  await flush();
  const component = nodes(page.tree).find((n) => typeof n.type === 'function' && n.type.name === 'FallbackEditor');
  const editor = h.mountComponent(component.type, { value: [{ provider: 'custom', model: 'custom-model' }], onChange() {} });
  await flush();
  for (const select of nodes(editor.tree).filter((n) => n.type === 'select')) {
    const wanted = select.props['data-role'] === 'provider' ? 'custom' : 'custom-model';
    assert.equal(select.props.value, wanted);
    assert.equal(select.props.children.filter((n) => n?.type === 'option' && n.props.value === '').length, 1);
  }
});
