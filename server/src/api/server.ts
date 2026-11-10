// API HTTP + canal em tempo real (Server-Sent Events) + arquivos estáticos do escritório virtual.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { App } from '../app.ts';
import type { AgentState, DomainEvent, Severity } from '../core/types.ts';
import { AGENT_STATES } from '../core/types.ts';
import { DEPARTMENTS, topologicalOrder, validateDependencies } from '../agents/index.ts';
import { computeEvidence } from '../core/evidence.ts';
import { verifyAuditChain, buildReceiptsCsv } from '../agents/d09-auditoria.ts';
import { MAINTENANCE_TASKS } from '../agents/d08-automacao.ts';
import { matchesPattern } from '../core/eventBus.ts';
import { luxorMinerConfig, LUXOR_DOCS } from '../adapters/luxor.ts';
import { DEFAULT_SELECTOR, NOT_CALCULABLE, activeCandidates } from '../mining/selector.ts';
import { energyReport } from '../mining/energy.ts';
import { buildIndicators } from '../mining/state.ts';
import { AUTH_PHRASE, testChecklist, validateTestRequest } from '../mining/testPlan.ts';
import { findCoin } from '../mining/catalog.ts';
import { SRBMINER, buildSrbArgs } from '../mining/srbminer.ts';
import { QrCode } from '../tools/qr.ts';
import { lanAddresses, lanLink, phoneLink } from '../tools/celular.ts';
import { sha256File } from '../mining/process.ts';
import type { TestReport } from '../mining/testRunner.ts';
import { buildQuote } from '../mining/quotes.ts';
import type { MarketQuote } from '../mining/profitability.ts';
import { WhatToMineSource } from '../adapters/whattomine.ts';
import { autoMiningSnapshot } from '../mining/simulation.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};

const STREAM_TYPES = ['agent.state', 'agent.*', 'alert.*', 'action.*', 'system.*', 'strategy.*', 'pool.*', 'wallet.*', 'mining.*'];

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, url: URL) => Promise<void> | void;

/** Aceita requisição sem cabeçalho Origin (ferramentas locais) ou com Origin igual ao Host atendido. */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === String(req.headers.host ?? '');
  } catch {
    return false;
  }
}

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
    json(res, 200, list.map((a) => ({ ...a, healthLevel: runtime.healthOf(a.id)?.level })));
  });

  // Saúde coletiva (regras fixas do runtime) e mapa de dependências entre os agentes.
  route('GET', '/api/agents-health', (_q, res) => {
    const all = runtime.healthAll();
    const byLevel = { ok: 0, atencao: 0, falha: 0, indeterminado: 0 };
    for (const h of all) byLevel[h.level]++;
    json(res, 200, { total: all.length, byLevel, agents: all });
  });
  route('GET', '/api/dependencies', (_q, res) => {
    json(res, 200, { ...runtime.dependencyGraph(), problems: validateDependencies(runtime.definitions()), order: topologicalOrder(runtime.definitions()) });
  });

  route('GET', '/api/agents/:id', async (_q, res, p) => {
    const a = runtime.agent(Number(p.id));
    if (!a) return json(res, 404, { error: 'agente inexistente' });
    const brief = (id: number) => { const x = runtime.agent(id); return x ? { id: x.id, code: x.code, name: x.name, state: x.state } : undefined; };
    json(res, 200, {
      ...a,
      health: await runtime.checkHealth(a.id),
      dependencies: a.dependsOn.map(brief).filter(Boolean),
      dependents: runtime.agents().filter((x) => x.dependsOn.includes(a.id)).map((x) => brief(x.id)),
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
      appEnv: config.appEnv,
      simulationRejected: config.simulationRejected,
      mining: app.mining.state,
      uptimeS: Math.floor((runtime.now() - runtime.startedAt) / 1000),
    });
  });

  // LLM: estado (provedor, modelo, limites) e teste da chave. A chave em si nunca aparece nas respostas.
  route('GET', '/api/llm/status', (_q, res) => json(res, 200, { ...llm.status(), validation: store.getKV('llm.validation', null) }));
  route('POST', '/api/llm/validate', async (_q, res) => {
    const v = await llm.validate();
    store.setKV('llm.validation', v, runtime.now());
    app.bus.publish({ type: 'system.llm_validation', severity: v.ok ? 'info' : 'warn', message: `LLM (${v.provider ?? 'sem provedor'}): ${v.detail}`, data: { ok: v.ok, provider: v.provider, model: v.model } });
    json(res, 200, { validation: v, status: llm.status() });
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

  // ---------------- GPU (somente leitura pelo nvidia-smi; nenhum minerador é consultado ou iniciado) ----------------
  route('GET', '/api/gpu', async (_q, res) => json(res, 200, { ...(await app.gpu.read()), mineracao: app.mining.state }));

  // ---------------- rentabilidade de GPU (recomendação; mineração DESATIVADA) ----------------
  const wtm = config.miningDataSource === 'whattomine' ? new WhatToMineSource(app.http) : undefined;
  const energyNow = () => {
    const lim = store.latestMetric('gpu.power_limit_w');
    return energyReport({
      mode: config.energyCostMode,
      tariffKwh: config.energyPriceKwh,
      monthlyCostInformed: config.energyMonthlyCostLocal,
      declaredPowerW: config.powerWatts,
      hoursPerDay: config.operationHoursPerDay,
      daysPerMonth: config.energyDaysPerMonth,
      gpuPowerLimitW: lim && lim.provenance === 'real' && typeof lim.value === 'number' ? lim.value : undefined,
    }, store.getKV<TestReport | null>('mining.lastTest', null)?.energiaMedida); // modalidade B: só amostras do último teste em MINERANDO
  };
  route('GET', '/api/energy', (_q, res) => json(res, 200, { moeda: config.localCurrency, ...energyNow() }));
  route('GET', '/api/auto-mining', async (_q, res) => {
    const energia = energyNow();
    const cfg = { ...DEFAULT_SELECTOR, energyCostDay: energia.custoDiario, maxQuoteAgeMs: config.miningDataMaxAgeMin * 60_000 };
    const now = Date.now();
    const quotes: MarketQuote[] = [];
    const motivos: Record<string, string> = {};
    let fonte = 'INDISPONÍVEL: MINING_DATA_SOURCE=none (nenhuma fonte de rentabilidade habilitada)';
    let fonteStatus: Record<string, unknown> = { habilitada: false };
    if (wtm) {
      const st = await wtm.coins();
      const p = store.latestMetric(`price.BTC-${config.localCurrency}`);
      const btc = p && typeof p.value === 'number' ? { price: p.value, ts: p.ts, provenance: p.provenance } : undefined;
      for (const coin of activeCandidates()) {
        const r = buildQuote(coin, st.ok ? st.coins : undefined, config.gpuHashrates[coin.symbol], btc);
        if (r.quote) quotes.push(r.quote);
        else motivos[coin.symbol] = `${NOT_CALCULABLE}: ${st.ok ? r.reason : st.reason}`;
      }
      const coinAges = st.ok
        ? Object.fromEntries(activeCandidates().filter((c) => c.wtmTag).map((c) => {
            const w = st.coins.find((x) => x.tag === c.wtmTag);
            return [c.symbol, w ? { atualizadoEm: new Date(w.timestampMs).toISOString(), idadeMin: Math.round((now - w.timestampMs) / 60_000), atrasado: w.lagging, algoritmo: w.algorithm } : null];
          }))
        : {};
      fonte = st.ok ? 'whattomine + coinbase (estimado)' : st.reason;
      fonteStatus = {
        habilitada: true,
        ok: st.ok,
        consultadoEm: new Date(st.ok ? st.fetchedAt : st.at).toISOString(),
        entradasRejeitadas: st.ok ? st.rejected : undefined,
        moedas: coinAges,
        cotacaoBtc: btc ? { procedencia: btc.provenance, fonte: p!.source, atualizadoEm: new Date(btc.ts).toISOString(), idadeMin: Math.round((now - btc.ts) / 60_000) } : null,
        limiteIdadeMin: config.miningDataMaxAgeMin,
      };
    }
    const snap = autoMiningSnapshot(cfg, quotes, now, { motivos, fonte });
    const calculavel = snap.moedas.some((m) => m.eligible);
    json(res, 200, {
      ...snap,
      rentabilidade: calculavel ? 'ESTIMADA (nunca garantida)' : NOT_CALCULABLE,
      moeda: config.localCurrency,
      periodo: 'dia',
      mineracao: app.mining.state,
      fonteStatus,
      energia,
    });
  });

  // ---------------- estado da mineração e teste controlado ----------------
  // O minerador só conta como integrado se o arquivo existe AGORA e o SHA-256 confere com o informado no .env.
  const minerCheck = async (): Promise<{ ok: boolean; detalhe: string }> => {
    const mg = config.minerGpu;
    if (mg.problemas.length) return { ok: false, detalhe: `configuração recusada: ${mg.problemas.join('; ')}` };
    if (!app.supervisor || !mg.path || !mg.sha256) {
      if (app.supervisor) return { ok: true, detalhe: 'binário de teste injetado (somente testes automatizados)' };
      return { ok: false, detalhe: `informe MINER_GPU_PATH (caminho do ${SRBMINER.exeName}) e MINER_GPU_SHA256 no .env; veja docs/MINERADOR-SRBMINER.md` };
    }
    try {
      const h = await sha256File(mg.path);
      return h === mg.sha256
        ? { ok: true, detalhe: `${SRBMINER.name}: ${mg.path} · SHA-256 conferido agora (${h.slice(0, 12)}…)` }
        : { ok: false, detalhe: `SHA-256 NÃO confere: arquivo ${h.slice(0, 12)}…, informado ${mg.sha256.slice(0, 12)}…. Não execute: baixe de novo da página oficial` };
    } catch (e) {
      return { ok: false, detalhe: `arquivo não encontrado ou ilegível em MINER_GPU_PATH (${(e as NodeJS.ErrnoException).code ?? 'erro'}). Se o antivírus moveu o arquivo para a quarentena, a decisão de liberar é sua: o sistema não desativa proteções` };
    }
  };
  route('GET', '/api/mining/state', (_q, res) => {
    const get = (k: string) => store.latestMetric(k);
    json(res, 200, {
      ...app.mining.snapshot(),
      indicadores: buildIndicators(get, app.supervisor ? app.supervisor.isRunning() : undefined, Date.now()),
      processo: app.supervisor?.last() ?? null,
      testeAtual: app.runner?.active() ? app.runner.current() : null,
      ultimoTeste: store.getKV('mining.lastTest', null),
      minerador: { nome: `${SRBMINER.name} ${SRBMINER.version}`, configurado: !!app.supervisor, worker: config.minerGpu.worker, problemas: config.minerGpu.problemas },
      historico: app.mining.history().slice(-20),
    });
  });
  const checklistFor = async (body: unknown) => {
    const req = validateTestRequest(body);
    if (typeof req === 'string') return { erro: req };
    const gpu = await app.gpu.read(true);
    const mc = await minerCheck();
    return { req, ...testChecklist({ req, gpu, allowedPools: config.allowedPools, payoutAddresses: config.payoutAddresses, minerIntegrated: mc.ok, minerDetail: mc.detalhe, maxTempC: config.maxTempC, criticalTempC: config.criticalTempC, busy: !!app.runner?.active() }) };
  };
  const toReady = (motivo: string) => {
    if (['DESATIVADA', 'PARADA', 'DADOS INDISPONÍVEIS'].includes(app.mining.state)) app.mining.transition('PRONTA PARA TESTE', 'operador', motivo);
  };
  route('POST', '/api/mining/test/check', async (req, res) => {
    const r = await checklistFor(await readBody(req));
    if ('erro' in r) return json(res, 400, { error: r.erro });
    if (r.pronto) toReady('todas as pré-condições conferidas');
    else if (app.mining.state === 'PRONTA PARA TESTE') app.mining.transition('DESATIVADA', 'operador', 'pré-condição deixou de ser atendida');
    json(res, 200, { ...r, estado: app.mining.state });
  });
  route('POST', '/api/mining/test/start', async (req, res) => {
    const body = await readBody(req);
    if (body.confirmacao !== AUTH_PHRASE) return json(res, 400, { error: `autorização explícita ausente: digite a frase exata "${AUTH_PHRASE}"`, estado: app.mining.state });
    const r = await checklistFor(body);
    if ('erro' in r) return json(res, 400, { error: r.erro });
    if (!r.pronto) return json(res, 409, { error: 'pré-condições não atendidas: teste não iniciado', checks: r.checks, estado: app.mining.state });
    if (!app.runner) return json(res, 409, { error: 'minerador não configurado', estado: app.mining.state });
    const coin = findCoin(r.req.coin)!;
    let args: string[];
    try {
      args = buildSrbArgs({ profile: coin.minerProfile!, wallet: config.payoutAddresses[r.req.coin], worker: config.minerGpu.worker, gpuOffTempC: Math.round(config.maxTempC) });
    } catch (e) {
      return json(res, 409, { error: `teste não iniciado: ${(e as Error).message}`, estado: app.mining.state });
    }
    toReady('pré-condições conferidas no início do teste');
    try {
      const teste = await app.runner.start({ coin: r.req.coin, durationMin: r.req.durationMin, args, profile: coin.minerProfile!, worker: config.minerGpu.worker });
      json(res, 200, { ok: true, estado: app.mining.state, teste, checks: r.checks });
    } catch (e) {
      json(res, 500, { error: `teste não iniciado: ${(e as Error).message}`, estado: app.mining.state, ultimoTeste: store.getKV('mining.lastTest', null) });
    }
  });
  route('POST', '/api/mining/stop', async (_q, res) => {
    if (app.runner?.active()) {
      const rep = await app.runner.stop('INTERROMPER pelo operador');
      return json(res, 200, { ok: true, mensagem: 'teste interrompido; processo encerrado e confirmado', estado: app.mining.state, teste: rep, processo: app.supervisor?.last() ?? null });
    }
    if (!app.supervisor || !app.supervisor.isRunning()) return json(res, 200, { ok: true, mensagem: 'nenhum processo de mineração ativo', estado: app.mining.state });
    const rec = await app.supervisor.stop('interrompido pelo operador');
    if (['INICIANDO', 'MINERANDO', 'ERRO', 'TESTE AUTORIZADO'].includes(app.mining.state)) app.mining.transition('PARADA', 'operador', 'botão INTERROMPER');
    json(res, 200, { ok: true, processo: rec, estado: app.mining.state });
  });

  // ---------------- abrir no celular (QR) ----------------
  // Só para quem está NESTE computador: o QR leva o token. O celular precisa estar no mesmo Wi-Fi.
  route('GET', '/api/celular', (req, res) => {
    const a = req.socket.remoteAddress ?? '';
    if (!(a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1')) return json(res, 403, { error: 'o QR só é mostrado no próprio computador' });
    const aberto = config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1';
    if (!aberto || !config.apiToken) {
      return json(res, 200, { liberado: false, motivo: 'o painel atende só este computador. Feche o painel e abra o Abrir-no-Celular.bat (ele libera o Wi-Fi com token).' });
    }
    const ips = lanAddresses();
    if (!ips.length) return json(res, 200, { liberado: false, motivo: 'não encontrei o endereço deste computador na rede local. Ele está no Wi-Fi ou no cabo?' });
    const opcoes = ips.map((ip) => {
      const link = phoneLink(ip, config.port, config.apiToken!, config.publicLink);
      return { ip, endereco: `http://${ip}:${config.port}`, link, linkLocal: lanLink(ip, config.port, config.apiToken!), svg: QrCode.encodeText(link).toSvg() };
    });
    json(res, 200, { liberado: true, linkPublico: config.publicLink, opcoes });
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
  const isLoopback = (req: IncomingMessage) => {
    const a = req.socket.remoteAddress ?? '';
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  };
  const authorized = (req: IncomingMessage, url: URL) => {
    // Sem API_TOKEN, só o próprio computador é atendido (nunca a rede local).
    if (!config.apiToken) return isLoopback(req);
    const h = String(req.headers.authorization ?? '');
    const tok = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token') ?? '';
    return safeEqual(tok, config.apiToken);
  };
  const root = resolve(webDir);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    try {
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname !== '/api/health' && !authorized(req, url)) return json(res, 401, { error: 'não autorizado' });
        // Validação de origem: comandos (não-GET) vindos de outra página são recusados.
        if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return json(res, 403, { error: 'origem não permitida' });
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
