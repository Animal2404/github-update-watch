@echo off
rem ===========================================================================
rem  GitHub Update Watch - launcher
rem  NOTE: keep this file ASCII-only. cmd.exe parses .cmd by the OEM code page
rem  (GBK on zh-CN Windows); UTF-8 Chinese here gets split mid-line and the
rem  commands break. All Chinese UI text lives in the web app instead.
rem ===========================================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if not defined PORT set "PORT=7321"
set "URL=http://127.0.0.1:%PORT%/"

rem ---- locate node: PATH first, then the bundled DSH runtime ----
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" (
    set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  ) else if exist "D:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" (
    set "NODE=D:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
  ) else (
    echo [ERROR] node not found. Install Node.js 18+ and run again.
    pause
    exit /b 1
  )
)

rem ---- start the server; this console IS the server (close it to stop) ----
start "GitHub Update Watch - server (close this window to stop)" cmd /k ""%NODE%" server.mjs"

rem ---- wait for the port, then open an app-mode window (no address bar) ----
powershell -NoProfile -Command "for($i=0;$i -lt 30;$i++){try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',%PORT%);$c.Close();exit 0}catch{Start-Sleep -Milliseconds 300}};exit 1"

set "BROWSER="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if defined GUW_NO_BROWSER (
  echo [info] GUW_NO_BROWSER set - skipping window. Browser detected: %BROWSER%
  echo [info] server url: %URL%
  exit /b 0
)
if defined BROWSER (
  start "" "%BROWSER%" --app=%URL% --window-size=1240,860 --user-data-dir="%TEMP%\guw-app-profile"
) else (
  start "" %URL%
)
endlocal
