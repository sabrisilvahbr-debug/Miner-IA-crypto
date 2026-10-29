# Seleção automática de moeda (RTX 3060) — SIMULAÇÃO

**Estado atual: somente simulação.** O módulo decide qual moeda seria a melhor, mas não inicia mineradores, não altera carteiras e não executa trocas. Qualquer ativação real exige aprovação explícita do operador em uma etapa posterior.

## Moedas

| Moeda | Algoritmo | Pool (fonte) | Situação |
|---|---|---|---|
| Pearl (PRL) | PearlHash | `stratum+tcp://prl.2miners.com:1818` ([2Miners](https://2miners.com/prl-mining-pool)) | Pool e algoritmo conferidos. Falta login/worker e software para a RTX 3060. |
| Quantus (QTC) | Poseidon2 | `stratum+tcp://qtc.2miners.com:3636` ([2Miners](https://2miners.com/qtc-mining-pool)) | Pool e algoritmo conferidos. Falta login/worker e software para a RTX 3060. |
| EPIC | não verificado | — | A INVESTIGAR. Sem pool nem minerador: nunca avaliada. |
| Tari (XTM) | não verificado | — | A INVESTIGAR. Sem pool nem minerador: nunca avaliada. |

Taxa da pool 2Miners: 1% (PPLNS). Pagamento mínimo: 1 PRL e 0,1 QTC.

## Fonte de rentabilidade

A API da WhatToMine **não foi verificada**. A consulta a `whattomine.com` foi bloqueada neste ambiente (HTTP 403 pelo proxy), e a documentação de acesso não foi confirmada. Por isso:
- o sistema **não tem fonte de rentabilidade validada**;
- sem dados atuais (menos de 15 minutos), cada moeda aparece como indisponível e a decisão é `aguardar_dados`;
- dados antigos nunca são usados como atuais.

Para alimentar a simulação, os dados precisam vir de uma fonte verificada. Hoje, o módulo aceita entradas do tipo `MarketQuote` (receita em BRL/dia, moedas/dia, horário da coleta e nome da fonte).

## Regras de decisão

- Lucro líquido = receita − taxa da pool − taxa do minerador − energia.
- Energia = consumo (W) / 1000 × 24 h × tarifa (R$/kWh).
- Tarifa inicial: R$ 0,90/kWh. Se `ENERGY_PRICE_KWH` estiver no `.env`, ele tem prioridade.
- Consumo: se `POWER_WATTS` não estiver definido, usa 170 W (TDP máximo da RTX 3060, marcado como estimativa).
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

- Nenhuma cotação real é usada: a fonte de rentabilidade não está validada.
- Login/worker e software de mineração para PRL e QTC ainda não estão verificados.
- O painel visual ainda não mostra a seleção automática; a informação está disponível pela API.
- Não há teste de integração com minerador real, porque nenhuma ativação real foi autorizada.
