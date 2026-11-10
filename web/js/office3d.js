// Escritório virtual em WebGL (three.js): prédio com 10 salas, 50 agentes em voxel, câmera orbital,
// paredes que baixam no lado da câmera, anéis de estado e arcos de dependência do agente selecionado.
// Mesma interface pública do escritório isométrico (office.js), que continua como alternativa sem WebGL.
import * as THREE from '../vendor/three.module.min.js';
import { Office, STATE_COLORS, LAYOUT, roomOrigin, agentSpot } from './office.js';

const { ROOM_W, ROOM_D, WORLD_W, WORLD_D } = LAYOUT;
const OX = -WORLD_W / 2; // o prédio fica centrado na origem
const OZ = -WORLD_D / 2;

const C = {
  slab: '#8f6e66', outer: '#a7837b', outerTop: '#c79d93', floor: '#e8dcc7', corridor: '#d8cbb5',
  wall: '#9a9fa8', wallTop: '#c3c8ce', legs: '#2d3240',
  skin: ['#f1c7a3', '#d9a27a', '#a8704a', '#7a4e33', '#f5d6bd'],
  hair: ['#2b2420', '#5a3b22', '#d8b25a', '#1d1d24', '#8e4b2a', '#c9c9c9'],
  depends: '#f2c14e', dependents: '#6cb6ff',
};

const hash = (n) => { const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lighten = (hex, k) => '#' + new THREE.Color(hex).multiplyScalar(k).getHexString();

/** Junta caixas {x, y (profundidade), z (altura), w, d, h, color, style.top} em uma única geometria com cor por vértice. */
function buildBoxes(items) {
  const pos = [];
  const nor = [];
  const col = [];
  const idx = [];
  const cSide = new THREE.Color();
  const cTop = new THREE.Color();
  for (const it of items) {
    const x0 = it.x, x1 = it.x + it.w, y0 = it.z, y1 = it.z + it.h, z0 = it.y, z1 = it.y + it.d;
    cSide.set(it.style?.side ?? it.color);
    cTop.set(it.style?.top ?? lighten(it.color, 1.12));
    const faces = [
      [0, 1, 0, x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, cTop],
      [0, -1, 0, x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, cSide],
      [0, 0, 1, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, cSide],
      [0, 0, -1, x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, cSide],
      [1, 0, 0, x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, cSide],
      [-1, 0, 0, x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, cSide],
    ];
    for (const f of faces) {
      const base = pos.length / 3;
      for (let v = 0; v < 4; v++) {
        pos.push(f[3 + v * 3], f[4 + v * 3], f[5 + v * 3]);
        nor.push(f[0], f[1], f[2]);
        col.push(f[15].r, f[15].g, f[15].b);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

export class Office3D {
  constructor(canvas, departments) {
    this.is3d = true;
    this.canvas = canvas;
    this.departments = departments;
    this.agents = new Map();
    this.filter = { states: new Set(), dept: null, query: '' };
    this.selected = null;
    this.hovered = null;
    this.focusedDept = null;
    this.labelsMode = 'auto';
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.rightInset = 0;
    this.dirty = true;
    this.width = 1;
    this.height = 1;

    // Lança erro se o WebGL não estiver disponível: quem chama cai no escritório isométrico.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(26, 1, 1, 600);
    this.cam = { az: Math.PI / 4, pol: 0.92, dist: 90, tx: 0, tz: 0 };
    this.goal = { ...this.cam };

    this.labels = document.createElement('canvas');
    this.labels.id = 'officeLabels';
    this.labels.setAttribute('aria-hidden', 'true');
    canvas.insertAdjacentElement('afterend', this.labels);
    this.lctx = this.labels.getContext('2d');

    this.ray = new THREE.Raycaster();
    this.tmp = new THREE.Vector3();
    this.build();
    this.resize();
  }

  // ---------------------------------------------------------------- dados
  setAgents(list) {
    for (const a of list) this.agents.set(a.id, { ...(this.agents.get(a.id) ?? {}), ...a });
    this.dirty = true;
  }

  updateAgentState(id, state) {
    const a = this.agents.get(id);
    if (a) { a.state = state; a.flashUntil = performance.now() + 1500; this.dirty = true; }
  }

  matches(a) {
    return Office.prototype.matches.call(this, a);
  }

  // ---------------------------------------------------------------- construção da cena
  build() {
    const sc = this.scene;
    sc.add(new THREE.HemisphereLight(0xffffff, 0x9a8478, 1.5));
    const sun = new THREE.DirectionalLight(0xfff1dc, 1.9);
    sun.position.set(-26, 46, 18);
    sc.add(sun);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.root = new THREE.Group();
    this.root.position.set(OX, 0, OZ);
    sc.add(this.root);
    const mesh = (items) => { const m = new THREE.Mesh(buildBoxes(items), mat); this.root.add(m); return m; };

    // laje, piso do corredor, pisos das salas e faixa colorida de cada departamento
    const floors = [
      { x: -0.9, y: -0.9, z: -0.5, w: WORLD_W + 1.8, d: WORLD_D + 1.8, h: 0.5, color: C.slab, style: { top: C.corridor } },
    ];
    for (const d of this.departments) {
      const { x, y } = roomOrigin(d.id);
      const lower = d.id > 5;
      floors.push({ x, y, z: 0, w: ROOM_W, d: ROOM_D, h: 0.02, color: C.floor, style: { top: C.floor } });
      floors.push({ x: x + 0.3, y: lower ? y + ROOM_D - 0.65 : y + 0.3, z: 0.02, w: ROOM_W - 0.6, d: 0.35, h: 0.02, color: d.color, style: { top: d.color } });
    }
    mesh(floors);

    // paredes agrupadas por lado: o lado voltado para a câmera baixa para não esconder a sala
    const T = 0.45;
    const wt = 0.22;
    const sides = { n: [], s: [], w: [], e: [] };
    const outer = { n: [], s: [], w: [], e: [] };
    outer.n.push({ x: -T, y: -T, z: 0, w: WORLD_W + 2 * T, d: T, h: 1.3, color: C.outer, style: { top: C.outerTop } });
    outer.s.push({ x: -T, y: WORLD_D, z: 0, w: WORLD_W + 2 * T, d: T, h: 1.3, color: C.outer, style: { top: C.outerTop } });
    outer.w.push({ x: -T, y: 0, z: 0, w: T, d: WORLD_D, h: 1.3, color: C.outer, style: { top: C.outerTop } });
    outer.e.push({ x: WORLD_W, y: 0, z: 0, w: T, d: WORLD_D, h: 1.3, color: C.outer, style: { top: C.outerTop } });
    const furniture = [];
    for (const d of this.departments) {
      const { x, y } = roomOrigin(d.id);
      const lower = d.id > 5;
      const wall = (side, bx, by, w, dd) => sides[side].push({ x: bx, y: by, z: 0, w, d: dd, h: 1.6, color: C.wall, style: { top: C.wallTop } });
      const withDoor = (side, by) => { // porta voltada ao corredor central
        const half = ROOM_W / 2 - 1;
        wall(side, x, by, half, wt);
        wall(side, x + half + 2, by, half, wt);
      };
      if (lower) withDoor('n', y); else wall('n', x, y, ROOM_W, wt);
      if (lower) wall('s', x, y + ROOM_D - wt, ROOM_W, wt); else withDoor('s', y + ROOM_D - wt);
      wall('w', x, y + wt, wt, ROOM_D - 2 * wt);
      wall('e', x + ROOM_W - wt, y + wt, wt, ROOM_D - 2 * wt);
      Office.prototype.furnish.call(null, d, x, y, furniture); // mesmo mobiliário temático do isométrico
    }
    mesh(furniture);
    this.walls = [];
    const normals = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] };
    for (const k of Object.keys(sides)) {
      this.walls.push({ mesh: mesh(sides[k]), normal: normals[k], low: 0.16 });
      this.walls.push({ mesh: mesh(outer[k]), normal: normals[k], low: 0.4 });
    }

    // contorno da sala em foco
    this.outlines = new Map();
    for (const d of this.departments) {
      const { x, y } = roomOrigin(d.id);
      const pts = [[x, y], [x + ROOM_W, y], [x + ROOM_W, y + ROOM_D], [x, y + ROOM_D]].map(([px, pz]) => new THREE.Vector3(px, 0.07, pz));
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: d.color }));
      line.visible = false;
      this.root.add(line);
      this.outlines.set(d.id, line);
    }

    // agentes: corpo em voxel (uma geometria por agente), anel de estado e disco de seleção
    this.figures = new Map();
    const ringGeo = new THREE.RingGeometry(0.44, 0.6, 28).rotateX(-Math.PI / 2);
    const discGeo = new THREE.CircleGeometry(0.44, 28).rotateX(-Math.PI / 2);
    const haloGeo = new THREE.RingGeometry(0.68, 0.8, 32).rotateX(-Math.PI / 2);
    for (let id = 1; id <= 50; id++) {
      const dept = this.departments.find((d) => d.id === Math.ceil(id / 5));
      const p = agentSpot(id);
      const shirt = dept?.color ?? '#888888';
      const seed = id * 7;
      const skin = C.skin[Math.floor(hash(seed) * C.skin.length)];
      const hair = C.hair[Math.floor(hash(seed + 3) * C.hair.length)];
      const arm = lighten(shirt, 0.86);
      const part = (x, y, z, w, d, h, color) => ({ x, y, z, w, d, h, color, style: { top: color } });
      const body = new THREE.Mesh(buildBoxes([
        part(-0.2, -0.1, 0, 0.17, 0.2, 0.62, C.legs), part(0.03, -0.1, 0, 0.17, 0.2, 0.62, C.legs),
        part(-0.24, -0.14, 0.62, 0.48, 0.28, 0.55, shirt),
        part(-0.34, -0.08, 0.68, 0.1, 0.16, 0.42, arm), part(0.24, -0.08, 0.68, 0.1, 0.16, 0.42, arm),
        part(-0.18, -0.15, 1.17, 0.36, 0.3, 0.36, skin), part(-0.2, -0.17, 1.46, 0.4, 0.34, 0.12, hair),
      ]), new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true }));
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ transparent: true }));
      const disc = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.28 }));
      const halo = new THREE.Mesh(haloGeo, new THREE.MeshBasicMaterial({ color: '#f0c96a' }));
      ring.position.y = disc.position.y = 0.05;
      halo.position.y = 0.06;
      halo.visible = false;
      const g = new THREE.Group();
      g.position.set(p.x, 0, p.y);
      if (id > 25) body.rotation.y = Math.PI; // a fileira de baixo trabalha de frente para as mesas do sul
      g.add(disc, ring, halo, body);
      this.root.add(g);
      const box = new THREE.Box3(new THREE.Vector3(p.x + OX - 0.45, 0, p.y + OZ - 0.45), new THREE.Vector3(p.x + OX + 0.45, 1.75, p.y + OZ + 0.45));
      this.figures.set(id, { group: g, body, ring, disc, halo, box, world: new THREE.Vector3(p.x + OX, 0, p.y + OZ), seed });
    }

    this.arcs = new THREE.Group();
    this.scene.add(this.arcs);
    this.arcsFor = null;
    this.linked = new Set();
  }

  // ---------------------------------------------------------------- câmera
  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, r.width);
    this.height = Math.max(1, r.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.width, this.height, false);
    this.labels.width = Math.round(this.width * dpr);
    this.labels.height = Math.round(this.height * dpr);
    this.lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.camera.aspect = this.width / this.height;
    this.dirty = true;
  }

  placeCamera(c) {
    const s = Math.sin(c.pol);
    this.camera.position.set(c.tx + c.dist * s * Math.sin(c.az), c.dist * Math.cos(c.pol), c.tz + c.dist * s * Math.cos(c.az));
    this.camera.lookAt(c.tx, 0.6, c.tz);
    const inset = this.width > 760 ? this.rightInset : 0;
    if (inset) this.camera.setViewOffset(this.width, this.height, inset / 2, 0, this.width, this.height);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  /** Aproxima (fator > 1) ou afasta. */
  zoomAt(factor) {
    this.goal.dist = clamp(this.goal.dist / factor, 9, 190);
    this.dirty = true;
  }

  /** Arrasta o prédio pelo chão, em pixels de tela. */
  panBy(dx, dy) {
    const wpp = (2 * this.cam.dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / this.height;
    const s = Math.sin(this.cam.az);
    const c = Math.cos(this.cam.az);
    const fwd = (dy * wpp) / Math.max(0.25, Math.cos(this.cam.pol));
    const tx = this.goal.tx - c * dx * wpp - s * fwd;
    const tz = this.goal.tz + s * dx * wpp - c * fwd;
    this.goal.tx = this.cam.tx = clamp(tx, -WORLD_W * 0.7, WORLD_W * 0.7);
    this.goal.tz = this.cam.tz = clamp(tz, -WORLD_D * 0.9, WORLD_D * 0.9);
    this.dirty = true;
  }

  /** Gira (azimute) e inclina (polar) a câmera, em radianos. */
  orbitBy(dAz, dPol, snap = true) {
    this.goal.az += dAz;
    this.goal.pol = clamp(this.goal.pol + dPol, 0.12, 1.3);
    if (snap) { this.cam.az = this.goal.az; this.cam.pol = this.goal.pol; }
    this.dirty = true;
  }

  rotate(dir) {
    this.orbitBy((dir * Math.PI) / 4, 0, false);
    if (!this.focusedDept && !this.selected) this.overview(); // reenquadra o prédio no novo ângulo
  }

  /** Distância em que os pontos dados cabem na tela, respeitando as margens ocupadas pelo HUD. */
  fitDistance(points, tx, tz, inset) {
    const mx = 1 - (inset.left + inset.right) / this.width;
    const top = 1 - (2 * inset.top) / this.height;
    const bottom = -1 + (2 * inset.bottom) / this.height;
    let lo = 6;
    let hi = 400;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      this.placeCamera({ ...this.goal, tx, tz, dist: mid });
      const fits = points.every((p) => { const v = this.tmp.copy(p).project(this.camera); return Math.abs(v.x) <= mx && v.y <= top && v.y >= bottom; });
      if (fits) hi = mid; else lo = mid;
    }
    this.placeCamera(this.cam);
    return hi;
  }

  overview() {
    this.focusedDept = null;
    const m = this.width < 760;
    const pts = [];
    for (const x of [OX, -OX]) for (const z of [OZ, -OZ]) for (const y of [0, 1.6]) pts.push(new THREE.Vector3(x, y, z));
    const dist = this.fitDistance(pts, 0, 0, m ? { top: 96, right: 4, bottom: 120, left: 4 } : { top: 96, right: 16, bottom: 30, left: 16 });
    // No celular o prédio é limitado pela largura: começa mais perto e o operador arrasta para navegar.
    Object.assign(this.goal, { tx: 0, tz: 0, dist: m ? dist * 0.62 : dist });
    this.dirty = true;
  }

  focusDept(id) {
    this.focusedDept = id;
    const { x, y } = roomOrigin(id);
    const cx = x + ROOM_W / 2 + OX;
    const cz = y + ROOM_D / 2 + OZ;
    const pts = [];
    for (const px of [x, x + ROOM_W]) for (const pz of [y, y + ROOM_D]) for (const h of [0, 2.4]) pts.push(new THREE.Vector3(px + OX, h, pz + OZ));
    const m = this.width < 760;
    const dist = this.fitDistance(pts, cx, cz, m ? { top: 90, right: 10, bottom: 130, left: 10 } : { top: 150, right: 120 + this.rightInset / 2, bottom: 110, left: 120 + this.rightInset / 2 });
    Object.assign(this.goal, { tx: cx, tz: cz, dist: clamp(dist, 14, 120) });
    this.dirty = true;
  }

  focusAgent(id) {
    const f = this.figures.get(id);
    if (!f) return;
    this.selected = id;
    this.focusedDept = Math.ceil(id / 5);
    Object.assign(this.goal, { tx: f.world.x, tz: f.world.z, dist: Math.min(this.goal.dist, this.width < 760 ? 78 : 64) });
    this.dirty = true;
  }

  // ---------------------------------------------------------------- interação
  pick(sx, sy) {
    this.ray.setFromCamera({ x: (sx / this.width) * 2 - 1, y: -(sy / this.height) * 2 + 1 }, this.camera);
    const ray = this.ray.ray;
    let best = null;
    let bestD = Infinity;
    for (const [id, f] of this.figures) {
      const hit = ray.intersectBox(f.box, this.tmp);
      if (!hit) continue;
      const d = hit.distanceToSquared(ray.origin);
      if (d < bestD) { best = id; bestD = d; }
    }
    if (best) return { type: 'agent', id: best };
    const ground = ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), this.tmp);
    if (!ground) return null;
    const gx = ground.x - OX;
    const gz = ground.z - OZ;
    for (const d of this.departments) {
      const { x, y } = roomOrigin(d.id);
      if (gx >= x && gx <= x + ROOM_W && gz >= y && gz <= y + ROOM_D) return { type: 'room', id: d.id };
    }
    return null;
  }

  // ---------------------------------------------------------------- dependências do agente selecionado
  rebuildArcs() {
    this.arcsFor = this.selected;
    for (const m of this.arcs.children) { m.geometry.dispose(); m.material.dispose(); }
    this.arcs.clear();
    this.linked.clear();
    const sel = this.selected ? this.agents.get(this.selected) : null;
    if (!sel) return;
    const arc = (fromId, toId, color) => {
      const a = this.figures.get(fromId)?.world;
      const b = this.figures.get(toId)?.world;
      if (!a || !b) return;
      const mid = a.clone().lerp(b, 0.5);
      mid.y = 2.6 + a.distanceTo(b) * 0.22;
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(a.x, 1.75, a.z), mid, new THREE.Vector3(b.x, 1.75, b.z));
      this.arcs.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 28, 0.055, 6), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 })));
    };
    for (const dep of sel.dependsOn ?? []) { arc(dep, sel.id, C.depends); this.linked.add(dep); }
    for (const a of this.agents.values()) if (a.dependsOn?.includes(sel.id)) { arc(sel.id, a.id, C.dependents); this.linked.add(a.id); }
  }

  // ---------------------------------------------------------------- desenho
  render(t) {
    // câmera: aproxima suavemente do alvo
    const k = this.reducedMotion ? 1 : 0.2;
    let moving = false;
    for (const key of ['az', 'pol', 'dist', 'tx', 'tz']) {
      const d = this.goal[key] - this.cam[key];
      if (Math.abs(d) > 0.002) { this.cam[key] += d * k; moving = true; } else this.cam[key] = this.goal[key];
    }
    this.placeCamera(this.cam);

    // paredes do lado da câmera ficam baixas
    const sx = Math.sin(this.cam.az);
    const sz = Math.cos(this.cam.az);
    for (const w of this.walls) {
      const target = w.normal[0] * sx + w.normal[1] * sz > 0.25 ? w.low : 1;
      const d = target - w.mesh.scale.y;
      if (Math.abs(d) > 0.01) { w.mesh.scale.y += d * (this.reducedMotion ? 1 : 0.25); moving = true; } else w.mesh.scale.y = target;
    }

    if (this.arcsFor !== this.selected) this.rebuildArcs();
    for (const [id, line] of this.outlines) line.visible = this.focusedDept === id || this.filter.dept === id;

    const now = performance.now();
    for (const [id, f] of this.figures) {
      const a = this.agents.get(id);
      if (!a) { f.group.visible = false; continue; }
      f.group.visible = true;
      const state = a.state ?? 'ocioso';
      const shown = this.matches(a);
      const color = STATE_COLORS[state] ?? '#888888';
      f.body.material.opacity = shown ? 1 : 0.16;
      f.ring.material.color.set(color);
      f.disc.material.color.set(color);
      f.ring.material.opacity = (shown ? 1 : 0.2) * (state === 'erro' ? 0.5 + 0.5 * Math.abs(Math.sin(t / 250)) : state === 'desconectado' ? 0.55 : 0.95);
      f.disc.material.opacity = shown ? 0.28 : 0.06;
      const animate = !this.reducedMotion && (state === 'operacional' || state === 'aguardando');
      f.body.position.y = animate ? Math.abs(Math.sin(t / 380 + f.seed)) * 0.07 : 0;
      f.halo.visible = id === this.selected || id === this.hovered;
      const flash = a.flashUntil && a.flashUntil > now ? (a.flashUntil - now) / 1500 : 0;
      f.ring.scale.setScalar(1 + flash * 0.6);
    }

    this.renderer.render(this.scene, this.camera);
    this.drawLabels();
    this.dirty = moving;
  }

  showLabelFor(a) {
    if (this.labelsMode === 'all') return true;
    const sel = a.id === this.selected || a.id === this.hovered;
    if (this.labelsMode === 'none') return sel;
    if (sel || this.linked.has(a.id)) return true;
    if (!this.matches(a)) return false;
    if (a.state === 'erro') return true;
    if (this.focusedDept === a.department) return true;
    return this.cam.dist < 48 && this.width >= 760;
  }

  toScreen(x, y, z) {
    const v = this.tmp.set(x, y, z).project(this.camera);
    if (v.z > 1) return null;
    return [(v.x * 0.5 + 0.5) * this.width, (-v.y * 0.5 + 0.5) * this.height];
  }

  drawLabels() {
    const ctx = this.lctx;
    ctx.clearRect(0, 0, this.width, this.height);
    const small = this.width < 760 || this.cam.dist > 95;
    // placas dos departamentos
    for (const d of this.departments) {
      const { x, y } = roomOrigin(d.id);
      const p = this.toScreen(x + ROOM_W / 2 + OX, 2.5, y + ROOM_D / 2 + OZ);
      if (!p) continue;
      const text = small ? `${String(d.id).padStart(2, '0')} ${d.code}` : `${String(d.id).padStart(2, '0')} · ${d.name.toUpperCase()}`;
      ctx.font = `600 ${small ? 9 : 10}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      const w = ctx.measureText(text).width + 16;
      ctx.fillStyle = 'rgba(16,12,10,0.88)';
      roundRect(ctx, p[0] - w / 2, p[1] - 10, w, 20, 10);
      ctx.fill();
      ctx.strokeStyle = d.color;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#efe3c8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, p[0], p[1] + 0.5);
    }
    // etiquetas dos agentes (como na referência: caixa escura com o ponto de estado)
    ctx.font = '600 10.5px system-ui, -apple-system, Segoe UI, sans-serif';
    for (const [id, f] of this.figures) {
      const a = this.agents.get(id);
      if (!a || !this.showLabelFor(a)) continue;
      const p = this.toScreen(f.world.x, 2.0, f.world.z);
      if (!p) continue;
      const name = a.name.length > 22 ? a.name.slice(0, 21) + '…' : a.name;
      const w = ctx.measureText(name).width + 22;
      const sel = id === this.selected;
      ctx.fillStyle = sel ? 'rgba(212,166,74,0.96)' : 'rgba(10,10,12,0.9)';
      roundRect(ctx, p[0] - w / 2, p[1] - 9, w, 18, 3);
      ctx.fill();
      ctx.fillStyle = sel ? '#14100c' : '#f2efe8';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, p[0] - w / 2 + 6, p[1] + 0.5);
      ctx.beginPath();
      ctx.arc(p[0] + w / 2 - 8, p[1], 3.5, 0, Math.PI * 2);
      ctx.fillStyle = STATE_COLORS[a.state] ?? '#888';
      ctx.fill();
    }
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
