// Escritório virtual: 10 salas (departamentos) com 5 agentes cada, mobiliário temático e etiquetas.
import { IsoScene, pointInPoly, shade } from './iso.js';

export const STATE_COLORS = {
  operacional: '#3ecf8e',
  ocioso: '#9aa1ab',
  aguardando: '#f2c14e',
  erro: '#ff5d5d',
  bloqueado: '#b07cff',
  desconectado: '#5d6670',
};

const ROOM_W = 10;
const ROOM_D = 8;
const GAP_X = 1.6;
const GAP_Y = 3.2;
const MARGIN = 1.6;
const WORLD_W = MARGIN * 2 + ROOM_W * 5 + GAP_X * 4;
const WORLD_D = MARGIN * 2 + ROOM_D * 2 + GAP_Y;

const COLORS = {
  slab: '#8f6e66',
  outer: '#a7837b',
  floor: '#e8dcc7',
  corridor: '#d8cbb5',
  wallBack: '#8e949d',
  wallTop: '#c3c8ce',
  wallFront: '#a3a9b1',
  desk: '#b58a5a',
  deskTop: '#cfa673',
  chair: '#6a6f86',
  monitor: '#22252d',
  rack: '#23262c',
  plant: '#5f9e6e',
  pot: '#c07a52',
  skin: ['#f1c7a3', '#d9a27a', '#a8704a', '#7a4e33', '#f5d6bd'],
  hair: ['#2b2420', '#5a3b22', '#d8b25a', '#1d1d24', '#8e4b2a', '#c9c9c9'],
  legs: '#2d3240',
};

export function roomOrigin(dept) {
  const c = (dept - 1) % 5;
  const r = Math.floor((dept - 1) / 5);
  return { x: MARGIN + c * (ROOM_W + GAP_X), y: MARGIN + r * (ROOM_D + GAP_Y) };
}

/** Normal de um lado da sala, rotacionada para a vista. Lado frontal = normal com componente +x ou +y. */
function sideIsFront(side, rotation) {
  const normals = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] };
  let [x, y] = normals[side];
  for (let i = 0; i < rotation; i++) [x, y] = [-y, x];
  return x > 0.5 || y > 0.5;
}

function hash(n) {
  let x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

export class Office {
  constructor(canvas, departments) {
    this.departments = departments;
    this.scene = new IsoScene(canvas, { w: WORLD_W, d: WORLD_D });
    this.agents = new Map(); // id -> dados do agente
    this.agentBoxes = new Map(); // id -> {x,y}
    this.filter = { states: new Set(), dept: null, query: '' };
    this.selected = null;
    this.hovered = null;
    this.focusedDept = null;
    this.labelsMode = 'auto';
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.rightInset = 0; // largura do painel lateral aberto (desktop)
    this.onPickAgent = () => {};
    this.onPickRoom = () => {};
    this.dirty = true;
    this.rebuild();
  }

  setAgents(list) {
    for (const a of list) this.agents.set(a.id, { ...(this.agents.get(a.id) ?? {}), ...a });
    this.dirty = true;
  }

  updateAgentState(id, state) {
    const a = this.agents.get(id);
    if (a) { a.state = state; a.flashUntil = performance.now() + 1500; this.dirty = true; }
  }

  matches(a) {
    if (this.filter.states.size && !this.filter.states.has(a.state)) return false;
    if (this.filter.dept && a.department !== this.filter.dept) return false;
    if (this.filter.query) {
      const q = this.filter.query.toLowerCase();
      if (!a.name.toLowerCase().includes(q) && !a.code.toLowerCase().includes(q)) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- construção
  rebuild() {
    const s = this.scene;
    const rot = s.rotation;
    const items = [];
    const floors = [];
    const add = (x, y, z, w, d, h, color, style) => items.push({ x, y, z, w, d, h, color, style });

    // laje e piso do prédio
    floors.push({ draw: (sc) => {
      sc.poly(sc.floorPoly(-0.5, -0.5, WORLD_W + 1, WORLD_D + 1, -0.35), shade(COLORS.slab, 0.8));
      sc.poly(sc.floorPoly(0, 0, WORLD_W, WORLD_D, 0), COLORS.corridor, shade(COLORS.corridor, 0.92));
    } });

    // paredes externas (baixas no lado frontal, como na referência)
    const T = 0.45;
    const outer = [
      { side: 'n', x: -T, y: -T, w: WORLD_W + 2 * T, d: T },
      { side: 's', x: -T, y: WORLD_D, w: WORLD_W + 2 * T, d: T },
      { side: 'w', x: -T, y: 0, w: T, d: WORLD_D },
      { side: 'e', x: WORLD_W, y: 0, w: T, d: WORLD_D },
    ];
    for (const o of outer) {
      const front = sideIsFront(o.side, rot);
      add(o.x, o.y, 0, o.w, o.d, front ? 0.55 : 1.1, COLORS.outer, { top: '#c79d93' });
    }

    for (const d of this.departments) {
      const { x, y } = roomOrigin(d.id);
      const tint = d.color;
      floors.push({ dept: d.id, draw: (sc) => {
        const pts = sc.floorPoly(x, y, ROOM_W, ROOM_D, 0.01);
        const focused = this.focusedDept === d.id || this.filter.dept === d.id;
        sc.poly(pts, focused ? '#f3e9d6' : COLORS.floor, shade(COLORS.floor, 0.9));
        // faixa colorida do departamento junto à parede do fundo
        const stripe = sc.floorPoly(x + 0.3, y + 0.3, ROOM_W - 0.6, 0.35, 0.02);
        sc.poly(stripe, tint);
        if (focused) {
          sc.ctx.save();
          sc.ctx.strokeStyle = tint;
          sc.ctx.lineWidth = 2.5;
          sc.ctx.setLineDash([6, 4]);
          sc.ctx.beginPath();
          pts.forEach((p, i) => (i ? sc.ctx.lineTo(p[0], p[1]) : sc.ctx.moveTo(p[0], p[1])));
          sc.ctx.closePath();
          sc.ctx.stroke();
          sc.ctx.restore();
        }
      } });

      // paredes da sala: fundo altas, frente baixas com porta
      const wt = 0.22;
      const sides = [
        { side: 'n', x, y, w: ROOM_W, d: wt },
        { side: 's', x, y: y + ROOM_D - wt, w: ROOM_W, d: wt },
        { side: 'w', x, y: y + wt, w: wt, d: ROOM_D - 2 * wt },
        { side: 'e', x: x + ROOM_W - wt, y: y + wt, w: wt, d: ROOM_D - 2 * wt },
      ];
      for (const sd of sides) {
        const front = sideIsFront(sd.side, rot);
        const h = front ? 0.28 : 1.5;
        const color = front ? COLORS.wallFront : COLORS.wallBack;
        const horizontal = sd.side === 'n' || sd.side === 's';
        const door = (sd.side === 's' && Math.floor((d.id - 1) / 5) === 0) || (sd.side === 'n' && Math.floor((d.id - 1) / 5) === 1);
        if (door) {
          // porta voltada ao corredor central
          const gap = 2;
          const mid = (horizontal ? sd.w : sd.d) / 2;
          if (horizontal) {
            add(sd.x, sd.y, 0, mid - gap / 2, sd.d, h, color, { top: COLORS.wallTop });
            add(sd.x + mid + gap / 2, sd.y, 0, mid - gap / 2, sd.d, h, color, { top: COLORS.wallTop });
          }
        } else add(sd.x, sd.y, 0, sd.w, sd.d, h, color, { top: COLORS.wallTop });
      }

      this.furnish(d, x, y, items);
    }

    // agentes: 5 por sala em arco, de frente para as mesas
    this.agentBoxes.clear();
    const roomRow = (dept) => Math.floor((dept - 1) / 5);
    for (let i = 1; i <= 50; i++) {
      const dept = Math.ceil(i / 5);
      const k = (i - 1) % 5;
      const { x, y } = roomOrigin(dept);
      const back = roomRow(dept) === 0 ? 0 : 1; // sala de baixo tem porta ao norte; mesas ficam ao sul
      const ax = x + 1.3 + k * 1.85;
      const ay = back === 0 ? y + 3.15 + (k % 2) * 0.55 : y + ROOM_D - 3.75 - (k % 2) * 0.55;
      const box = { x: ax, y: ay, z: 0, w: 0.62, d: 0.5, h: 1.7, agentId: i, draw: (sc, v, t) => this.drawAgent(sc, v, t, i) };
      items.push(box);
      this.agentBoxes.set(i, { x: ax + 0.31, y: ay + 0.25 });
    }

    s.setScene(floors, items);
    this.dirty = true;
  }

  /** Mobiliário temático por departamento. */
  furnish(d, x, y, items) {
    const add = (ix, iy, z, w, dd, h, color, style) => items.push({ x: x + ix, y: y + iy, z, w, d: dd, h, color, style });
    const lower = Math.floor((d.id - 1) / 5) === 1;
    const deskY = lower ? ROOM_D - 1.75 : 1.0;
    // 5 mesas de trabalho com monitor e cadeira
    for (let k = 0; k < 5; k++) {
      const dx = 1.05 + k * 1.85;
      add(dx, deskY, 0, 1.15, 0.7, 0.62, COLORS.desk, { top: COLORS.deskTop });
      add(dx + 0.35, deskY + (lower ? 0.45 : 0.1), 0.62, 0.45, 0.12, 0.38, COLORS.monitor, { top: '#3a3f4a', side: COLORS.monitor });
      add(dx + 0.38, deskY + (lower ? -0.55 : 0.95), 0, 0.42, 0.42, 0.42, COLORS.chair);
    }
    const plant = (ix, iy) => { add(ix, iy, 0, 0.45, 0.45, 0.35, COLORS.pot); add(ix + 0.05, iy + 0.05, 0.35, 0.35, 0.35, 0.55, COLORS.plant, { top: '#7cc08a' }); };
    const midY = lower ? 1.1 : ROOM_D - 2.2;
    switch (d.id) {
      case 1: // mesa de reunião da diretoria
        add(3.4, midY - 0.2, 0, 3.2, 1.4, 0.6, '#9a6b45', { top: '#c08a5a' });
        for (let k = 0; k < 3; k++) add(3.6 + k * 1.05, midY - 0.75, 0, 0.42, 0.42, 0.42, COLORS.chair);
        plant(0.5, midY); plant(8.9, midY);
        break;
      case 2: // painel de cotações
        add(2.5, midY, 0, 5, 0.3, 1.35, '#1d2430', { top: '#2c3646', side: '#1d2430' });
        add(2.7, midY - 0.02, 0.35, 4.6, 0.05, 0.8, '#245a7a', { top: '#4aa3d4' });
        plant(8.9, midY);
        break;
      case 3: // racks de mineradores (ASIC)
      case 5: // racks de rede/pool
        for (let k = 0; k < 4; k++) add(1.0 + k * 2.1, midY - 0.2, 0, 1.3, 1.0, 1.55, COLORS.rack, { top: '#3a3f48', side: COLORS.rack });
        break;
      case 4: // baterias e quadro de energia
        for (let k = 0; k < 3; k++) add(1.2 + k * 1.3, midY, 0, 0.9, 0.7, 1.1, '#2f6b3b', { top: '#5fb36d' });
        add(6.3, midY, 0, 2.4, 0.4, 1.3, '#6f7a84', { top: '#a3adb6' });
        break;
      case 6: // cabine de segurança e alarme
        add(1.0, midY - 0.4, 0, 2.2, 1.6, 1.6, '#2b3442', { top: '#56657a', side: '#2b3442', alpha: 0.9 });
        add(7.6, midY, 0, 0.35, 0.35, 1.5, '#b8343c', { top: '#ff5d5d' });
        plant(5.0, midY);
        break;
      case 7: // quadro branco e mesa redonda de estratégia
        add(1.0, midY, 0, 3.0, 0.2, 1.3, '#e6e8ec', { top: '#ffffff', side: '#cfd3da' });
        add(5.3, midY - 0.3, 0, 1.6, 1.6, 0.6, '#7b4f8a', { top: '#a36cb4' });
        break;
      case 8: // bancada de manutenção
        add(1.0, midY, 0, 3.4, 0.9, 0.85, '#6a5a48', { top: '#8f7a62' });
        add(5.2, midY, 0, 0.9, 0.7, 1.2, '#c0392b', { top: '#e05a4a' });
        add(7.0, midY, 0, 1.6, 0.9, 0.5, '#4fc1b0', { top: '#7fe0d1' });
        break;
      case 9: // arquivos de auditoria
        for (let k = 0; k < 4; k++) add(1.0 + k * 1.0, midY, 0, 0.8, 0.7, 1.25, '#7d7f86', { top: '#a6a9b0' });
        plant(8.6, midY);
        break;
      case 10: // parede de telas e sofá
        add(1.0, midY, 0, 4.2, 0.25, 1.45, '#1d2430', { top: '#2c3646', side: '#1d2430' });
        add(6.0, midY - 0.3, 0, 2.6, 0.9, 0.45, '#6b5d8c', { top: '#8a7cb0' });
        break;
    }
  }

  // ---------------------------------------------------------------- desenho de agentes
  drawAgent(sc, v, t, id) {
    const a = this.agents.get(id);
    if (!a) return;
    const visible = this.matches(a);
    const alpha = visible ? 1 : 0.18;
    const state = a.state ?? 'ocioso';
    const seed = id * 7;
    const animate = !this.reducedMotion && (state === 'operacional' || state === 'aguardando');
    const bob = animate ? Math.sin(t / 380 + seed) * 0.035 : 0;
    const cx = v.x0 + (v.x1 - v.x0) / 2;
    const cy = v.y0 + (v.y1 - v.y0) / 2;
    const ctx = sc.ctx;

    // anel de estado no chão
    const ring = STATE_COLORS[state] ?? '#888';
    const [px, py] = sc.project(cx, cy, 0.02);
    ctx.save();
    ctx.globalAlpha = alpha * (state === 'erro' ? 0.55 + 0.45 * Math.abs(Math.sin(t / 250)) : 0.85);
    ctx.beginPath();
    ctx.ellipse(px, py, sc.scale * 0.55, sc.scale * 0.3, 0, 0, Math.PI * 2);
    ctx.fillStyle = ring + '55';
    ctx.fill();
    ctx.lineWidth = Math.max(1, sc.scale * 0.06);
    ctx.strokeStyle = ring;
    if (state === 'desconectado') ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.restore();

    const dept = this.departments.find((d) => d.id === a.department);
    const shirt = dept?.color ?? '#888';
    const skin = COLORS.skin[Math.floor(hash(seed) * COLORS.skin.length)];
    const hair = COLORS.hair[Math.floor(hash(seed + 3) * COLORS.hair.length)];
    const part = (x0, y0, z0, w, d, h, color, style) => sc.box({ x0: cx + x0, x1: cx + x0 + w, y0: cy + y0, y1: cy + y0 + d, z0: z0 + bob, z1: z0 + h + bob }, color, { ...style, alpha });
    part(-0.2, -0.1, 0, 0.17, 0.2, 0.62, COLORS.legs);
    part(0.03, -0.1, 0, 0.17, 0.2, 0.62, COLORS.legs);
    part(-0.24, -0.14, 0.62, 0.48, 0.28, 0.55, shirt);
    part(-0.34, -0.08, 0.68, 0.1, 0.16, 0.42, shade(shirt, 0.9));
    part(0.24, -0.08, 0.68, 0.1, 0.16, 0.42, shade(shirt, 0.9));
    part(-0.18, -0.15, 1.17, 0.36, 0.3, 0.36, skin);
    part(-0.2, -0.17, 1.46, 0.4, 0.34, 0.12, hair);

    if (a.flashUntil && a.flashUntil > performance.now()) {
      const [hx, hy] = sc.project(cx, cy, 2.0);
      ctx.save();
      ctx.globalAlpha = (a.flashUntil - performance.now()) / 1500;
      ctx.fillStyle = ring;
      ctx.beginPath();
      ctx.arc(hx, hy, sc.scale * 0.18, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------- etiquetas
  showLabelFor(a) {
    if (this.labelsMode === 'all') return true;
    if (this.labelsMode === 'none') return a.id === this.selected || a.id === this.hovered;
    if (a.id === this.selected || a.id === this.hovered) return true;
    if (!this.matches(a)) return false;
    if (['erro', 'desconectado', 'bloqueado'].includes(a.state)) return true;
    if (this.focusedDept === a.department) return true;
    return this.scene.scale >= 30;
  }

  drawLabels() {
    const sc = this.scene;
    const ctx = sc.ctx;
    const small = sc.scale < 18;
    // placas dos departamentos
    for (const d of this.departments) {
      const { x, y } = roomOrigin(d.id);
      const lower = Math.floor((d.id - 1) / 5) === 1;
      const [vx, vy] = sc.rot(x + ROOM_W / 2, y + (lower ? ROOM_D - 0.6 : 0.6));
      const [sx, sy] = sc.project(vx, vy, 2.2);
      const text = small ? `${String(d.id).padStart(2, '0')} ${d.code}` : `${String(d.id).padStart(2, '0')} · ${d.name.toUpperCase()}`;
      ctx.font = `600 ${small ? 9 : 10}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      const w = ctx.measureText(text).width + 16;
      ctx.fillStyle = 'rgba(16,12,10,0.86)';
      roundRect(ctx, sx - w / 2, sy - 10, w, 20, 10);
      ctx.fill();
      ctx.strokeStyle = d.color;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#efe3c8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, sx, sy + 0.5);
    }
    // nomes dos agentes
    ctx.font = '600 10.5px system-ui, -apple-system, Segoe UI, sans-serif';
    for (const [id, pos] of this.agentBoxes) {
      const a = this.agents.get(id);
      if (!a || !this.showLabelFor(a)) continue;
      const [vx, vy] = sc.rot(pos.x, pos.y);
      const [sx, sy] = sc.project(vx, vy, 2.05);
      const name = a.name.length > 22 ? a.name.slice(0, 21) + '…' : a.name;
      const w = ctx.measureText(name).width + 22;
      const sel = id === this.selected;
      ctx.fillStyle = sel ? 'rgba(212,166,74,0.95)' : 'rgba(10,10,12,0.88)';
      roundRect(ctx, sx - w / 2, sy - 9, w, 18, 3);
      ctx.fill();
      ctx.fillStyle = sel ? '#14100c' : '#f2efe8';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, sx - w / 2 + 6, sy + 0.5);
      ctx.beginPath();
      ctx.arc(sx + w / 2 - 8, sy, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = STATE_COLORS[a.state] ?? '#888';
      ctx.fill();
    }
  }

  // ---------------------------------------------------------------- interação
  pick(sx, sy) {
    const sc = this.scene;
    let best = null;
    let bestD = Infinity;
    for (const [id, pos] of this.agentBoxes) {
      const [vx, vy] = sc.rot(pos.x, pos.y);
      const [ax, ay] = sc.project(vx, vy, 0.85);
      const dx = (sx - ax) / sc.scale;
      const dy = (sy - ay) / sc.scale;
      const d = dx * dx * 4 + dy * dy;
      if (Math.abs(dx) < 0.55 && Math.abs(dy) < 1.15 && d < bestD) { best = id; bestD = d; }
    }
    if (best) return { type: 'agent', id: best };
    for (const d of this.departments) {
      const { x, y } = roomOrigin(d.id);
      if (pointInPoly(sx, sy, sc.floorPoly(x, y, ROOM_W, ROOM_D, 0))) return { type: 'room', id: d.id };
    }
    return null;
  }

  focusDept(id) {
    this.focusedDept = id;
    const { x, y } = roomOrigin(id);
    const sc = this.scene;
    const target = Math.min(sc.width / 14, sc.height / 9, 60);
    sc.focus(x + ROOM_W / 2, y + ROOM_D / 2, Math.max(target, 20));
    sc.panX -= this.rightInset / 2;
    this.dirty = true;
  }

  focusAgent(id) {
    const pos = this.agentBoxes.get(id);
    if (!pos) return;
    this.selected = id;
    this.focusedDept = Math.ceil(id / 5);
    const sc = this.scene;
    sc.focus(pos.x, pos.y, Math.max(sc.scale, Math.min(sc.width / 14, 46)));
    sc.panX -= this.rightInset / 2;
    this.dirty = true;
  }

  overview() {
    this.focusedDept = null;
    const m = this.scene.width < 760;
    this.scene.fit(m ? { top: 96, right: 6, bottom: 110, left: 6 } : { top: 150, right: 90, bottom: 80, left: 30 });
    // No celular o prédio é limitado pela largura: começa mais próximo e o operador arrasta para navegar.
    if (m) this.scene.scale *= 1.6;
    this.dirty = true;
  }

  rotate(dir) {
    this.scene.setRotation(this.scene.rotation + dir);
    this.rebuild();
    if (this.selected) this.focusAgent(this.selected);
    else if (this.focusedDept) this.focusDept(this.focusedDept);
    else this.overview();
  }

  render(t) {
    this.scene.render(t);
    this.drawLabels();
    this.dirty = false;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
