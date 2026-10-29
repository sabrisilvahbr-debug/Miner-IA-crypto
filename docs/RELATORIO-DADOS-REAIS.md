# Relatório — eliminação de simulações e monitoramento real (2026-10-29)

Hardware de referência: **NVIDIA GeForce RTX 3050, 6 GB, limite de 70 W** (dados do `nvidia-smi` enviados pelo operador). O sistema ainda não rodou nesse computador.

## 1. Simulações removidas dos fluxos de produção

| Onde estava | O que fazia | Agora |
|---|---|---|
| `config.ts` | padrão `simulated` para minerador, mercado, rede, pool e carteira | padrão `none`. Em `APP_ENV=production`, `simulated` é recusado, vira `none` e aparece no selo do painel |
| `adapters/external.ts`, `adapters/miner.ts` | criavam adaptadores simulados se pedidos | recusam criar adaptador simulado fora de `APP_ENV=test` |
| `adapters/luxor.ts` | sem autenticação ou sem worker, **trocava os dados da pool por números do simulador** (saldo, pagos, hashrate) | sem autenticação: **INDISPONÍVEL**, sem saldo nem hashrate. Autenticada sem worker: dados reais da conta e **POOL NÃO CONECTADA** |
| `api/server.ts` (rentabilidade) | usava 170 W fixos (RTX 3060) e tarifa 0,90 embutida | custo de energia vem do módulo de energia. Sem custo: **RENTABILIDADE NÃO CALCULÁVEL — FALTA DE DADOS REAIS** |
| `gpu/monitor.ts`, seleção de moeda | rótulo "SIMULAÇÃO" | GPU real com **HARDWARE NÃO VERIFICADO** até a primeira leitura. Seleção marcada como "RECOMENDAÇÃO — MINERAÇÃO DESATIVADA" |
| `web/js/app.js` (selo de modo) | mostrava **"DADOS REAIS" mesmo sem nenhuma fonte configurada** | "SEM FONTES CONFIGURADAS", "FONTES REAIS (PARCIAIS)" ou "SIMULADO — SOMENTE EM TESTES" |
| `.env.example` | começava em modo simulação | produção, sem simulação |

O simulador (`adapters/sim.ts`, `SimulatedMinerAdapter`, `SimulatedMarket` etc.) continua no código **só para a suíte de testes** (`testConfig`, `APP_ENV=test`).

Não foram encontrados `Math.random`, gráficos com dados fixos nem transações inventadas no painel. A animação do escritório 3D reflete o estado real de execução de cada agente.

## 2. Implementado

- **Coleta real da GPU** (`gpu/nvidiaSmi.ts`, `gpu/monitor.ts`, agente 14): `nvidia-smi` do PATH (ou `NVIDIA_SMI_PATH` validado), argumentos fixos, sem shell, tempo limite de 5 s, cache de 5 s, leitura a cada 30 s sem bloquear a interface. Grava histórico com o horário da coleta, não regrava a mesma amostra, campo `[N/A]` fica ausente (nunca zero), dado com mais de 30 s vira DESATUALIZADO, e há alerta de temperatura.
- **Máquina de estados** (`mining/state.ts`): DESATIVADA, PRONTA PARA TESTE, TESTE AUTORIZADO, INICIANDO, MINERANDO, ERRO, PARADA, DADOS INDISPONÍVEIS. Cada transição tem origem, horário e motivo e vira evento auditável. O sistema sempre inicia DESATIVADA, então um teste nunca é retomado depois de reiniciar. MINERANDO exige processo ativo **e** hashrate do minerador no último minuto.
- **Oito indicadores independentes**: processo, GPU em uso, hashrate local, worker, shares aceitas, shares rejeitadas, saldo da pool e pagamentos confirmados.
- **Teste controlado** (`mining/testPlan.ts`, `/api/mining/test/*`, botões no painel): verifica a GPU, a moeda, a compatibilidade, o minerador, a pool autorizada, o endereço público, o formato de login, a duração (1–30 min, padrão 5), os limites e os riscos. Exige a frase de autorização. **Sem minerador verificado, responde "NÃO IMPLEMENTADO" e não executa nada.**
- **Supervisor de processos** (`mining/process.ts`): base para a etapa futura. Lista explícita de binários com caminho absoluto e **SHA-256 conferido**, argumentos montados pelo backend, sem shell, tempo máximo obrigatório, INTERROMPER com confirmação de encerramento. Não há nenhum minerador cadastrado.
- **Custo de energia** (`mining/energy.ts`, `/api/energy`): modalidade A (custo mensal informado ou consumo declarado × tarifa) e modalidade B (média medida **durante mineração**, só da GPU). O modo "comparar" mostra os dois e usa um só. Consumo em repouso é recusado. Há aviso quando o custo informado passa do máximo da GPU no limite de potência.
- **Lucro** separado em receita, taxas da pool e do minerador, energia e outros custos, com moeda, período, horário e fonte das cotações.
- **Segurança da API**: sem `API_TOKEN`, só o próprio computador é atendido (antes, qualquer máquina da rede era aceita). Comandos de outra origem são recusados (403), com `x-frame-options: DENY`. Endereço de recebimento só público (texto que pareça frase-semente é recusado).
- **Auditoria dos 50 agentes**: `docs/AUDITORIA-AGENTES.md`, gerada do código (`npm run audit:agents`).
- **Investigação NiceHash / Pearl / Luxor**: `docs/INTEGRACOES-GPU.md`, com fontes.

## 3. Integrações efetivamente testadas

| Integração | Teste automatizado | Teste ao vivo |
|---|---|---|
| nvidia-smi | sim (executor falso; amostra no formato da RTX 3050) | **só "ausente"**, neste ambiente sem GPU |
| WhatToMine | sim (formato real, falhas HTTP e de rede) | leitura pela ferramenta web em 2026-10-29; do servidor deste ambiente, bloqueada |
| Coinbase, mempool.space | sim | não (rede bloqueada neste ambiente) |
| Luxor | sim | **não validada** com a sua chave |
| Supervisor de processos | sim, com o próprio Node como processo inofensivo | não há minerador |
| Painel | capturas de tela no computador e no celular, sem erros de JavaScript | — |

## 4. Continua indisponível

- Mineração com a RTX 3050: nenhum minerador verificado. A compatibilidade da Pearl com a RTX 3050 de 6 GB não está confirmada em nenhuma fonte.
- Hashrate, shares, worker, saldo e pagamentos: dependem de minerador e pool conectados.
- NiceHash: sem documentação oficial de taxas, mínimo de pagamento e GPUs suportadas.
- Modalidade B de energia: só existe depois de uma sessão de mineração medida.

## 5. Problemas encontrados

1. Simulação como padrão em produção. **Corrigido.**
2. Fallback simulado da Luxor. **Corrigido.**
3. Selo "DADOS REAIS" sem fontes. **Corrigido.**
4. API aberta à rede local quando não havia `API_TOKEN`. **Corrigido.**
5. Sem validação de origem em comandos. **Corrigido.**
6. Hardware errado nos cálculos: o sistema usava a RTX 3060 (170 W), mas a placa é uma RTX 3050 (70 W). **Corrigido.** O custo informado de R$ 110/mês foi calculado para 170 W. Na RTX 3050, o máximo só da GPU é de cerca de R$ 45/mês (70 W, 24 h, R$ 0,90/kWh, antes de impostos). O painel mostra esse aviso.
7. Quantus: o algoritmo diverge entre as fontes e a sigla QTC é de outra moeda na WhatToMine. A moeda está em investigação.
8. O `tsc` não pôde ser instalado (registro do npm inacessível daqui). Veja o build abaixo.

## 6. Testes e build

- `npm test`: **156 de 156** passando.
- `npm run check:modules`: **41/41** módulos do servidor carregam sem erro.
- `node --check` nos 4 scripts do painel: OK.
- `npm run build` / `npm run typecheck`: **não executados aqui**, porque o `npm install` falha com `ENOTFOUND registry.npmjs.org`. Precisa ser rodado no seu computador.

## 7. Como rodar no Windows

1. Instale o Node.js 22.13 ou superior.
2. `git pull` na pasta do projeto e `copy .env.luxor.example .env`. Não é preciso abrir como administrador.
3. `npm install` e depois `npm run build`, para conferir tipos e build.
4. `npm test` e depois `npm start`.
5. Abra `http://127.0.0.1:8050` → **GPU e Mineração**. Em até 30 s deve aparecer a RTX 3050 com estado **REAL** e a sua leitura atual.

## 8. Próximos passos para um teste curto

1. Confirmar, na documentação oficial de um minerador, suporte a PearlHash na RTX 3050 de 6 GB e a VRAM necessária.
2. Você baixa o minerador da fonte oficial e confere o SHA-256 publicado.
3. Informar caminho e hash ao sistema (integração do minerador: próxima etapa, depende da sua aprovação).
4. Informar `PAYOUT_ADDRESS_PRL` (endereço público) e incluir a pool em `ALLOWED_POOLS`.
5. No painel: **Verificar pré-condições** → **INICIAR TESTE** (5 min) com autorização explícita → **INTERROMPER** se necessário.
