# Integrações para a NVIDIA GeForce RTX 3050 (6 GB) — investigação

Hardware de referência, informado pelo operador a partir do `nvidia-smi` no Windows: GeForce RTX 3050, 6144 MiB, driver 591.86, CUDA 13.1 (informado pelo driver), modelo WDDM, limite de potência 70 W. Na captura: 17–18 W, 43 °C, 0% de uso. **Não houve mineração na captura.** O sistema relê esses valores a cada 30 s; os números acima não são usados como medição.

Verificado em 2026-10-29. "Não informado" significa que a fonte consultada não diz.

## Resumo

| Opção | Paga em | Algoritmo | Compatível com a RTX 3050 6 GB? | Integração implementada |
|---|---|---|---|---|
| **NiceHash** | BTC (segundo o site) | o NiceHash escolhe | não informado nas páginas consultadas | **Não.** Faltam documentação oficial de API, taxas e mínimo de pagamento |
| **Pearl (PRL)** | PRL | PearlHash | **provável**: benchmark público da RTX 3050 **8GB**; a de 6 GB não aparece | Pool, algoritmo, taxa e pagamento mínimo, sim. Minerador, não |
| **Quantus (QTC)** | QTC | Poseidon2 (= QPoW) | **provável**: "RTX 3000-series and newer"; sem benchmark da RTX 3050 | Pool, algoritmo, taxa e pagamento mínimo, sim. Minerador, não |
| **Luxor** | BTC, LTC/DOGE, SC, ZEC | SHA-256 e outros de ASIC | **não**: o guia oficial fala só em ASIC | Só leitura da conta (API), já existente. Não serve para a GPU |

Nenhuma das três opções está pronta para um teste real. Por isso, o botão **INICIAR TESTE** mostra a lista do que falta e não executa nada.

## NiceHash

- Site: "Connect your miners to NiceHash marketplace and earn BTC for every share" ([nicehash.com](https://www.nicehash.com/)). A página de GPU ([cpu-gpu-mining](https://www.nicehash.com/cpu-gpu-mining)) cita dois programas, **QuickMiner** e **Miner**, e diz "Earn Bitcoin by mining on NiceHash with your GPU or CPU".
- **Não informado** nessas páginas: sistemas operacionais, GPUs suportadas, VRAM mínima, taxas, pagamento mínimo, para onde vai o pagamento.
- A RTX 3050 tem o limitador LHR (Lite Hash Rate) da NVIDIA ([Guru3D](https://www.guru3d.com/news-story/nvidia-lhr-version-3-anti-crypto-algorithm-for-rtx-30503080-12gb-would-be-90-unlocked.html)). O efeito disso nos algoritmos que o NiceHash escolher não foi verificado.
- Nova busca em 2026-10-29: só apareceram guias de terceiros e cópias de wiki, nenhuma página oficial com taxas ou GPUs suportadas. Nada foi usado.
- **Para avançar:** a documentação oficial de suporte do NiceHash (taxas, mínimo de pagamento, API de estatísticas do minerador) e a confirmação de suporte à RTX 3050 no QuickMiner.

## Pearl (PRL) — PearlHash

- **O que é:** blockchain de "prova de trabalho útil", em que mineradores fazem multiplicação de matrizes em GPU. Mineração "somente NVIDIA". O pool oficial da Pearl Research aceita apenas H100 e H200, com taxa de 20%; pools da comunidade aceitam GPUs de consumo ([Hashrate Index, da Luxor, 2026-06-02](https://hashrateindex.com/blog/pearl-prl-ai-compute-cryptocurrency/)).
- **GPUs:** "Nvidia RTX 2000-series and newer, AMD RX 6000-series (RDNA2), and Intel Arc" ([Kryptex, 2026-06-18](https://pool.kryptex.com/en/articles/pearl-miners-en)). As duas fontes divergem sobre AMD e Intel. **Nenhuma cita a RTX 3050 nem a VRAM mínima.**
- **Mineradores citados pela Kryptex:** SRBMiner-MULTI (Windows e Linux), BzMiner, PeakMiner, ARCMiner (Intel Arc), lpminer (Windows). Os downloads apontam para miner.download e GitHub. A página **não diz** que algum seja oficial, nem informa a taxa do desenvolvedor ou o hash de integridade.
- **Pools com endereço documentado:**
  - 2Miners: `stratum+tcp://prl.2miners.com:1818`, taxa 1%, mínimo 1 PRL. **Login não documentado** ([2Miners](https://2miners.com/prl-mining-pool)).
  - Kryptex: `stratum+tcp://prl.kryptex.network:7048` (há `prl-br` para a América do Sul). Para o SRBMiner-MULTI, `--algorithm pearlhash --wallet WALLET_ADDRESS.WORKER`. Taxa de 1% e pagamento automático por hora ao atingir o limite ([Kryptex](https://pool.kryptex.com/en/articles/how-to-mine-pearl-en)).
- **Benchmark:** a [hashrate.no](https://www.hashrate.no/coins/PRL/benchmarks) lista a **RTX 3050 8GB com 31,34 Th/s e 0,560 Th/W** (cerca de 56 W). A RTX 3050 **6 GB** tem menos núcleos e não aparece; o desempenho dela deve ser menor. A página não diz qual minerador foi usado.
- **SRBMiner-MULTI 3.8.1** ([GitHub oficial do autor](https://github.com/doktor83/SRBMiner-Multi/releases)): "Minor improvements on algorithm 'pearlhash' for NVIDIA 2000, 3000, 4000 and 5000 series GPUs". A página publica **só MD5** do arquivo (`d21d4ad2fe78118161b33c4c3437644e *SRBMiner-Multi-3-8-1-win64.zip`), não SHA-256. Taxa do desenvolvedor para pearlhash: não informada na página.
- **Estimativa de 2026-10-29** (fórmula do sistema; WhatToMine das 18:36 UTC: nethash 75.660.874.387.190.869.565, recompensa 2.211,65 PRL, bloco 184 s, 0,0000223 BTC/PRL; Coinbase: R$ 424.959/BTC; R$ 0,90/kWh; taxa da pool 1% e do minerador 2,5% presumida): com 31,34 Th/s e 56 W, **≈ 0,43 PRL/dia, receita ≈ R$ 4,08/dia, energia ≈ R$ 1,21/dia, líquido ≈ R$ 2,73/dia (≈ R$ 82/mês)**. Para a 6 GB, supondo 20% menos (suposição, não medição): ≈ R$ 2,06/dia. **Premissa não verificada:** que o `nethash` da WhatToMine esteja em H/s, na mesma unidade do benchmark. O valor muda todo dia com a dificuldade e o preço. Não é lucro comprovado.
- **Rentabilidade no sistema:** a WhatToMine lista a Pearl (tag `PRL`, algoritmo `Pearl`), usada pelo sistema com hashrate medido.
- **Conversão em BTC:** a WhatToMine informa a cotação da PRL em BTC. Corretora, liquidez e taxas de conversão **não foram verificadas**.
- **Para avançar:** (1) confirmar em fonte oficial do minerador que a RTX 3050 de 6 GB roda PearlHash; (2) escolher um minerador com download e hash verificáveis; (3) você baixar, conferir o hash e informar o caminho e o SHA-256 ao sistema; (4) informar `PAYOUT_ADDRESS_PRL` (endereço público). Só então o teste curto pode ser autorizado.

## Quantus (QTC) — Poseidon2 / QPoW

- **Algoritmo:** a Kryptex esclarece: "classic Proof-of-Work on the Poseidon2 hash (the QPoW algorithm)" ([Kryptex](https://pool.kryptex.com/articles/how-to-mine-quantus-en)). Portanto, Poseidon2 (2Miners) e QPoW (WhatToMine) são o mesmo algoritmo, e a moeda voltou a ser avaliada.
- **GPUs:** "Nvidia (RTX 3000-series and newer) and AMD RDNA (RX 6000-series and newer)". Sem benchmark público da RTX 3050.
- **Minerador citado:** só o SRBMiner-MULTI, com taxa do desenvolvedor de 2,5%.
- **Pool 2Miners:** `stratum+tcp://qtc.2miners.com:3636`, taxa 1%, mínimo 0,1 QTC. Login não documentado na página.
- **Na WhatToMine:** tag `QUANTUS` (a sigla `QTC` lá é da Qubitcoin).

## Luxor

- O guia oficial ([Getting Started](https://docs.luxor.tech/platform/mining/getting-started)) fala apenas em conectar ASICs: `btc.`, `ltc.`, `sc.` e `zec.global.luxor.tech:700`, com worker `SUBCONTA.WORKER`. GPU não é mencionada.
- O artigo da Hashrate Index (da Luxor) sobre a Pearl **não** diz que a Luxor tenha pool de Pearl.
- **Conclusão:** a Luxor não é compatível com a RTX 3050 nas moedas documentadas. A integração com a Luxor existente (só leitura da conta, para um ASIC futuro) foi mantida e **não foi validada com a sua chave**.

## O que nunca é feito

- Baixar ou executar minerador automaticamente.
- Desativar o Microsoft Defender, o firewall ou outra proteção.
- Aceitar comando, caminho ou argumento vindo do navegador.
- Pedir chave privada ou frase-semente. Só endereço público.
