# Os 50 agentes

Gerado a partir de `server/src/agents/`. Cada agente é um módulo com contrato padronizado (`AgentDefinition` em `server/src/core/types.ts`).

Maturidade: **validado** = lógica determinística coberta por testes; **simulado** = validado contra o simulador, ainda sem validação com equipamento real; **esboço** = implementado, depende de integração externa não testada.

## 1. Direção e coordenação (agentes 1–5)

| # | Agente | Responsabilidade | Execução | Entradas → Saídas | Permissões | Maturidade |
|---|---|---|---|---|---|---|
| 1 | **Diretor Geral**<br>`A01-DIRETOR` | Consolida o estado coletivo dos 50 agentes, o nível de evidência de mineração e o índice de saúde do sistema. | Agendado (1 min)<br>**essencial** | estado dos agentes, métricas de mineração → `system.health_score`, `system.evidence_level`, `director.summary` | `read:runtime` `read:metrics` `write:metrics` `emit:alert` | validado |
| 2 | **Coordenador de Tarefas**<br>`A02-COORDENADOR` | Supervisiona a fila: tamanho, concorrência, duplicatas evitadas e tarefas presas, que encerra com falha. | Contínuo (10s)<br>**essencial** | fila de tarefas → `queue.queued`, `queue.running`, `queue.duplicates_skipped` | `read:runtime` `write:metrics` `emit:alert` | validado |
| 3 | **Registro Central**<br>`A03-REGISTRO` | Valida a integridade do registro: 50 agentes, 5 por departamento, códigos únicos e contratos completos. | Agendado (5 min)<br>**essencial** | definições dos agentes → `registry.count`, `registry.valid` | `read:runtime` `write:metrics` `emit:alert` | validado |
| 4 | **Supervisor de Saúde**<br>`A04-SAUDE` | Verifica batimentos: agentes contínuos e agendados sem sucesso recente e agentes com falhas consecutivas. | Contínuo (30s)<br>**essencial** | estado dos agentes → `health.stale_agents`, `health.failing_agents` | `read:runtime` `write:metrics` `emit:alert` | validado |
| 5 | **Gestor de Configuração e Políticas**<br>`A05-CONFIG` | Valida a configuração na inicialização e periodicamente: fontes de dados, limites, segredos ausentes e combinações inseguras. | Agendado (30 min)<br>**essencial** | variáveis de ambiente → `config.warnings`, `config.data_mode` | `write:metrics` `emit:alert` | validado |

## 2. Inteligência de mercado (agentes 6–10)

| # | Agente | Responsabilidade | Execução | Entradas → Saídas | Permissões | Maturidade |
|---|---|---|---|---|---|---|
| 6 | **Coletor de Preços**<br>`A06-PRECOS` | Coleta cotações à vista dos pares configurados (API pública da Coinbase ou simulador). | Agendado (2 min) | PRICE_PAIRS, API de mercado → `price.<PAR>` | `read:market` `write:metrics` | simulado |
| 7 | **Monitor de Dificuldade**<br>`A07-DIFICULDADE` | Acompanha dificuldade, hashrate da rede Bitcoin e a próxima reavaliação de dificuldade. | Agendado (15 min) | API de rede (mempool.space) → `network.difficulty`, `network.hashrate_hs`, `network.difficulty_change_pct`, `network.remaining_blocks` | `read:market` `write:metrics` | simulado |
| 8 | **Monitor de Recompensa de Bloco**<br>`A08-RECOMPENSA` | Calcula a recompensa por bloco e os blocos restantes até o próximo halving a partir da altura da rede. | Por evento<br>gatilhos: `metric.network.height` | network.height → `network.block_subsidy_btc`, `network.blocks_to_halving` | `read:metrics` `write:metrics` | validado |
| 9 | **Analista de Volatilidade**<br>`A09-VOLATILIDADE` | Mede a volatilidade recente do preço do BTC (desvio-padrão dos retornos) e alerta em oscilações fortes. | Por evento<br>gatilhos: `metric.price.BTC-USD` | histórico de price.BTC-USD → `market.volatility_pct` | `read:metrics` `write:metrics` `emit:alert` | validado |
| 10 | **Monitor de Taxas de Rede**<br>`A10-TAXAS` | Acompanha as taxas recomendadas da rede Bitcoin (sat/vB), relevantes para pagamentos de pool. | Agendado (10 min) | API de rede (mempool.space) → `network.fee_fastest`, `network.fee_hour`, `network.fee_economy` | `read:market` `write:metrics` | simulado |

## 3. Mineração e hardware (agentes 11–15)

| # | Agente | Responsabilidade | Execução | Entradas → Saídas | Permissões | Maturidade |
|---|---|---|---|---|---|---|
| 11 | **Conector de Mineradores**<br>`A11-CONECTOR-MINER` | Mantém a conexão com a API do minerador (XMRig, cgminer ou simulador) e registra versão, pool e tempo ativo. | Contínuo (15s) | MINER_TYPE, MINER_URL → `miner.connected`, `miner.version`, `miner.pool_url`, `miner.uptime_s` | `read:miner` `write:metrics` | simulado |
| 12 | **Leitor de Hashrate**<br>`A12-HASHRATE` | Lê o hashrate informado pelo minerador (curto e 15 min). Não é confirmação da pool. | Contínuo (15s) | resumo do minerador → `miner.hashrate_hs`, `miner.hashrate_15m_hs` | `read:miner` `write:metrics` | simulado |
| 13 | **Monitor Térmico**<br>`A13-TERMICO` | Registra a temperatura informada pelo hardware e alerta acima dos limites configurados. | Contínuo (30s)<br>**essencial** | resumo do minerador, MAX_TEMP_C, CRITICAL_TEMP_C → `miner.temperature_c` | `read:miner` `write:metrics` `emit:alert` | simulado |
| 14 | **Inventário de Hardware**<br>`A14-INVENTARIO` | Registra o hardware, o algoritmo e as threads informados pelo minerador. | Agendado (1 h) | resumo do minerador → `miner.hardware`, `miner.algo`, `miner.threads` | `read:miner` `write:metrics` | simulado |
| 15 | **Detector de Anomalias de Desempenho**<br>`A15-ANOMALIAS` | Compara o hashrate atual com a mediana recente; em queda forte, alerta e propõe reinício (sujeito ao Guardião e ao operador). | Por evento<br>gatilhos: `metric.miner.hashrate_hs` | histórico de miner.hashrate_hs → `miner.hashrate_deviation_pct`, `proposta restart_miner` | `read:metrics` `emit:alert` `propose:action` `write:metrics` | validado |

## 4. Rentabilidade e energia (agentes 16–20)

| # | Agente | Responsabilidade | Execução | Entradas → Saídas | Permissões | Maturidade |
|---|---|---|---|---|---|---|
| 16 | **Medidor de Consumo**<br>`A16-CONSUMO` | Registra a potência do equipamento: medida pelo minerador quando disponível; caso contrário, o valor declarado em POWER_WATTS (estimado). | Contínuo (1 min) | resumo do minerador, POWER_WATTS → `energy.power_w`, `energy.kwh_day` | `read:miner` `write:metrics` | simulado |
| 17 | **Gestor de Tarifa de Energia**<br>`A17-TARIFA` | Publica a tarifa de energia informada pelo operador (ENERGY_PRICE_KWH) para os cálculos de custo. | Agendado (6 h) | ENERGY_PRICE_KWH → `energy.tariff_kwh` | `write:metrics` | validado |
| 18 | **Calculadora de Rentabilidade**<br>`A18-RENTABILIDADE` | Estima receita, custo de energia e resultado diário para mineração SHA-256 (Bitcoin). Sempre marcado como estimativa. | Agendado (5 min) | hashrate, dificuldade, recompensa, preço, potência, tarifa → `profit.btc_day`, `profit.revenue_day`, `profit.energy_cost_day`, `profit.net_day` | `read:metrics` `write:metrics` | validado |
| 19 | **Comparador de Viabilidade**<br>`A19-COMPARADOR` | Calcula pontos de equilíbrio: tarifa máxima e preço mínimo do BTC em que a mineração cobre a energia. | Agendado (1 h) | estimativas de rentabilidade → `profit.breakeven_tariff`, `profit.breakeven_btc_price` | `read:metrics` `write:metrics` | validado |
| 20 | **Projeção de Custos**<br>`A20-PROJECAO` | Projeta 30 dias de custo de energia e receita, aplicando o próximo ajuste de dificuldade estimado. | Agendado (1 h) | estimativas diárias, network.difficulty_change_pct → `profit.month_energy_cost`, `profit.month_revenue` | `read:metrics` `write:metrics` | validado |

## 5. Pools e infraestrutura (agentes 21–25)

| # | Agente | Responsabilidade | Execução | Entradas → Saídas | Permissões | Maturidade |
|---|---|---|---|---|---|---|
| 21 | **Conector de Pools**<br>`A21-CONECTOR-POOL` | Consulta a pool principal (Luxor, via API oficial somente leitura, ou endpoint JSON) após autenticação válida; sem autenticação ou sem mineradores ativos, mantém as métricas simuladas e publica o motivo. | Agendado (2 min) | POOL_SOURCE, LUXOR_API_KEY (backend), POOL_STATS_URL → `pool.connected`, `pool.source_mode`, `pool.fallback_reason`, `luxor.auth`, `luxor.active_miners`, `luxor.balance` | `read:pool` `write:metrics` | simulado |
| 22 | **Monitor de Shares**<br>`A22-SHARES` | Acompanha shares aceitas e rejeitadas informadas pelo minerador; o aumento de shares aceitas é a evidência de mineração ativa. | Contínuo (30s) | resumo do minerador → `miner.shares_accepted`, `miner.shares_rejected`, `miner.shares_accepted_delta`, `miner.reject_rate_pct` | `read:miner` `write:metrics` `emit:alert` | simulado |
| 23 | **Monitor de Saldo na Pool**<br>`A23-SALDO-POOL` | Registra o saldo não pago e o total já pago informados pela pool. | Agendado (10 min) | estatísticas da pool (Luxor ou JSON) → `pool.balance`, `pool.paid_total` | `read:pool` `write:metrics` | simulado |
| 24 | **Recomendador de Failover**<br>`A24-FAILOVER` | Quando a pool cai, propõe troca para a próxima pool da lista permitida. Nunca troca sozinho. | Por evento<br>gatilhos: `pool.disconnected` | pool.disconnected, ALLOWED_POOLS → `proposta switch_pool` | `read:metrics` `propose:action` `emit:alert` | validado |
| 25 | **Monitor de Rede e Latência**<br>`A25-REDE` | Mede a latência TCP até o servidor stratum da pool e acompanha a latência da API do minerador. | Contínuo (2 min) | POOL_STRATUM_URL, net.latency_miner_ms → `net.latency_pool_ms` | `read:metrics` `write:metrics` `emit:alert` | simulado |

## 6. Risco e segurança (agentes 26–30)

| # | Agente | Responsabilidade | Execução | Entradas → Saídas | Permissões | Maturidade |
|---|---|---|---|---|---|---|
| 26 | **Guardião de Risco**<br>`A26-GUARDIAO` | Avalia regras determinísticas de risco, pausa o sistema em condição crítica e bloqueia ações proibidas. Não usa LLM. | Contínuo (10s)<br>gatilhos: `metric.miner.temperature_c`, `metric.miner.reject_rate_pct`<br>**essencial** | métricas de temperatura, shares e carteira, regras R01–R08, S01–S04 → `risk.level`, `risk.findings`, `system.paused` | `read:metrics` `read:miner` `write:metrics` `emit:alert` `control:system` | validado |
| 27 | **Cofre de Credenciais**<br>`A27-COFRE` | Verifica quais segredos estão configurados sem jamais exibir seus valores e detecta segredos fracos. | Agendado (1 h)<br>**essencial** | variáveis de ambiente sensíveis → `secrets.configured`, `secrets.weak` | `read:secrets` `write:metrics` `emit:alert` | validado |
| 28 | **Monitor de Segurança**<br>`A28-SEGURANCA` | Verifica exposição da API, proteção da API do minerador e a lista de carteiras permitidas. | Agendado (10 min)<br>**essencial** | HOST, API_TOKEN, MINER_ACCESS_TOKEN, ALLOWED_WALLETS → `security.issues` | `read:metrics` `write:metrics` `emit:alert` | validado |
| 29 | **Limitador de Chamadas Externas**<br>`A29-LIMITADOR` | Publica o uso do limitador de chamadas por host e alerta quando chamadas são contidas. | Contínuo (1 min) | estatísticas do limitador → `ratelimit.allowed`, `ratelimit.throttled` | `write:metrics` `emit:alert` | validado |
| 30 | **Validador de Procedência de Dados**<br>`A30-PROCEDENCIA` | Garante que toda métrica tem procedência válida, detecta dados vencidos e mistura de dados reais com simulados. | Agendado (2 min)<br>**essencial** | todas as métricas atuais → `data.real`, `data.estimado`, `data.simulado`, `data.stale` | `read:metrics` `write:metrics` `emit:alert` | validado |

## 7. Estratégia e inteligência artificial (agentes 31–35)

| # | Agente | Responsabilidade | Execução | Entradas → Saídas | Permissões | Maturidade |
|---|---|---|---|---|---|---|
| 31 | **Estrategista**<br>`A31-ESTRATEGISTA` | Gera recomendações por regras explícitas (resultado negativo, rejeição alta, temperatura, ausência de shares). Propõe, nunca executa. | Agendado (15 min) | estimativas de rentabilidade, shares, temperatura, evidência → `strategy.recommendations`, `eventos strategy.recommendation` | `read:metrics` `write:metrics` `propose:action` | validado |
| 32 | **Simulador de Cenários**<br>`A32-CENARIOS` | Calcula sensibilidade do resultado a variações de preço (±20%), dificuldade (+10%) e tarifa (+20%). | Agendado (1 h)<br>gatilhos: `scenario.requested` | hashrate, dificuldade, preço, potência, tarifa → `scenario.worst_net_day`, `scenario.best_net_day`, `relatório scenarios` | `read:metrics` `write:metrics` | validado |
| 33 | **Gateway de LLM**<br>`A33-GATEWAY-LLM` | Único ponto de acesso a modelo de linguagem: controla limites diários e mensais e publica disponibilidade e consumo. | Agendado (10 min) | LLM_ENABLED, ANTHROPIC_API_KEY, limites de uso → `llm.enabled`, `llm.calls_today`, `llm.tokens_month` | `call:llm` `write:metrics` `emit:alert` | validado |
| 34 | **Redator de Análises**<br>`A34-REDATOR` | Produz uma análise curta em português. Usa o LLM quando habilitado e valida a saída; caso contrário, usa texto determinístico. | Agendado (6 h)<br>gatilhos: `analysis.requested` | métricas consolidadas → `relatório analysis` | `read:metrics` `call:llm` `write:metrics` | validado |
| 35 | **Avaliador de Recomendações**<br>`A35-AVALIADOR` | Mede o histórico de propostas: aprovadas, rejeitadas, bloqueadas e executadas com sucesso. | Agendado (6 h) | histórico de ações → `strategy.acceptance_rate`, `strategy.blocked` | `write:metrics` | validado |

## 8. Automação e manutenção (agentes 36–40)

| # | Agente | Responsabilidade | Execução | Entradas → Saídas | Permissões | Maturidade |
|---|---|---|---|---|---|---|
| 36 | **Agendador de Manutenção**<br>`A36-MANUTENCAO` | Controla a agenda de manutenção preventiva e alerta tarefas vencidas. | Agendado (1 h) | registro de manutenções concluídas → `maintenance.overdue` | `write:metrics` `emit:alert` | validado |
| 37 | **Executor de Ações**<br>`A37-EXECUTOR` | Executa somente ações aprovadas pelo operador e reavaliadas pelo Guardião no momento da execução. Nunca executa operações financeiras. | Por evento<br>gatilhos: `action.approved` | action.approved → `action.executed`, `action.failed` | `execute:action` `read:miner` | validado |
| 38 | **Reiniciador de Processos**<br>`A38-RECUPERACAO` | Aplica espera progressiva (circuit breaker) a agentes internos com falhas consecutivas. Não reinicia equipamentos. | Por evento<br>gatilhos: `agent.error`<br>**essencial** | agent.error → `período de espera do agente` | `read:runtime` `read:miner` `emit:alert` | validado |
| 39 | **Gestor de Versões**<br>`A39-VERSOES` | Registra versões do aplicativo, do Node.js e do minerador, e alerta minerador abaixo da versão mínima. | Agendado (12 h) | miner.version, MIN_MINER_VERSION → `app.version`, `app.node_version` | `read:metrics` `write:metrics` `emit:alert` | validado |
| 40 | **Backup e Retenção**<br>`A40-BACKUP` | Faz cópia consistente do banco (VACUUM INTO), mantém as 7 mais recentes e remove registros além do prazo de retenção. | Agendado (6 h)<br>**essencial** | DB_PATH, RETENTION_DAYS → `backup.last_at`, `retention.purged` | `write:files` `write:metrics` | validado |

## 9. Auditoria e finanças (agentes 41–45)

| # | Agente | Responsabilidade | Execução | Entradas → Saídas | Permissões | Maturidade |
|---|---|---|---|---|---|---|
| 41 | **Auditor de Trilha**<br>`A41-AUDITOR` | Mantém trilha de auditoria encadeada por hash (SHA-256) para ações, pausas e alertas, e verifica sua integridade. | Por evento<br>gatilhos: `action.*`, `system.*`, `alert.raised`<br>**essencial** | eventos de ação, sistema e alerta → `audit.records`, `audit.chain_ok` | `write:metrics` `emit:alert` | validado |
| 42 | **Contador de Receitas**<br>`A42-RECEITAS` | Contabiliza somente valores recebidos com confirmação on-chain no endereço monitorado. | Agendado (1 h)<br>gatilhos: `wallet.received` | wallet.received_btc → `finance.confirmed_received_btc`, `finance.confirmed_received_local` | `read:metrics` `write:metrics` | validado |
| 43 | **Conciliador Pool × Carteira**<br>`A43-CONCILIADOR` | Compara o total pago informado pela pool com o recebido confirmado na carteira e alerta divergências. | Agendado (6 h) | pool.paid_total, finance.confirmed_received_btc → `finance.reconciliation_diff_btc` | `read:metrics` `write:metrics` `emit:alert` | validado |
| 44 | **Monitor de Carteira**<br>`A44-CARTEIRA` | Consulta em modo leitura o saldo e o total recebido do endereço de recebimento (ex.: endereço de depósito da Coinbase). Não guarda chaves. | Agendado (10 min) | WALLET_BTC_ADDRESS → `wallet.address`, `wallet.balance_btc`, `wallet.received_btc`, `wallet.unconfirmed_btc`, `wallet.tx_count` | `read:wallet` `write:metrics` | simulado |
| 45 | **Exportador Fiscal**<br>`A45-FISCAL` | Gera CSV de recebimentos confirmados com a cotação do momento, para apoio à declaração. Não substitui contador. | Agendado (24 h)<br>gatilhos: `export.requested` | histórico de finance.confirmed_received_btc, histórico de preços → `exports/recebimentos.csv` | `write:files` `write:metrics` | validado |

## 10. Comunicação e controle (agentes 46–50)

| # | Agente | Responsabilidade | Execução | Entradas → Saídas | Permissões | Maturidade |
|---|---|---|---|---|---|---|
| 46 | **Console de Eventos**<br>`A46-CONSOLE` | Mede o fluxo do console de eventos: eventos por minuto e erros na última hora. | Contínuo (30s)<br>**essencial** | eventos persistidos → `events.per_min`, `events.errors_1h` | `write:metrics` | validado |
| 47 | **Central de Alertas**<br>`A47-ALERTAS` | Consolida alertas abertos por severidade e escala alertas recorrentes. | Por evento<br>gatilhos: `alert.raised`, `alert.repeated`<br>**essencial** | alert.raised, alert.repeated → `alerts.open`, `alerts.critical` | `write:metrics` `emit:alert` | validado |
| 48 | **Notificador**<br>`A48-NOTIFICADOR` | Envia alertas de severidade erro ou crítica para o Telegram do operador, quando configurado. | Por evento<br>gatilhos: `alert.raised` | alert.raised, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID → `mensagem no Telegram` | `notify:external` | stub |
| 49 | **Gerador de Relatórios e Métricas**<br>`A49-RELATORIOS` | Gera o relatório operacional consolidado: agentes, evidência de mineração, métricas-chave com procedência e alertas. | Agendado (1 h)<br>gatilhos: `report.requested` | estado dos agentes, métricas, alertas → `relatório operational` | `read:runtime` `read:metrics` `write:metrics` | validado |
| 50 | **Interface do Operador**<br>`A50-OPERADOR` | Mantém a API e o canal em tempo real do escritório 3D; publica clientes conectados e tempo ativo. | Contínuo (30s)<br>**essencial** | conexões da interface → `ui.clients`, `app.uptime_s` | `read:runtime` `write:metrics` | validado |
