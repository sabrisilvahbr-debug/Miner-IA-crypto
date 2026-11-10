// Interface do operador: escritório 3D, filtros, fichas dos agentes, console, alertas, ações, métricas e relatórios.
import { api, connectStream, setToken, UnauthorizedError } from './api.js';
import { Office, STATE_COLORS } from './office.js';

const STATES = ['operacional', 'ocioso', 'aguardando', 'erro', 'bloqueado', 'desconectado'];
const STATE_LABEL = { operacional: 'Operacional', ocioso: 'Ocioso', aguardando: 'Aguardando', erro: 'Erro', bloqueado: 'Bloqueado', desconectado: 'Desconectado' };
const MODE_LABEL = { continuous: 'Contínuo', scheduled: 'Agendado', event: 'Por evento' };
const MATURITY_LABEL = { stub: 'PARCIALMENTE IMPLEMENTADO', simulado: 'IMPLEMENTADO, MAS NÃO VALIDADO', validado: 'IMPLEMENTADO E TESTADO' };

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const st = {
  departments: [],
  agents: new Map(),
  summary: null,
  events: [],
  panel: null,
  office: null,
  streamOk: false,
};

// ---------------------------------------------------------------- formatação
const pad = (n) => String(n).padStart(2, '0');
function fmtTime(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
function fmtAgo(ts) {
  if (!ts) return 'nunca';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `há ${s}s`;
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return new Date(ts).toLocaleString('pt-BR');
}
function fmtMs(ms) {
  if (!ms) return '—';
  if (ms < 60_000) return `${ms / 1000}s`;
  if (ms < 3_600_000) return `${ms / 60_000} min`;
  return `${ms / 3_600_000} h`;
}
function fmtHash(v) {
  const u = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s', 'ZH/s'];
  let i = 0; let x = v;
  while (x >= 1000 && i < u.length - 1) { x /= 1000; i++; }
  return `${x.toFixed(2)} ${u[i]}`;
}
function fmtValue(m) {
  const v = m.value;
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'sim' : 'não';
  if (typeof v !== 'number') return esc(v);
  if (m.unit === 'H/s') return fmtHash(v);
  if (m.unit === 'BTC') return `${v.toFixed(8)} BTC`;
  if (m.key.endsWith('_at')) return fmtAgo(v);
  if (Math.abs(v) >= 1e9) return v.toExponential(3) + (m.unit ? ` ${esc(m.unit)}` : '');
  const digits = Math.abs(v) < 10 && !Number.isInteger(v) ? 3 : Number.isInteger(v) ? 0 : 2;
  return v.toLocaleString('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: 0 }) + (m.unit ? ` ${esc(m.unit)}` : '');
}
const tag = (p) => `<span class="tag ${esc(p)}">${esc(p)}</span>`;
// Rótulos de estado exibidos ao operador (nunca escondem erro nem ausência de dado).
const STATE_TAG = {
  REAL: ['real', 'REAL'], ESTIMADO: ['estimado', 'ESTIMADO'], 'DADOS DESATUALIZADOS': ['desatualizado', 'DESATUALIZADO'],
  INDISPONÍVEL: ['indisponivel', 'INDISPONÍVEL'], ERRO: ['erro', 'ERRO'], 'NÃO IMPLEMENTADO': ['naoimpl', 'NÃO IMPLEMENTADO'], 'NÃO CONFIGURADO': ['naoimpl', 'NÃO CONFIGURADO'], INATIVO: ['indisponivel', 'INATIVO'],
  'HASHRATE NÃO MEDIDO': ['indisponivel', 'HASHRATE NÃO MEDIDO'], 'POOL NÃO CONECTADA': ['indisponivel', 'POOL NÃO CONECTADA'],
  'NENHUMA SHARE ACEITA CONFIRMADA': ['indisponivel', 'NENHUMA SHARE ACEITA CONFIRMADA'], INATIVO: ['indisponivel', 'INATIVO'],
  'HARDWARE NÃO VERIFICADO': ['indisponivel', 'HARDWARE NÃO VERIFICADO'],
};
const stTag = (label) => { const [c, t] = STATE_TAG[label] ?? ['indisponivel', label]; return `<span class="tag ${c}">${esc(t)}</span>`; };
const stateBadge = (s) => `<span class="state-badge"><i style="background:${STATE_COLORS[s] ?? '#888'}"></i>${esc(STATE_LABEL[s] ?? s)}</span>`;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------------------------------------------------------------- dados
async function load() {
  const [departments, agents, summary, events] = await Promise.all([
    api('/api/departments'), api('/api/agents'), api('/api/summary'), api('/api/events?limit=80'),
  ]);
  st.departments = departments;
  for (const a of agents) st.agents.set(a.id, a);
  st.summary = summary;
  st.events = events.reverse();
}

async function refreshSummary() {
  try {
    const [summary, agents] = await Promise.all([api('/api/summary'), api('/api/agents')]);
    st.summary = summary;
    for (const a of agents) st.agents.set(a.id, a);
    st.office.setAgents(agents);
    renderHud();
  } catch (e) {
    if (e instanceof UnauthorizedError) askToken();
  }
}

// ---------------------------------------------------------------- HUD
function counts() {
  const c = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const a of st.agents.values()) c[a.state] = (c[a.state] ?? 0) + 1;
  return c;
}

function renderHud() {
  renderRoster();
  renderDirectory();
  renderEvidence();
  renderTop();
}

function renderRoster() {
  const c = counts();
  const f = st.office.filter.states;
  $('#roster').innerHTML =
    `<button class="chip total${f.size ? '' : ' on'}" data-state="">◉ ${st.agents.size} AGENTES</button>` +
    STATES.map((s) => `<button class="chip${f.has(s) ? ' on' : ''}" data-state="${s}" title="Filtrar: ${STATE_LABEL[s]}"><i style="background:${STATE_COLORS[s]}"></i>${STATE_LABEL[s].toUpperCase()} ${c[s]}</button>`).join('');
}

function renderDirectory() {
  const el = $('#directory');
  el.innerHTML = st.departments.map((d) => {
    const agents = [...st.agents.values()].filter((a) => a.department === d.id);
    const on = st.office.filter.dept === d.id || st.office.focusedDept === d.id;
    return `<button class="dir-item${on ? ' on' : ''}" data-dept="${d.id}"><span class="num">${pad(d.id)}</span><span>${esc(d.name)}</span><span class="bar">${agents.map((a) => `<i title="${esc(a.name)}" style="background:${STATE_COLORS[a.state]}"></i>`).join('')}</span></button>`;
  }).join('');
  const s = st.summary;
  if (s) {
    const dept = st.office.focusedDept ? st.departments.find((d) => d.id === st.office.focusedDept) : null;
    $('#floorName').textContent = dept ? dept.name : 'Andar de Mineração';
    $('#floorMeta').textContent = dept ? `SETOR ${pad(dept.id)} · AGENTES ${dept.id * 5 - 4}–${dept.id * 5}` : `OFFICE 50 · ROSTER ${s.collective.total} | CARREGADO`;
  }
}

function renderEvidence() {
  const s = st.summary;
  if (!s) return;
  const e = s.evidence;
  $('#evidence').innerHTML = `
    <h3><span>EVIDÊNCIA DE MINERAÇÃO</span><span>${e.simulated ? tag('simulado') : e.level ? tag('real') : ''}</span></h3>
    <div class="lvl">Nível ${e.level} de 5 · ${esc(e.label)}</div>
    <p>${esc(e.statement)}</p>
    <div class="steps${e.simulated ? ' sim' : ''}">${e.steps.map((x) => `<i class="${x.met ? 'met' : ''}" title="${esc(x.label)}"></i>`).join('')}</div>`;
  const vals = Object.values(s.sources);
  const anySim = vals.some((v) => v === 'simulated');
  const anyReal = vals.some((v) => v !== 'simulated' && v !== 'none');
  const badge = $('#modeBadge');
  badge.textContent = anySim ? 'SIMULADO — SOMENTE EM TESTES' : anyReal ? (vals.includes('none') ? 'FONTES REAIS (PARCIAIS)' : 'FONTES REAIS') : 'SEM FONTES CONFIGURADAS';
  badge.title = s.simulationRejected?.length ? `Simulação recusada em produção: ${s.simulationRejected.join(', ')}` : '';
  badge.classList.toggle('real', !anySim && anyReal);
  badge.classList.toggle('none', !anySim && !anyReal);
}

function renderTop() {
  const s = st.summary;
  if (!s) return;
  const paused = s.pause.paused;
  $('#sysDot').classList.toggle('paused', paused);
  $('#sysState').textContent = paused ? `Pausado · ${s.pause.reason ?? ''}` : `Em operação · risco ${s.risk}`;
  const b = $('#btnPause');
  b.textContent = paused ? 'Retomar sistema' : 'Pausar sistema';
  b.className = paused ? 'btn ok' : 'btn danger';
  $('#navAlerts').textContent = s.alertsOpen || '';
  $('#navActions').textContent = s.actionsPending || '';
}

// ---------------------------------------------------------------- console de eventos
function pushEvent(e) {
  st.events.push(e);
  if (st.events.length > 400) st.events.splice(0, st.events.length - 400);
  renderConsole();
}

function renderConsole() {
  const list = $('#consoleList');
  const items = st.events.slice(-150).reverse();
  list.innerHTML = items.map((e) => `<li><time>${fmtTime(e.ts)}</time><span class="sev ${esc(e.severity)}">${esc(e.severity.toUpperCase())}</span><span>${e.agentId ? `<b>A${pad(e.agentId)}</b> ` : ''}${esc(e.message)}</span></li>`).join('');
  $('#consoleMeta').innerHTML = `AGENTES ${st.agents.size} |<br>EVENTOS ${st.events.length}`;
}

// ---------------------------------------------------------------- painéis
function openPanel(kind, arg) {
  st.panel = { kind, arg };
  $('#panel').hidden = false;
  st.office.rightInset = window.innerWidth > 760 ? $('#panel').offsetWidth : 0;
  setActiveNav(kind === 'agent' || kind === 'dept' ? 'office' : kind);
  return renderPanel();
}

function closePanel() {
  st.panel = null;
  $('#panel').hidden = true;
  st.office.rightInset = 0;
  st.office.selected = null;
  st.office.dirty = true;
  setActiveNav('office');
}

function setActiveNav(view) {
  for (const b of document.querySelectorAll('#nav button, #tabbar button')) {
    const v = b.dataset.view;
    b.classList.toggle('active', v === view || (v === 'more' && ['actions', 'metrics', 'reports', 'risk', 'pool', 'celular', 'more'].includes(view)));
  }
}

function setPanel(kicker, title, html) {
  $('#panelKicker').textContent = kicker;
  $('#panelTitle').textContent = title;
  $('#panelBody').innerHTML = html;
}

async function renderPanel() {
  if (!st.panel) return;
  const { kind, arg } = st.panel;
  try {
    if (kind === 'agent') return await panelAgent(arg);
    if (kind === 'dept') return panelDept(arg);
    if (kind === 'agents') return panelAgents();
    if (kind === 'events') return await panelEvents();
    if (kind === 'alerts') return await panelAlerts();
    if (kind === 'actions') return await panelActions();
    if (kind === 'metrics') return await panelMetrics();
    if (kind === 'reports') return await panelReports();
    if (kind === 'risk') return await panelRisk();
    if (kind === 'pool') return await panelPool();
    if (kind === 'mining') return await panelMining();
    if (kind === 'celular') return await panelCelular();
    if (kind === 'more') return panelMore();
  } catch (e) {
    if (e instanceof UnauthorizedError) return askToken();
    setPanel('ERRO', 'Não foi possível carregar', `<p class="empty">${esc(e.message)}</p>`);
  }
}

async function panelAgent(id) {
  const a = await api(`/api/agents/${id}`);
  const dept = st.departments.find((d) => d.id === a.department);
  const outputs = a.outputsLatest.length
    ? `<div class="metric-grid">${a.outputsLatest.map((m) => `<span class="k">${esc(m.key)}</span><span class="v">${fmtValue(m)} ${tag(m.provenance)}</span>`).join('')}</div>`
    : '<p class="empty">Sem métricas publicadas ainda.</p>';
  const execs = a.executions.length
    ? a.executions.slice(0, 8).map((x) => `<div class="row"><div class="top"><span>${x.ok ? '✓' : '✗'} ${esc(x.status)} · tentativa ${x.attempt}</span><span class="meta">${fmtTime(x.started_at)} · ${x.duration_ms} ms</span></div>${x.summary || x.error ? `<div class="meta">${esc(x.summary ?? x.error)}</div>` : ''}</div>`).join('')
    : '<p class="empty">Nenhuma execução registrada.</p>';
  const events = a.events.length
    ? a.events.slice(0, 8).map((e) => `<div class="row"><div class="top"><span class="sev ${esc(e.severity)}">${esc(e.severity)}</span><span class="meta">${fmtTime(e.ts)}</span></div><div>${esc(e.message)}</div></div>`).join('')
    : '<p class="empty">Nenhum evento.</p>';
  setPanel(`${a.code} · ${dept ? dept.name.toUpperCase() : ''}`, a.name, `
    <div class="section"><p>${esc(a.responsibility)}</p>
      <dl class="kv">
        <dt>Estado</dt><dd>${stateBadge(a.state)}${a.running ? ' · executando' : ''}</dd>
        <dt>Execução</dt><dd>${esc(MODE_LABEL[a.mode])}${a.intervalMs ? ` · a cada ${fmtMs(a.intervalMs)}` : ''}${a.triggers?.length ? `<br><span class="meta">gatilhos: ${a.triggers.map(esc).join(', ')}</span>` : ''}</dd>
        <dt>Maturidade</dt><dd>${esc(MATURITY_LABEL[a.maturity] ?? a.maturity)}${a.essential ? ' · essencial (roda com sistema pausado)' : ''}</dd>
        <dt>Última execução</dt><dd>${fmtAgo(a.lastRunAt)}</dd>
        <dt>Último sucesso</dt><dd>${fmtAgo(a.lastSuccessAt)}</dd>
        <dt>Execuções</dt><dd>${a.runs} · falhas ${a.failures} · seguidas ${a.consecutiveFailures} · duplicatas evitadas ${a.duplicatesSkipped}</dd>
        ${a.lastError ? `<dt>Último erro</dt><dd style="color:var(--err)">${esc(a.lastError)} <span class="meta">${fmtAgo(a.lastErrorAt)}</span></dd>` : ''}
        ${a.lastSummary ? `<dt>Resumo</dt><dd>${esc(a.lastSummary)}</dd>` : ''}
      </dl>
      <div class="btn-row"><button class="btn" data-run="${a.id}">Executar agora</button></div>
    </div>
    ${healthSection(a)}
    <div class="section"><h4>Contrato</h4><dl class="kv">
      <dt>Entradas</dt><dd>${a.inputs.map(esc).join(' · ')}</dd>
      <dt>Saídas</dt><dd>${a.outputs.map(esc).join(' · ')}</dd>
      <dt>Permissões</dt><dd><code>${a.permissions.map(esc).join('</code> <code>')}</code></dd>
    </dl></div>
    <div class="section"><h4>Saídas atuais</h4>${outputs}</div>
    <div class="section"><h4>Execuções recentes</h4><div class="list">${execs}</div></div>
    <div class="section"><h4>Eventos do agente</h4><div class="list">${events}</div></div>`);
}

const HEALTH_LABEL = { ok: 'Saudável', atencao: 'Atenção', falha: 'Falha', indeterminado: 'Sem execução ainda' };
const CHECK_LABEL = { execucao: 'Execução', batimento: 'Batimento', falhas: 'Falhas', fonte: 'Fonte externa', espera: 'Espera', dependencias: 'Dependências', proprio: 'Verificação própria' };

function healthSection(a) {
  const h = a.health;
  if (!h) return '';
  const link = (x) => `<button class="dep" data-agent="${x.id}"><i style="background:${STATE_COLORS[x.state]}"></i>${esc(x.code)} · ${esc(x.name)}</button>`;
  const deps = a.dependencies?.length ? a.dependencies.map(link).join('') : '<span class="meta">Não consome dados de outro agente.</span>';
  const dependents = a.dependents?.length ? a.dependents.map(link).join('') : '<span class="meta">Nenhum agente consome os dados deste.</span>';
  return `
    <div class="section"><h4>Saúde <span class="health ${esc(h.level)}">${esc(HEALTH_LABEL[h.level] ?? h.level)}</span></h4>
      <div class="list">${h.checks.map((c) => `<div class="row"><div class="top"><span><i class="hdot ${esc(c.level)}"></i>${esc(CHECK_LABEL[c.name] ?? c.name)}</span></div><div class="meta">${esc(c.detail)}</div></div>`).join('')}</div>
    </div>
    <div class="section"><h4>Dependências</h4>
      <p class="meta">Recebe dados de <span class="legend" style="background:#f2c14e"></span></p><div class="deps">${deps}</div>
      <p class="meta">Fornece dados para <span class="legend" style="background:#6cb6ff"></span></p><div class="deps">${dependents}</div>
    </div>`;
}

function agentRows(list) {
  return list.length
    ? `<div class="list">${list.map((a) => `<div class="row agent-row" data-agent="${a.id}"><i style="background:${STATE_COLORS[a.state]}"></i><div><div>${esc(a.name)}</div><div class="code">${esc(a.code)} · ${esc(MODE_LABEL[a.mode])}</div></div><span class="meta">${esc(STATE_LABEL[a.state])}</span></div>`).join('')}</div>`
    : '<p class="empty">Nenhum agente corresponde aos filtros.</p>';
}

function panelDept(id) {
  const d = st.departments.find((x) => x.id === id);
  const list = [...st.agents.values()].filter((a) => a.department === id);
  setPanel(`SETOR ${pad(id)} · AGENTES ${id * 5 - 4}–${id * 5}`, d.name, `
    <div class="section">${agentRows(list)}</div>
    <div class="btn-row"><button class="btn" data-filter-dept="${id}">${st.office.filter.dept === id ? 'Mostrar todos os setores' : 'Destacar só este setor'}</button></div>`);
}

function panelAgents() {
  const f = st.office.filter;
  const list = [...st.agents.values()].filter((a) => st.office.matches(a));
  setPanel('REGISTRO CENTRAL', `Agentes (${list.length}/${st.agents.size})`, `
    <div class="tools">
      <input id="fQuery" type="search" placeholder="Buscar por nome ou código" value="${esc(f.query)}" />
      <select id="fState"><option value="">Todos os estados</option>${STATES.map((s) => `<option value="${s}" ${f.states.size === 1 && f.states.has(s) ? 'selected' : ''}>${STATE_LABEL[s]}</option>`).join('')}</select>
      <select id="fDept"><option value="">Todos os setores</option>${st.departments.map((d) => `<option value="${d.id}" ${f.dept === d.id ? 'selected' : ''}>${pad(d.id)} · ${esc(d.name)}</option>`).join('')}</select>
    </div>
    ${agentRows(list)}`);
  const q = $('#fQuery');
  q.oninput = () => { f.query = q.value; st.office.dirty = true; renderAgentsListOnly(); };
  $('#fState').onchange = (e) => { f.states = new Set(e.target.value ? [e.target.value] : []); st.office.dirty = true; renderRoster(); renderAgentsListOnly(); };
  $('#fDept').onchange = (e) => { f.dept = e.target.value ? Number(e.target.value) : null; st.office.dirty = true; renderDirectory(); renderAgentsListOnly(); };
}

function renderAgentsListOnly() {
  const list = [...st.agents.values()].filter((a) => st.office.matches(a));
  $('#panelTitle').textContent = `Agentes (${list.length}/${st.agents.size})`;
  const body = $('#panelBody');
  body.querySelector('.list, .empty')?.remove();
  body.insertAdjacentHTML('beforeend', agentRows(list));
}

async function panelEvents() {
  const sev = st.panel.sev ?? '';
  const events = await api(`/api/events?limit=200${sev ? `&severity=${sev}` : ''}`);
  setPanel('CONSOLE', 'Eventos', `
    <div class="tools"><select id="fSev">
      <option value="">Todas as severidades</option>
      <option value="warn,error,critical" ${sev === 'warn,error,critical' ? 'selected' : ''}>Avisos e erros</option>
      <option value="error,critical" ${sev === 'error,critical' ? 'selected' : ''}>Somente erros</option>
    </select></div>
    <div class="list">${events.map((e) => `<div class="row"><div class="top"><span class="sev ${esc(e.severity)}">${esc(e.severity)} · ${esc(e.type)}</span><span class="meta">${fmtTime(e.ts)}</span></div><div>${e.agentId ? `<button class="link" data-agent="${e.agentId}">A${pad(e.agentId)}</button> ` : ''}${esc(e.message)}</div></div>`).join('') || '<p class="empty">Sem eventos.</p>'}</div>`);
  $('#fSev').onchange = (e) => { st.panel.sev = e.target.value; renderPanel(); };
}

async function panelAlerts() {
  const alerts = await api('/api/alerts');
  const open = alerts.filter((a) => !a.acknowledged);
  setPanel('CENTRAL DE ALERTAS', `Alertas (${open.length} abertos)`, `
    <div class="list">${alerts.map((a) => `<div class="row" style="${a.acknowledged ? 'opacity:.55' : ''}">
      <div class="top"><span class="sev ${esc(a.severity)}">${esc(a.severity.toUpperCase())} · ${esc(a.code)}</span><span class="meta">${fmtAgo(a.ts)}${a.count > 1 ? ` · ${a.count}x` : ''}</span></div>
      <div>${esc(a.message)}</div>
      ${a.acknowledged ? '' : `<div class="btn-row"><button class="btn" data-ack="${esc(a.id)}">Reconhecer</button>${a.agentId ? `<button class="btn" data-agent="${a.agentId}">Ver agente</button>` : ''}</div>`}
    </div>`).join('') || '<p class="empty">Nenhum alerta.</p>'}</div>`);
}

const KIND_LABEL = { pause_miner: 'Pausar minerador', resume_miner: 'Retomar minerador', restart_miner: 'Reiniciar minerador', switch_pool: 'Trocar pool', adjust_threads: 'Ajustar threads', withdraw: 'Saque', purchase: 'Compra', payment: 'Pagamento', trade: 'Negociação' };
const ACTION_STATUS = { pendente_operador: 'aguardando operador', bloqueada: 'bloqueada pelo Guardião', aprovada_operador: 'aprovada', rejeitada: 'rejeitada', executada: 'executada', falhou: 'falhou' };

async function panelActions() {
  const actions = await api('/api/actions');
  setPanel('GUARDIÃO + OPERADOR', 'Ações propostas', `
    <p class="note">Agentes apenas propõem. Toda ação passa pelas regras do Guardião e exige sua aprovação. Compras, pagamentos, saques e negociações são sempre bloqueados.</p>
    <div class="list">${actions.map((a) => `<div class="row">
      <div class="top"><b>${esc(KIND_LABEL[a.kind] ?? a.kind)}</b><span class="meta">${fmtAgo(a.ts)}</span></div>
      <div class="meta">Proposta por A${pad(a.proposedBy)} · evidência ${tag(a.evidence)} · ${esc(ACTION_STATUS[a.status] ?? a.status)}</div>
      <div>${esc(a.reason)}</div>
      ${a.guardianReasons.length ? `<div class="meta" style="color:var(--err)">${a.guardianReasons.map(esc).join('<br>')}</div>` : ''}
      ${a.result ? `<div class="meta">Resultado: ${esc(a.result)}</div>` : ''}
      ${a.status === 'pendente_operador' ? `<div class="btn-row"><button class="btn ok" data-approve="${esc(a.id)}">Aprovar</button><button class="btn" data-reject="${esc(a.id)}">Rejeitar</button></div>` : ''}
    </div>`).join('') || '<p class="empty">Nenhuma ação proposta.</p>'}</div>`);
}

const GROUPS = { gpu: 'GPU (nvidia-smi)', miner: 'Minerador', pool: 'Pool', wallet: 'Carteira', finance: 'Finanças', profit: 'Rentabilidade (estimativas)', scenario: 'Cenários', energy: 'Energia', price: 'Preços', network: 'Rede Bitcoin', market: 'Mercado', risk: 'Risco', system: 'Sistema', net: 'Rede local' };

async function panelMetrics() {
  const metrics = await api('/api/metrics');
  const groups = {};
  for (const m of metrics) (groups[m.key.split('.')[0]] ??= []).push(m);
  const order = Object.keys(GROUPS).filter((g) => groups[g]).concat(Object.keys(groups).filter((g) => !GROUPS[g]).sort());
  setPanel('MÉTRICAS ATUAIS', `${metrics.length} métricas`, `
    <p class="note">Procedência: ${tag('real')} medido na fonte · ${tag('estimado')} calculado ou declarado · ${tag('simulado')} SIMULADO — somente em testes automatizados, nunca em produção · ${tag('teste')} dados de teste.</p>
    ${order.map((g) => `<div class="section"><h4>${esc(GROUPS[g] ?? g)}</h4><div class="metric-grid">${groups[g].map((m) => `<span class="k" title="${esc(m.source)} · ${fmtAgo(m.ts)}">${esc(m.key)}</span><span class="v">${fmtValue(m)} ${tag(m.provenance)}</span>`).join('')}</div></div>`).join('')}`);
}

async function panelReports() {
  const get = (k) => api(`/api/reports/${k}`, { allowError: true });
  const [op, an, sc] = await Promise.all([get('operational'), get('analysis'), get('scenarios')]);
  const has = (r) => r && r.body;
  const analysis = has(an) ? `<p>${esc(an.body.resumo)}</p>${an.body.riscos?.length ? `<ul>${an.body.riscos.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}<p class="meta">Fonte: ${esc(an.body.fonte)} · ${fmtAgo(an.ts)}${an.body.observacao ? ` · ${esc(an.body.observacao)}` : ''}</p>` : '<p class="empty">Ainda não gerada.</p>';
  const scen = has(sc) ? `<div class="metric-grid">${sc.body.rows.map((r) => `<span class="k">preço ×${r.preco} · dif ×${r.dificuldade} · tarifa ×${r.tarifa}</span><span class="v" style="color:${r.resultado_dia < 0 ? 'var(--err)' : 'var(--ok)'}">${r.resultado_dia.toLocaleString('pt-BR')} ${esc(sc.body.moeda)}/dia</span>`).join('')}</div><p class="meta">${tag(sc.body.provenance)} Estimativas, não promessas de resultado.</p>` : '<p class="empty">Ainda não gerado (requer hashrate, dificuldade, preço, potência e tarifa).</p>';
  setPanel('RELATÓRIOS', 'Relatórios e análises', `
    <div class="btn-row" style="margin-bottom:14px">
      <button class="btn" data-request="report">Gerar relatório</button>
      <button class="btn" data-request="analysis">Gerar análise</button>
      <button class="btn" data-request="scenario">Recalcular cenários</button>
      <a class="btn" href="/api/exports/recebimentos.csv" download>Baixar CSV de recebimentos</a>
    </div>
    <div class="section"><h4>Análise</h4>${analysis}</div>
    <div class="section"><h4>Cenários de sensibilidade</h4>${scen}</div>
    <div class="section"><h4>Relatório operacional ${has(op) ? `· ${fmtAgo(op.ts)}` : ''}</h4>${has(op) ? `<pre class="json">${esc(JSON.stringify(op.body, null, 2))}</pre>` : '<p class="empty">Ainda não gerado.</p>'}</div>`);
}

const LUXOR_STATE = { nao_configurada: 'chave não configurada', validada: 'autenticação validada', falhou: 'autenticação recusada', inacessivel: 'API inacessível', resposta_invalida: 'resposta fora do esquema' };

async function panelPool() {
  const [l, metrics] = await Promise.all([api('/api/luxor/status'), api('/api/metrics?prefix=')]);
  const m = Object.fromEntries(metrics.map((x) => [x.key, x]));
  const v = l.validation;
  const mc = l.minerConfig;
  const ok = v?.state === 'validada';
  const color = ok && v.dataVerified ? 'var(--ok)' : ok ? 'var(--wait)' : 'var(--err)';
  const row = (k) => (m[k] ? `<span class="k">${esc(k)}</span><span class="v">${fmtValue(m[k])} ${tag(m[k].provenance)}</span>` : '');
  setPanel('POOL PRINCIPAL', 'Luxor', `
    ${!l.enabled ? '<p class="note">A Luxor não é a pool ativa. Defina <code>POOL_SOURCE=luxor</code> no .env do servidor.</p>' : ''}
    <div class="section"><h4>Autenticação</h4><dl class="kv">
      <dt>Chave no backend</dt><dd>${l.keyConfigured ? 'configurada (nunca enviada ao navegador)' : '<b style="color:var(--err)">ausente</b>'}</dd>
      <dt>Estado</dt><dd><b style="color:${color}">${esc(v ? LUXOR_STATE[v.state] ?? v.state : 'não verificado')}</b>${v?.httpStatus ? ` · HTTP ${v.httpStatus}` : ''}</dd>
      <dt>Dados conferidos</dt><dd>${v?.dataVerified ? 'sim: /workspace e /pool/summary conforme o esquema documentado' : 'não'}</dd>
      ${v?.workspace ? `<dt>Workspace</dt><dd>${esc(v.workspace.name)} · ${esc(v.workspace.products.join(', '))}</dd>` : ''}
      <dt>Última verificação</dt><dd>${v?.checkedAt ? fmtAgo(v.checkedAt) : 'nunca'}</dd>
      <dt>Detalhe</dt><dd>${esc(v?.message ?? '—')}</dd>
    </dl>
    <div class="btn-row"><button class="btn" data-luxor-validate="1" ${l.enabled ? '' : 'disabled'}>Validar agora</button></div></div>
    <div class="section"><h4>Dados da conta</h4>
      ${m['pool.fallback_reason']?.value ? `<p class="note">Métricas de pool em modo SIMULADO: ${esc(m['pool.fallback_reason'].value)}</p>` : ''}
      <div class="metric-grid">${['luxor.active_miners', 'luxor.hashrate_5m', 'luxor.uptime_24h', 'luxor.balance', 'luxor.revenue_24h', 'luxor.revenue_all_time', 'luxor.subaccounts', 'pool.source_mode'].map(row).join('') || '<span class="empty">Sem dados: nenhuma consulta autorizada ainda.</span>'}</div>
    </div>
    <div class="section"><h4>Configuração para o minerador (${esc(l.currency)})</h4>
      <dl class="kv">
        <dt>URL da pool</dt><dd><code>${esc(mc.url)}</code></dd>
        <dt>Worker</dt><dd><code>${esc(mc.worker ?? '<SUBCONTA>.<NOME_DO_EQUIPAMENTO>')}</code></dd>
        <dt>Senha</dt><dd><code>${esc(mc.password)}</code> <span class="meta">(exemplo da documentação)</span></dd>
      </dl>
      ${mc.missing.length ? `<p class="note">Falta definir no .env: ${mc.missing.map(esc).join('; ')}</p>` : ''}
      <p class="meta">${mc.notes.map(esc).join(' ')} Fonte: <a href="${esc(mc.source)}" target="_blank" rel="noopener" style="color:var(--gold-2)">guia da Luxor</a>.</p>
    </div>`);
}

async function panelRisk() {
  const [r, audit] = await Promise.all([api('/api/risk'), api('/api/audit/verify')]);
  const llm = st.summary?.llm;
  setPanel('AGENTE 26', 'Guardião de Risco', `
    <div class="section"><dl class="kv">
      <dt>Sistema</dt><dd>${r.pause.paused ? `<b style="color:var(--block)">PAUSADO</b> · ${esc(r.pause.reason ?? '')} · por ${esc(r.pause.by ?? '')}` : '<b style="color:var(--ok)">Em operação</b>'}</dd>
      <dt>Nível de risco</dt><dd>${esc(r.state.level)}</dd>
      <dt>Achados</dt><dd>${r.state.findings.length ? r.state.findings.map(esc).join('<br>') : 'nenhum'}</dd>
      <dt>Temperatura</dt><dd>${r.snapshot.temperatureC ?? 'sem leitura'}${r.snapshot.temperatureC !== undefined ? ' °C' : ''}</dd>
      <dt>Ações na hora</dt><dd>${r.snapshot.actionsLastHour} · reinícios ${r.snapshot.restartsLastHour}</dd>
      <dt>Auditoria</dt><dd>${audit.ok ? `cadeia íntegra (${audit.records} registros)` : `<b style="color:var(--err)">corrompida no registro ${audit.brokenAt}</b>`}</dd>
      <dt>LLM</dt><dd>${llm ? (llm.enabled ? `ativo · ${llm.callsToday}/${llm.maxCallsPerDay} chamadas hoje` : esc(llm.reason)) : '—'}</dd>
    </dl>
    <div class="btn-row">${r.pause.paused ? '<button class="btn ok" data-system="resume">Retomar sistema</button>' : '<button class="btn danger" data-system="pause">Pausar sistema</button>'}</div></div>
    <div class="section"><h4>Regras determinísticas</h4><div class="list">${r.rules.map((x) => `<div class="row"><b>${esc(x.id)}</b> ${esc(x.description)}</div>`).join('')}</div></div>`);
}

// ---------------------------------------------------------------- GPU e mineração (somente dados reais)
const fmtWhen = (iso) => (iso ? `${fmtTime(Date.parse(iso))} (${fmtAgo(Date.parse(iso))})` : 'nunca');
const money = (v, cur) => (typeof v === 'number' ? `${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${esc(cur)}` : '—');

function ind(label, i) {
  const val = i.valor === undefined ? '—' : typeof i.valor === 'boolean' ? (i.valor ? 'sim' : 'não') : `${esc(i.valor)}${i.unidade ? ` ${esc(i.unidade)}` : ''}`;
  const src = [i.fonte && `fonte: ${esc(i.fonte)}`, i.atualizadoEm && `atualizado ${fmtWhen(i.atualizadoEm)}`, i.observacao && esc(i.observacao)].filter(Boolean).join(' · ');
  return `<div class="ind"><span class="lbl">${esc(label)}</span><span class="val">${val} ${stTag(i.estado)}</span>${src ? `<span class="src">${src}</span>` : ''}</div>`;
}

function spark(points) {
  if (points.length < 2) return '<p class="empty">Ainda não há histórico suficiente. Nenhuma curva é desenhada sem leituras reais.</p>';
  const xs = points.map((p) => p.ts); const ys = points.map((p) => Number(p.value));
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const d = points.map((p, k) => `${k ? 'L' : 'M'}${(((p.ts - x0) / (x1 - x0 || 1)) * 300).toFixed(1)},${(42 - ((Number(p.value) - y0) / (y1 - y0 || 1)) * 38).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 300 46" preserveAspectRatio="none"><path d="${d}"/></svg><p class="meta">${points.length} leituras reais · mín ${y0} · máx ${y1}</p>`;
}

async function panelMining() {
  const [gpu, mining, energy, auto, hTemp, hPow] = await Promise.all([
    api('/api/gpu'), api('/api/mining/state'), api('/api/energy'), api('/api/auto-mining'),
    api('/api/metrics/history?key=gpu.temperature_c&limit=120'), api('/api/metrics/history?key=gpu.power_w&limit=120'),
  ]);
  const g = gpu.gpus?.[0];
  const gstate = gpu.status === 'ok' ? 'REAL' : gpu.status === 'desatualizado' ? 'DADOS DESATUALIZADOS' : gpu.status === 'erro_leitura' ? 'ERRO' : 'INDISPONÍVEL';
  const gv = (label, v, unit) => ind(label, v === null || v === undefined ? { estado: g ? 'INDISPONÍVEL' : gstate, observacao: g ? 'campo não suportado pelo driver' : undefined } : { estado: 'REAL', valor: v, unidade: unit, fonte: 'nvidia-smi', atualizadoEm: gpu.coletadoEm });
  const I = mining.indicadores;
  const cur = energy.moeda;
  const em = (name, m) => `<div class="ind"><span class="lbl">${esc(name)}</span><span class="val">${m.disponivel ? `${money(m.diario, cur)}/dia · ${money(m.mensal, cur)}/mês ${stTag('ESTIMADO')}` : stTag('INDISPONÍVEL')}</span><span class="src">${esc(m.disponivel ? `${m.base} · escopo: ${m.escopo}` : m.motivo)}</span></div>`;
  const coins = auto.moedas.map((c) => c.eligible && c.net
    ? `<div class="ind"><span class="lbl">${esc(c.symbol)} · ${esc(c.algorithm)}</span><span class="val">${money(c.net.netDay, auto.moeda)}/dia ${stTag('ESTIMADO')}</span><span class="src">receita ${money(c.net.grossDay, auto.moeda)} − taxas ${money(c.net.poolFeeDay + c.net.minerFeeDay, auto.moeda)} − energia ${money(c.net.energyDay, auto.moeda)} − outros ${money(c.net.otherDay, auto.moeda)} · fonte ${esc(c.quoteSource)} · dado de ${c.quoteAgeMin} min</span></div>`
    : `<div class="ind"><span class="lbl">${esc(c.symbol)} · ${esc(c.algorithm)}</span><span class="val">${stTag('INDISPONÍVEL')}</span><span class="src">${esc(c.reason)}</span></div>`).join('');
  setPanel('HARDWARE E MINERAÇÃO', 'GPU e Mineração', `
    <div class="banner${mining.estado === 'DESATIVADA' ? ' off' : ''}">MINERAÇÃO: ${esc(mining.estado)} · desde ${fmtWhen(mining.desde)}</div>
    <div class="section"><h4>GPU ${stTag(gpu.hardware)} ${stTag(gstate)}</h4>
      <p class="meta">${esc(gpu.mensagem)} Última leitura bem-sucedida: ${fmtWhen(gpu.coletadoEm)} · última tentativa: ${fmtWhen(gpu.consultadoEm)}.</p>
      ${gv('Modelo', g?.name)}${gv('Driver', g?.driverVersion)}${gv('Memória total', g?.memoryTotalMiB, 'MiB')}${gv('Memória usada', g?.memoryUsedMiB, 'MiB')}
      ${gv('Utilização', g?.utilizationPct, '%')}${gv('Temperatura', g?.temperatureC, '°C')}${gv('Consumo instantâneo (somente GPU)', g?.powerW, 'W')}${gv('Limite de potência', g?.powerLimitW, 'W')}
    </div>
    <div class="section"><h4>Histórico real da GPU</h4><p class="meta">Temperatura (°C)</p>${spark(hTemp)}<p class="meta">Consumo da GPU (W)</p>${spark(hPow)}</div>
    <div class="section"><h4>Indicadores de mineração (independentes)</h4>
      ${ind('Processo do minerador ativo', I.processoAtivo)}${ind('GPU em utilização', I.gpuEmUso)}${ind('Hashrate local medido', I.hashrateLocal)}${ind('Worker conectado à pool', I.workerConectado)}
      ${ind('Shares aceitas', I.sharesAceitas)}${ind('Shares rejeitadas', I.sharesRejeitadas)}${ind('Saldo informado pela pool', I.saldoConfirmado)}${ind('Pagamentos confirmados', I.pagamentosConfirmados)}
    </div>
    <div class="section"><h4>Custo de energia · modo ${esc(energy.modo)}</h4>
      ${em('A — informado pelo operador', energy.informado)}${em('B — medido durante mineração', energy.medido)}
      <p class="meta">Usado no lucro: ${energy.usadoNoLucro ? esc(energy.usadoNoLucro) : 'nenhum (custo indisponível)'}. Os dois métodos nunca são somados.</p>
      ${energy.avisos.map((a) => `<p class="note">${esc(a)}</p>`).join('')}
    </div>
    <div class="section"><h4>Rentabilidade (${esc(auto.periodo)}, ${esc(auto.moeda)})</h4>
      <div class="banner">${esc(auto.rentabilidade)}</div>${coins}
      <p class="meta">Fonte: ${esc(auto.fonteMercado)}${auto.fonteStatus?.consultadoEm ? ` · consultada ${fmtWhen(auto.fonteStatus.consultadoEm)}` : ''}${auto.fonteStatus?.cotacaoBtc ? ` · cotação BTC: ${esc(auto.fonteStatus.cotacaoBtc.fonte)}, ${fmtWhen(auto.fonteStatus.cotacaoBtc.atualizadoEm)}` : ''}. O painel nunca garante lucro.</p>
    </div>
    <div class="section"><h4>Minerador ${stTag(mining.minerador?.configurado ? 'REAL' : 'NÃO CONFIGURADO')}</h4>
      <p class="meta">${esc(mining.minerador?.nome ?? 'SRBMiner-MULTI')} · worker ${esc(mining.minerador?.worker ?? '—')} · ${mining.minerador?.configurado ? 'caminho e SHA-256 informados no .env (o hash é conferido de novo a cada teste)' : 'informe MINER_GPU_PATH e MINER_GPU_SHA256 no .env (docs/MINERADOR-SRBMINER.md)'}</p>
      ${(mining.minerador?.problemas ?? []).map((x) => `<p class="note">${esc(x)}</p>`).join('')}
    </div>
    <div class="section"><h4>Teste controlado</h4>
      <div class="form-row"><label>Moeda <select id="tCoin">${auto.moedas.map((c) => `<option>${esc(c.symbol)}</option>`).join('') || '<option>PRL</option>'}</select></label>
        <label>Duração (min) <input id="tDur" type="number" min="1" max="30" value="5" style="width:64px"></label></div>
      <div class="form-row"><label style="flex:1">Autorização (digite a frase exata) <input id="tAuth" type="text" autocomplete="off" spellcheck="false" placeholder="AUTORIZO TESTE DE MINERAÇÃO" style="width:100%"></label></div>
      <div class="btn-row"><button class="btn" data-mining="check">Verificar pré-condições</button><button class="btn primary" data-mining="start">INICIAR TESTE</button><button class="btn danger" data-mining="stop">INTERROMPER</button></div>
      <div id="tResult" class="checks list"></div>
      <div id="tLive">${liveHtml(mining)}</div>
    </div>
    <div class="section"><h4>Transições de estado</h4><div class="list">${mining.historico.slice().reverse().map((t) => `<div class="row"><b>${esc(t.from)} → ${esc(t.to)}</b> · ${fmtTime(t.at)} · ${esc(t.origem)}: ${esc(t.motivo)}</div>`).join('') || '<p class="empty">Sem transições.</p>'}</div></div>`);
}

function renderChecks(r) {
  const box = $('#tResult');
  if (!box) return;
  const head = r.error ? `<p class="note">${esc(r.error)}</p>` : '';
  box.innerHTML = head + (r.checks ?? []).map((c) => `<div class="row"><span class="${c.ok ? 'ok' : 'no'}">${c.ok ? '✓' : '✗'}</span><span><b>${esc(c.item)}</b><br><span class="meta">${esc(c.detalhe)}</span></span></div>`).join('');
}

async function miningCommand(kind) {
  const body = { coin: $('#tCoin')?.value ?? 'PRL', durationMin: Number($('#tDur')?.value ?? 5) };
  if (kind === 'stop') { const r = await api('/api/mining/stop', { method: 'POST', allowError: true }); toast(r.mensagem ?? `Estado: ${r.estado}`); return renderPanel(); }
  if (kind === 'check') { const r = await api('/api/mining/test/check', { method: 'POST', body, allowError: true }); renderChecks(r); toast(r.pronto ? 'Pré-condições atendidas' : 'Há pré-condições pendentes'); return; }
  const pre = await api('/api/mining/test/check', { method: 'POST', body, allowError: true });
  if (!pre.pronto) { renderChecks(pre); toast('Teste não iniciado: há pré-condições pendentes'); return; }
  // A frase é DIGITADA pelo operador; o painel nunca a preenche sozinho. O servidor confere o texto exato.
  const frase = ($('#tAuth')?.value ?? '').trim();
  if (!frase) { renderChecks({ ...pre, error: `Digite a frase de autorização no campo acima. ${pre.plano?.autorizacao ?? ''}` }); return; }
  const r = await api('/api/mining/test/start', { method: 'POST', body: { ...body, confirmacao: frase }, allowError: true });
  if ($('#tAuth')) $('#tAuth').value = '';
  renderChecks(r);
  toast(r.error ?? `Estado: ${r.estado}`);
  await updateMiningLive();
}

function fmtHs(v) {
  if (typeof v !== 'number') return '—';
  for (const [f, n] of [[1e15, 'PH/s'], [1e12, 'TH/s'], [1e9, 'GH/s'], [1e6, 'MH/s'], [1e3, 'kH/s']]) if (v >= f) return `${(v / f).toFixed(2)} ${n}`;
  return `${v.toFixed(0)} H/s`;
}

/** Teste em andamento (console ao vivo) ou relatório do último teste. Nada aqui é estimado. */
function liveHtml(mining) {
  const t = mining.testeAtual;
  if (t) {
    return `<div class="banner">TESTE EM ANDAMENTO · ${esc(mining.estado)} · ${esc(t.moeda)} · ${esc(t.pool)} · desde ${fmtWhen(t.iniciadoEm)}</div>
      <pre class="console">${esc((t.console.ultimas ?? []).join('\n')) || 'aguardando a saída do minerador…'}</pre>
      <p class="meta">Console gravado em ${esc(t.console.arquivo)}. Use INTERROMPER para parar a qualquer momento.</p>`;
  }
  const r = mining.ultimoTeste;
  if (!r) return '<p class="empty">Nenhum teste realizado.</p>';
  const li = (xs) => xs.map((x) => `<li>${esc(x)}</li>`).join('');
  return `<h4 style="margin-top:12px">Último teste ${stTag('REAL')}</h4>
    <p class="meta">${esc(r.moeda)} · ${esc(r.minerador)} · ${esc(r.pool)} · worker ${esc(r.worker)} · ${fmtWhen(r.iniciadoEm)} → ${fmtWhen(r.encerradoEm)} (${r.duracaoS ?? '?'} s) · fim: ${esc(r.motivoFim ?? '—')}</p>
    <div class="ind"><span class="lbl">Hashrate informado pelo minerador</span><span class="val">médio ${fmtHs(r.hashrate.medioHs)} · máx. ${fmtHs(r.hashrate.maximoHs)}</span><span class="src">${r.hashrate.amostras} leituras · trecho original: ${esc(r.hashrate.trechoOriginal ?? '—')}</span></div>
    <div class="ind"><span class="lbl">Shares (console)</span><span class="val">${r.shares.aceitas} aceitas · ${r.shares.rejeitadas} rejeitadas</span><span class="src">${esc(r.shares.fonte)}</span></div>
    <div class="ind"><span class="lbl">GPU durante o teste</span><span class="val">máx. ${r.gpu.temperaturaMaxC ?? '—'} °C · média ${r.gpu.potenciaMediaW != null ? r.gpu.potenciaMediaW.toFixed(1) : '—'} W</span><span class="src">${r.gpu.amostrasPotencia} amostras de consumo (nvidia-smi)</span></div>
    <p class="meta"><b>Comprovado:</b></p><ul>${li(r.comprovado) || '<li>nada</li>'}</ul>
    <p class="meta"><b>Não comprovado:</b></p><ul>${li(r.naoComprovado)}</ul>
    <p class="meta">Log completo: ${esc(r.console.arquivo)}</p>
    <pre class="console">${esc((r.console.ultimas ?? []).slice(-12).join('\n'))}</pre>`;
}

async function updateMiningLive() {
  const box = $('#tLive');
  if (!box) return;
  const m = await api('/api/mining/state', { allowError: true });
  if (!m || m.error) return;
  box.innerHTML = liveHtml(m);
  const ban = document.querySelector('.panel .banner');
  if (ban && ban.textContent.startsWith('MINERAÇÃO')) { ban.textContent = `MINERAÇÃO: ${m.estado}`; ban.classList.toggle('off', m.estado === 'DESATIVADA'); }
}

// QR para abrir o painel no celular (só aparece no próprio computador; o QR leva o token).
async function panelCelular() {
  const r = await api('/api/celular', { allowError: true });
  if (!r || r.error || !r.liberado) {
    setPanel('ACESSO', 'Abrir no celular', `<div class="section"><p class="note">${esc(r?.motivo ?? r?.error ?? 'indisponível')}</p>
      <p class="meta">O celular precisa estar no mesmo Wi-Fi deste computador. O painel nunca fica aberto para a internet.</p></div>`);
    return;
  }
  const [o, ...outros] = r.opcoes;
  setPanel('ACESSO', 'Abrir no celular', `
    <div class="section qr-box">
      <div class="qr"><img alt="QR code para abrir o painel no celular" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(o.svg)}"></div>
      <p><b>Aponte a câmera do celular</b> para o código e toque no link que aparecer.</p>
      <p class="meta">O celular abre o painel já autorizado e guarda o endereço. Depois disso, ${esc(r.linkPublico.replace(/^https:\/\//, ''))} abre o painel direto. Dica: no Safari, Compartilhar → Adicionar à Tela de Início.</p>
    </div>
    <div class="section"><h4>Sem câmera ou sem internet no celular</h4>
      <p class="meta">Digite no navegador do celular: <code>${esc(o.endereco)}</code> e o token quando o painel pedir.</p>
      ${outros.length ? `<p class="meta">Outros endereços deste computador (redes virtuais costumam não funcionar): ${outros.map((x) => `<code>${esc(x.endereco)}</code>`).join(' ')}</p>` : ''}
      <p class="note">O código dá acesso ao painel: não mostre esta tela para outras pessoas.</p>
    </div>`);
}

function panelMore() {
  setPanel('MENU', 'Mais opções', `<div class="list">
    ${[['mining', 'GPU e Mineração'], ['celular', 'Abrir no celular'], ['pool', 'Pool Luxor'], ['actions', 'Ações propostas'], ['metrics', 'Métricas'], ['reports', 'Relatórios'], ['risk', 'Guardião de Risco'], ['agents', 'Lista de agentes']].map(([v, l]) => `<button class="row" data-open="${v}" style="text-align:left">${l}</button>`).join('')}
  </div>`);
}

// ---------------------------------------------------------------- comandos
async function togglePause() {
  const paused = st.summary?.pause.paused;
  try {
    if (paused) {
      const r = await api('/api/system/resume', { method: 'POST', allowError: true });
      toast(r.ok ? 'Sistema retomado' : `Retomada recusada: ${r.reason}`);
    } else {
      if (!confirm('Pausar o sistema? Apenas agentes essenciais continuarão rodando e nenhuma ação será executada.')) return;
      await api('/api/system/pause', { method: 'POST', body: { reason: 'pausa manual pelo operador' } });
      toast('Sistema pausado');
    }
    await refreshSummary();
    renderPanel();
  } catch (e) {
    if (e instanceof UnauthorizedError) askToken(); else toast(e.message);
  }
}

async function handlePanelClick(e) {
  const t = e.target.closest('button, [data-agent], a');
  if (!t) return;
  const d = t.dataset;
  try {
    if (d.agent) { const id = Number(d.agent); const r = openPanel('agent', id); st.office.focusAgent(id); return r; }
    if (d.run) { const r = await api(`/api/agents/${d.run}/run`, { method: 'POST', allowError: true }); toast(r.accepted ? 'Execução enfileirada' : r.reason ?? 'Não enfileirado'); setTimeout(renderPanel, 1200); return; }
    if (d.ack) { await api(`/api/alerts/${d.ack}/ack`, { method: 'POST' }); toast('Alerta reconhecido'); await refreshSummary(); return renderPanel(); }
    if (d.approve) { const r = await api(`/api/actions/${d.approve}/approve`, { method: 'POST', allowError: true }); toast(r.ok ? 'Ação aprovada; o Executor fará a reavaliação final' : `Bloqueada: ${r.reason}`); setTimeout(renderPanel, 800); return; }
    if (d.reject) { await api(`/api/actions/${d.reject}/reject`, { method: 'POST' }); toast('Ação rejeitada'); return renderPanel(); }
    if (d.request) { await api(`/api/requests/${d.request}`, { method: 'POST' }); toast('Solicitação enviada'); setTimeout(renderPanel, 1500); return; }
    if (d.system) return togglePause();
    if (d.luxorValidate) { t.disabled = true; toast('Consultando a Luxor (somente leitura)…'); const r = await api('/api/luxor/validate', { method: 'POST', allowError: true }); toast(r.validation ? `Luxor: ${LUXOR_STATE[r.validation.state] ?? r.validation.state}` : (r.error ?? 'falhou')); await refreshSummary(); return renderPanel(); }
    if (d.mining) return miningCommand(d.mining);
    if (d.open) return openPanel(d.open);
    if (d.filterDept) { const id = Number(d.filterDept); st.office.filter.dept = st.office.filter.dept === id ? null : id; st.office.dirty = true; renderDirectory(); return renderPanel(); }
  } catch (err) {
    if (err instanceof UnauthorizedError) askToken(); else toast(err.message);
  }
}

function askToken() {
  const dlg = $('#tokenDialog');
  if (dlg.open) return;
  dlg.showModal();
  dlg.onclose = async () => {
    setToken($('#tokenInput').value.trim());
    location.reload();
  };
}

// ---------------------------------------------------------------- canvas: navegação e seleção
function setupCanvas() {
  const canvas = $('#office');
  const office = st.office;
  const pointers = new Map();
  let drag = null; // um ponteiro: arrasta (ou gira, com botão direito / Shift)
  let pinch = null; // dois dedos: aproxima e gira
  const tip = $('#tooltip');

  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const two = () => {
    const [a, b] = [...pointers.values()];
    return { dist: Math.hypot(a[0] - b[0], a[1] - b[1]), angle: Math.atan2(b[1] - a[1], b[0] - a[0]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
  };

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, pos(e));
    if (pointers.size === 1) drag = { start: pos(e), last: pos(e), moved: false, orbit: e.button === 2 || e.shiftKey };
    if (pointers.size === 2) { pinch = two(); drag = null; }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pos(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (pinch && pointers.size === 2) {
      const now = two();
      if (pinch.dist > 0) office.zoomAt(now.dist / pinch.dist, now.mid[0], now.mid[1]);
      let da = now.angle - pinch.angle;
      if (da > Math.PI) da -= 2 * Math.PI;
      if (da < -Math.PI) da += 2 * Math.PI;
      office.orbitBy(-da, 0);
      pinch = now;
      return;
    }
    if (drag && pointers.size === 1) {
      if (!drag.moved && Math.abs(p[0] - drag.start[0]) + Math.abs(p[1] - drag.start[1]) > 6) { drag.moved = true; canvas.classList.add('dragging'); tip.hidden = true; }
      if (drag.moved) {
        const dx = p[0] - drag.last[0];
        const dy = p[1] - drag.last[1];
        if (drag.orbit) office.orbitBy(-dx * 0.006, -dy * 0.004);
        else office.panBy(dx, dy);
      }
      drag.last = p;
      return;
    }
    if (e.pointerType === 'mouse') {
      const hit = office.pick(p[0], p[1]);
      const id = hit?.type === 'agent' ? hit.id : null;
      if (id !== office.hovered) { office.hovered = id; office.dirty = true; }
      if (hit) {
        if (hit.type === 'agent') {
          const a = st.agents.get(hit.id);
          tip.innerHTML = `<b>${esc(a.name)}</b>${esc(a.code)} · ${esc(STATE_LABEL[a.state])}<br><span style="color:var(--muted)">${esc(a.lastSummary ?? a.responsibility)}</span>`;
        } else {
          const d = st.departments.find((x) => x.id === hit.id);
          tip.innerHTML = `<b>${pad(d.id)} · ${esc(d.name)}</b>Clique para abrir o setor`;
        }
        tip.style.left = `${p[0]}px`;
        tip.style.top = `${p[1]}px`;
        tip.hidden = false;
        canvas.style.cursor = 'pointer';
      } else { tip.hidden = true; canvas.style.cursor = ''; }
    }
  });
  const end = (e) => {
    const p = pos(e);
    if (drag && !drag.moved && pointers.size === 1 && e.type === 'pointerup') {
      const hit = office.pick(p[0], p[1]);
      if (hit?.type === 'agent') { openPanel('agent', hit.id); office.selected = hit.id; office.focusedDept = Math.ceil(hit.id / 5); office.dirty = true; renderDirectory(); }
      else if (hit?.type === 'room') { openPanel('dept', hit.id); office.focusDept(hit.id); renderDirectory(); }
    }
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) { drag = null; canvas.classList.remove('dragging'); }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => { tip.hidden = true; if (office.hovered) { office.hovered = null; office.dirty = true; } });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); const [x, y] = pos(e); office.zoomAt(Math.exp(-e.deltaY * 0.0015), x, y); }, { passive: false });

  $('#vZoomIn').onclick = () => office.zoomAt(1.25);
  $('#vZoomOut').onclick = () => office.zoomAt(0.8);
  $('#vRotL').onclick = () => office.rotate(-1);
  $('#vRotR').onclick = () => office.rotate(1);
  $('#vHome').onclick = () => { office.selected = null; office.overview(); renderDirectory(); };
  $('#vLabels').onclick = () => {
    const modes = ['auto', 'all', 'none'];
    office.labelsMode = modes[(modes.indexOf(office.labelsMode) + 1) % 3];
    office.dirty = true;
    toast(`Etiquetas: ${{ auto: 'automáticas', all: 'todas', none: 'somente seleção' }[office.labelsMode]}`);
  };

  const onResize = () => { office.resize(); if (!office.focusedDept) office.overview(); office.dirty = true; };
  new ResizeObserver(onResize).observe($('#stage'));
  onResize();
}

function loop() {
  let last = 0;
  const frame = (t) => {
    requestAnimationFrame(frame);
    if (document.hidden) return;
    const animated = !st.office.reducedMotion;
    if (st.office.dirty || (animated && t - last > 66)) { // ~15 fps para a animação ociosa
      last = t;
      st.office.render(t);
    }
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- inicialização
function wireUi() {
  $('#roster').addEventListener('click', (e) => {
    const b = e.target.closest('[data-state]');
    if (!b) return;
    const f = st.office.filter.states;
    if (!b.dataset.state) f.clear();
    else if (f.has(b.dataset.state)) f.delete(b.dataset.state);
    else f.add(b.dataset.state);
    st.office.dirty = true;
    renderRoster();
    if (st.panel?.kind === 'agents') renderAgentsListOnly();
  });
  $('#btnDirectory').onclick = () => {
    const d = $('#directory');
    d.hidden = !d.hidden;
    $('#btnDirectory').setAttribute('aria-expanded', String(!d.hidden));
  };
  $('#directory').addEventListener('click', (e) => {
    const b = e.target.closest('[data-dept]');
    if (!b) return;
    const id = Number(b.dataset.dept);
    openPanel('dept', id);
    st.office.focusDept(id);
    renderDirectory();
  });
  const nav = (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    const v = b.dataset.view;
    if (v === 'office') { closePanel(); st.office.overview(); renderDirectory(); return; }
    openPanel(v);
  };
  $('#nav').addEventListener('click', nav);
  $('#tabbar').addEventListener('click', nav);
  $('#panelClose').onclick = closePanel;
  $('#panelBody').addEventListener('click', handlePanelClick);
  $('#btnPause').onclick = togglePause;
  $('#btnRefresh').onclick = async () => { await refreshSummary(); renderPanel(); toast('Atualizado'); };
  $('#cExpand').onclick = () => { const c = $('#console'); c.classList.toggle('open'); $('#cExpand').textContent = c.classList.contains('open') ? 'Recolher' : 'Expandir'; };
  $('#cClear').onclick = () => { st.events = []; renderConsole(); };
  $('#cCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(st.events, null, 2)); toast('Eventos copiados'); } catch { toast('Não foi possível copiar'); }
  };
  $('#cDownload').onclick = () => {
    const blob = new Blob([JSON.stringify(st.events, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `eventos-office50-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && st.panel) closePanel(); });
}

function connect() {
  const conn = $('#conn');
  connectStream({
    open: () => { conn.className = 'conn on'; conn.querySelector('span').textContent = 'Tempo real ativo'; },
    error: () => { conn.className = 'conn off'; conn.querySelector('span').textContent = 'Reconectando…'; },
    state: (e) => {
      const a = st.agents.get(e.agentId);
      if (a) { a.state = e.data.state; a.running = e.data.running; }
      st.office.updateAgentState(e.agentId, e.data.state);
      clearTimeout(connect.t);
      connect.t = setTimeout(() => { renderRoster(); renderDirectory(); }, 300);
    },
    event: (e) => {
      pushEvent(e);
      if (e.type.startsWith('system.') || e.type.startsWith('action.') || e.type === 'alert.raised') refreshSummary();
    },
  });
}

/** Link vindo do QR ou do Abrir-no-Celular.bat: "#token=XXXX" ou "#celular:XXXX". O token fica só neste navegador
 *  e some do endereço na hora. A parte depois do "#" nunca é enviada ao servidor. */
function tokenFromHash() {
  let h = '';
  try { h = decodeURIComponent(location.hash.slice(1)); } catch { return null; }
  if (!h) return null;
  let open = null;
  let m = /^celular:([A-Za-z0-9_-]{8,128})$/.exec(h);
  if (m) { setToken(m[1]); open = 'celular'; } else if ((m = /^token=([A-Za-z0-9_-]{8,128})$/.exec(h))) setToken(m[1]);
  if (m) history.replaceState(null, '', location.pathname + location.search);
  return open;
}

/** Escritório em WebGL; sem WebGL (ou com ?vista=iso), o escritório isométrico em Canvas 2D. */
async function createOffice() {
  const canvas = $('#office');
  if (new URLSearchParams(location.search).get('vista') !== 'iso') {
    try {
      const { Office3D } = await import('./office3d.js');
      const office = new Office3D(canvas, st.departments);
      document.body.dataset.vista = '3d';
      return office;
    } catch (e) {
      console.warn('WebGL indisponível; usando a vista isométrica.', e);
      // Um canvas que já tentou WebGL não aceita contexto 2D: troca por um novo.
      const fresh = canvas.cloneNode(false);
      canvas.replaceWith(fresh);
      $('#officeLabels')?.remove();
    }
  }
  document.body.dataset.vista = 'iso';
  return new Office($('#office'), st.departments);
}

async function main() {
  const abrir = tokenFromHash();
  try {
    await load();
  } catch (e) {
    if (e instanceof UnauthorizedError) return askToken();
    $('#sysState').textContent = `Servidor indisponível: ${e.message}`;
    return;
  }
  st.office = await createOffice();
  st.office.setAgents([...st.agents.values()]);
  wireUi();
  setupCanvas();
  renderHud();
  renderConsole();
  loop();
  connect();
  if (abrir) openPanel(abrir);
  setInterval(refreshSummary, 10_000);
  setInterval(() => { if (st.panel && ['agent', 'metrics', 'alerts', 'actions'].includes(st.panel.kind) && !document.hidden) renderPanel(); }, 15_000);
  // Durante um teste, só a área do console é atualizada (o campo da frase não é apagado).
  setInterval(() => { if (st.panel?.kind === 'mining' && !document.hidden) void updateMiningLive(); }, 5_000);
}

main();
