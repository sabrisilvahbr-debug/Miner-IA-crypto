// Renderizador isométrico 3D em Canvas 2D, sem dependências.
// Mundo em unidades (x, y no chão; z para cima). Projeção isométrica com 4 rotações de câmera,
// ordenação de profundidade topológica entre caixas e seleção por toque/clique.

const C30 = Math.cos(Math.PI / 6);

export function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * f));
  const b = Math.min(255, Math.round((n & 255) * f));
  return `rgb(${r},${g},${b})`;
}

export class IsoScene {
  constructor(canvas, world) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.W = world.w;
    this.D = world.d;
    this.rotation = 0;
    this.scale = 22;
    this.panX = 0;
    this.panY = 0;
    this.items = [];
    this.floors = [];
    this.order = [];
    this.dpr = 1;
    this.width = 0;
    this.height = 0;
  }

  // ---------- coordenadas ----------
  rot(x, y) {
    const { W, D } = this;
    switch (this.rotation) {
      case 1: return [D - y, x];
      case 2: return [W - x, D - y];
      case 3: return [y, W - x];
      default: return [x, y];
    }
  }

  viewBox(it) {
    const a = this.rot(it.x, it.y);
    const b = this.rot(it.x + it.w, it.y + it.d);
    return { x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]), z0: it.z, z1: it.z + it.h };
  }

  viewDims() {
    return this.rotation % 2 ? [this.D, this.W] : [this.W, this.D];
  }

  // Projeção sem câmera (escala 1), usada para ordenação e limites.
  rawProject(x, y, z) {
    return [(x - y) * C30, (x + y) * 0.5 - z];
  }

  project(x, y, z) {
    const [rx, ry] = this.rawProject(x, y, z);
    const [vw, vd] = this.viewDims();
    const [cx, cy] = this.rawProject(vw / 2, vd / 2, 0);
    return [this.width / 2 + (rx - cx) * this.scale + this.panX, this.height / 2 + (ry - cy) * this.scale + this.panY];
  }

  unproject(sx, sy) {
    const [vw, vd] = this.viewDims();
    const [cx, cy] = this.rawProject(vw / 2, vd / 2, 0);
    const rx = (sx - this.width / 2 - this.panX) / this.scale + cx;
    const ry = (sy - this.height / 2 - this.panY) / this.scale + cy;
    // rx = (x-y)C30 ; ry = (x+y)/2
    const a = rx / C30;
    const b = ry * 2;
    return [(a + b) / 2, (b - a) / 2];
  }

  // ---------- cena ----------
  setScene(floors, items) {
    this.floors = floors;
    this.items = items;
    this.computeOrder();
  }

  /** Ordenação topológica: A fica atrás de B quando os retângulos de tela se sobrepõem e A está separado de B em x, y ou z. */
  computeOrder() {
    const boxes = this.items.map((it) => {
      const v = this.viewBox(it);
      const pts = [];
      for (const x of [v.x0, v.x1]) for (const y of [v.y0, v.y1]) for (const z of [v.z0, v.z1]) pts.push(this.rawProject(x, y, z));
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      return { it, v, sx0: Math.min(...xs), sx1: Math.max(...xs), sy0: Math.min(...ys), sy1: Math.max(...ys) };
    });
    const n = boxes.length;
    const behind = Array.from({ length: n }, () => []);
    const eps = 1e-6;
    for (let i = 0; i < n; i++) {
      const A = boxes[i];
      for (let j = i + 1; j < n; j++) {
        const B = boxes[j];
        if (A.sx1 <= B.sx0 || B.sx1 <= A.sx0 || A.sy1 <= B.sy0 || B.sy1 <= A.sy0) continue;
        const a = A.v;
        const b = B.v;
        let aFirst;
        if (a.x1 <= b.x0 + eps) aFirst = true;
        else if (b.x1 <= a.x0 + eps) aFirst = false;
        else if (a.y1 <= b.y0 + eps) aFirst = true;
        else if (b.y1 <= a.y0 + eps) aFirst = false;
        else if (a.z1 <= b.z0 + eps) aFirst = true;
        else if (b.z1 <= a.z0 + eps) aFirst = false;
        else aFirst = a.x0 + a.y0 + a.z0 < b.x0 + b.y0 + b.z0;
        if (aFirst) behind[j].push(i);
        else behind[i].push(j);
      }
    }
    const visited = new Uint8Array(n);
    const order = [];
    const visit = (i) => {
      if (visited[i]) return;
      visited[i] = 1;
      for (const k of behind[i]) visit(k);
      order.push(boxes[i]);
    };
    const seeds = boxes.map((_, i) => i).sort((p, q) => (boxes[p].v.x0 + boxes[p].v.y0) - (boxes[q].v.x0 + boxes[q].v.y0));
    for (const i of seeds) visit(i);
    this.order = order;
  }

  setRotation(r) {
    this.rotation = ((r % 4) + 4) % 4;
    this.computeOrder();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = r.width;
    this.height = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
  }

  /** Enquadra o prédio inteiro dentro da área livre (descontando os painéis sobrepostos). */
  fit(inset = { top: 40, right: 40, bottom: 40, left: 40 }) {
    const [vw, vd] = this.viewDims();
    const corners = [[0, 0], [vw, 0], [0, vd], [vw, vd]].map(([x, y]) => this.rawProject(x, y, 0));
    const spanX = Math.max(...corners.map((c) => c[0])) - Math.min(...corners.map((c) => c[0]));
    const spanY = Math.max(...corners.map((c) => c[1])) - Math.min(...corners.map((c) => c[1])) + 2;
    const availW = Math.max(100, this.width - inset.left - inset.right);
    const availH = Math.max(100, this.height - inset.top - inset.bottom);
    this.scale = Math.max(5, Math.min(availW / spanX, availH / spanY));
    this.panX = (inset.left - inset.right) / 2;
    this.panY = (inset.top - inset.bottom) / 2;
  }

  /** Centraliza a câmera em um ponto do mundo com a escala informada. */
  focus(x, y, scale) {
    if (scale) this.scale = scale;
    this.panX = 0;
    this.panY = 0;
    const [vx, vy] = this.rot(x, y);
    const [sx, sy] = this.project(vx, vy, 0);
    this.panX = this.width / 2 - sx;
    this.panY = this.height / 2 - sy;
  }

  // ---------- desenho ----------
  poly(pts, fill, stroke) {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.closePath();
    c.fillStyle = fill;
    c.fill();
    if (stroke) {
      c.strokeStyle = stroke;
      c.lineWidth = 0.6;
      c.stroke();
    }
  }

  /** Desenha uma caixa em coordenadas de vista (já rotacionadas). */
  box(v, color, opts = {}) {
    const P = (x, y, z) => this.project(x, y, z);
    const top = [P(v.x0, v.y0, v.z1), P(v.x1, v.y0, v.z1), P(v.x1, v.y1, v.z1), P(v.x0, v.y1, v.z1)];
    const right = [P(v.x1, v.y0, v.z0), P(v.x1, v.y1, v.z0), P(v.x1, v.y1, v.z1), P(v.x1, v.y0, v.z1)];
    const left = [P(v.x0, v.y1, v.z0), P(v.x1, v.y1, v.z0), P(v.x1, v.y1, v.z1), P(v.x0, v.y1, v.z1)];
    const a = opts.alpha ?? 1;
    if (a !== 1) this.ctx.globalAlpha = a;
    this.poly(left, shade(opts.side ?? color, 0.7), shade(opts.side ?? color, 0.6));
    this.poly(right, shade(opts.side ?? color, 0.84), shade(opts.side ?? color, 0.72));
    this.poly(top, opts.top ?? color, shade(opts.top ?? color, 0.85));
    if (a !== 1) this.ctx.globalAlpha = 1;
    return { top, right, left };
  }

  /** Caixa em coordenadas de mundo (rotaciona antes de desenhar). */
  worldBox(it, color, opts) {
    return this.box(this.viewBox(it), color, opts);
  }

  floorPoly(x, y, w, d, z = 0) {
    const a = this.rot(x, y);
    const b = this.rot(x + w, y);
    const c = this.rot(x + w, y + d);
    const e = this.rot(x, y + d);
    return [a, b, c, e].map(([vx, vy]) => this.project(vx, vy, z));
  }

  render(time) {
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.width, this.height);
    for (const f of this.floors) f.draw(this, time);
    for (const b of this.order) {
      const it = b.it;
      // descarte de itens fora da tela
      const [sx, sy] = this.project(b.v.x0, b.v.y0, 0);
      if (sx < -400 || sx > this.width + 400 || sy < -400 || sy > this.height + 600) continue;
      if (it.draw) it.draw(this, b.v, time);
      else this.box(b.v, it.color, it.style);
    }
  }
}

export function pointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
