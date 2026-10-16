<#
  Formosa Tycoon: abre el juego a internet con tuneles de Cloudflare (sin cuenta, sin abrir puertos).
  Uso (en PowerShell, dentro de la carpeta del proyecto):   .\scripts\tunel.ps1
  Hace todo solo: revisa que la base de datos este prendida, levanta la web, el tiempo real (Reverb), el reloj de partidas y el planificador, abre DOS tuneles
  (uno para la web y otro para Reverb), pone las direcciones en el .env y te muestra el enlace para tus amigos.
  Ctrl+C lo cierra todo y deja el .env como estaba.
#>
param([int]$Puerto = 8000, [int]$PuertoReverb = 8080)

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
Set-Location $raiz

# cloudflared: el que este en el PATH o, si no, scripts\cloudflared.exe (descarga manual, ver mas abajo).
$cf = $null
$cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($cmd) { $cf = $cmd.Source }
elseif (Test-Path (Join-Path $PSScriptRoot 'cloudflared.exe')) { $cf = Join-Path $PSScriptRoot 'cloudflared.exe' }
if (-not $cf) {
    Write-Host 'Falta cloudflared.exe. Descargalo con:' -ForegroundColor Yellow
    Write-Host '  Invoke-WebRequest -Uri https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe -OutFile scripts\cloudflared.exe' -ForegroundColor Yellow
    exit 1
}
if (-not (Test-Path '.env')) { Write-Host 'No encuentro el archivo .env' -ForegroundColor Red; exit 1 }
if (-not (Test-Path 'public\build\manifest.json')) { Write-Host 'Falta compilar el front: corre  npm run build' -ForegroundColor Yellow; exit 1 }

# La base de datos la pone Laragon: si MariaDB esta apagada, el mapa no carga (cada pedido falla). Mejor avisar antes de abrir nada.
function Leer-Env([string]$texto, [string]$clave, [string]$defecto) {
    $m = [regex]::Match($texto, "(?m)^$([regex]::Escape($clave))=(.*)$")
    if ($m.Success) { $v = $m.Groups[1].Value.Trim().Trim('"'); if ($v) { return $v } }
    return $defecto
}
function Base-Responde([string]$servidor, [int]$puerto) {
    $c = New-Object System.Net.Sockets.TcpClient
    try { $r = $c.BeginConnect($servidor, $puerto, $null, $null); return ($r.AsyncWaitHandle.WaitOne(2000) -and $c.Connected) }
    catch { return $false }
    finally { $c.Close() }
}
$envTexto = Get-Content '.env' -Raw
# Si la vez anterior se cerro la ventana sin Ctrl+C, el .env quedo con las direcciones del tunel viejo: se restaura desde la copia
# antes de seguir (si no, esa copia se pisaria con un .env ya modificado y se perderia el original).
if ((Test-Path '.env.antes-del-tunel') -and ($envTexto -match '(?m)^APP_URL=https://[a-z0-9-]+\.trycloudflare\.com')) {
    Write-Host 'El .env quedo de un tunel anterior (no se cerro con Ctrl+C). Lo restauro desde .env.antes-del-tunel.' -ForegroundColor Yellow
    Copy-Item '.env.antes-del-tunel' '.env' -Force
    $envTexto = Get-Content '.env' -Raw
}
$dbHost = Leer-Env $envTexto 'DB_HOST' '127.0.0.1'
$dbPuerto = [int](Leer-Env $envTexto 'DB_PORT' '3306')
if (-not (Base-Responde $dbHost $dbPuerto)) {
    Write-Host "La base de datos no responde en ${dbHost}:${dbPuerto}." -ForegroundColor Red
    Write-Host 'Abri Laragon y toca "Iniciar todo" (tienen que quedar en verde MySQL/MariaDB y, si lo usas, Apache). Despues volve a correr este script.' -ForegroundColor Yellow
    exit 1
}

$envOriginal = Get-Content '.env' -Raw
$copia = '.env.antes-del-tunel'
Set-Content -Path $copia -Value $envOriginal -NoNewline
$procesos = @()
$logs = Join-Path $env:TEMP 'formosa-tunel'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

function Poner-Env([string]$texto, [string]$clave, [string]$valor) {
    $linea = "$clave=$valor"
    if ($texto -match "(?m)^$([regex]::Escape($clave))=.*$") { return ($texto -replace "(?m)^$([regex]::Escape($clave))=.*$", $linea) }
    return ($texto.TrimEnd() + "`r`n" + $linea + "`r`n")
}

function Abrir-Tunel([string]$nombre, [string]$destino) {
    $out = Join-Path $logs "$nombre.out.log"; $err = Join-Path $logs "$nombre.err.log"
    Remove-Item $out, $err -ErrorAction SilentlyContinue
    $p = Start-Process $cf -ArgumentList @('tunnel', '--url', $destino, '--no-autoupdate') -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
    $script:procesos += $p
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        foreach ($f in @($err, $out)) {
            if (Test-Path $f) {
                $m = Select-String -Path $f -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($m) { return $m.Matches[0].Value }
            }
        }
    }
    throw "No pude abrir el tunel de $nombre (mira $err)"
}

try {
    Write-Host 'Abriendo tuneles...' -ForegroundColor Cyan
    $urlWeb = Abrir-Tunel 'web' "http://127.0.0.1:$Puerto"
    $urlWs = Abrir-Tunel 'reverb' "http://127.0.0.1:$PuertoReverb"
    $hostWs = ([uri]$urlWs).Host

    $t = $envOriginal
    $t = Poner-Env $t 'APP_URL' $urlWeb
    $t = Poner-Env $t 'APP_DEBUG' 'false'
    $t = Poner-Env $t 'TRUSTED_PROXIES' '*'
    $t = Poner-Env $t 'SESSION_SECURE_COOKIE' 'true'
    $t = Poner-Env $t 'VITE_REVERB_HOST' "`"$hostWs`""
    $t = Poner-Env $t 'VITE_REVERB_PORT' '443'
    $t = Poner-Env $t 'VITE_REVERB_SCHEME' 'https'
    Set-Content -Path '.env' -Value $t -NoNewline
    & php artisan config:clear | Out-Null

    Write-Host 'Levantando Reverb, la web, el reloj de partidas y el planificador...' -ForegroundColor Cyan
    $procesos += Start-Process php -ArgumentList @('artisan', 'reverb:start', '--host=127.0.0.1', "--port=$PuertoReverb") -WindowStyle Hidden -PassThru
    $procesos += Start-Process php -ArgumentList @('artisan', 'serve', '--host=127.0.0.1', "--port=$Puerto") -WindowStyle Hidden -PassThru
    $procesos += Start-Process php -ArgumentList @('artisan', 'juego:reloj') -WindowStyle Hidden -PassThru
    $procesos += Start-Process php -ArgumentList @('artisan', 'schedule:work') -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 4

    Write-Host ''
    Write-Host '  Listo. Mandales este enlace a tus amigos:' -ForegroundColor Green
    Write-Host "  $urlWeb/mapa" -ForegroundColor White -BackgroundColor DarkGreen
    Write-Host ''
    Write-Host '  Tu PC tiene que quedar prendida y con esta ventana abierta. Ctrl+C para cerrar todo.' -ForegroundColor Gray
    Write-Host '  (El enlace cambia cada vez que corres este script.)' -ForegroundColor Gray
    while ($true) { Start-Sleep -Seconds 5 }
}
finally {
    Write-Host "`nCerrando..." -ForegroundColor Cyan
    foreach ($p in $procesos) { if ($p -and -not $p.HasExited) { & taskkill /PID $p.Id /T /F 2>$null | Out-Null } }
    Set-Content -Path '.env' -Value $envOriginal -NoNewline
    & php artisan config:clear | Out-Null
    Write-Host '.env restaurado.' -ForegroundColor Cyan
}
