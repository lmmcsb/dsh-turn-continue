import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

// Force the documented fallback without depending on a developer's installed profile.
function localSchema() {
  const source = fs.readFileSync(new URL('../lib/schema.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/import\.meta\.url/g, "'file:///missing-schema.js'").replace(/export /g, '');
  return vm.runInNewContext(`${source}\n;({ z, defineConfig, usingLocalSchema });`, {
    createRequire: () => () => { throw new Error('host schema unavailable'); },
    process: { env: {} }, os: { homedir: () => '/missing-host' }, path,
  });
}

test('local schema resolves root defaults and validates Standard Schema with required nested fields', () => {
  const { z, defineConfig, usingLocalSchema } = localSchema();
  assert.equal(usingLocalSchema, true);
  const schema = defineConfig({ enabled: z.boolean().default(false), limit: z.number().default(3).min(0).max(20), routes: z.array(z.object({ provider: z.string().required() })).default([]) });
  assert.equal(schema().enabled, false);
  assert.equal(schema['~standard'].validate(undefined).value.limit, 3);
  for (const raw of [{ enabled: 'false' }, { limit: -1 }, { limit: 21 }, { limit: Infinity }, { routes: [{}] }, []]) {
    assert.ok(schema['~standard'].validate(raw).issues?.length, JSON.stringify(raw));
  }
  assert.equal(schema({ enabled: true, limit: 0 }).limit, 0);
});
