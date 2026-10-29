# AI CRYPTO MINER — VIRTUAL MINING OFFICE 50

Gerenciador de mineração de criptomoedas com **50 agentes lógicos em 10 departamentos**, um **Guardião de Risco** com regras determinísticas e um **escritório virtual 3D** que funciona no computador e no iPhone.

> **Importante:** o número de agentes não prova que há mineração. O painel mostra um **nível de evidência** (0 a 5) e só declara "mineração ativa" com shares aceitas a partir de dados reais. Nada aqui promete rentabilidade, e nenhum agente executa compras, pagamentos, saques ou negociações.
>
> **Sem simulação em produção.** Com `APP_ENV=production` (o padrão), nenhuma fonte simulada é aceita: o que não está configurado ou não responde aparece como **INDISPONÍVEL**, **HASHRATE NÃO MEDIDO**, **POOL NÃO CONECTADA** etc. Dados simulados existem só na suíte de testes automatizados.
>
> **Hardware de referência:** NVIDIA GeForce RTX 3050 (6 GB, limite de 70 W). A mineração está **DESATIVADA**: nenhum minerador de GPU foi verificado. Veja [`docs/INTEGRACOES-GPU.md`](docs/INTEGRACOES-GPU.md) e [`docs/RELATORIO-DADOS-REAIS.md`](docs/RELATORIO-DADOS-REAIS.md).

## Como rodar

Requisito: **Node.js 22.13 ou mais recente**. Não há dependências para instalar.

```bash
git clone https://github.com/sabrisilvahbr-debug/Miner-IA-crypto.git
cd Miner-IA-crypto
cp .env.example .env      # sem .env, as fontes ficam desligadas (INDISPONÍVEL)
# ou o modelo completo (RTX 3050 + Luxor):
# cp .env.luxor.example .env   (e preencha só os campos marcados com <-- PREENCHA)
npm start
```

Abra `http://127.0.0.1:8050`.

Testes: `npm test`. Carregamento de todos os módulos (sem dependências): `npm run check:modules`. Build e verificação de tipos: `npm install && npm run build`. Auditoria dos agentes: `npm run audit:agents` ([`docs/AUDITORIA-AGENTES.md`](docs/AUDITORIA-AGENTES.md)). Monitoramento da GPU no Windows: [`docs/GPU-WINDOWS.md`](docs/GPU-WINDOWS.md).

## Usar no iPhone

1. No `.env`: `HOST=0.0.0.0` e `API_TOKEN=` com um token longo.
2. No iPhone (mesma rede Wi-Fi), abra `http://IP-DO-COMPUTADOR:8050` e informe o token.
3. No Safari, **Compartilhar → Adicionar à Tela de Início** para abrir como aplicativo.

Não exponha o painel à internet sem um túnel ou VPN com HTTPS.

## Fontes de dados reais

Por padrão todas as fontes estão em `none` e aparecem como **INDISPONÍVEL**. Em produção, `simulated` é recusado e o painel avisa. Para dados reais, ajuste o `.env`:

| O que | Configuração | Observação |
|---|---|---|
| Cotação do BTC | `MARKET_SOURCE=coinbase` | API pública de cotação da Coinbase, somente leitura |
| Rede Bitcoin | `NETWORK_SOURCE=mempool` | dificuldade, altura, taxas (mempool.space) |
| ASIC de Bitcoin | `MINER_TYPE=cgminer`, `MINER_URL=tcp://IP:4028` | API cgminer/bmminer, somente leitura |
| XMRig (CPU/GPU) | `MINER_TYPE=xmrig`, `MINER_URL=http://127.0.0.1:8080`, `MINER_ACCESS_TOKEN` | permite pausar/retomar após aprovação |
| **Pool Luxor (principal)** | `POOL_SOURCE=luxor`, `LUXOR_API_KEY`, `LUXOR_SUBACCOUNT` | API oficial, somente leitura. Passo a passo em [`docs/LUXOR.md`](docs/LUXOR.md) e validação com `npm run luxor:check` |
| Outra pool | `POOL_SOURCE=json`, `POOL_STATS_URL` e caminhos dos campos | funciona com qualquer pool que tenha endpoint JSON |
| Recebimentos | `WALLET_SOURCE=mempool`, `WALLET_BTC_ADDRESS`, `ALLOWED_WALLETS` | ex.: endereço de depósito BTC da sua conta Coinbase |
| GPU NVIDIA | nada a configurar (`NVIDIA_SMI_PATH` só se o nvidia-smi não estiver no PATH) | leitura a cada 30 s pelo nvidia-smi, somente leitura |
| Rentabilidade de GPU | `MINING_DATA_SOURCE=whattomine`, `GPU_HASHRATE_<MOEDA>` medido | sem hashrate medido: RENTABILIDADE NÃO CALCULÁVEL |
| Energia | `ENERGY_COST_MODE`, `ENERGY_PRICE_KWH`, `ENERGY_MONTHLY_COST` ou `POWER_WATTS` | modalidade A (informado) e B (medido durante mineração); nunca somadas |

### Sobre a Coinbase

A Coinbase é corretora e carteira, **não é uma pool de mineração**. O caminho usual é: o minerador trabalha para uma pool, e a pool paga em BTC para um endereço de depósito da sua conta Coinbase. Este sistema lê esse endereço em modo público (sem chaves e sem acesso à conta) e contabiliza só o que foi recebido com confirmação. Minerar Bitcoin com CPU ou GPU comuns não é viável; isso exige ASICs.

## O que tem dentro

- **50 agentes** com contrato padronizado, estados, permissões impostas pelo runtime, registros de execução e verificação de saúde. Catálogo completo: [`docs/AGENTES.md`](docs/AGENTES.md).
- **Runtime**: registro central, fila com deduplicação, concorrência limitada, tempo limite, novas tentativas com recuo exponencial, espera progressiva após falhas e logs estruturados em JSON (com segredos mascarados).
- **Guardião de Risco** (agente 26): regras R01–R08 e S01–S04, pausa global, bloqueio de operações financeiras e reavaliação no momento da execução.
- **Procedência obrigatória** em toda métrica: `real`, `estimado`, `simulado` (só em testes) ou `teste`.
- **Estado da mineração** com máquina de estados explícita (DESATIVADA, PRONTA PARA TESTE, TESTE AUTORIZADO, INICIANDO, MINERANDO, ERRO, PARADA, DADOS INDISPONÍVEIS) e oito indicadores independentes. MINERANDO exige processo ativo e hashrate medido pelo próprio minerador.
- **Auditoria** com trilha encadeada por SHA-256.
- **LLM opcional** (Claude API) por um único gateway, com limites e validação da saída. Desligado por padrão: o plano **Claude Pro não inclui chave de API**; ela é contratada à parte no Console da Anthropic e cobrada por uso.
- **Escritório 3D** sem dependências: 10 salas, 50 agentes com anel de estado, filtros por estado e setor, ficha individual, console de eventos (copiar/baixar JSON), alertas, ações para aprovar, métricas, relatórios e controles do Guardião.

Arquitetura, mapa de dependências, modos de execução, recursos e modelo de dados: [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md).

## Limitações conhecidas

- **Integração Luxor ainda não validada com a conta real**: o código e os testes estão prontos, mas a consulta autenticada precisa ser feita no seu computador (`npm run luxor:check`). Veja [`docs/LUXOR.md`](docs/LUXOR.md).
- **Nenhum adaptador foi validado com equipamento real.** nvidia-smi, XMRig, cgminer, Coinbase, mempool.space, WhatToMine e a pool JSON foram testados com respostas de teste; a classificação de cada agente está em [`docs/AUDITORIA-AGENTES.md`](docs/AUDITORIA-AGENTES.md).
- **Mineração com a RTX 3050 não implementada**: nenhum minerador de GPU foi verificado (origem, integridade e compatibilidade). O botão INICIAR TESTE mostra o que falta e não executa nada.
- O agente 48 (Telegram) está como `stub`: implementado, mas não testado com um bot real.
- A API de resumo do XMRig e a do cgminer não informam temperatura de forma padronizada; nesses casos o Monitor Térmico fica ocioso e a regra de temperatura não atua.
- Troca de pool, reinício e ajuste de threads são propostos, mas precisam ser feitos manualmente no equipamento; só pausar/retomar o XMRig é executado pelo sistema.
- Rentabilidade só é estimada para SHA-256 (Bitcoin), antes das taxas da pool.
- O CSV de recebimentos é apoio, não substitui um contador.
- O escritório 3D usa renderização isométrica em Canvas (estilo voxel), não WebGL.
