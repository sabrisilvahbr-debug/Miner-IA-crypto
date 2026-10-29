# Monitoramento da GPU no Windows — SOMENTE LEITURA

**Mineração: DESATIVADA.** O monitor lê a GPU real pelo `nvidia-smi`, a cada 30 segundos (agente 14), e grava o histórico. Ele **não inicia, não para e não configura nenhum minerador**. A mineração real continua desativada e exigirá aprovação explícita em uma etapa posterior.

## O que já existe

- `server/src/gpu/nvidiaSmi.ts`: comando fixo do `nvidia-smi` (sem shell, sem entrada do usuário), interpretação da saída CSV e tratamento de erros.
- `server/src/gpu/monitor.ts`: cache de 5 segundos, marcação de dados antigos (mais de 30 segundos) e registro de eventos.
- `GET /api/gpu`: retorna o estado da GPU. Protegido pelo `API_TOKEN`, como o restante do painel. Sem `API_TOKEN`, só o próprio computador é atendido.
- Painel **GPU e Mineração**: valores com unidade, fonte, horário da última leitura bem-sucedida e estado (REAL, DESATUALIZADO, INDISPONÍVEL, ERRO). O gráfico usa só o histórico gravado; sem leituras, mostra um aviso em vez de uma curva.

Não há agente separado. O painel e o monitor rodam no mesmo processo, no seu computador. Um processo separado só faz sentido quando houver controle de mineração, na fase seguinte.

## Campos lidos

Comando executado, com argumentos fixos:

```
nvidia-smi --query-gpu=index,name,driver_version,temperature.gpu,power.draw,power.limit,utilization.gpu,memory.used,memory.total,fan.speed,pstate --format=csv,noheader,nounits
```

Os nomes dos campos são os usados pelo `nvidia-smi` e devem ser conferidos no seu driver com `nvidia-smi --help-query-gpu`. **Isso ainda não foi testado em um computador Windows com RTX 3050.**

## Procedência dos dados

| Situação | Como aparece no painel |
|---|---|
| Valor lido do `nvidia-smi` | `real` |
| Campo com `[N/A]` ou `[Not Supported]` | ausente (`null`), nunca zero |
| `nvidia-smi` ausente, sem resposta ou com erro | `indisponivel`, com a mensagem do motivo |
| Última leitura com mais de 30 s | `desatualizado`: valores não são mostrados como atuais |
| Saída fora do formato esperado | `erro_leitura` |

## Como verificar no Windows

1. Confirme o driver NVIDIA:
   ```powershell
   nvidia-smi
   ```
   Deve listar a GeForce RTX 3050. Se o comando não existir, instale o driver pelo site da NVIDIA.
2. Veja os campos disponíveis:
   ```powershell
   nvidia-smi --help-query-gpu
   ```
3. Teste a leitura no mesmo formato que o sistema usa:
   ```powershell
   nvidia-smi --query-gpu=index,name,driver_version,temperature.gpu,power.draw,power.limit,utilization.gpu,memory.used,memory.total,fan.speed,pstate --format=csv,noheader,nounits
   ```
   A saída deve ter 11 campos separados por vírgula, em uma linha por GPU.
4. Se o `nvidia-smi` não estiver no PATH, informe o caminho completo no `.env`:
   ```
   NVIDIA_SMI_PATH=C:\Windows\System32\nvidia-smi.exe
   ```
   O caminho precisa ser absoluto e terminar em `nvidia-smi` ou `nvidia-smi.exe`. Outros valores são recusados na inicialização.

## Instalação e uso no Windows

1. Instale o Node.js 22.13 ou superior.
2. Na pasta do projeto:
   ```powershell
   npm test
   npm start
   ```
3. Abra `http://127.0.0.1:8050/api/gpu` no navegador com o token (ou use o painel). Sem o token, a resposta é `401`.

## Limitações

- O sistema ainda **não rodou** no seu Windows. Os valores da RTX 3050 que você enviou (6144 MiB, 70 W, driver 591.86) só servem de referência e aparecem em testes como amostra; o painel mostra **HARDWARE NÃO VERIFICADO** até a primeira leitura real feita pelo próprio sistema.
- Neste ambiente de desenvolvimento não existe `nvidia-smi`. O comportamento real verificado aqui é o de "nvidia-smi ausente".
- O consumo lido fora de mineração (ex.: 17 W em repouso) **não** é usado como consumo de mineração. A modalidade B do custo de energia só usa leituras feitas durante uma sessão de mineração, que ainda não existe.
