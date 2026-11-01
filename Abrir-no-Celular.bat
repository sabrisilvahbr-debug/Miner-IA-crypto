@echo off
REM Libera o painel para o celular na mesma rede Wi-Fi (com token) e abre o painel. Mineracao continua DESATIVADA.
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale a versao LTS em https://nodejs.org e abra este arquivo de novo.
  pause
  exit /b 1
)

call node --experimental-strip-types --disable-warning=ExperimentalWarning server\src\tools\celular.ts
if errorlevel 1 (
  echo Falha ao preparar o acesso pelo celular. Veja a mensagem acima.
  pause
  exit /b 1
)

call "%~dp0Iniciar-Painel.bat"
