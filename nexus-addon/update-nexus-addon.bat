@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM Update script for a standalone nexus-addon folder on Windows.
REM - Works even when this folder is not a git repository.
REM - Creates a timestamped backup before replacing files.
REM - Replaces content from GitHub without interactive prompts.

set "REPO_URL=https://github.com/DopeEx/NexusAccounting.git"
if not "%NEXUS_REPO_URL%"=="" set "REPO_URL=%NEXUS_REPO_URL%"

set "BRANCH=master"
if not "%NEXUS_REPO_BRANCH%"=="" set "BRANCH=%NEXUS_REPO_BRANCH%"

set "SUBDIR=nexus-addon"
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "SCRIPT_NAME=%~nx0"

for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "TIMESTAMP=%%I"
set "BACKUP_ROOT=%SCRIPT_DIR%\.update-backup"
set "BACKUP_FILE=%BACKUP_ROOT%\nexus-addon-%TIMESTAMP%.zip"
set "WORKDIR=%TEMP%\nexus-addon-update-%RANDOM%-%RANDOM%"

where git >nul 2>nul
if errorlevel 1 (
  echo Fehler: git wurde nicht gefunden. Bitte Git fuer Windows installieren.
  exit /b 1
)

echo [1/5] Erstelle Backup in %BACKUP_FILE%
mkdir "%BACKUP_ROOT%" 2>nul

powershell -NoProfile -Command "$src=Get-Item -LiteralPath '%SCRIPT_DIR%'; $dest='%BACKUP_FILE%'; $exclude=@('.update-backup'); $items=Get-ChildItem -LiteralPath $src.FullName -Force | Where-Object { $exclude -notcontains $_.Name }; if($items.Count -eq 0){ New-Item -Path $dest -ItemType File -Force | Out-Null } else { Compress-Archive -Path ($items | ForEach-Object FullName) -DestinationPath $dest -CompressionLevel Optimal -Force }"
if errorlevel 1 (
  echo Fehler: Backup konnte nicht erstellt werden.
  exit /b 1
)

echo [2/5] Klone %REPO_URL% ^(Branch: %BRANCH%^)
git clone --depth 1 --branch "%BRANCH%" "%REPO_URL%" "%WORKDIR%\repo"
if errorlevel 1 goto :clone_failed

set "SOURCE_DIR=%WORKDIR%\repo\%SUBDIR%"
if not exist "%SOURCE_DIR%\" (
  echo Fehler: Ordner '%SUBDIR%' wurde im Repo nicht gefunden.
  goto :clone_failed
)

echo [3/5] Entferne alte Dateien ^(Backup und Updater bleiben erhalten^)
for /f "delims=" %%I in ('dir /b /a "%SCRIPT_DIR%"') do (
  set "ITEM=%%I"
  if /I not "!ITEM!"==".update-backup" if /I not "!ITEM!"=="%SCRIPT_NAME%" if /I not "!ITEM!"=="update-nexus-addon.sh" (
    rmdir /s /q "%SCRIPT_DIR%\!ITEM!" >nul 2>nul
    if exist "%SCRIPT_DIR%\!ITEM!" del /f /q "%SCRIPT_DIR%\!ITEM!" >nul 2>nul
  )
)

echo [4/5] Kopiere neue Dateien
robocopy "%SOURCE_DIR%" "%SCRIPT_DIR%" /E /NFL /NDL /NJH /NJS /NC /NS >nul
set "ROBOCODE=%ERRORLEVEL%"
if %ROBOCODE% GEQ 8 (
  echo Fehler: Kopieren fehlgeschlagen ^(Robocopy Code %ROBOCODE%^).
  goto :cleanup_failed
)

echo [5/5] Update abgeschlossen
echo Quelle: %REPO_URL%@%BRANCH%/%SUBDIR%
echo Backup: %BACKUP_FILE%
echo Hinweis: Lokale Aenderungen wurden durch Repo-Dateien ersetzt.

rmdir /s /q "%WORKDIR%" >nul 2>nul
exit /b 0

:clone_failed
echo Fehler beim Klonen oder ungueltige Repo-Struktur.
echo Backup bleibt erhalten: %BACKUP_FILE%
goto :cleanup_failed

:cleanup_failed
rmdir /s /q "%WORKDIR%" >nul 2>nul
exit /b 1
