import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { makeApp } from './helpers.ts';
import { createApiServer } from '../src/api/server.ts';

test('escritório 3D: three.js é servido localmente (sem CDN) com o tipo certo', async () => {
  const app = makeApp();
  const server = createApiServer(app, 'web');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const path of ['/vendor/three.module.min.js', '/vendor/three.core.min.js', '/js/office3d.js']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type') ?? '', /javascript/, path);
      await res.arrayBuffer();
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('escritório 3D: nenhum script da interface carrega código de outro site', () => {
  for (const f of ['web/js/app.js', 'web/js/office.js', 'web/js/office3d.js', 'web/index.html']) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /(?:import|src=)[^\n]*https?:\/\//, f);
  }
  assert.ok(existsSync('web/vendor/three.LICENSE'), 'licença do three.js acompanha a cópia local');
  // os módulos importados existem
  const o3d = readFileSync('web/js/office3d.js', 'utf8');
  for (const m of o3d.matchAll(/from '(\.[^']+)'/g)) assert.ok(existsSync(new URL(m[1], new URL('web/js/', `file://${process.cwd()}/`)).pathname), m[1]);
});
