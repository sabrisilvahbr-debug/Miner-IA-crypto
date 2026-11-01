import { test } from 'node:test';
import assert from 'node:assert/strict';
import { disablePhone, enablePhone, lanAddresses, readableToken, tokenOf } from '../src/tools/celular.ts';
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
});
