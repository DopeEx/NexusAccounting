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

set "ZIP_URL=https://github.com/DopeEx/NexusAccounting/archive/refs/heads/%BRANCH%.zip"
if not "%NEXUS_ZIP_URL%"=="" set "ZIP_URL=%NEXUS_ZIP_URL%"

set "SUBDIR=nexus-addon"
set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "SCRIPT_NAME=%~nx0"

for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "TIMESTAMP=%%I"
set "BACKUP_ROOT=%SCRIPT_DIR%\.update-backup"
set "BACKUP_FILE=%BACKUP_ROOT%\nexus-addon-%TIMESTAMP%.zip"
set "WORKDIR=%TEMP%\nexus-addon-update-%RANDOM%-%RANDOM%"

echo [1/5] Creating backup at %BACKUP_FILE%
mkdir "%BACKUP_ROOT%" 2>nul

powershell -NoProfile -Command "$src=Get-Item -LiteralPath '%SCRIPT_DIR%'; $dest='%BACKUP_FILE%'; $exclude=@('.update-backup'); $items=Get-ChildItem -LiteralPath $src.FullName -Force | Where-Object { $exclude -notcontains $_.Name }; if($items.Count -eq 0){ New-Item -Path $dest -ItemType File -Force | Out-Null } else { Compress-Archive -Path ($items | ForEach-Object FullName) -DestinationPath $dest -CompressionLevel Optimal -Force }"
if errorlevel 1 (
  echo Error: Could not create backup.
  exit /b 1
)

where git >nul 2>nul
if errorlevel 1 (
  echo [2/5] Git not found, using ZIP fallback
  mkdir "%WORKDIR%" 2>nul
  set "ZIP_FILE=%WORKDIR%\repo.zip"
  powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%ZIP_URL%' -OutFile '%ZIP_FILE%'; Expand-Archive -LiteralPath '%ZIP_FILE%' -DestinationPath '%WORKDIR%\unzipped' -Force"
  if errorlevel 1 goto :source_failed

  for /f "delims=" %%I in ('powershell -NoProfile -Command "$root='%WORKDIR%\unzipped'; $d=Get-ChildItem -LiteralPath $root -Directory | Select-Object -First 1; if($null -eq $d){ exit 1 }; Write-Output $d.FullName"') do set "EXTRACTED_ROOT=%%I"
  if not defined EXTRACTED_ROOT goto :source_failed

  set "SOURCE_DIR=%EXTRACTED_ROOT%\%SUBDIR%"
  if not exist "%SOURCE_DIR%\" goto :source_failed
) else (
  echo [2/5] Cloning %REPO_URL% ^(branch: %BRANCH%^)
  git clone --depth 1 --branch "%BRANCH%" "%REPO_URL%" "%WORKDIR%\repo"
  if errorlevel 1 goto :source_failed

  set "SOURCE_DIR=%WORKDIR%\repo\%SUBDIR%"
  if not exist "%SOURCE_DIR%\" goto :source_failed
)

echo [3/5] Removing old files ^(backup and updater are kept^)
for /f "delims=" %%I in ('dir /b /a "%SCRIPT_DIR%"') do (
  set "ITEM=%%I"
  if /I not "!ITEM!"==".update-backup" if /I not "!ITEM!"=="%SCRIPT_NAME%" if /I not "!ITEM!"=="update-nexus-addon.sh" (
    rmdir /s /q "%SCRIPT_DIR%\!ITEM!" >nul 2>nul
    if exist "%SCRIPT_DIR%\!ITEM!" del /f /q "%SCRIPT_DIR%\!ITEM!" >nul 2>nul
  )
)

echo [4/5] Copying new files
robocopy "%SOURCE_DIR%" "%SCRIPT_DIR%" /E /NFL /NDL /NJH /NJS /NC /NS >nul
set "ROBOCODE=%ERRORLEVEL%"
if %ROBOCODE% GEQ 8 (
  echo Error: Copy failed ^(Robocopy code %ROBOCODE%^).
  goto :cleanup_failed
)

echo [5/5] Update completed
echo Source: %REPO_URL%@%BRANCH%/%SUBDIR%
echo Backup: %BACKUP_FILE%
echo Note: Local changes were replaced by repository files.

rmdir /s /q "%WORKDIR%" >nul 2>nul
exit /b 0

:source_failed
echo Error while loading update source ^(Git/ZIP^) or invalid repository structure.
echo Backup is kept: %BACKUP_FILE%
goto :cleanup_failed

:cleanup_failed
rmdir /s /q "%WORKDIR%" >nul 2>nul
exit /b 1
