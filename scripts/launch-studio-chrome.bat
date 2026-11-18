@echo off
setlocal

for %%I in ("%~dp0..") do set "ROOT_DIR=%%~fI"
set "EXT_DIR=%ROOT_DIR%\extension"
set "PROFILE_DIR=%ROOT_DIR%\.ndi-chrome-studio-profile"
set "EXT_ID=anjokcpcmbhbimpjgbffkjfbnciaaeff"

if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%"

set "CHROME_BIN="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME_BIN=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if "%CHROME_BIN%"=="" if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME_BIN=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if "%CHROME_BIN%"=="" if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME_BIN=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if "%CHROME_BIN%"=="" (
    echo Could not find Google Chrome chrome.exe.
    pause
    exit /b 1
)

set "START_URL=%~1"
if "%START_URL%"=="" set "START_URL=http://127.0.0.1:8765"

echo Launching Studio Chrome with zero-click Meet tab capture...
start "" "%CHROME_BIN%" ^
  --user-data-dir="%PROFILE_DIR%" ^
  --no-first-run ^
  --no-default-browser-check ^
  --load-extension="%EXT_DIR%" ^
  --allowlisted-extension-id=%EXT_ID% ^
  --auto-select-tab-capture-source-by-title=__NDI_SHARE__ ^
  --disable-blink-features=GetDisplayMediaRequiresUserActivation ^
  --silent-debugger-extension-api ^
  --autoplay-policy=no-user-gesture-required ^
  "%START_URL%"
