# Integrações para a NVIDIA GeForce RTX 3050 (6 GB) — investigação

Hardware de referência, informado pelo operador a partir do `nvidia-smi` no Windows: GeForce RTX 3050, 6144 MiB, driver 591.86, CUDA 13.1 (informado pelo driver), modelo WDDM, limite de potência 70 W. Na captura: 17–18 W, 43 °C, 0% de uso. **Não houve mineração na captura.** O sistema relê esses valores a cada 30 s; os números acima não são usados como medição.

Verificado em 2026-10-29. "Não informado" significa que a fonte consultada não diz.

## Resumo

| Opção | Paga em | Algoritmo | Compatível com a RTX 3050 6 GB? | Integração implementada |
|---|---|---|---|---|
| **NiceHash** | BTC (segundo o site) | o NiceHash escolhe | não informado nas páginas consultadas | **Não.** Faltam documentação oficial de API, taxas e mínimo de pagamento |
| **Pearl (PRL)** | PRL | PearlHash | **não confirmado**: as fontes citam "RTX série 2000 e mais novas" e não informam a VRAM mínima | Pool, algoritmo, taxa e pagamento mínimo, sim. Minerador, não |
| **Luxor** | BTC, LTC/DOGE, SC, ZEC | SHA-256 e outros de ASIC | **não**: o guia oficial fala só em ASIC | Só leitura da conta (API), já existente. Não serve para a GPU |

Nenhuma das três opções está pronta para um teste real. Por isso, o botão **INICIAR TESTE** mostra a lista do que falta e não executa nada.

## NiceHash

- Site: "Connect your miners to NiceHash marketplace and earn BTC for every share" ([nicehash.com](https://www.nicehash.com/)). A página de GPU ([cpu-gpu-mining](https://www.nicehash.com/cpu-gpu-mining)) cita dois programas, **QuickMiner** e **Miner**, e diz "Earn Bitcoin by mining on NiceHash with your GPU or CPU".
- **Não informado** nessas páginas: sistemas operacionais, GPUs suportadas, VRAM mínima, taxas, pagamento mínimo, para onde vai o pagamento.
- A RTX 3050 tem o limitador LHR (Lite Hash Rate) da NVIDIA ([Guru3D](https://www.guru3d.com/news-story/nvidia-lhr-version-3-anti-crypto-algorithm-for-rtx-30503080-12gb-would-be-90-unlocked.html)). O efeito disso nos algoritmos que o NiceHash escolher não foi verificado.
- **Para avançar:** a documentação oficial de suporte do NiceHash (taxas, mínimo de pagamento, API de estatísticas do minerador) e a confirmação de suporte à RTX 3050 no QuickMiner.

## Pearl (PRL) — PearlHash

- **O que é:** blockchain de "prova de trabalho útil", em que mineradores fazem multiplicação de matrizes em GPU. Mineração "somente NVIDIA". O pool oficial da Pearl Research aceita apenas H100 e H200, com taxa de 20%; pools da comunidade aceitam GPUs de consumo ([Hashrate Index, da Luxor, 2026-06-02](https://hashrateindex.com/blog/pearl-prl-ai-compute-cryptocurrency/)).
- **GPUs:** "Nvidia RTX 2000-series and newer, AMD RX 6000-series (RDNA2), and Intel Arc" ([Kryptex, 2026-06-18](https://pool.kryptex.com/en/articles/pearl-miners-en)). As duas fontes divergem sobre AMD e Intel. **Nenhuma cita a RTX 3050 nem a VRAM mínima.**
- **Mineradores citados pela Kryptex:** SRBMiner-MULTI (Windows e Linux), BzMiner, PeakMiner, ARCMiner (Intel Arc), lpminer (Windows). Os downloads apontam para miner.download e GitHub. A página **não diz** que algum seja oficial, nem informa a taxa do desenvolvedor ou o hash de integridade.
- **Pools com endereço documentado:**
  - 2Miners: `stratum+tcp://prl.2miners.com:1818`, taxa 1%, mínimo 1 PRL. **Login não documentado** ([2Miners](https://2miners.com/prl-mining-pool)).
  - Kryptex: `stratum+tcp://prl.kryptex.network:7048` (há `prl-br` para a América do Sul). Para o SRBMiner-MULTI, `--algorithm pearlhash --wallet WALLET_ADDRESS.WORKER`. Taxa de 1% e pagamento automático por hora ao atingir o limite ([Kryptex](https://pool.kryptex.com/en/articles/how-to-mine-pearl-en)).
- **Rentabilidade:** a WhatToMine lista a Pearl (tag `PRL`, algoritmo `Pearl`), usada pelo sistema com hashrate medido.
- **Conversão em BTC:** a WhatToMine informa a cotação da PRL em BTC. Corretora, liquidez e taxas de conversão **não foram verificadas**.
- **Para avançar:** (1) confirmar em fonte oficial do minerador que a RTX 3050 de 6 GB roda PearlHash; (2) escolher um minerador com download e hash verificáveis; (3) você baixar, conferir o hash e informar o caminho e o SHA-256 ao sistema; (4) informar `PAYOUT_ADDRESS_PRL` (endereço público). Só então o teste curto pode ser autorizado.

## Luxor

- O guia oficial ([Getting Started](https://docs.luxor.tech/platform/mining/getting-started)) fala apenas em conectar ASICs: `btc.`, `ltc.`, `sc.` e `zec.global.luxor.tech:700`, com worker `SUBCONTA.WORKER`. GPU não é mencionada.
- O artigo da Hashrate Index (da Luxor) sobre a Pearl **não** diz que a Luxor tenha pool de Pearl.
- **Conclusão:** a Luxor não é compatível com a RTX 3050 nas moedas documentadas. A integração com a Luxor existente (só leitura da conta, para um ASIC futuro) foi mantida e **não foi validada com a sua chave**.

## O que nunca é feito

- Baixar ou executar minerador automaticamente.
- Desativar o Microsoft Defender, o firewall ou outra proteção.
- Aceitar comando, caminho ou argumento vindo do navegador.
- Pedir chave privada ou frase-semente. Só endereço público.
