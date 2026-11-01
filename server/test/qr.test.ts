// Estrutura do QR. A leitura de verdade foi conferida no desenvolvimento com um leitor independente (OpenCV):
// versões 1, 4, 5, 6, 8, 9 e 10 e as 8 máscaras.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QrCode } from '../src/tools/qr.ts';

const finderOk = (q: QrCode, x0: number, y0: number) => {
  for (let dy = 0; dy < 7; dy++) for (let dx = 0; dx < 7; dx++) {
    const d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
    if (q.get(x0 + dx, y0 + dy) !== (d !== 2)) return false;
  }
  return true;
};

test('qr: tamanho cresce com o texto e o link do celular cabe na versão 5', () => {
  assert.equal(QrCode.encodeText('A').version, 1);
  const link = QrCode.encodeText('https://minercriptoia.vercel.app/?p=192.168.100.200:8050#t=ABCD-EFGH-JKLM-NPQR');
  assert.equal(link.version, 5);
  assert.equal(link.size, 37);
  assert.throws(() => QrCode.encodeText('x'.repeat(300)), /longo demais/);
});

test('qr: três padrões de localização, linhas de sincronismo e módulo escuro fixo', () => {
  for (const t of ['A', 'y'.repeat(100), 'w'.repeat(200)]) {
    const q = QrCode.encodeText(t);
    const n = q.size;
    assert.ok(finderOk(q, 0, 0) && finderOk(q, n - 7, 0) && finderOk(q, 0, n - 7), `localizadores v${q.version}`);
    for (let i = 8; i < n - 8; i++) {
      assert.equal(q.get(i, 6), i % 2 === 0);
      assert.equal(q.get(6, i), i % 2 === 0);
    }
    assert.equal(q.get(8, n - 8), true);
  }
});

test('qr: as 8 máscaras geram códigos diferentes e o SVG tem fundo branco com borda', () => {
  const t = 'https://minercriptoia.vercel.app/?p=192.168.0.23:8050#t=K7QF-M2XP-9RTA-H4WN';
  const svgs = new Set(Array.from({ length: 8 }, (_, m) => QrCode.encodeTextWithMask(t, m).toSvg()));
  assert.equal(svgs.size, 8);
  const svg = QrCode.encodeText(t).toSvg();
  assert.match(svg, /viewBox="0 0 45 45"/);
  assert.match(svg, /fill="#ffffff"/);
});
