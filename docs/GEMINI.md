# Gemini no painel (LLM opcional)

O painel funciona sem nenhum modelo de linguagem. Com o LLM ligado, um único agente passa a usá-lo: o **Redator de Análises (A34)**, que escreve um resumo curto em português a cada 6 horas. Se o modelo falhar, demorar ou responder algo inválido, o Redator usa o texto fixo de sempre. O Guardião de Risco nunca usa LLM.

O gateway aceita dois provedores: **Gemini (Google)**, que tem nível gratuito, e **Claude (Anthropic)**, pago por uso.

## Como ligar

1. Abra <https://aistudio.google.com/apikey>, entre com a sua conta Google e clique em **Create API key**. Copie a chave.
2. Dê duplo clique em **`Configurar-Gemini.bat`** e cole a chave quando ele pedir. Ela não aparece na tela.
3. O programa testa a chave com o Google e, se ela for aceita, grava `GEMINI_API_KEY`, `LLM_PROVIDER=gemini` e `LLM_ENABLED=true` no `.env`.
4. Abra (ou reinicie) o painel pelo `Iniciar-Painel.bat`. Em **Guardião → LLM** aparecem o provedor, o modelo, o uso do dia e o botão **Testar chave do LLM**.

Pelo terminal: `npm run gemini:setup` faz o mesmo, e `npm run gemini:check` só confere a chave que já está no `.env`.

## Formatos de chave aceitos

**Qualquer chave emitida pelo Google é aceita.** O formato não decide nada: quem decide se a chave vale é o Google, na primeira chamada.

| Como a chave começa | O que é | O que o painel faz |
|---|---|---|
| `AQ.` | Chave de autorização, o formato que o Google AI Studio emite hoje | Usa |
| `AIza` (39 caracteres) | Chave padrão, o formato antigo | Usa e avisa que o Google anunciou o fim das chaves padrão |
| Outro | Formato que o painel não conhece | Usa e avisa que o formato não foi reconhecido |

Em 2026 o Google trocou as chaves `AIza…` pelas `AQ.…`, e várias ferramentas pararam de aceitar chaves novas porque conferiam o prefixo antigo. Por isso aqui não há conferência de prefixo nem de tamanho. Segundo a documentação do Google, todas as chaves novas do AI Studio são de autorização, as chaves padrão sem restrição deixaram de ser aceitas em 19 de junho de 2026 e as chaves padrão em geral, a partir de setembro de 2026.

Só são recusados enganos evidentes de preenchimento, sempre com o motivo:

- campo vazio, ou texto de exemplo (`sua_chave_aqui`, `AIza...`);
- espaços, quebras de linha ou acentos no meio da chave;
- chave de outro provedor (`sk-ant-…`, `sk-…`) ou token temporário (`ya29.…`);
- menos de 20 caracteres (chave copiada pela metade).

Ao colar, o painel remove sozinho aspas, espaços nas pontas, caracteres invisíveis e o nome da variável (`GEMINI_API_KEY=…`, `x-goog-api-key: …`).

## Configuração no `.env`

| Variável | Para que serve | Padrão |
|---|---|---|
| `LLM_ENABLED` | Liga o LLM | `false` |
| `LLM_PROVIDER` | `auto`, `gemini` ou `anthropic` | `auto` |
| `GEMINI_API_KEY` | Chave do Google AI Studio (`GOOGLE_API_KEY` vale na falta dela) | vazio |
| `GEMINI_MODEL` | Código do modelo | `gemini-flash-lite-latest` |
| `GEMINI_THINKING_LEVEL` | `minimal`, `low`, `medium` ou `high` | vazio (padrão do modelo) |
| `GEMINI_API_MODE` | `auto`, `interactions` ou `generate-content` | `auto` |
| `LLM_MAX_CALLS_PER_DAY` | Teto de chamadas por dia | `10` |
| `LLM_MAX_TOKENS_PER_MONTH` | Teto de tokens por mês | `200000` |

Com `LLM_PROVIDER=auto`, o painel usa o provedor da chave que estiver preenchida. Com as duas chaves, mantém a Anthropic e avisa; defina `LLM_PROVIDER=gemini` para usar o Gemini. Uma chave do Google colocada por engano em `ANTHROPIC_API_KEY` é usada no Gemini, com aviso.

`gemini-flash-lite-latest` é o apelido do Google para o Flash-Lite mais recente, o modelo mais barato da família. O Google pode trocar o modelo por trás do apelido; para fixar uma versão, use o código dela (por exemplo `gemini-3.5-flash-lite`).

## O que é enviado ao Google

A cada análise, o painel envia a instrução do Redator e o retrato de até 11 métricas, cada uma com valor e procedência:

`miner.hashrate_hs`, `miner.temperature_c`, `miner.reject_rate_pct`, `system.evidence_level`, `profit.revenue_day`, `profit.energy_cost_day`, `profit.net_day`, `price.BTC-USD`, `network.difficulty_change_pct`, `pool.balance`, `risk.level`.

Não vão chaves, tokens, endereços de carteira nem dados da conta. O pedido leva `store: false`, para que o Google não guarde a conversa para consulta posterior. **No nível gratuito, o Google pode usar o que é enviado para melhorar os produtos dele**; no nível pago, não.

## Custos e limites

- O nível gratuito do Gemini não pede cartão e tem limites por minuto e por dia, definidos pelo Google para cada projeto.
- O painel faz no máximo 10 chamadas por dia e 200 mil tokens por mês (ajustáveis). Atingido um teto, o Redator volta ao texto fixo.
- Nos modelos do Gemini, o raciocínio interno também conta como tokens de saída. O painel soma esses tokens ao consumo e dá uma folga de 1.024 tokens no limite de cada resposta para que o raciocínio não corte o texto.
- Chamadas que falham também contam no teto diário, para que uma chave recusada não fique sendo tentada sem parar.

## As duas APIs do Gemini

O Google tem duas APIs de texto. O painel fala as duas:

- **Interactions** (`POST /v1beta/interactions`): a recomendada pelo Google para projetos novos. É a primeira tentativa.
- **generateContent** (`POST /v1beta/models/<modelo>:generateContent`): a anterior, que o Google marca como legada.

No modo `auto`, se o Google recusar o **formato** do pedido na primeira (ou o endereço não existir), o painel tenta a outra e passa a usar a que funcionou. Erros de chave, cota ou modelo não trocam de API. A chave vai sempre no cabeçalho `x-goog-api-key`, nunca no endereço.

## Problemas comuns

| Mensagem | Causa provável | O que fazer |
|---|---|---|
| o Google recusou a chave (HTTP 401 ou 400) | Chave apagada, copiada pela metade, recém-criada ou de formato que o Google deixou de aceitar | Crie uma chave nova no AI Studio e rode o `Configurar-Gemini.bat` |
| sem permissão (HTTP 403) | Chave bloqueada ou marcada como vazada, projeto restrito, nível gratuito indisponível para o projeto | Veja o estado do projeto no AI Studio; uma chave nova em um projeto novo costuma resolver |
| o Google aceitou a chave, mas o projeto não tem o nível gratuito (HTTP 403) | O Google não oferece o nível gratuito para aquele projeto ou para o local de onde veio a chamada | Teste a partir do seu computador; se continuar, crie a chave em um projeto novo ou ative o faturamento no AI Studio |
| créditos pré-pagos esgotados (HTTP 402) | O projeto usa créditos pré-pagos e eles acabaram | Recarregue ou use uma chave de um projeto no nível gratuito |
| o modelo não existe | `GEMINI_MODEL` com código errado ou modelo desativado pelo Google | `npm run gemini:check` lista os modelos que a chave enxerga |
| o modelo não está no nível gratuito (limite 0) | Modelo só do nível pago | Escolha um Flash ou Flash-Lite em `GEMINI_MODEL` |
| limite de uso atingido (HTTP 429) | Cota por minuto ou por dia | Espere a cota voltar |
| sem conexão com o Google | Internet ou firewall | Libere `generativelanguage.googleapis.com` |
| LLM desativado | `LLM_ENABLED=false` | Rode o `Configurar-Gemini.bat` ou mude para `true` |

Quando a chave, a permissão, o pagamento ou o modelo falham, o Gateway de LLM (A33) abre um alerta no painel com a mensagem.

## Cuidados com a chave

- Ela fica só no `.env` deste computador, que o Git ignora. Não a coloque em outros arquivos do projeto.
- Ela nunca aparece em logs, eventos, alertas, métricas ou respostas da API do painel, e nunca chega ao navegador. O terminal mostra só as pontas (`AQ.A…wxyz`).
- Prefira colar a chave quando o programa pedir. A opção `--chave` deixa a chave no histórico do terminal.
- Se a chave aparecer em um print ou em um repositório, apague-a no AI Studio e crie outra.

## O que não foi validado

- O gateway foi exercitado contra o servidor real do Google **só até a recusa de chaves falsas**: os formatos de erro usados nos testes são os que o Google devolveu em 10/11/2026 para chaves `AQ.…`, `AIza…` e de formato desconhecido.
- Com uma chave válida do operador, o Google **autenticou a chave** (formato `AQ.…`, listagem de modelos e apelido `gemini-flash-lite-latest` confirmados), mas recusou a geração com "nível gratuito indisponível para este projeto" quando chamado do ambiente de desenvolvimento. **Nenhuma geração foi concluída**: o formato da resposta segue a documentação do Google. A confirmação é o `npm run gemini:check` no seu computador.
- A integração com a Anthropic continua como estava e também não foi validada com uma chave real.
