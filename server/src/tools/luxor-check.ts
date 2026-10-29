// Verificação da integração Luxor: npm run luxor:check
// 1) GET /workspace (autenticação). Só se responder 200, consulta:
// 2) GET /pool/subaccounts  3) GET /pool/summary/{moeda}  4) GET /pool/workers/{moeda}?status=ACTIVE
// Somente leitura. A chave nunca é impressa (apenas os 4 primeiros e 4 últimos caracteres).
import { loadConfig } from '../config.ts';
import { checkSummary, checkWorkers, checkWorkspace, LuxorClient, LuxorHttpError, luxorMinerConfig, maskKey, type LuxorSummary, type LuxorWorkspace } from '../adapters/luxor.ts';

const ok = (s: string) => console.log(`  ✓ ${s}`);
const bad = (s: string) => console.log(`  ✗ ${s}`);
const info = (s: string) => console.log(`    ${s}`);

async function main(): Promise<number> {
  const c = loadConfig();
  console.log('AI CRYPTO MINER — verificação da pool Luxor (somente leitura)');
  console.log(`API: ${c.luxorApiUrl} · moeda: ${c.luxorCurrency} · chave: ${maskKey(c.luxorApiKey)}\n`);
  if (!c.luxorApiKey) {
    bad('LUXOR_API_KEY não está no .env do backend.');
    return 2;
  }
  const client = new LuxorClient({ baseUrl: c.luxorApiUrl, apiKey: c.luxorApiKey });
  const q = { subaccount_names: c.luxorSubaccount, site_id: c.luxorSiteId };

  console.log('1. Autenticação — GET /workspace');
  let ws: LuxorWorkspace;
  try {
    ws = await client.get<LuxorWorkspace>('/workspace');
  } catch (e) {
    if (e instanceof LuxorHttpError) {
      bad(`HTTP ${e.status}: ${e.message}`);
      if (e.status === 401) info('A chave foi recusada. Confira se foi copiada inteira ou gere outra em Workspace → API Keys.');
      if (e.status === 403) info('A chave não tem permissão para este recurso. Revise as permissões dela no painel da Luxor.');
    } else bad(`Sem resposta da API: ${(e as Error).message}`);
    console.log('\nRESULTADO: integração NÃO validada. Nenhuma outra consulta foi feita.');
    return 1;
  }
  const wsProblems = checkWorkspace(ws);
  if (wsProblems.length) {
    bad(`HTTP 200, mas fora do esquema documentado: ${wsProblems.join('; ')}`);
    return 1;
  }
  ok(`HTTP 200 · workspace "${ws.name}" · produtos: ${ws.products.join(', ') || '(nenhum)'} · sites: ${ws.sites.length}`);

  console.log('\n2. Subcontas — GET /pool/subaccounts');
  try {
    const sub = await client.get<{ subaccounts: { name: string }[] }>('/pool/subaccounts', { site_id: c.luxorSiteId });
    const names = (sub.subaccounts ?? []).map((s) => s.name);
    ok(`${names.length} subconta(s): ${names.join(', ') || '(nenhuma)'}`);
    if (c.luxorSubaccount && !names.includes(c.luxorSubaccount)) bad(`LUXOR_SUBACCOUNT="${c.luxorSubaccount}" não existe nesta conta.`);
    if (!names.length) info('Crie uma subconta no painel da Luxor antes de configurar o minerador.');
  } catch (e) {
    bad((e as Error).message);
  }

  console.log(`\n3. Resumo da pool — GET /pool/summary/${c.luxorCurrency}`);
  let summary: LuxorSummary | undefined;
  try {
    summary = await client.get<LuxorSummary>(`/pool/summary/${c.luxorCurrency}`, q);
    const p = checkSummary(summary);
    if (p.length) bad(`fora do esquema: ${p.join('; ')}`);
    else {
      ok('esquema conferido');
      const pick = (arr: { currency_type: string; revenue: number }[]) => arr.filter((x) => x.currency_type === c.luxorCurrency).reduce((a, x) => a + x.revenue, 0);
      info(`mineradores ativos: ${summary.active_miners}`);
      info(`hashrate 5m / 24h (valor bruto, unidade não documentada): ${summary.hashrate_5m} / ${summary.hashrate_24h}`);
      info(`uptime 24h: ${summary.uptime_24h}`);
      info(`saldo: ${pick(summary.balance).toFixed(8)} ${c.luxorCurrency} · receita 24h: ${pick(summary.revenue_24h).toFixed(8)} · total: ${pick(summary.revenue_all_time).toFixed(8)}`);
    }
  } catch (e) {
    bad((e as Error).message);
  }

  console.log(`\n4. Workers ativos — GET /pool/workers/${c.luxorCurrency}?status=ACTIVE`);
  try {
    const w = await client.get<{ total_active: number; workers: { name: string; subaccount_name: string; hashrate: number; last_share_time: string }[] }>(
      `/pool/workers/${c.luxorCurrency}`, { ...q, status: 'ACTIVE', page_size: 50 });
    const p = checkWorkers(w);
    if (p.length) bad(`fora do esquema: ${p.join('; ')}`);
    else {
      ok(`${w.total_active} worker(s) ativo(s)`);
      for (const x of w.workers.slice(0, 20)) info(`${x.subaccount_name}.${x.name} · hashrate ${x.hashrate} · última share ${x.last_share_time}`);
    }
  } catch (e) {
    bad((e as Error).message);
  }

  const verified = !!summary && checkSummary(summary).length === 0;
  console.log('\nRESULTADO:');
  console.log(verified
    ? '  Autenticação VALIDADA e dados de /workspace e /pool/summary conferidos com o esquema documentado.'
    : '  Autenticação validada, mas os dados da pool não puderam ser conferidos.');
  if (summary && summary.active_miners === 0) console.log('  Nenhum minerador ativo: os agentes de pool continuarão em modo SIMULADO até haver equipamento conectado.');

  const mc = luxorMinerConfig(c);
  console.log('\nConfiguração do minerador (guia oficial da Luxor):');
  info(`URL: ${mc.url}`);
  info(`Worker: ${mc.worker ?? '<SUBCONTA>.<NOME_DO_EQUIPAMENTO>'}`);
  info(`Senha: ${mc.password} (exemplo da documentação)`);
  if (mc.missing.length) info(`Falta definir no .env: ${mc.missing.join('; ')}`);
  return verified ? 0 : 1;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
