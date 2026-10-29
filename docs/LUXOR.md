# Pool principal: Luxor

Integração com a [API oficial da Luxor](https://docs.luxor.tech/platform/api/introduction), em modo **somente leitura**.

## Estado atual

| Item | Situação |
|---|---|
| Código da integração | Implementado e coberto por testes, com respostas simuladas no formato documentado |
| Autenticação com a chave real | **NÃO VALIDADA.** O ambiente de desenvolvimento não tem rota de rede até `app.luxor.tech` (bloqueio do proxy). A validação precisa ser feita no seu computador (passo A). |
| Dados reais da conta | Ainda não consultados |
| Agentes de pool (21, 23, 24, 43) | Continuam em modo **simulado** até haver autenticação aceita **e** pelo menos um minerador ativo na conta |

## Como funciona

- A chave fica só no backend, na variável `LUXOR_API_KEY` do `.env`. O `.env` é ignorado pelo Git. A chave nunca é enviada ao navegador, nunca aparece em logs, métricas ou eventos, e é mascarada em mensagens de erro.
- Autenticação: cabeçalho `authorization: <chave>`, base `https://app.luxor.tech/api/v2`, conforme a documentação.
- Ordem das consultas: primeiro `GET /workspace`. **Só se ele responder HTTP 200** com os campos documentados, o sistema consulta `GET /pool/summary/{moeda}`. A integração só é marcada como "dados conferidos" quando as duas respostas batem com o esquema documentado.
- Endpoints usados (todos GET): `/workspace`, `/pool/subaccounts`, `/pool/summary/{moeda}`, `/pool/workers/{moeda}`. O cliente recusa qualquer outro caminho. Criar subconta, alterar configurações de pagamento e qualquer outra escrita **não estão implementados**.
- Fallback: sem autenticação, com API inacessível ou com `active_miners = 0`, as métricas `pool.*` usam o simulador, ficam etiquetadas como **simulado** e o motivo é publicado em `pool.fallback_reason`. Os dados reais da conta, quando existirem, ficam em `luxor.*` com procedência **real**.
- A documentação não informa a unidade do hashrate de `/pool/summary`. O valor é guardado como veio (`luxor.hashrate_5m`) e **não é convertido** até ser comparado com o hashrate do próprio minerador.

## Configuração do minerador (somente dados do guia oficial)

Fonte: [Getting Started with Luxor Mining Pool](https://docs.luxor.tech/platform/mining/getting-started).

| Campo | Valor |
|---|---|
| URL (Bitcoin, SHA-256) | `stratum+tcp://btc.global.luxor.tech:700` |
| Worker | `SUBCONTA.NOME_DO_EQUIPAMENTO` (a subconta precisa existir antes; evite símbolos) |
| Senha | `123` (valor de exemplo da documentação) |

O guia não cita Stratum V2, TLS ou servidores regionais: o endereço `global` encaminha para a região mais próxima. Nenhum outro endereço, porta ou parâmetro foi usado.

## Passo A — Validar a chave e os dados reais (no seu computador)

1. **Gere uma chave nova.** A chave atual foi colada em uma conversa. No painel da Luxor, abra **Workspace → API Keys**, crie uma chave e exclua a antiga.
2. Baixe o código e entre na pasta:
   ```bash
   git pull
   ```
3. Crie o `.env` a partir do modelo completo (`cp .env.luxor.example .env`) e preencha pelo menos:
   ```
   POOL_SOURCE=luxor
   LUXOR_API_KEY=<sua chave nova>
   LUXOR_CURRENCY=BTC
   ```
4. Rode a verificação (somente leitura):
   ```bash
   npm run luxor:check
   ```
   Resultado esperado:
   - `1. Autenticação — GET /workspace` com `✓ HTTP 200 · workspace "…"`.
   - `RESULTADO: Autenticação VALIDADA e dados de /workspace e /pool/summary conferidos…`
   - Se aparecer `HTTP 401`, a chave foi recusada. Se aparecer `HTTP 403`, ela não tem permissão para o recurso.
5. Inicie o painel com `npm start`, abra **Pool Luxor** e clique em **Validar agora**. O estado deve ficar verde, com "Dados conferidos: sim".

## Passo B — Conectar um ASIC SHA-256 à Luxor (você executa)

Nada abaixo é feito automaticamente pelo sistema.

1. No painel da Luxor, crie uma **subconta** (ex.: `fazenda`).
2. No `.env`:
   ```
   LUXOR_SUBACCOUNT=fazenda
   LUXOR_WORKER_NAME=asic01
   ALLOWED_POOLS=stratum+tcp://btc.global.luxor.tech:700
   ```
   A aba **Pool Luxor** passa a mostrar o worker pronto (`fazenda.asic01`).
3. Na interface web do seu ASIC, em configuração de pools, preencha URL, Worker e Senha com os valores da tabela acima e salve. O equipamento reinicia a mineração. **Essa alteração é sua**: o sistema não altera equipamentos.
4. Para o painel ler o próprio minerador, habilite a API cgminer/bmminer no firmware (porta 4028) e configure:
   ```
   MINER_TYPE=cgminer
   MINER_URL=tcp://IP-DO-ASIC:4028
   POWER_WATTS=<consumo do equipamento>
   ENERGY_PRICE_KWH=<sua tarifa>
   ```
5. Após 10 a 15 minutos, valide:
   - `npm run luxor:check` deve listar `fazenda.asic01` em **Workers ativos**, com uma última share recente.
   - No painel, **Pool Luxor** deve mostrar `mineradores ativos ≥ 1` e `pool.source_mode = real`.
   - O cartão **Evidência de mineração** deve chegar ao nível 3 com etiqueta **real** (shares aceitas). Os níveis 4 e 5 dependem de saldo na pool e de pagamento confirmado.
6. Envie a saída do `luxor:check`, com a chave mascarada, para conferirmos a unidade do hashrate e marcarmos os agentes de pool como validados.

## Pagamentos para a Coinbase

O endereço de pagamento é configurado **por você** no painel da Luxor (configurações de pagamento). Para receber na Coinbase, use o endereço de depósito BTC da sua conta. O sistema não altera configurações de pagamento. Para acompanhar os recebimentos em modo leitura, use `WALLET_SOURCE=mempool`, `WALLET_BTC_ADDRESS` e `ALLOWED_WALLETS`.

## Validação pelo GitHub (sem usar o seu computador)

O workflow **Validar Luxor** (`.github/workflows/luxor-validacao.yml`) roda o `luxor:check` nos servidores do GitHub, somente quando acionado à mão.

1. No GitHub, abra **Settings → Secrets and variables → Actions → New repository secret**.
2. Crie o segredo `LUXOR_API_KEY` com a sua chave nova. Opcional: crie `LUXOR_SUBACCOUNT` com o nome da subconta.
3. Abra **Actions → Validar Luxor → Run workflow**.
4. Resultado esperado no log: `✓ HTTP 200`, `✓ esquema conferido` e `Autenticação VALIDADA…`.

Como o repositório é público, os logs também são. Por isso essa execução usa `LUXOR_CHECK_REDACT=1`: o nome do workspace, os nomes de subcontas e workers, os saldos, as receitas e o hashrate aparecem como `[oculto]`. O GitHub também mascara o valor dos segredos automaticamente.

## Equipamento: RTX 3060

A Luxor opera BTC (SHA-256), LTC/DOGE (Scrypt), SC e ZEC. Hoje todos esses são minerados por ASICs, e uma GPU como a RTX 3060 produziria hashrate próximo de zero neles. Por isso o modelo `.env.luxor.example` vem com `MINER_TYPE=none`. A integração com a API da Luxor funciona e pode ser validada mesmo assim, mas a evidência de mineração continuará no nível 0 até haver um ASIC compatível conectado.
