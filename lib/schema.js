/**
 * Config schema 工厂。
 *
 * 首选宿主自带的 @deepseek-ai/schemastery（和 dsh-model-failover 用法一致）：
 * 它自带 Standard Schema 协议和 JSON Schema 投影，设置页才能把配置画成表单。
 * 但本插件以 `link:` 挂进 profile，Node 按真实路径解析 ESM，
 * 插件目录下没有 node_modules，裸包名可能找不到宿主那份 ——
 * 所以再加一条「按 DSH_HOME 定位 profile 的 node_modules」的兜底，
 * 最后才是本地实现（只保证能跑，不保证设置页能画）。
 *
 * 两条路径都必须实现 Standard Schema：宿主的 cordis 启动插件前会读
 * `Config["~standard"].validate(raw)`，缺了会直接 fiber failed。
 */

import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// 本地实现：default / min / max / required / 嵌套 object 与 array
// ---------------------------------------------------------------------------

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = clone(item);
    return out;
  }
  return value;
}

function makeNode(kind, extra = {}) {
  const node = {
    kind,
    def: undefined,
    hasDefault: false,
    default(value) {
      node.def = value;
      node.hasDefault = true;
      return node;
    },
    min(value) {
      node.minimum = value;
      return node;
    },
    max(value) {
      node.maximum = value;
      return node;
    },
    required() {
      node.isRequired = true;
      return node;
    },
    ...extra,
  };
  return node;
}

function resolveNode(node, value) {
  if (value === undefined) {
    if (node.hasDefault) value = clone(node.def);
    else if (node.isRequired) throw new TypeError('Required configuration value is missing');
    else return undefined;
  }
  if (node.kind === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a configuration object');
    const out = { ...value };
    for (const [key, child] of Object.entries(node.shape)) {
      const next = resolveNode(child, Object.hasOwn(value, key) ? value[key] : undefined);
      if (next !== undefined) out[key] = next;
      else delete out[key];
    }
    return out;
  }
  if (node.kind === 'array') {
    if (!Array.isArray(value)) throw new TypeError('Expected a configuration array');
    return value.map((item) => resolveNode(node.item, item));
  }
  if (node.kind === 'boolean' && typeof value !== 'boolean') throw new TypeError('Expected a boolean');
  if (node.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Expected a finite number');
    if (node.minimum !== undefined && value < node.minimum) throw new RangeError(`Minimum is ${node.minimum}`);
    if (node.maximum !== undefined && value > node.maximum) throw new RangeError(`Maximum is ${node.maximum}`);
  }
  if (node.kind === 'string' && typeof value !== 'string') throw new TypeError('Expected a string');
  return value;
}

const localZ = {
  boolean: () => makeNode('boolean'),
  number: () => makeNode('number'),
  string: () => makeNode('string'),
  array: (item) => makeNode('array', { item }),
  object: (shape) => makeNode('object', { shape }),
  any: () => makeNode('any'),
};

/** 与 schemastery 同形的包装：可调用 + Standard Schema 协议。 */
function wrapLocal(shape) {
  const node = localZ.object(shape);
  const Config = (raw = {}) => resolveNode(node, raw);
  Config.__node = node;
  Object.defineProperty(Config, '~standard', {
    get() {
      return {
        version: 1,
        vendor: 'dsh-turn-continue-local',
        validate(value) {
          try {
            return { value: Config(value) };
          } catch (error) {
            return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
          }
        },
      };
    },
  });
  return Config;
}

// ---------------------------------------------------------------------------
// 优先用宿主副本
// ---------------------------------------------------------------------------

function dshHomeCandidates() {
  const out = [];
  const fromEnv = process.env.DSH_HOME?.trim();
  if (fromEnv !== undefined && fromEnv !== '') out.push(fromEnv);
  out.push(path.join(os.homedir(), '.dsh'));
  return out;
}

function tryRequire(id) {
  try {
    return require(id);
  } catch {
    return null;
  }
}

/** 在 profile 的 node_modules 里找宿主那份 schemastery。 */
function loadFromProfiles() {
  for (const home of dshHomeCandidates()) {
    const profilesDir = path.join(home, 'profiles');
    const names = ['desktop', 'default'];
    for (const name of names) {
      const mod = tryRequire(path.join(profilesDir, name, 'node_modules', '@deepseek-ai', 'schemastery'));
      if (mod !== null) return mod;
    }
  }
  return null;
}

function loadHost() {
  for (const loader of [() => tryRequire('@deepseek-ai/schemastery'), loadFromProfiles]) {
    const mod = loader();
    if (mod === null) continue;
    const z = mod?.default ?? mod;
    if (typeof z?.object === 'function') return z;
  }
  return null;
}

const host = loadHost();

/** 真正的 z：有宿主就用宿主的，没有就用本地的。 */
export const z = host ?? localZ;

/**
 * 声明插件配置。
 * @param shape - 字段表（用上面的 z 写）
 * @returns 可调用、且实现 Standard Schema 的 Config
 */
export function defineConfig(shape) {
  if (host !== null) {
    // schemastery 的 Schema 本身就是可调用函数，且自带 ~standard，直接返回它。
    return host.object(shape);
  }
  return wrapLocal(shape);
}

/** 本地实现是否在用（诊断用）。 */
export const usingLocalSchema = host === null;
