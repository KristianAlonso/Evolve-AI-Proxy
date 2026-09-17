#Requires -Version 5.1
<#
.SYNOPSIS
  Arranca el stack de pruebas de evolve_ai_proxy en background (sin bloquear) y vuelca
  TODOS los logs a archivos, para poder inspeccionar el reprocesamiento de prompt y
  los cache hits/misses del modelo sin esperar al REPL interactivo de opencode.

.DESCRIPTION
  1. Levanta el proxy evolutivo (cd app; npx tsx src/index.ts, escucha 127.0.0.1:8787).
  2. Levanta llama.cpp vía D:\llama.cpp\scripts\Qwen3.8-27B-UD.ps1 (llama-server en
     127.0.0.1:9095). La consola del script llama.cpp (donde llama-server imprime
     "prompt eval", tokens/s, y sobre todo el % de tokens en cache) se vuelca a
     llama-<ts>.log / llama-<ts>.err.log.
  3. Espera a que ambos estén listos (GET /v1/models).
  4. Corre opencode EN BACKGROUND con el modelo del proxy:
       opencode --model evolve_proxy/llama_cpp/default --log-level DEBUG --prompt "Hola"
     con stdout/stderr a archivos.

  ARCHIVOS QUE SE GENERAN (todos impresos al final):
    <LogRoot>\opencode-<ts>.log          stdout de opencode
    <LogRoot>\opencode-<ts>.err.log      stderr de opencode (--log-level DEBUG)
    <LogRoot>\llama-<ts>.log             consola del script llama.cpp / llama-server
    <LogRoot>\llama-<ts>.err.log         stderr de llama-server (errores GPU, etc.)
    <ProxyDir>\logs\proxy-stdout-<ts>.log  espejo stdout del proxy (CONSOLE_LOG)
    <ProxyDir>\logs\proxy-stderr-<ts>.log  espejo stderr del proxy
    <ProxyDir>\logs\evolve-proxy-<fecha>.log  logger estructurado del proxy (trace_id)

  USO:
    # Arrancar todo (no bloquea):
    powershell -ExecutionPolicy Bypass -File .\scripts\opencode-proxy-test.ps1

    # Mismo pero esperar a que opencode termine:
    .\scripts\opencode-proxy-test.ps1 -Wait -Prompt "otra pregunta"

    # Ver los cache hits/misses de llama-server:
    Select-String -Path .\logs\llama-*.log -Pattern "prompt eval|cached|pp1|pp2"

    # Detener todo lo arrancado por la última pasada:
    .\scripts\opencode-proxy-test.ps1 -Kill
#>
[CmdletBinding()]
param(
  [string]$LlamaScript   = "D:\llama.cpp\scripts\Qwen3.8-27B-UD.ps1",
  [string]$ProxyDir      = "D:\_projects_personal\evolve_ai_proxy\app",
  [string]$OpencodeBin   = "opencode",
  [string]$Model         = "evolve_proxy/llama_cpp/default",
  [string]$Prompt        = "Hola",
  [string]$LogLevel      = "DEBUG",
  [string]$LogRoot       = "D:\_projects_personal\evolve_ai_proxy\logs",
  [string]$ProxyPort     = "8787",
  [string]$LlamaPort     = "9095",
  [int]$ReadyTimeoutSec  = 900,
  [switch]$SkipLlama,    # -SkipLlama: no relanzar llama-server (reutiliza el del puerto)
  [switch]$Pure,         # -Pure: opencode --pure (sin plugins: sin opencode-swarm ni litellm)
  [switch]$Wait,         # -Wait: queda en foreground esperando a que opencode termine (default: background)
  [switch]$Kill          # -Kill: mata los procesos arrancados por esta script
)

$ErrorActionPreference = "Stop"
$ts = (Get-Date).ToString("yyyyMMdd-HH-mm-ss")
if (-not (Test-Path $LogRoot)) { New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null }
if (-not (Test-Path (Join-Path $ProxyDir "logs"))) { New-Item -ItemType Directory -Path (Join-Path $ProxyDir "logs") -Force | Out-Null }

# --- Kill ------------------------------------------------------------------
if ($Kill) {
  $stateFiles = Get-ChildItem (Join-Path $LogRoot "run-*.state.json") -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending
  if ($stateFiles) {
    $state = (Get-Content $stateFiles[0].FullName -Raw | ConvertFrom-Json)
    foreach ($p in $state.procIds) {
      try { Stop-Process -Id $p.procId -Force -ErrorAction SilentlyContinue } catch {}
    }
  }
  # Fallback: procesos hijos que sobreviven a su launcher (llama-server, node/tsx, opencode).
  Get-Process -Name "llama-server", "opencode", "node" -ErrorAction SilentlyContinue |
    Where-Object {
      $cmd = (Get-WmiObject Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
      $cmd -match "llama-server|opencode|tsx src[\\/]?index[\\/]ts"
    } | Stop-Process -Force -ErrorAction SilentlyContinue
  Write-Host "[+] Procesos detenidos." -ForegroundColor Green
  exit 0
}

# --- Sanity ----------------------------------------------------------------
if (-not (Test-Path $LlamaScript)) {
  Write-Host "[-] No encuentro la script llama.cpp: $LlamaScript" -ForegroundColor Red; exit 1
}
if (-not (Test-Path (Join-Path $ProxyDir "src\index.ts"))) {
  Write-Host "[-] La app del proxy no tiene src/index.ts: $ProxyDir" -ForegroundColor Red; exit 1
}
$ocCmd = Get-Command $OpencodeBin -ErrorAction SilentlyContinue
if (-not $ocCmd) {
  Write-Host "[-] No encuentro 'opencode' en el PATH." -ForegroundColor Red; exit 1
}

# --- Rutas de log -----------------------------------------------------------
$ocLog       = Join-Path $LogRoot ("opencode-" + $ts + ".log")
$ocErrLog    = Join-Path $LogRoot ("opencode-" + $ts + ".err.log")
$llamaLog    = Join-Path $LogRoot ("llama-" + $ts + ".log")
$llamaErrLog = Join-Path $LogRoot ("llama-" + $ts + ".err.log")
$proxyMirror = Join-Path $ProxyDir ("logs\proxy-stdout-" + $ts + ".log")
$proxyErr    = Join-Path $ProxyDir ("logs\proxy-stderr-" + $ts + ".log")

# Helper: lanza un script .ps1 en un launcher powershell con stdout/stderr a archivos.
# El script llama.cpp usa sintaxis PS7 ('&&'), así que los launchers requieren pwsh.
function Get-PS7 {
  $pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
  if (-not $pwshCmd) { throw "Falta 'pwsh' (PowerShell 7): la script llama.cpp usa '&&' (solo PS7)." }
  return $pwshCmd.Source
}
$PS7 = Get-PS7

# Helper: lanza un script .ps1 en un launcher powershell con stdout/stderr a archivos.
function Start-Redirected {
  param([string]$ScriptPath, [string]$OutFile, [string]$ErrFile)
  return (Start-Process -FilePath $PS7 -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`"" -RedirectStandardOutput $OutFile -RedirectStandardError $ErrFile -WindowStyle Normal -PassThru)
}

# Mata instancias previas del proxy evolutivo que estén colgando de puertos.
function Stop-StaleProxy {
  Get-Process -Name "node" -ErrorAction SilentlyContinue |
    Where-Object {
      $cmd = (Get-WmiObject Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
      $cmd -match "evolve_ai_proxy.*tsx.*index\.ts|tsx.*evolve_ai_proxy"
    } | ForEach-Object {
      Write-Host ("[i] Matando proxy viejo PID {0} (tsx src/index.ts)." -f $_.Id) -ForegroundColor Yellow
      Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
  Start-Sleep -Seconds 2
}

# --- 1) Proxy evolutivo (app) ----------------------------------------------
# Si ya hay algo escuchando en el puerto, el nuevo proxy no escucha: matamos la
# instancia anterior (específico al proyecto) y re-echamos el puerto.
$stale = Get-NetTCPConnection -LocalPort $ProxyPort -State Listen -ErrorAction SilentlyContinue
if ($stale) {
  Stop-StaleProxy
  if (Get-NetTCPConnection -LocalPort $ProxyPort -State Listen -ErrorAction SilentlyContinue) {
    Write-Host ("[-] El puerto {0} sigue ocupado tras matar los proxies viejos." -f $ProxyPort) -ForegroundColor Red
    exit 1
  }
}
$proxyLauncher = Join-Path $ProxyDir (".launch-" + $ts + "-proxy.ps1")
Set-Content -Path $proxyLauncher -Value (
  "Set-Location " + (Convert-Path -Path $ProxyDir) + "`r`n" +
  "`$env:CONSOLE_LOG = 'true'`r`n" +
  "npx tsx src/index.ts"
) -Encoding ascii
$proxyProc = Start-Redirected -ScriptPath $proxyLauncher -OutFile $proxyMirror -ErrFile $proxyErr

# --- 2) llama.cpp (el script ya arranca también atomic_ai_proxy) ------------
# Siempre lo arrancamos NOSOTROS para tener su consola a disco (llama-server imprime
# ahí "prompt eval ... s = X/Y", "cached N tokens (P%)", pp1/pp2). Si hay un
# llama-server anterior en el puerto, se mata y se relanzar (reload de ~varios min).
if (-not $SkipLlama) {
  Get-Process -Name "llama-server" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $llamaProc = Start-Redirected -ScriptPath $LlamaScript -OutFile $llamaLog -ErrFile $llamaErrLog
} else {
  $llamaProc = $null
  Write-Host ("[i] -SkipLlama: reusing llama-server existente en {0} (sin log de consola)." -f $LlamaPort) -ForegroundColor Yellow
}

# --- Esperar ready (proxy :8787, llama-server :9095) ------------------------
function Wait-Ready {
  param([string]$Uri, [string]$Name)
  Write-Host ("[*] Esperando {0} ({1})..." -f $Name, $Uri) -ForegroundColor Yellow
  $deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec 5 | Out-Null
      Write-Host ("[+] {0} listo." -f $Name) -ForegroundColor Green
      return $true
    } catch {}
    Start-Sleep -Seconds 5
  }
  Write-Host ("[-] {0} no respondió antes de {1}s." -f $Name, $ReadyTimeoutSec) -ForegroundColor Red
  return $false
}
$readyProxy  = Wait-Ready ("http://127.0.0.1:" + $ProxyPort + "/health") "proxy"   # la ruta real del proxy (NO /v1/models)
$readyLlama  = if ($SkipLlama) { $true } else { Wait-Ready ("http://127.0.0.1:" + $LlamaPort + "/v1/models") "llama-server" }
if (-not $readyProxy) { exit 1 }
if (-not $readyLlama) { exit 1 }

# --- 3) opencode (en background, logs a archivo) ----------------------------
$ocPure = if ($Pure) { " --pure" } else { "" }
$ocLauncher = Join-Path $LogRoot (".launch-" + $ts + "-opencode.ps1")
Set-Content -Path $ocLauncher -Value (
  "Set-Location `"" + $env:USERPROFILE + "`"`r`n" +
  "opencode --model " + $Model + $ocPure + " --log-level " + $LogLevel + " --prompt `"$(($Prompt).Replace('"','`"'))`""
) -Encoding ascii
$ocProc = Start-Redirected -ScriptPath $ocLauncher -OutFile $ocLog -ErrFile $ocErrLog

# --- Persistir estado (para -Kill sin volver a arrancar) ---------------------
$state = [ordered]@{
  startedAt   = (Get-Date).ToString("s")
  procIds     = @(
    @{ procId = $ocProc.Id;    name = "opencode"  },
    @{ procId = $proxyProc.Id; name = "proxy"     }
  ) + @(
    if ($llamaProc) { @{ procId = $llamaProc.Id; name = "llama.cpp" } }
  )
  logs = @{
    oc        = $ocLog
    ocErr     = $ocErrLog
    llama     = $llamaLog
    llamaErr  = $llamaErrLog
    proxyOut  = $proxyMirror
    proxyErr  = $proxyErr
    proxyApp  = (Join-Path $ProxyDir "logs")
  }
}
$stateFile = Join-Path $LogRoot ("run-" + $ts + ".state.json")
$state | ConvertTo-Json -Depth 4 | Set-Content -Path $stateFile -Encoding ascii

# --- Resumen ---------------------------------------------------------------
Write-Host ""
Write-Host ("[+] opencode  PID: {0}   (stdout: {1})" -f $ocProc.Id, $ocLog) -ForegroundColor Green
Write-Host ("[+] proxy     PID: {0}   (stdout: {1})" -f $proxyProc.Id, $proxyMirror) -ForegroundColor Green
if ($llamaProc) { Write-Host ("[+] llama.cpp PID: {0}   (consola: {1})" -f $llamaProc.Id, $llamaLog) -ForegroundColor Green }
else { Write-Host ("[i] llama.cpp reusado del puerto {0} (sin log de consola de esta pasada)." -f $LlamaPort) -ForegroundColor Yellow }
Write-Host ("[+] state: {0}" -f $stateFile) -ForegroundColor Cyan
Write-Host ""
Write-Host "[i] Para ver los cache hits/misses del modelo:" -ForegroundColor Cyan
Write-Host "    Select-String -Path '$llamaLog' -Pattern 'cached|prompt eval|pp1|pp2'"
Write-Host "[i] Detener todo:  .\scripts\opencode-proxy-test.ps1 -Kill" -ForegroundColor Cyan

if ($Wait) {
  Write-Host "[*] Esperando a que opencode termine..." -ForegroundColor Yellow
  $ocProc.WaitForCompletion()
  Write-Host ("[+] opencode terminó (exit {0})." -f $ocProc.ExitCode) -ForegroundColor Green
}

exit 0
