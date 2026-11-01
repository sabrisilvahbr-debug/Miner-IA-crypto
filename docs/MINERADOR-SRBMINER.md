# Teste controlado com o SRBMiner-MULTI (RTX 3050)

**A mineração continua DESATIVADA.** Esta integração só permite um **teste curto**, iniciado por você no painel, depois de todas as pré-condições conferidas e com a frase **AUTORIZO TESTE DE MINERAÇÃO** digitada. O sistema nunca baixa, instala ou inicia o minerador sozinho, e nunca desativa o antivírus, o firewall ou outra proteção.

## O que o sistema faz

| Etapa | Como |
|---|---|
| Executa | Só o arquivo de `MINER_GPU_PATH`, e só se o **SHA-256 conferir** com `MINER_GPU_SHA256` naquele momento. Sem shell, argumentos montados pelo servidor. |
| Argumentos | `--disable-cpu --disable-gpu-amd --disable-gpu-intel --algorithm pearlhash --pool prl-br.kryptex.network:7048 --wallet SEU_ENDEREÇO.WORKER --gpu-off-temperature 80`. Todos documentados no [arquivo Parameters oficial](https://github.com/doktor83/SRBMiner-Multi/blob/master/Parameters) e no [comando publicado pela Kryptex](https://pool.kryptex.com/articles/how-to-mine-pearl-en). |
| Nunca usa | `--api-enable` (a API aceita leitura por qualquer site), `--api-rig-restart-url` / `--api-rig-shutdown-url` (reiniciam/desligam o computador), `--shutdown-temperature` (desliga o computador). |
| Lê | O console do minerador: "result accepted", "result rejected", "new job" e "Total:" ([guia de mensagens do miner.download](https://www.miner.download/en-miner-messages/srbminer)). Linha em formato desconhecido é ignorada e contada, nunca adivinhada. |
| Para sozinho | No fim do tempo (1–30 min, padrão 5) · GPU a 90 °C ou mais (na hora) · 80 °C ou mais em 3 leituras seguidas · 2 min sem hashrate · se o minerador fechar · se o painel for fechado (inclusive fechando a janela). |
| Grava | O console completo em `data/logs/srbminer-DATA.log` e um relatório com o que foi e o que **não** foi comprovado. |

**Por que a Kryptex, e não a 2Miners?** A 2Miners não publica o formato do login da Pearl. A Kryptex publica o comando completo do SRBMiner-MULTI, com `CARTEIRA.WORKER`, e tem servidor na América do Sul. Se a 2Miners publicar o formato, ela pode ser adicionada ao catálogo.

## Passo a passo no Windows

### 1. Baixar o minerador (você faz)

1. Abra a página oficial de releases: https://github.com/doktor83/SRBMiner-Multi/releases
2. Na versão **3.8.1**, baixe `SRBMiner-Multi-3-8-1-win64.zip`.
3. Confira o MD5 publicado na página. No PowerShell, na pasta Downloads:
   ```powershell
   Get-FileHash .\SRBMiner-Multi-3-8-1-win64.zip -Algorithm MD5
   ```
   O resultado precisa ser `D21D4AD2FE78118161B33C4C3437644E`. **Se for diferente, apague o arquivo e não continue.**
4. Extraia o ZIP numa pasta só dele, por exemplo `C:\Mineradores\`.

> O antivírus do Windows costuma classificar mineradores como "aplicativo potencialmente indesejado" e pode mover o arquivo para a quarentena. O sistema **não desativa nenhuma proteção**. Liberar ou não esse arquivo específico é decisão sua.

### 2. Calcular o SHA-256 do executável

```powershell
Get-FileHash "C:\Mineradores\SRBMiner-Multi-3-8-1\SRBMiner-MULTI.exe" -Algorithm SHA256
```

Ajuste o caminho para onde o arquivo `SRBMiner-MULTI.exe` ficou depois de extrair. Copie o valor da coluna **Hash**.

### 3. Endereço de recebimento da Pearl

Segundo a Kryptex, você pode criar um endereço na carteira oficial da Pearl (Pearl Wallet) ou usar um endereço de depósito da corretora BigOne. Use **só o endereço público**. **Nunca** digite em lugar nenhum do sistema uma chave privada ou frase-semente.

### 4. Preencher o `.env`

Abra o `.env` da pasta do projeto no Bloco de Notas e preencha:

```
MINER_GPU_PATH=C:\Mineradores\SRBMiner-Multi-3-8-1\SRBMiner-MULTI.exe
MINER_GPU_SHA256=cole_aqui_o_hash_do_passo_2
MINER_WORKER=rtx3050
PAYOUT_ADDRESS_PRL=seu_endereco_publico_da_pearl
ALLOWED_POOLS=stratum+tcp://prl-br.kryptex.network:7048
```

Feche o painel (feche a janela preta) e abra de novo o `Iniciar-Painel.bat`.

### 5. Fazer o teste

1. No painel, abra **GPU e Mineração**.
2. Em **Minerador**, deve aparecer **REAL**. Se aparecer algum aviso em vermelho, corrija o `.env`.
3. Em **Teste controlado**: moeda **PRL**, duração **5** minutos, e clique em **Verificar pré-condições**. Todas devem ficar com ✓.
4. Digite no campo **Autorização** a frase exata `AUTORIZO TESTE DE MINERAÇÃO` e clique em **INICIAR TESTE**.
5. Acompanhe o console. Para parar antes, clique em **INTERROMPER**.
6. No fim, veja o **Último teste**: hashrate informado pelo minerador, shares, temperatura e consumo, e as listas "Comprovado" e "Não comprovado".

### 6. Depois do teste

- O saldo só é comprovado na página da pool (Kryptex, pelo seu endereço) e o pagamento, na sua carteira. O sistema não verifica nenhum dos dois.
- Me envie o arquivo de log (`data\logs\srbminer-….log`) e o relatório. Com uma amostra real do console, eu confiro se a leitura do hashrate e das shares está certa e calculo o resultado com o seu hashrate medido.

## Limitações

- O formato do console e da API do SRBMiner-MULTI não tem documentação oficial. A leitura usa as mensagens descritas pelo miner.download e **precisa ser conferida com o log do primeiro teste real**.
- O teste não comprova saldo, pagamento nem lucro.
- A taxa do desenvolvedor do SRBMiner-MULTI para pearlhash não foi confirmada.
- A RTX 3050 de **6 GB** não aparece em nenhum benchmark público. Só o teste comprova se ela minera Pearl.
- Se o Windows for desligado à força durante o teste, o minerador para junto. Se só o painel for encerrado à força (pelo Gerenciador de Tarefas), confira no Gerenciador de Tarefas se `SRBMiner-MULTI.exe` ficou aberto e finalize-o.
