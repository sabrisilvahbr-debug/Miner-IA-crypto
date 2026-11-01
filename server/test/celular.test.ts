import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disablePhone, enablePhone, lanAddresses, lanLink, phoneLink, readableToken, tokenOf } from '../src/tools/celular.ts';
import { createApiServer } from '../src/api/server.ts';
import { makeApp } from './helpers.ts';
import { fixEnv } from '../src/tools/setup-env.ts';
import { parseDotEnv } from '../src/config.ts';

test('celular: token legível tem 16 caracteres sem símbolos ambíguos', () => {
  const t = readableToken(Buffer.from([...Array(16).keys()]));
  assert.match(t, /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
  assert.notEqual(readableToken(), readableToken());
});

test('celular: liga HOST=0.0.0.0 e cria token só se não existir', () => {
  const r = enablePhone('HOST=127.0.0.1            # só este computador\nPORT=8050\n# API_TOKEN=gere-com-npm-run-token\n', () => 'AAAA-BBBB-CCCC-DDDD');
  const env = parseDotEnv(r.text);
  assert.equal(env.HOST, '0.0.0.0');
  assert.equal(env.API_TOKEN, 'AAAA-BBBB-CCCC-DDDD');
  assert.equal(r.criado, true);
  const again = enablePhone(r.text, () => 'XXXX-XXXX-XXXX-XXXX');
  assert.equal(again.token, 'AAAA-BBBB-CCCC-DDDD', 'token existente é mantido');
  assert.equal(again.criado, false);
  assert.equal(fixEnv(r.text).changes.length, 0, 'o Iniciar-Painel.bat não desfaz, porque há token');
});

test('celular: modelo da Luxor com API_TOKEN vazio também recebe token', () => {
  const r = enablePhone('HOST=127.0.0.1\nAPI_TOKEN=                                  # <-- PREENCHA\n', () => 'QQQQ-WWWW-EEEE-RRRR');
  assert.equal(tokenOf(r.text), 'QQQQ-WWWW-EEEE-RRRR');
  assert.equal(parseDotEnv(r.text).HOST, '0.0.0.0');
});

test('celular: desfazer volta para 127.0.0.1 e mantém o token', () => {
  const t = disablePhone('HOST=0.0.0.0\nAPI_TOKEN=AAAA-BBBB-CCCC-DDDD\n');
  assert.equal(parseDotEnv(t).HOST, '127.0.0.1');
  assert.equal(parseDotEnv(t).API_TOKEN, 'AAAA-BBBB-CCCC-DDDD');
});

test('celular: mostra só endereços privados da rede local', () => {
  const ifaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    wifi: [{ address: '192.168.0.23', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
    vpn: [{ address: '8.8.4.4', family: 'IPv4', internal: false }],
    eth: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
  } as unknown as Parameters<typeof lanAddresses>[0];
  assert.deepEqual(lanAddresses(ifaces), ['192.168.0.23', '10.0.0.5']);
  const virt = { wsl: [{ address: '172.20.0.1', family: 'IPv4', internal: false }], wifi: [{ address: '192.168.1.9', family: 'IPv4', internal: false }] } as unknown as Parameters<typeof lanAddresses>[0];
  assert.deepEqual(lanAddresses(virt), ['192.168.1.9', '172.20.0.1'], 'Wi-Fi antes de rede virtual');
});

test('celular: link do QR leva o endereço na consulta e o token só depois do "#"', () => {
  const l = phoneLink('192.168.0.23', 8050, 'AAAA-BBBB-CCCC-DDDD', 'https://minercriptoia.vercel.app/');
  assert.equal(l, 'https://minercriptoia.vercel.app/?p=192.168.0.23:8050#t=AAAA-BBBB-CCCC-DDDD');
  assert.ok(!new URL(l).search.includes('AAAA'), 'o token nunca vai na parte enviada ao servidor');
  assert.equal(lanLink('192.168.0.23', 8050, 'AAAA-BBBB-CCCC-DDDD'), 'http://192.168.0.23:8050/#token=AAAA-BBBB-CCCC-DDDD');
});

async function getCelular(over: Parameters<typeof makeApp>[0]) {
  const app = makeApp(over);
  const server = createApiServer(app, 'web');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const b = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const headers: Record<string, string> = over?.apiToken ? { authorization: `Bearer ${over.apiToken}` } : {};
    const r = await fetch(`${b}/api/celular`, { headers });
    return { status: r.status, body: await r.json() };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('API /api/celular: painel só local não gera QR e explica o que fazer', async () => {
  const r = await getCelular({});
  assert.equal(r.status, 200);
  assert.equal(r.body.liberado, false);
  assert.match(r.body.motivo, /Abrir-no-Celular\.bat/);
});

test('API /api/celular: com Wi-Fi liberado e token, devolve QR e link com o token só no "#"', async () => {
  const r = await getCelular({ host: '0.0.0.0', apiToken: 'AAAA-BBBB-CCCC-DDDD' });
  assert.equal(r.status, 200);
  if (!r.body.liberado) {
    assert.match(r.body.motivo, /rede local/, 'máquina sem endereço de rede local');
    return;
  }
  const o = r.body.opcoes[0];
  assert.match(o.link, /^https:\/\/minercriptoia\.vercel\.app\/\?p=[0-9.]+:8050#t=AAAA-BBBB-CCCC-DDDD$/);
  assert.match(o.svg, /^<svg /);
});

test('API /api/celular: sem o token, recusa', async () => {
  const app = makeApp({ host: '0.0.0.0', apiToken: 'AAAA-BBBB-CCCC-DDDD' });
  const server = createApiServer(app, 'web');
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const b = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try { assert.equal((await fetch(`${b}/api/celular`)).status, 401); } finally { await new Promise<void>((r) => server.close(() => r())); }
});
