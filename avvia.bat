@echo off
cd /d "%~dp0"
:loop
"C:\Program Files\nodejs\node.exe" server.js
echo Server terminato, riavvio in 3 secondi...
timeout /t 3 /nobreak >nul
goto loop
