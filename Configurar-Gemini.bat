@echo off
REM Liga o LLM do painel com uma chave do Google AI Studio (Gemini). Nao mexe na mineracao, que continua DESATIVADA.
chcp 65001 >nul
title AI CRYPTO MINER - Configurar o Gemini
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado.
  echo Instale a versao LTS em https://nodejs.org, feche esta janela e abra este arquivo de novo.
  pause
  exit /b 1
)

call node --experimental-strip-types --disable-warning=ExperimentalWarning server\src\tools\setup-env.ts
if errorlevel 1 (
  echo Falha ao preparar o .env. Veja a mensagem acima.
  pause
  exit /b 1
)

call node --experimental-strip-types --disable-warning=ExperimentalWarning server\src\tools\gemini-setup.ts
pause
