# Arquitetura — VIRTUAL MINING OFFICE 50

## 1. Auditoria inicial e decisão de migração

O repositório continha apenas um `README.md` vazio. Não havia código da versão de 25 agentes para preservar nem a lista individual da especificação anterior, então a lista de 50 agentes foi definida a partir da proposta aprovada pelo operador. Começar do zero não foi uma escolha técnica, e sim a única opção.

## 2. Visão geral

```
                ┌────────────────── Navegador (computador / iPhone) ──────────────────┐
                │  Escritório 3D (Canvas isométrico) · painéis · console · filtros       │
                └───────────────▲──────────────────────────────┬───────────────────────┘
                     SSE /api/stream                      REST /api/*
                ┌───────────────┴──────────────────────────────▼───────────────────────┐
                │ API (node:http)  ── autenticação opcional por API_TOKEN                │
                ├──────────────────────────────────────────────────────────────────────┤
                │ Runtime: registro central · fila com deduplicação · concorrência       │
                │ limitada · tempo limite · novas tentativas · estados · execuções       │
                │ Barramento de eventos · Guardião de Risco · Gateway de LLM (opcional)  │
                ├──────────────────────────────────────────────────────────────────────┤
                │ 50 agentes (módulos lógicos, mesmo processo)                           │
                ├──────────────────────────────────────────────────────────────────────┤
                │ Adaptadores somente leitura: XMRig · cgminer · Coinbase (cotação) ·    │
                │ mempool.space (rede e carteira) · pool JSON · simulador                │
                ├──────────────────────────────────────────────────────────────────────┤
                │ SQLite (node:sqlite): agentes, tarefas, execuções, eventos, métricas,  │
                │ alertas, ações, auditoria, uso de LLM, relatórios                      │
                └──────────────────────────────────────────────────────────────────────┘
```

Os agentes **não** são 50 processos nem 50 conexões com modelos de linguagem. São módulos com contrato padronizado (`AgentDefinition`) executados por um runtime único.

## 3. Mapa de dependências

```
Mercado ───────────── A06 Preços ──┬──► A09 Volatilidade
                      A07 Dificuldade ─┐
                      A08 Recompensa ◄─ network.height (A07)
                      A10 Taxas
Hardware ──────────── A11 Conector ─┐  (todos leem o mesmo MinerService com cache de 5 s)
                      A12 Hashrate ─┼──► A15 Anomalias ──► proposta restart_miner
                      A13 Térmico ──┼──► A26 Guardião
                      A14 Inventário┘
                      A22 Shares ────────► A26 Guardião · Evidência nível 3
Energia ───────────── A16 Consumo + A17 Tarifa ─┐
                                                ├──► A18 Rentabilidade ──► A19 Equilíbrio ──► A20 Projeção
Mercado + Hardware ─────────────────────────────┘                     └──► A32 Cenários · A31 Estrategista
Pools ─────────────── A21 Conector ──► pool.disconnected ──► A24 Failover ──► proposta switch_pool
                      A23 Saldo ──────────────► A43 Conciliador ◄── A42 Receitas ◄── A44 Carteira
Propostas (A15, A24, A31) ──► Guardião (regras) ──► operador aprova ──► A37 Executor (reavalia) ──► minerador
Eventos action.* / system.* / alert.raised ──► A41 Auditor (cadeia SHA-256)
alert.raised ──► A47 Central de Alertas ──► A48 Notificador (Telegram)
agent.error ──► A38 Recuperação (espera progressiva)
Tudo ──► A01 Diretor · A49 Relatórios · A46 Console · A50 Interface
```

## 4. Contínuos, agendados e por evento

| Modo | Agentes |
|---|---|
| **Contínuos** (laços curtos) | 2 (10 s), 4 (30 s), 11, 12 (15 s), 13 (30 s), 16 (1 min), 22 (30 s), 25 (2 min), 26 (10 s), 29 (1 min), 46, 50 (30 s) |
| **Agendados** | 1, 3, 5, 6, 7, 10, 14, 17, 18, 19, 20, 21, 23, 27, 28, 30, 31, 32, 33, 34, 35, 36, 39, 40, 42, 43, 44, 45, 49 |
| **Por evento** | 8, 9, 15, 24, 37, 38, 41, 47, 48 (alguns agendados também reagem a eventos: 26, 32, 34, 42, 45, 49) |

**Essenciais** (continuam rodando com o sistema pausado): 1–5, 13, 26–28, 30, 38, 40, 41, 46, 47, 50.

## 5. Recursos de processamento

- O gerenciador inteiro roda em **1 processo Node.js 22+**, ~60–120 MB de RAM em uso típico, CPU próxima de zero (picos curtos a cada ciclo).
- Banco SQLite local com retenção de 30 dias (configurável) e backup a cada 6 h (7 cópias).
- Chamadas externas limitadas a 30/min por host (configurável), com cache compartilhado para o minerador.
- A **mineração em si não roda neste aplicativo**: ela roda no minerador (ASIC com cgminer/bmminer, ou XMRig em CPU/GPU). O aplicativo apenas lê, avalia e, com aprovação, pausa/retoma o XMRig.
- LLM: desligado por padrão; quando ligado, um único gateway com teto de chamadas/dia e tokens/mês.

## 6. Modelo de dados

| Tabela | Conteúdo |
|---|---|
| `agents` | estado, última execução, último sucesso, último erro, contadores |
| `tasks` | fila com chave de idempotência (índice único parcial impede duplicatas ativas) |
| `executions` | cada tentativa: início, fim, duração, status, resumo/erro |
| `events` | console de eventos (tipo, severidade, agente, dados, procedência) |
| `metrics` / `metrics_latest` | histórico e valor atual; **toda métrica tem procedência**: `real`, `estimado`, `simulado` ou `teste` |
| `alerts` | alertas agrupados por código (janela de 10 min) e reconhecimento |
| `actions` | propostas, razões do Guardião, decisão do operador, resultado |
| `audit` | trilha encadeada por SHA-256 (detecta adulteração) |
| `llm_usage` | chamadas e tokens por agente |
| `reports`, `kv` | relatórios gerados e estado do sistema (pausa, manutenção) |

## 7. Contrato do agente

```ts
interface AgentDefinition {
  id; code; name; department; responsibility;
  mode: 'continuous' | 'scheduled' | 'event'; intervalMs?; triggers?;
  permissions: Permission[]; inputs: string[]; outputs: string[];
  essential?; maturity: 'stub' | 'simulado' | 'validado'; timeoutMs?;
  run(ctx): Promise<{ status: 'ok' | 'skipped' | 'disconnected' | 'blocked'; summary; metrics?; events? }>;
}
```

O runtime **impõe** as permissões: acessar o minerador exige `read:miner`, escrever métricas exige `write:metrics`, propor ações exige `propose:action`, e assim por diante. Uma métrica sem procedência é rejeitada.

Estados: `operacional` (executando ou último ciclo com sucesso), `ocioso` (nada a fazer / dado indisponível), `aguardando` (na fila ou contido pelo limitador), `erro` (falhou após as tentativas), `bloqueado` (sistema pausado ou em espera após falhas), `desconectado` (fonte externa não responde).

## 8. Guardião de Risco (sem LLM)

| Regra | Efeito |
|---|---|
| R01 | Compras, pagamentos, saques e negociações **sempre** bloqueados |
| R02 | Tipo de ação desconhecido bloqueado |
| R03 | Com o sistema pausado, só a pausa do minerador é permitida |
| R04 | Dado simulado/teste não autoriza ação em minerador real |
| R05 / R06 | Limites de reinícios e de ações por hora |
| R07 | Troca de pool só para `ALLOWED_POOLS` |
| R08 | Não retomar/aumentar carga acima de `MAX_TEMP_C` |
| S01–S04 | Temperatura crítica pausa o sistema; temperatura alta, rejeição alta e carteira fora da lista geram atenção/crítico |
| H01 | Toda ação aprovada pelas regras ainda exige aprovação do operador, e o Executor reavalia no momento de executar |

## 9. Níveis de evidência de mineração

`0 Desconectado → 1 Conectado ao minerador → 2 Hashrate informado pelo minerador → 3 Shares aceitas → 4 Saldo na pool → 5 Pagamento confirmado on-chain`

"Mineração ativa" só é declarada a partir do nível 3 **com dados reais e recentes** (≤ 5 min). Com qualquer dado simulado no caminho, a interface mostra "SIMULAÇÃO — nenhum minerador real está sendo medido".
