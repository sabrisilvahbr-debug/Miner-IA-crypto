@echo off
REM Abre o painel AI CRYPTO MINER no seu computador. Mineracao continua DESATIVADA.
chcp 65001 >nul
title AI CRYPTO MINER - Painel
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

if not exist "node_modules" (
  echo Instalando dependencias ^(so na primeira vez^)...
  call npm install
  if errorlevel 1 (
    echo Falha em npm install. Veja a mensagem acima.
    pause
    exit /b 1
  )
)

echo Conferindo o sistema...
call npm run build
if errorlevel 1 (
  echo Falha na conferencia do sistema. Veja a mensagem acima.
  pause
  exit /b 1
)

echo Abrindo o painel em http://127.0.0.1:8050 ...
start "" cmd /c "timeout /t 3 >nul & start http://127.0.0.1:8050"
call npm start
pause
