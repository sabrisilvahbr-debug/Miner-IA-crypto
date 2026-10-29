# Seleção automática de moeda (RTX 3050 6 GB) — somente recomendação

**Estado atual: mineração DESATIVADA.** O módulo calcula, com dados reais, qual moeda seria a melhor, mas não inicia mineradores, não altera carteiras e não executa trocas. Sem dados reais, mostra `RENTABILIDADE NÃO CALCULÁVEL — FALTA DE DADOS REAIS`. Qualquer ativação real exige aprovação explícita do operador em uma etapa posterior.

## Moedas

| Moeda | Algoritmo | Pool (fonte) | Situação |
|---|---|---|---|
| Pearl (PRL) | PearlHash | `stratum+tcp://prl.2miners.com:1818` ([2Miners](https://2miners.com/prl-mining-pool)) | Pool e algoritmo conferidos. Compatibilidade com a RTX 3050 de 6 GB, minerador e login ainda não comprovados (ver `docs/INTEGRACOES-GPU.md`). |
| Quantus (QTC) | Poseidon2 (= QPoW na WhatToMine) | `stratum+tcp://qtc.2miners.com:3636` ([2Miners](https://2miners.com/qtc-mining-pool)) | Pool e algoritmo conferidos (a Kryptex confirma que Poseidon2 é o algoritmo QPoW). Na WhatToMine aparece como QUANTUS. Minerador e login não comprovados. |
| EPIC | não verificado | — | A INVESTIGAR. Sem pool nem minerador: nunca avaliada. |
| Tari (XTM) | não verificado | — | A INVESTIGAR. Sem pool nem minerador: nunca avaliada. |

Taxa da pool 2Miners: 1% (PPLNS). Pagamento mínimo: 1 PRL e 0,1 QTC.

## Fonte de rentabilidade: WhatToMine

- Endpoint: `GET https://whattomine.com/coins.json`. Em 2026-10-29 ele respondeu sem chave. O sistema **não presume** que isso continue: qualquer falha (sem rede, HTTP 4xx/5xx, JSON fora do formato) vira "indisponível", com o motivo.
- Habilite com `MINING_DATA_SOURCE=whattomine`. O padrão do código é `none`.
- Cada entrada é validada (sigla, algoritmo, tempo de bloco, recompensa, `nethash`, cotação em BTC, `lagging`, `timestamp`). Entrada fora do formato é descartada, nunca corrigida.
- Consulta a cada 5 minutos no máximo (cache).
- A idade do dado vem do `timestamp` da própria WhatToMine. Acima de `MINING_DATA_MAX_AGE_MIN` (padrão 15), o dado não entra no cálculo. **Na verificação de 2026-10-29, os dados tinham cerca de 70 minutos**: com o limite de 15 minutos, o sistema tende a mostrar "desatualizado". Aumentar o limite é decisão sua.
- Moeda com `lagging: true` não é usada. Algoritmo diferente do catálogo também não.

### Cálculo da receita (sempre estimado)

```
moedas/dia = (hashrate medido da GPU / nethash) × recompensa do bloco × 86400 / tempo do bloco
receita BRL/dia = moedas/dia × cotação da moeda em BTC × cotação do BTC em BRL (Coinbase)
```

- O hashrate vem de `GPU_HASHRATE_<SIGLA>` no `.env` (ex.: `GPU_HASHRATE_PRL`). Ele precisa ser **medido** na sua placa e estar na **mesma unidade do `nethash`** da WhatToMine, que não é documentada. Antes de confiar no número, compare o resultado com a calculadora do site da WhatToMine para o mesmo hashrate.
- A cotação do BTC só é usada se for real (`MARKET_SOURCE=coinbase`). Cotação simulada é recusada.
- A idade da cotação final é a do dado mais antigo entre WhatToMine e Coinbase.

## Regras de decisão

- Lucro líquido = receita − taxa da pool − taxa do minerador − energia.
- Energia = consumo (W) / 1000 × 24 h × tarifa (R$/kWh).
- Custo de energia: vem do módulo de energia (`/api/energy`), na modalidade escolhida em `ENERGY_COST_MODE`. **Não há mais valor padrão de consumo**: sem custo informado ou medido, a rentabilidade não é calculável.
- A cada 5 minutos, o módulo reavalia. Troca só quando o ganho no horizonte (1 dia) passa do custo da parada (3 min de resultado atual) **e** do limite mínimo (R$ 1,00 e 10% de vantagem relativa), **e** o intervalo desde a última troca passou de 30 minutos.
- Se todas as alternativas têm resultado líquido negativo, a decisão é `suspender`.
- Não escolhe moeda pelo rendimento bruto nem pela quantidade de moedas.

## Endpoint

`GET /api/auto-mining` retorna o modo (`SIMULAÇÃO`), a decisão atual, a avaliação de cada moeda e a fonte de mercado usada (ou "indisponível").

## Testes

```bash
npm test
```

Os testes cobrem: cálculo de energia e lucro líquido, pagamento mínimo, frescor dos dados, moedas em investigação, falhas de fonte, dados desatualizados, suspensão por prejuízo, proteção contra oscilação, intervalo mínimo entre trocas e simulação de queda de uma moeda.

## Limitações conhecidas

- A WhatToMine não é alcançável a partir do ambiente de desenvolvimento; o adaptador foi testado com respostas no formato real, mas a consulta ao vivo só acontece no seu computador.
- O hashrate da RTX 3050 em Pearl ainda não foi medido: sem ele, o lucro fica indisponível.
- Login/worker e software de mineração para a PRL ainda não estão verificados. A QTC está em investigação.
- O painel visual ainda não mostra a seleção automática; a informação está disponível pela API.
- Não há teste de integração com minerador real, porque nenhuma ativação real foi autorizada.
