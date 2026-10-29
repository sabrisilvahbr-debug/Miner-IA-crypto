// API HTTP + canal em tempo real (Server-Sent Events) + arquivos estáticos do escritório virtual.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { App } from '../app.ts';
import type { AgentState, DomainEvent, Severity } from '../core/types.ts';
import { AGENT_STATES } from '../core/types.ts';
import { DEPARTMENTS } from '../agents/index.ts';
import { computeEvidence } from '../core/evidence.ts';
import { verifyAuditChain, buildReceiptsCsv } from '../agents/d09-auditoria.ts';
import { MAINTENANCE_TASKS } from '../agents/d08-automacao.ts';
import { matchesPattern } from '../core/eventBus.ts';
import { luxorMinerConfig, LUXOR_DOCS } from '../adapters/luxor.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};

const STREAM_TYPES = ['agent.state', 'agent.*', 'alert.*', 'action.*', 'system.*', 'strategy.*', 'pool.*', 'wallet.*'];

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, url: URL) => Promise<void> | void;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new Error('corpo da requisição grande demais');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function createApiServer(app: App, webDir: string) {
  const { runtime, store, guardian, llm, config } = app;
  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
  const route = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:([a-z]+)/gi, (_m, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, pattern, keys, handler });
  };
  const sseClients = new Set<ServerResponse>();
  const operator = (req: IncomingMessage) => (req.headers['x-operator'] ? String(req.headers['x-operator']).slice(0, 40) : 'operador');

  // ---------------- consultas ----------------
  route('GET', '/api/health', (_q, res) => json(res, 200, { ok: true, agents: runtime.agents().length, paused: guardian.pauseState().paused }));

  route('GET', '/api/departments', (_q, res) => {
    const agents = runtime.agents();
    json(res, 200, DEPARTMENTS.map((d) => ({ ...d, agents: agents.filter((a) => a.department === d.id).map((a) => ({ id: a.id, code: a.code, name: a.name, state: a.state })) })));
  });

  route('GET', '/api/agents', (_q, res, _p, url) => {
    const state = url.searchParams.get('state') as AgentState | null;
    const dept = url.searchParams.get('department');
    let list = runtime.agents();
    if (state && AGENT_STATES.includes(state)) list = list.filter((a) => a.state === state);
    if (dept) list = list.filter((a) => a.department === Number(dept));
    json(res, 200, list);
  });

  route('GET', '/api/agents/:id', (_q, res, p) => {
    const a = runtime.agent(Number(p.id));
    if (!a) return json(res, 404, { error: 'agente inexistente' });
    json(res, 200, {
      ...a,
      executions: store.listExecutions(a.id, 15),
      tasks: store.listTasks({ agentId: a.id, limit: 10 }),
      events: store.listEvents({ agentId: a.id, limit: 20 }),
      outputsLatest: store.latestMetrics().filter((m) => m.agentId === a.id),
    });
  });

  route('GET', '/api/summary', (_q, res) => {
    const ev = computeEvidence((k) => store.latestMetric(k), runtime.now());
    json(res, 200, {
      product: 'AI CRYPTO MINER — VIRTUAL MINING OFFICE 50',
      collective: runtime.collectiveSummary(),
      evidence: ev,
      pause: guardian.pauseState(),
      risk: store.latestMetric('risk.level')?.value ?? 'normal',
      alertsOpen: store.listAlerts({ openOnly: true, limit: 500 }).length,
      actionsPending: store.listActions({ status: 'pendente_operador' }).length,
      llm: llm.status(),
      sources: { market: config.marketSource, network: config.networkSource, miner: config.minerType, pool: config.poolSource, wallet: config.walletSource },
      uptimeS: Math.floor((runtime.now() - runtime.startedAt) / 1000),
    });
  });

  route('GET', '/api/events', (_q, res, _p, url) => {
    const sev = url.searchParams.get('severity');
    json(res, 200, store.listEvents({
      limit: Number(url.searchParams.get('limit') ?? 100),
      agentId: url.searchParams.get('agentId') ? Number(url.searchParams.get('agentId')) : undefined,
      severity: sev ? (sev.split(',') as Severity[]) : undefined,
      type: url.searchParams.get('type') ?? undefined,
    }));
  });

  route('GET', '/api/metrics', (_q, res, _p, url) => json(res, 200, store.latestMetrics(url.searchParams.get('prefix') ?? '')));
  route('GET', '/api/metrics/history', (_q, res, _p, url) => {
    const key = url.searchParams.get('key');
    if (!key) return json(res, 400, { error: 'parâmetro key obrigatório' });
    json(res, 200, store.metricHistory(key, Math.min(Number(url.searchParams.get('limit') ?? 200), 2000)));
  });

  route('GET', '/api/alerts', (_q, res, _p, url) => json(res, 200, store.listAlerts({ openOnly: url.searchParams.get('open') === '1', limit: 200 })));
  route('GET', '/api/actions', (_q, res, _p, url) => json(res, 200, store.listActions({ status: url.searchParams.get('status') ?? undefined, limit: 100 })));
  route('GET', '/api/risk', (_q, res) => json(res, 200, { rules: guardian.rules(), pause: guardian.pauseState(), snapshot: guardian.snapshot(), state: guardian.checkState() }));
  route('GET', '/api/reports/:kind', (_q, res, p) => {
    const r = store.latestReport(p.kind);
    if (!r) return json(res, 404, { error: 'relatório ainda não gerado' });
    json(res, 200, r);
  });
  route('GET', '/api/audit/verify', (_q, res) => json(res, 200, verifyAuditChain(store)));
  route('GET', '/api/maintenance', (_q, res) => {
    const done = store.getKV<Record<string, number>>('maintenance.done', {});
    json(res, 200, MAINTENANCE_TASKS.map((t) => ({ ...t, lastDoneAt: done[t.id] ?? null })));
  });
  route('GET', '/api/exports/recebimentos.csv', (_q, res) => {
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="recebimentos.csv"' });
    res.end(buildReceiptsCsv(store, config.localCurrency));
  });

  // ---------------- pool Luxor (a chave nunca sai do backend) ----------------
  route('GET', '/api/luxor/status', (_q, res) => {
    json(res, 200, {
      enabled: config.poolSource === 'luxor',
      keyConfigured: !!config.luxorApiKey,
      currency: config.luxorCurrency,
      subaccount: config.luxorSubaccount ?? null,
      validation: app.luxor?.validation ?? store.getKV('luxor.validation', null),
      minerConfig: luxorMinerConfig(config),
      docs: LUXOR_DOCS,
    });
  });
  route('POST', '/api/luxor/validate', async (_q, res) => {
    if (!app.luxor) return json(res, 409, { error: 'POOL_SOURCE não é luxor' });
    const v = await app.luxor.authenticate(true);
    if (v.state === 'validada') await app.luxor.stats(); // confere também o /pool/summary
    json(res, 200, { validation: app.luxor.validation });
  });

  // ---------------- comandos do operador ----------------
  route('POST', '/api/system/pause', async (req, res) => {
    const b = await readBody(req);
    json(res, 200, runtime.pauseSystem(String(b.reason ?? 'pausa manual'), operator(req)));
  });
  route('POST', '/api/system/resume', (req, res) => {
    const r = runtime.resumeSystem(operator(req));
    json(res, r.ok ? 200 : 409, r);
  });
  route('POST', '/api/agents/:id/run', (_q, res, p) => {
    const r = runtime.enqueue(Number(p.id), 'execução solicitada pelo operador', undefined, `${p.id}:operador`);
    json(res, r.accepted ? 202 : 409, { accepted: r.accepted, duplicate: r.duplicate, reason: r.reason });
  });
  route('POST', '/api/actions/:id/approve', (req, res, p) => {
    const r = runtime.decideAction(p.id, 'approve', operator(req));
    json(res, r.ok ? 200 : 409, r);
  });
  route('POST', '/api/actions/:id/reject', (req, res, p) => {
    const r = runtime.decideAction(p.id, 'reject', operator(req));
    json(res, r.ok ? 200 : 409, r);
  });
  route('POST', '/api/alerts/:id/ack', (_q, res, p) => json(res, store.ackAlert(p.id) ? 200 : 404, { ok: true }));
  route('POST', '/api/maintenance/:id/done', (_q, res, p) => {
    if (!MAINTENANCE_TASKS.some((t) => t.id === p.id)) return json(res, 404, { error: 'tarefa inexistente' });
    const done = store.getKV<Record<string, number>>('maintenance.done', {});
    done[p.id] = runtime.now();
    store.setKV('maintenance.done', done);
    json(res, 200, { ok: true });
  });
  route('POST', '/api/requests/:kind', (_q, res, p) => {
    const allowed: Record<string, string> = { analysis: 'analysis.requested', scenario: 'scenario.requested', report: 'report.requested', export: 'export.requested' };
    if (!allowed[p.kind]) return json(res, 404, { error: 'tipo desconhecido' });
    app.bus.publish({ type: allowed[p.kind], severity: 'info', message: `Operador solicitou ${p.kind}` });
    json(res, 202, { ok: true });
  });

  // ---------------- tempo real ----------------
  route('GET', '/api/stream', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    runtime.setClientCount(sseClients.size);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
      runtime.setClientCount(sseClients.size);
    });
  });
  const unsubscribe = app.bus.subscribe('*', (e: DomainEvent) => {
    if (!sseClients.size || !STREAM_TYPES.some((p) => matchesPattern(p, e.type))) return;
    const payload = `event: ${e.type === 'agent.state' ? 'state' : 'event'}\ndata: ${JSON.stringify(e)}\n\n`;
    for (const c of sseClients) c.write(payload);
  });

  // ---------------- autenticação e estáticos ----------------
  const authorized = (req: IncomingMessage, url: URL) => {
    if (!config.apiToken) return true;
    const h = String(req.headers.authorization ?? '');
    const tok = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token') ?? '';
    return safeEqual(tok, config.apiToken);
  };
  const root = resolve(webDir);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    try {
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname !== '/api/health' && !authorized(req, url)) return json(res, 401, { error: 'não autorizado' });
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = url.pathname.match(r.pattern);
          if (!m) continue;
          const params: Record<string, string> = {};
          r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
          return await r.handler(req, res, params, url);
        }
        return json(res, 404, { error: 'rota inexistente' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'método não permitido' });
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
      const file = resolve(join(root, rel || 'index.html'));
      if (!file.startsWith(root)) return json(res, 403, { error: 'caminho inválido' });
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : body);
      } catch {
        const body = await readFile(join(root, 'index.html'));
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(body);
      }
    } catch (e) {
      app.logger.log('error', 'erro na API', { error: String(e), path: url.pathname });
      if (!res.headersSent) json(res, 500, { error: 'erro interno' });
    }
  });
  server.on('close', () => {
    unsubscribe();
    for (const c of sseClients) c.end();
  });
  return server;
}
