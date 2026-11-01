// Executor do TESTE CONTROLADO de mineração. Só é chamado pela rota /api/mining/test/start depois de:
// checklist completo + frase de autorização digitada pelo operador. Regras:
//  - um teste por vez, com duração máxima (1–30 min) aplicada pelo supervisor;
//  - MINERANDO só com processo ativo E hashrate informado pelo próprio minerador no último minuto;
//  - para sozinho por temperatura (crítica: na hora; máxima: 3 leituras seguidas), por falta de hashrate
//    (2 min sem "Total:") ou quando o processo termina;
//  - grava o console completo em arquivo e um relatório com o que foi e o que NÃO foi comprovado.
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { ProcessSupervisor, ProcessRecord } from './process.ts';
import type { MiningStateMachine, MiningState } from './state.ts';
import { SrbConsoleParser, SRBMINER } from './srbminer.ts';
import type { MinerProfile } from './catalog.ts';
import type { GpuView } from '../gpu/monitor.ts';
import type { Metric } from '../core/types.ts';
import type { MeasuredPower } from './energy.ts';

export interface TestReport {
  moeda: string;
  minerador: string;
  pool: string;
  worker: string;
  iniciadoEm: string;
  encerradoEm?: string;
  duracaoS?: number;
  motivoFim?: string;
  codigoSaida?: number | null;
  estadoFinal?: MiningState;
  hashrate: { ultimoHs?: number; maximoHs?: number; medioHs?: number; amostras: number; trechoOriginal?: string };
  shares: { aceitas: number; rejeitadas: number; fonte: string };
  tarefasRecebidas: number;
  gpu: { temperaturaMaxC?: number; potenciaMediaW?: number; amostrasPotencia: number; utilizacaoMediaPct?: number };
  energiaMedida?: MeasuredPower;
  console: { linhas: number; linhasTotalNaoReconhecidas: number; arquivo: string; ultimas: string[] };
  comprovado: string[];
  naoComprovado: string[];
}

export interface RunnerDeps {
  supervisor: ProcessSupervisor;
  binaryId: string;
  mining: MiningStateMachine;
  gpu: { read(force?: boolean): Promise<GpuView> };
  putMetric: (m: Metric) => void;
  saveReport: (r: TestReport) => void;
  logDir: string;
  maxTempC: number;
  criticalTempC: number;
  now?: () => number;
  tickMs?: number;
  noHashrateStopMs?: number;
}

export interface StartInput {
  coin: string;
  durationMin: number;
  args: string[];
  profile: MinerProfile;
  worker: string;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);

export class MiningTestRunner {
  private d: RunnerDeps;
  private now: () => number;
  private parser?: SrbConsoleParser;
  private timer?: NodeJS.Timeout;
  private log?: WriteStream;
  private report?: TestReport;
  private finishing?: Promise<TestReport | undefined>;
  private hotStreak = 0;
  private lastHrAt?: number;
  private hrSamples: number[] = [];
  private powerSamples: number[] = [];
  private utilSamples: number[] = [];
  private tempMax?: number;
  private miningFrom?: number;
  private miningTo?: number;
  private ticking = false;
  private stopReason?: string;

  constructor(d: RunnerDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
  }

  active(): boolean {
    return !!this.report && !this.report.encerradoEm;
  }

  current(): TestReport | undefined {
    if (!this.report) return undefined;
    return { ...this.report, console: { ...this.report.console, ultimas: this.parser?.lastLines(30) ?? this.report.console.ultimas } };
  }

  async start(i: StartInput): Promise<TestReport> {
    if (this.active() || this.d.supervisor.isRunning()) throw new Error('já existe um teste em andamento');
    const m = this.d.mining;
    if (m.state !== 'PRONTA PARA TESTE') throw new Error(`estado ${m.state}: verifique as pré-condições antes`);
    const t0 = this.now();
    const stamp = new Date(t0).toISOString().replace(/[:.]/g, '-');
    mkdirSync(this.d.logDir, { recursive: true });
    const file = join(this.d.logDir, `srbminer-${stamp}.log`);
    this.reset();
    this.parser = new SrbConsoleParser(this.now);
    this.report = {
      moeda: i.coin, minerador: `${SRBMINER.name} ${SRBMINER.version}`, pool: `${i.profile.poolName} · ${i.profile.stratumUrl}`, worker: i.worker,
      iniciadoEm: new Date(t0).toISOString(),
      hashrate: { amostras: 0 }, shares: { aceitas: 0, rejeitadas: 0, fonte: 'console do minerador ("result accepted"/"result rejected")' },
      tarefasRecebidas: 0, gpu: { amostrasPotencia: 0 },
      console: { linhas: 0, linhasTotalNaoReconhecidas: 0, arquivo: file, ultimas: [] },
      comprovado: [], naoComprovado: [],
    };
    this.log = createWriteStream(file, { flags: 'a' });
    this.log.write(`# ${SRBMINER.name} ${SRBMINER.version} · ${i.coin} · ${i.durationMin} min · ${new Date(t0).toISOString()}\n# argumentos: ${i.args.join(' ')}\n`);

    m.transition('TESTE AUTORIZADO', 'operador', `frase de autorização digitada: ${i.coin}, ${i.durationMin} min`);
    m.transition('INICIANDO', 'supervisor', `iniciando ${SRBMINER.name} na pool ${i.profile.poolName}`);
    try {
      await this.d.supervisor.start({
        binaryId: this.d.binaryId,
        args: i.args,
        maxRuntimeMs: i.durationMin * 60_000,
        onOutput: (text) => {
          this.log?.write(text);
          this.parser?.feed(text);
        },
      });
    } catch (e) {
      m.transition('ERRO', 'supervisor', `minerador não iniciado: ${(e as Error).message}`);
      this.stopReason = `não iniciado: ${(e as Error).message}`;
      await this.finish();
      throw e;
    }
    this.timer = setInterval(() => void this.tick(), this.d.tickMs ?? 5000);
    return this.current()!;
  }

  /** INTERROMPER: encerra o processo, confirma a saída e fecha o relatório. */
  async stop(reason: string): Promise<TestReport | undefined> {
    this.stopReason ??= reason;
    if (this.d.supervisor.isRunning()) await this.d.supervisor.stop(reason);
    return this.finish();
  }

  private reset(): void {
    this.finishing = undefined;
    this.hotStreak = 0;
    this.lastHrAt = undefined;
    this.hrSamples = [];
    this.powerSamples = [];
    this.utilSamples = [];
    this.tempMax = undefined;
    this.miningFrom = undefined;
    this.miningTo = undefined;
    this.stopReason = undefined;
  }

  private metric(key: string, value: number | boolean, unit?: string, ts = this.now()): void {
    this.d.putMetric({ key, value, unit, provenance: 'real', source: `${SRBMINER.name} (console)`, ts, agentId: 0 });
  }

  /** Uma rodada de supervisão. Exposto para os testes automatizados. */
  async tick(): Promise<void> {
    if (this.ticking || !this.report || this.report.encerradoEm) return;
    this.ticking = true;
    try {
      const m = this.d.mining;
      const s = this.parser!.stats;
      const alive = this.d.supervisor.isRunning();
      const now = this.now();

      if (s.hashrateAt !== undefined && s.hashrateAt !== this.lastHrAt && s.hashrateHs !== undefined) {
        this.lastHrAt = s.hashrateAt;
        this.metric('miner.hashrate_hs', s.hashrateHs, 'H/s', s.hashrateAt);
        if (m.state === 'MINERANDO' && s.hashrateHs > 0) this.hrSamples.push(s.hashrateHs);
      }
      this.metric('miner.shares_accepted', s.accepted);
      this.metric('miner.shares_rejected', s.rejected);
      if (s.jobs > 0 || s.accepted > 0) this.metric('miner.pool_connected', true);

      if (alive) {
        try {
          const g = (await this.d.gpu.read(true)).gpus?.[0];
          if (g?.temperatureC != null) {
            this.tempMax = Math.max(this.tempMax ?? g.temperatureC, g.temperatureC);
            if (g.temperatureC >= this.d.criticalTempC) { await this.stop(`temperatura crítica: ${g.temperatureC} °C (limite ${this.d.criticalTempC} °C)`); return; }
            this.hotStreak = g.temperatureC >= this.d.maxTempC ? this.hotStreak + 1 : 0;
            if (this.hotStreak >= 3) { await this.stop(`temperatura acima de ${this.d.maxTempC} °C em 3 leituras seguidas (${g.temperatureC} °C)`); return; }
          }
          if (m.state === 'MINERANDO') {
            if (g?.powerW != null) this.powerSamples.push(g.powerW);
            if (g?.utilizationPct != null) this.utilSamples.push(g.utilizationPct);
          }
        } catch { /* leitura da GPU falhou: o monitor registra o motivo; o teste segue com os limites do minerador */ }
      }

      const fresh = s.hashrateAt !== undefined && now - s.hashrateAt <= 60_000 && (s.hashrateHs ?? 0) > 0;
      if (alive && m.state === 'INICIANDO' && fresh) {
        m.transition('MINERANDO', 'supervisor', `hashrate informado pelo minerador: ${s.hashrateRaw}`, {
          processAlive: true, minerHashrate: { value: s.hashrateHs!, unit: 'H/s', at: s.hashrateAt! },
        });
        this.miningFrom = now;
      }
      if (alive && m.state === 'MINERANDO') {
        this.miningTo = now;
        if (s.hashrateAt !== undefined && now - s.hashrateAt > (this.d.noHashrateStopMs ?? 120_000)) {
          await this.stop('o minerador parou de informar hashrate por mais de 2 minutos');
          return;
        }
      }
      if (!alive) await this.finish();
    } finally {
      this.ticking = false;
    }
  }

  private finish(): Promise<TestReport | undefined> {
    this.finishing ??= this.doFinish();
    return this.finishing;
  }

  private async doFinish(): Promise<TestReport | undefined> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const r = this.report;
    if (!r) return undefined;
    const rec: ProcessRecord | undefined = this.d.supervisor.last();
    const end = rec?.endedAt ?? this.now();
    const s = this.parser!.stats;
    const m = this.d.mining;
    if (['INICIANDO', 'MINERANDO', 'ERRO', 'TESTE AUTORIZADO'].includes(m.state)) {
      m.transition('PARADA', 'supervisor', this.stopReason ?? rec?.reason ?? 'teste encerrado');
    }
    await new Promise<void>((res) => (this.log ? this.log.end(() => res()) : res()));
    this.log = undefined;

    const measured: MeasuredPower | undefined = this.powerSamples.length && this.miningFrom !== undefined
      ? { avgW: avg(this.powerSamples)!, samples: this.powerSamples.length, duringMining: true, fromAt: this.miningFrom, toAt: this.miningTo ?? end }
      : undefined;
    Object.assign(r, {
      encerradoEm: new Date(end).toISOString(),
      duracaoS: Math.round((end - Date.parse(r.iniciadoEm)) / 1000),
      motivoFim: this.stopReason ?? rec?.reason ?? 'processo terminou',
      codigoSaida: rec?.exitCode,
      estadoFinal: m.state,
      hashrate: {
        ultimoHs: s.hashrateHs, maximoHs: this.hrSamples.length ? Math.max(...this.hrSamples) : undefined,
        medioHs: avg(this.hrSamples), amostras: this.hrSamples.length, trechoOriginal: s.hashrateRaw,
      },
      shares: { ...r.shares, aceitas: s.accepted, rejeitadas: s.rejected },
      tarefasRecebidas: s.jobs,
      gpu: { temperaturaMaxC: this.tempMax, potenciaMediaW: avg(this.powerSamples), amostrasPotencia: this.powerSamples.length, utilizacaoMediaPct: avg(this.utilSamples) },
      energiaMedida: measured,
      console: { linhas: s.lines, linhasTotalNaoReconhecidas: s.unmatchedTotalLines, arquivo: r.console.arquivo, ultimas: this.parser!.lastLines(30) },
    } satisfies Partial<TestReport>);
    r.comprovado = [];
    r.naoComprovado = [];
    (this.hrSamples.length ? r.comprovado : r.naoComprovado).push(this.hrSamples.length
      ? `o minerador informou hashrate na RTX 3050 (médio ${fmtHs(r.hashrate.medioHs!)}, ${r.hashrate.amostras} leituras)`
      : 'nenhum hashrate maior que zero foi informado pelo minerador');
    (s.jobs > 0 ? r.comprovado : r.naoComprovado).push(s.jobs > 0 ? `a pool enviou trabalho (${s.jobs} linhas "new job")` : 'nenhuma linha "new job" no console: conexão com a pool não confirmada');
    (s.accepted > 0 ? r.comprovado : r.naoComprovado).push(s.accepted > 0
      ? `${s.accepted} share(s) aceita(s) segundo o console (rejeitadas: ${s.rejected})`
      : 'nenhuma share aceita no console (em poucos minutos isso pode acontecer)');
    r.naoComprovado.push('saldo e pagamento: só a página da pool e a carteira comprovam; o teste não verifica');
    r.naoComprovado.push('lucro: um teste curto não comprova receita diária');
    if (s.unmatchedTotalLines > 0) r.naoComprovado.push(`${s.unmatchedTotalLines} linha(s) "Total:" em formato não reconhecido: envie o arquivo de log para ajustar a leitura`);
    if (!measured) r.naoComprovado.push('consumo durante mineração: sem amostras suficientes');
    this.d.saveReport({ ...r });
    return { ...r };
  }
}

export function fmtHs(v: number): string {
  const u: [number, string][] = [[1e15, 'PH/s'], [1e12, 'TH/s'], [1e9, 'GH/s'], [1e6, 'MH/s'], [1e3, 'kH/s']];
  for (const [f, n] of u) if (v >= f) return `${(v / f).toFixed(2)} ${n}`;
  return `${v.toFixed(0)} H/s`;
}
