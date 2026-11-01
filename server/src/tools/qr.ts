// Gerador de QR code sem dependências (modo byte, correção de erro M, versões 1–10).
// Segue a especificação ISO/IEC 18004 no mesmo desenho do gerador de referência de Project Nayuki (MIT).
// Usado só para mostrar no computador o link que abre o painel no celular. Conferido nos testes com um
// leitor independente (OpenCV) durante o desenvolvimento.

const ECC_M_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const MAX_VERSION = 10;

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const r = new Array<number>(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < r.length) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return r;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const r = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (r.shift() as number);
    r.push(0);
    divisor.forEach((coef, i) => { r[i] ^= gfMul(coef, factor); });
  }
  return r;
}

function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

const dataCodewords = (ver: number) => Math.floor(rawDataModules(ver) / 8) - ECC_M_PER_BLOCK[ver] * BLOCKS_M[ver];

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const size = ver * 4 + 17;
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

export class QrCode {
  readonly version: number;
  readonly size: number;
  readonly mask: number;
  private modules: boolean[][];
  private isFunction: boolean[][];

  static encodeText(text: string): QrCode {
    const bytes = [...new TextEncoder().encode(text)];
    for (let ver = 1; ver <= MAX_VERSION; ver++) {
      const ccBits = ver <= 9 ? 8 : 16;
      if (4 + ccBits + bytes.length * 8 <= dataCodewords(ver) * 8) return new QrCode(ver, bytes);
    }
    throw new Error(`texto longo demais para QR (máx. versão ${MAX_VERSION})`);
  }

  /** Só para testes: força a máscara (0–7) para conferir todas com um leitor. */
  static encodeTextWithMask(text: string, mask: number): QrCode {
    const q = QrCode.encodeText(text);
    return new QrCode(q.version, [...new TextEncoder().encode(text)], mask);
  }

  private constructor(ver: number, bytes: number[], forcedMask = -1) {
    this.version = ver;
    this.size = ver * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));

    // Bits de dados: modo byte (0100), contagem, bytes, terminador e preenchimento.
    const bits: number[] = [];
    const push = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(0b0100, 4);
    push(bytes.length, ver <= 9 ? 8 : 16);
    for (const b of bytes) push(b, 8);
    const capBits = dataCodewords(ver) * 8;
    push(0, Math.min(4, capBits - bits.length));
    push(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capBits; pad ^= 0xec ^ 0x11) push(pad, 8);
    const data: number[] = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

    this.drawFunctionPatterns();
    const all = this.addEcc(data);
    this.drawCodewords(all);

    let best = forcedMask;
    if (best < 0) {
      let minPenalty = Infinity;
      for (let m = 0; m < 8; m++) {
        this.applyMask(m);
        this.drawFormatBits(m);
        const p = this.penalty();
        if (p < minPenalty) { minPenalty = p; best = m; }
        this.applyMask(m); // desfaz (XOR)
      }
    }
    this.mask = best;
    this.applyMask(best);
    this.drawFormatBits(best);
  }

  get(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.size && y < this.size && this.modules[y][x];
  }

  private set(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }

  private drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);
    const pos = alignmentPositions(this.version);
    const n = pos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    this.drawFormatBits(0); // reserva a área; redesenhado com a máscara escolhida
    if (this.version >= 7) {
      let rem = this.version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const v = (this.version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const a = this.size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, bit(v, i));
        this.set(b, a, bit(v, i));
      }
    }
  }

  private drawFinder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.set(xx, yy, d !== 2 && d !== 4);
      }
    }
  }

  private drawFormatBits(mask: number): void {
    const data = (0 << 3) | mask; // nível M = 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const v = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(v, i));
    this.set(8, 7, bit(v, 6));
    this.set(8, 8, bit(v, 7));
    this.set(7, 8, bit(v, 8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(v, i));
    for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(v, i));
    for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(v, i));
    this.set(8, this.size - 8, true);
  }

  private addEcc(data: number[]): number[] {
    const ver = this.version;
    const numBlocks = BLOCKS_M[ver];
    const eccLen = ECC_M_PER_BLOCK[ver];
    const raw = Math.floor(rawDataModules(ver) / 8);
    const numShort = numBlocks - (raw % numBlocks);
    const shortLen = Math.floor(raw / numBlocks);
    const div = rsDivisor(eccLen);
    const blocks: number[][] = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, div);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const out: number[] = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= numShort) out.push(b[i]); });
    }
    return out;
  }

  private drawCodewords(data: number[]): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = bit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  private applyMask(m: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let inv: boolean;
        switch (m) {
          case 0: inv = (x + y) % 2 === 0; break;
          case 1: inv = y % 2 === 0; break;
          case 2: inv = x % 3 === 0; break;
          case 3: inv = (x + y) % 3 === 0; break;
          case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (!this.isFunction[y][x] && inv) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  /** Penalidade da especificação (regras 1, 2 e 4, e a 3 simplificada): só escolhe a máscara mais legível. */
  private penalty(): number {
    const n = this.size;
    const m = this.modules;
    let p = 0;
    const runs = (get: (a: number, b: number) => boolean) => {
      for (let a = 0; a < n; a++) {
        let run = 1;
        for (let b = 1; b <= n; b++) {
          if (b < n && get(a, b) === get(a, b - 1)) run++;
          else { if (run >= 5) p += 3 + (run - 5); run = 1; }
        }
      }
    };
    runs((y, x) => m[y][x]);
    runs((x, y) => m[y][x]);
    for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
    }
    const pat = [true, false, true, true, true, false, true];
    const match = (get: (k: number) => boolean, start: number) => pat.every((v, k) => get(start + k) === v);
    for (let a = 0; a < n; a++) for (let b = 0; b + 7 <= n; b++) {
      if (match((k) => m[a][k], b)) p += 40;
      if (match((k) => m[k][a], b)) p += 40;
    }
    let dark = 0;
    for (const row of m) for (const c of row) if (c) dark++;
    const total = n * n;
    p += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
    return p;
  }

  /** SVG com zona de silêncio de 4 módulos (fundo branco, módulos pretos). */
  toSvg(border = 4): string {
    const dim = this.size + border * 2;
    const parts: string[] = [];
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) if (this.modules[y][x]) parts.push(`M${x + border},${y + border}h1v1h-1z`);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#ffffff"/><path d="${parts.join('')}" fill="#000000"/></svg>`;
  }
}
