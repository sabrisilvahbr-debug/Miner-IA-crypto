# Auditoria dos 50 agentes

Gerado por `npm run audit:agents` a partir do código. Não edite à mão.

**Como ler a classificação:**
- **IMPLEMENTADO E TESTADO**: lógica coberta por testes automatizados e sem dependência de hardware ou conta externa.
- **IMPLEMENTADO, MAS NÃO VALIDADO**: o código existe e passa nos testes com dados de teste, mas nunca rodou com o equipamento ou a conta real.
- **PARCIALMENTE IMPLEMENTADO**: esboço.

Os agentes são módulos coordenados por um único runtime (não são 50 processos). Nenhum agente executa mineração. Última execução, resultado e erros de cada um ficam em `GET /api/agents/:id` e na ficha do agente no painel.

| Classificação | Agentes |
|---|---|
| IMPLEMENTADO E TESTADO | 36 |
| IMPLEMENTADO, MAS NÃO VALIDADO | 13 |
| PARCIALMENTE IMPLEMENTADO | 1 |

## 1. Direção e coordenação

| # | Agente | Função | Entradas | Saídas | Ferramentas e fontes | Classificação | Disponibilidade hoje |
|---|---|---|---|---|---|---|---|
| 1 | **Diretor Geral** (A01-DIRETOR) | Consolida o estado coletivo dos 50 agentes, o nível de evidência de mineração e o índice de saúde do sistema. | estado dos agentes, métricas de mineração | system.health_score, system.evidence_level, director.summary | read:runtime; métricas gravadas por outros agentes; write:metrics; emit:alert | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 2 | **Coordenador de Tarefas** (A02-COORDENADOR) | Supervisiona a fila: tamanho, concorrência, duplicatas evitadas e tarefas presas, que encerra com falha. | fila de tarefas | queue.queued, queue.running, queue.duplicates_skipped | read:runtime; write:metrics; emit:alert | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 3 | **Registro Central** (A03-REGISTRO) | Valida a integridade do registro: 50 agentes, 5 por departamento, códigos únicos e contratos completos. | definições dos agentes | registry.count, registry.valid | read:runtime; write:metrics; emit:alert | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 4 | **Supervisor de Saúde** (A04-SAUDE) | Verifica batimentos: agentes contínuos e agendados sem sucesso recente e agentes com falhas consecutivas. | estado dos agentes | health.stale_agents, health.failing_agents | read:runtime; write:metrics; emit:alert | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 5 | **Gestor de Configuração e Políticas** (A05-CONFIG) | Valida a configuração na inicialização e periodicamente: fontes de dados, limites, segredos ausentes e combinações inseguras. | variáveis de ambiente | config.warnings, config.data_mode | write:metrics; emit:alert | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |

## 2. Inteligência de mercado

| # | Agente | Função | Entradas | Saídas | Ferramentas e fontes | Classificação | Disponibilidade hoje |
|---|---|---|---|---|---|---|---|
| 6 | **Coletor de Preços** (A06-PRECOS) | Coleta cotações à vista dos pares configurados (API pública da Coinbase ou simulador). | PRICE_PAIRS, API de mercado | price.<PAR> | Coinbase e mempool.space; write:metrics | IMPLEMENTADO, MAS NÃO VALIDADO | depende de MARKET_SOURCE=coinbase / NETWORK_SOURCE=mempool; não testado ao vivo no ambiente de desenvolvimento |
| 7 | **Monitor de Dificuldade** (A07-DIFICULDADE) | Acompanha dificuldade, hashrate da rede Bitcoin e a próxima reavaliação de dificuldade. | API de rede (mempool.space) | network.difficulty, network.hashrate_hs, network.difficulty_change_pct, network.remaining_blocks | Coinbase e mempool.space; write:metrics | IMPLEMENTADO, MAS NÃO VALIDADO | depende de MARKET_SOURCE=coinbase / NETWORK_SOURCE=mempool; não testado ao vivo no ambiente de desenvolvimento |
| 8 | **Monitor de Recompensa de Bloco** (A08-RECOMPENSA) | Calcula a recompensa por bloco e os blocos restantes até o próximo halving a partir da altura da rede. | network.height | network.block_subsidy_btc, network.blocks_to_halving | métricas gravadas por outros agentes; write:metrics | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 9 | **Analista de Volatilidade** (A09-VOLATILIDADE) | Mede a volatilidade recente do preço do BTC (desvio-padrão dos retornos) e alerta em oscilações fortes. | histórico de price.BTC-USD | market.volatility_pct | métricas gravadas por outros agentes; write:metrics; emit:alert | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 10 | **Monitor de Taxas de Rede** (A10-TAXAS) | Acompanha as taxas recomendadas da rede Bitcoin (sat/vB), relevantes para pagamentos de pool. | API de rede (mempool.space) | network.fee_fastest, network.fee_hour, network.fee_economy | Coinbase e mempool.space; write:metrics | IMPLEMENTADO, MAS NÃO VALIDADO | depende de MARKET_SOURCE=coinbase / NETWORK_SOURCE=mempool; não testado ao vivo no ambiente de desenvolvimento |

## 3. Mineração e hardware

| # | Agente | Função | Entradas | Saídas | Ferramentas e fontes | Classificação | Disponibilidade hoje |
|---|---|---|---|---|---|---|---|
| 11 | **Conector de Mineradores** (A11-CONECTOR-MINER) | Mantém a conexão com a API do minerador (XMRig, cgminer ou simulador) e registra versão, pool e tempo ativo. | MINER_TYPE, MINER_URL | miner.connected, miner.version, miner.pool_url, miner.uptime_s | minerador (XMRig/cgminer) e GPU (nvidia-smi); write:metrics | IMPLEMENTADO, MAS NÃO VALIDADO | INDISPONÍVEL até haver minerador integrado |
| 12 | **Leitor de Hashrate** (A12-HASHRATE) | Lê o hashrate informado pelo minerador (curto e 15 min). Não é confirmação da pool. | resumo do minerador | miner.hashrate_hs, miner.hashrate_15m_hs | minerador (XMRig/cgminer) e GPU (nvidia-smi); write:metrics | IMPLEMENTADO, MAS NÃO VALIDADO | INDISPONÍVEL até haver minerador integrado |
| 13 | **Monitor Térmico** (A13-TERMICO) | Registra a temperatura informada pelo hardware e alerta acima dos limites configurados. | resumo do minerador, MAX_TEMP_C, CRITICAL_TEMP_C | miner.temperature_c | minerador (XMRig/cgminer) e GPU (nvidia-smi); write:metrics; emit:alert | IMPLEMENTADO, MAS NÃO VALIDADO | INDISPONÍVEL até haver minerador integrado |
| 14 | **Inventário e Sensores da GPU** (A14-INVENTARIO) | Lê a GPU pelo nvidia-smi a cada 30 s (modelo, driver, VRAM, uso, temperatura, potência e limite) e grava o histórico. Só publica valores lidos; campo sem suporte fica ausente. Registra também o hardware informado pelo minerador, se houver. | nvidia-smi (somente leitura), resumo do minerador, MAX_TEMP_C, CRITICAL_TEMP_C | gpu.status, gpu.name, gpu.temperature_c, gpu.power_w, gpu.power_limit_w, gpu.utilization_pct, gpu.memory_used_mib, gpu.memory_total_mib, gpu.driver, miner.hardware | minerador (XMRig/cgminer) e GPU (nvidia-smi); write:metrics; emit:alert | IMPLEMENTADO, MAS NÃO VALIDADO | depende do nvidia-smi no Windows (HARDWARE NÃO VERIFICADO pelo sistema) |
| 15 | **Detector de Anomalias de Desempenho** (A15-ANOMALIAS) | Compara o hashrate atual com a mediana recente; em queda forte, alerta e propõe reinício (sujeito ao Guardião e ao operador). | histórico de miner.hashrate_hs | miner.hashrate_deviation_pct, proposta restart_miner | métricas gravadas por outros agentes; emit:alert; propose:action; write:metrics | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |

## 4. Rentabilidade e energia

| # | Agente | Função | Entradas | Saídas | Ferramentas e fontes | Classificação | Disponibilidade hoje |
|---|---|---|---|---|---|---|---|
| 16 | **Medidor de Consumo** (A16-CONSUMO) | Registra a potência do equipamento: medida pelo minerador quando disponível; caso contrário, o valor declarado em POWER_WATTS (estimado). | resumo do minerador, POWER_WATTS | energy.power_w, energy.kwh_day | minerador (XMRig/cgminer) e GPU (nvidia-smi); write:metrics | IMPLEMENTADO, MAS NÃO VALIDADO | INDISPONÍVEL até haver minerador integrado |
| 17 | **Gestor de Tarifa de Energia** (A17-TARIFA) | Publica a tarifa de energia informada pelo operador (ENERGY_PRICE_KWH) para os cálculos de custo. | ENERGY_PRICE_KWH | energy.tariff_kwh | write:metrics | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 18 | **Calculadora de Rentabilidade** (A18-RENTABILIDADE) | Estima receita, custo de energia e resultado diário para mineração SHA-256 (Bitcoin). Sempre marcado como estimativa. | hashrate, dificuldade, recompensa, preço, potência, tarifa | profit.btc_day, profit.revenue_day, profit.energy_cost_day, profit.net_day | métricas gravadas por outros agentes; write:metrics | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 19 | **Comparador de Viabilidade** (A19-COMPARADOR) | Calcula pontos de equilíbrio: tarifa máxima e preço mínimo do BTC em que a mineração cobre a energia. | estimativas de rentabilidade | profit.breakeven_tariff, profit.breakeven_btc_price | métricas gravadas por outros agentes; write:metrics | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 20 | **Projeção de Custos** (A20-PROJECAO) | Projeta 30 dias de custo de energia e receita, aplicando o próximo ajuste de dificuldade estimado. | estimativas diárias, network.difficulty_change_pct | profit.month_energy_cost, profit.month_revenue | métricas gravadas por outros agentes; write:metrics | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |

## 5. Pools e infraestrutura

| # | Agente | Função | Entradas | Saídas | Ferramentas e fontes | Classificação | Disponibilidade hoje |
|---|---|---|---|---|---|---|---|
| 21 | **Conector de Pools** (A21-CONECTOR-POOL) | Consulta a pool principal (Luxor, via API oficial somente leitura, ou endpoint JSON) após autenticação válida. Sem autenticação, a pool fica INDISPONÍVEL; sem worker ativo, NÃO CONECTADA. Nunca preenche com dados simulados. | POOL_SOURCE, LUXOR_API_KEY (backend), POOL_STATS_URL | pool.connected, pool.source_mode, pool.fallback_reason, luxor.auth, luxor.active_miners, luxor.balance | pool (Luxor ou JSON); write:metrics | IMPLEMENTADO, MAS NÃO VALIDADO | INDISPONÍVEL até a Luxor ser validada com a sua chave |
| 22 | **Monitor de Shares** (A22-SHARES) | Acompanha shares aceitas e rejeitadas informadas pelo minerador; o aumento de shares aceitas é a evidência de mineração ativa. | resumo do minerador | miner.shares_accepted, miner.shares_rejected, miner.shares_accepted_delta, miner.reject_rate_pct | minerador (XMRig/cgminer) e GPU (nvidia-smi); write:metrics; emit:alert | IMPLEMENTADO, MAS NÃO VALIDADO | INDISPONÍVEL até haver minerador integrado |
| 23 | **Monitor de Saldo na Pool** (A23-SALDO-POOL) | Registra o saldo não pago e o total já pago informados pela pool. | estatísticas da pool (Luxor ou JSON) | pool.balance, pool.paid_total | pool (Luxor ou JSON); write:metrics | IMPLEMENTADO, MAS NÃO VALIDADO | INDISPONÍVEL até a Luxor ser validada com a sua chave |
| 24 | **Recomendador de Failover** (A24-FAILOVER) | Quando a pool cai, propõe troca para a próxima pool da lista permitida. Nunca troca sozinho. | pool.disconnected, ALLOWED_POOLS | proposta switch_pool | métricas gravadas por outros agentes; propose:action; emit:alert | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 25 | **Monitor de Rede e Latência** (A25-REDE) | Mede a latência TCP até o servidor stratum da pool e acompanha a latência da API do minerador. | POOL_STRATUM_URL, net.latency_miner_ms | net.latency_pool_ms | métricas gravadas por outros agentes; write:metrics; emit:alert | IMPLEMENTADO, MAS NÃO VALIDADO | funciona com os dados disponíveis |

## 6. Risco e segurança

| # | Agente | Função | Entradas | Saídas | Ferramentas e fontes | Classificação | Disponibilidade hoje |
|---|---|---|---|---|---|---|---|
| 26 | **Guardião de Risco** (A26-GUARDIAO) | Avalia regras determinísticas de risco, pausa o sistema em condição crítica e bloqueia ações proibidas. Não usa LLM. | métricas de temperatura, shares e carteira, regras R01–R08, S01–S04 | risk.level, risk.findings, system.paused | métricas gravadas por outros agentes; minerador (XMRig/cgminer) e GPU (nvidia-smi); write:metrics; emit:alert; control:system | IMPLEMENTADO E TESTADO | INDISPONÍVEL até haver minerador integrado |
| 27 | **Cofre de Credenciais** (A27-COFRE) | Verifica quais segredos estão configurados sem jamais exibir seus valores e detecta segredos fracos. | variáveis de ambiente sensíveis | secrets.configured, secrets.weak | read:secrets; write:metrics; emit:alert | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 28 | **Monitor de Segurança** (A28-SEGURANCA) | Verifica exposição da API, proteção da API do minerador e a lista de carteiras permitidas. | HOST, API_TOKEN, MINER_ACCESS_TOKEN, ALLOWED_WALLETS | security.issues | métricas gravadas por outros agentes; write:metrics; emit:alert | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 29 | **Limitador de Chamadas Externas** (A29-LIMITADOR) | Publica o uso do limitador de chamadas por host e alerta quando chamadas são contidas. | estatísticas do limitador | ratelimit.allowed, ratelimit.throttled | write:metrics; emit:alert | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 30 | **Validador de Procedência de Dados** (A30-PROCEDENCIA) | Garante que toda métrica tem procedência válida, detecta dados vencidos e mistura de dados reais com simulados. | todas as métricas atuais | data.real, data.estimado, data.simulado, data.stale | métricas gravadas por outros agentes; write:metrics; emit:alert | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |

## 7. Estratégia e inteligência artificial

| # | Agente | Função | Entradas | Saídas | Ferramentas e fontes | Classificação | Disponibilidade hoje |
|---|---|---|---|---|---|---|---|
| 31 | **Estrategista** (A31-ESTRATEGISTA) | Gera recomendações por regras explícitas (resultado negativo, rejeição alta, temperatura, ausência de shares). Propõe, nunca executa. | estimativas de rentabilidade, shares, temperatura, evidência | strategy.recommendations, eventos strategy.recommendation | métricas gravadas por outros agentes; write:metrics; propose:action | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 32 | **Simulador de Cenários** (A32-CENARIOS) | Calcula sensibilidade do resultado a variações de preço (±20%), dificuldade (+10%) e tarifa (+20%). | hashrate, dificuldade, preço, potência, tarifa | scenario.worst_net_day, scenario.best_net_day, relatório scenarios | métricas gravadas por outros agentes; write:metrics | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 33 | **Gateway de LLM** (A33-GATEWAY-LLM) | Único ponto de acesso a modelo de linguagem: controla limites diários e mensais e publica disponibilidade e consumo. | LLM_ENABLED, ANTHROPIC_API_KEY, limites de uso | llm.enabled, llm.calls_today, llm.tokens_month | API Anthropic (opcional); write:metrics; emit:alert | IMPLEMENTADO E TESTADO | desligado (LLM_ENABLED=false) |
| 34 | **Redator de Análises** (A34-REDATOR) | Produz uma análise curta em português. Usa o LLM quando habilitado e valida a saída; caso contrário, usa texto determinístico. | métricas consolidadas | relatório analysis | métricas gravadas por outros agentes; API Anthropic (opcional); write:metrics | IMPLEMENTADO E TESTADO | desligado (LLM_ENABLED=false) |
| 35 | **Avaliador de Recomendações** (A35-AVALIADOR) | Mede o histórico de propostas: aprovadas, rejeitadas, bloqueadas e executadas com sucesso. | histórico de ações | strategy.acceptance_rate, strategy.blocked | write:metrics | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |

## 8. Automação e manutenção

| # | Agente | Função | Entradas | Saídas | Ferramentas e fontes | Classificação | Disponibilidade hoje |
|---|---|---|---|---|---|---|---|
| 36 | **Agendador de Manutenção** (A36-MANUTENCAO) | Controla a agenda de manutenção preventiva e alerta tarefas vencidas. | registro de manutenções concluídas | maintenance.overdue | write:metrics; emit:alert | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 37 | **Executor de Ações** (A37-EXECUTOR) | Executa somente ações aprovadas pelo operador e reavaliadas pelo Guardião no momento da execução. Nunca executa operações financeiras. | action.approved | action.executed, action.failed | execute:action; minerador (XMRig/cgminer) e GPU (nvidia-smi) | IMPLEMENTADO E TESTADO | INDISPONÍVEL até haver minerador integrado |
| 38 | **Reiniciador de Processos** (A38-RECUPERACAO) | Aplica espera progressiva (circuit breaker) a agentes internos com falhas consecutivas. Não reinicia equipamentos. | agent.error | período de espera do agente | read:runtime; minerador (XMRig/cgminer) e GPU (nvidia-smi); emit:alert | IMPLEMENTADO E TESTADO | INDISPONÍVEL até haver minerador integrado |
| 39 | **Gestor de Versões** (A39-VERSOES) | Registra versões do aplicativo, do Node.js e do minerador, e alerta minerador abaixo da versão mínima. | miner.version, MIN_MINER_VERSION | app.version, app.node_version | métricas gravadas por outros agentes; write:metrics; emit:alert | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 40 | **Backup e Retenção** (A40-BACKUP) | Faz cópia consistente do banco (VACUUM INTO), mantém as 7 mais recentes e remove registros além do prazo de retenção. | DB_PATH, RETENTION_DAYS | backup.last_at, retention.purged | write:files; write:metrics | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |

## 9. Auditoria e finanças

| # | Agente | Função | Entradas | Saídas | Ferramentas e fontes | Classificação | Disponibilidade hoje |
|---|---|---|---|---|---|---|---|
| 41 | **Auditor de Trilha** (A41-AUDITOR) | Mantém trilha de auditoria encadeada por hash (SHA-256) para ações, pausas e alertas, e verifica sua integridade. | eventos de ação, sistema e alerta | audit.records, audit.chain_ok | write:metrics; emit:alert | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 42 | **Contador de Receitas** (A42-RECEITAS) | Contabiliza somente valores recebidos com confirmação on-chain no endereço monitorado. | wallet.received_btc | finance.confirmed_received_btc, finance.confirmed_received_local | métricas gravadas por outros agentes; write:metrics | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 43 | **Conciliador Pool × Carteira** (A43-CONCILIADOR) | Compara o total pago informado pela pool com o recebido confirmado na carteira e alerta divergências. | pool.paid_total, finance.confirmed_received_btc | finance.reconciliation_diff_btc | métricas gravadas por outros agentes; write:metrics; emit:alert | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 44 | **Monitor de Carteira** (A44-CARTEIRA) | Consulta em modo leitura o saldo e o total recebido do endereço de recebimento (ex.: endereço de depósito da Coinbase). Não guarda chaves. | WALLET_BTC_ADDRESS | wallet.address, wallet.balance_btc, wallet.received_btc, wallet.unconfirmed_btc, wallet.tx_count | mempool.space (endereço público); write:metrics | IMPLEMENTADO, MAS NÃO VALIDADO | desligado (WALLET_SOURCE=none, escolha do operador) |
| 45 | **Exportador Fiscal** (A45-FISCAL) | Gera CSV de recebimentos confirmados com a cotação do momento, para apoio à declaração. Não substitui contador. | histórico de finance.confirmed_received_btc, histórico de preços | exports/recebimentos.csv | write:files; write:metrics | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |

## 10. Comunicação e controle

| # | Agente | Função | Entradas | Saídas | Ferramentas e fontes | Classificação | Disponibilidade hoje |
|---|---|---|---|---|---|---|---|
| 46 | **Console de Eventos** (A46-CONSOLE) | Mede o fluxo do console de eventos: eventos por minuto e erros na última hora. | eventos persistidos | events.per_min, events.errors_1h | write:metrics | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 47 | **Central de Alertas** (A47-ALERTAS) | Consolida alertas abertos por severidade e escala alertas recorrentes. | alert.raised, alert.repeated | alerts.open, alerts.critical | write:metrics; emit:alert | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 48 | **Notificador** (A48-NOTIFICADOR) | Envia alertas de severidade erro ou crítica para o Telegram do operador, quando configurado. | alert.raised, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID | mensagem no Telegram | notify:external | PARCIALMENTE IMPLEMENTADO | funciona com os dados disponíveis |
| 49 | **Gerador de Relatórios e Métricas** (A49-RELATORIOS) | Gera o relatório operacional consolidado: agentes, evidência de mineração, métricas-chave com procedência e alertas. | estado dos agentes, métricas, alertas | relatório operational | read:runtime; métricas gravadas por outros agentes; write:metrics | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
| 50 | **Interface do Operador** (A50-OPERADOR) | Mantém a API e o canal em tempo real do escritório 3D; publica clientes conectados e tempo ativo. | conexões da interface | ui.clients, app.uptime_s | read:runtime; write:metrics | IMPLEMENTADO E TESTADO | funciona com os dados disponíveis |
