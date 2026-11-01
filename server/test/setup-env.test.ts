import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixEnv } from '../src/tools/setup-env.ts';

test('setup-env: 0.0.0.0 sem token volta para 127.0.0.1', () => {
  const r = fixEnv('HOST=0.0.0.0\nPORT=8050\nAPI_TOKEN=                # <-- PREENCHA\n');
  assert.match(r.text, /^HOST=127\.0\.0\.1/m);
  assert.equal(r.changes.length, 1);
});

test('setup-env: 0.0.0.0 com token é mantido', () => {
  const src = 'HOST=0.0.0.0\nAPI_TOKEN=abcDEF123\n';
  const r = fixEnv(src);
  assert.equal(r.text, src);
  assert.equal(r.changes.length, 0);
});

test('setup-env: 127.0.0.1 não muda', () => {
  const src = 'HOST=127.0.0.1\n# API_TOKEN=x\n';
  assert.equal(fixEnv(src).text, src);
});
