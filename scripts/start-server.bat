@echo off
setlocal enabledelayedexpansion

for %%I in ("%~dp0..") do set "ROOT_DIR=%%~fI"
cd /d "%ROOT_DIR%"

set "VENV_PY=%ROOT_DIR%\.venv\Scripts\python.exe"
if not exist "%VENV_PY%" (
    echo [setup] Creating Python virtual environment in .venv...
    where py >nul 2>nul
    if %ERRORLEVEL%==0 (
        py -3 -m venv "%ROOT_DIR%\.venv"
    ) else (
        python -m venv "%ROOT_DIR%\.venv"
    )
    if errorlevel 1 (
        echo Failed to create virtual environment. Install Python 3.10+ from python.org.
        pause
        exit /b 1
    )
)

set "STAMP=%ROOT_DIR%\.venv\.deps_installed"
if not exist "%STAMP%" (
    echo [setup] Installing dependencies...
    "%VENV_PY%" -m pip install --upgrade pip
    "%VENV_PY%" -m pip install -r "%ROOT_DIR%\requirements.txt"
    if errorlevel 1 (
        echo Failed to install dependencies.
        pause
        exit /b 1
    )
    type nul > "%STAMP%"
)

if "%NDI_PORT%"=="" set "NDI_PORT=8765"
"%VENV_PY%" -m server.app --host 0.0.0.0 --port %NDI_PORT% %*
if errorlevel 1 pause
