<#
  Formosa Tycoon: arranca todo para jugar EN TU PC (sin internet): la web, el tiempo real (Reverb),
  el reloj de partidas (cierra subastas y partidas a tiempo) y el planificador (limpia el chat).
  Uso (en PowerShell, dentro de la carpeta del proyecto):   .\scripts\iniciar.ps1
  Antes: abri Laragon y toca "Iniciar todo" (la base de datos). Ctrl+C cierra todo.
  Para jugar con amigos por internet usa  .\scripts\tunel.ps1  en vez de este.
#>
param([int]$Puerto = 8000, [int]$PuertoReverb = 8080)

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
Set-Location $raiz

if (-not (Test-Path '.env')) { Write-Host 'No encuentro el archivo .env' -ForegroundColor Red; exit 1 }
if (-not (Test-Path 'public\build\manifest.json')) { Write-Host 'Falta compilar el front: corre  npm run build' -ForegroundColor Yellow; exit 1 }

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
$dbHost = Leer-Env $envTexto 'DB_HOST' '127.0.0.1'
$dbPuerto = [int](Leer-Env $envTexto 'DB_PORT' '3306')
if (-not (Base-Responde $dbHost $dbPuerto)) {
    Write-Host "La base de datos no responde en ${dbHost}:${dbPuerto}." -ForegroundColor Red
    Write-Host 'Abri Laragon y toca "Iniciar todo" (tienen que quedar en verde MySQL/MariaDB). Despues volve a correr este script.' -ForegroundColor Yellow
    exit 1
}

# Si quedo un .env de un tunel anterior que no se cerro bien, avisa: apunta a direcciones que ya no existen.
if ($envTexto -match '(?m)^APP_URL=https://[a-z0-9-]+\.trycloudflare\.com') {
    Write-Host 'Ojo: tu .env todavia apunta a un tunel anterior (trycloudflare). Si el mapa no carga bien, restauralo desde .env.antes-del-tunel.' -ForegroundColor Yellow
}

$procesos = @()
try {
    & php artisan config:clear | Out-Null
    Write-Host 'Levantando Reverb, la web, el reloj de partidas y el planificador...' -ForegroundColor Cyan
    $procesos += Start-Process php -ArgumentList @('artisan', 'reverb:start', '--host=127.0.0.1', "--port=$PuertoReverb") -WindowStyle Hidden -PassThru
    $procesos += Start-Process php -ArgumentList @('artisan', 'serve', '--host=127.0.0.1', "--port=$Puerto") -WindowStyle Hidden -PassThru
    $procesos += Start-Process php -ArgumentList @('artisan', 'juego:reloj') -WindowStyle Hidden -PassThru
    $procesos += Start-Process php -ArgumentList @('artisan', 'schedule:work') -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 4

    Write-Host ''
    Write-Host '  Listo. Abri el juego en:' -ForegroundColor Green
    Write-Host "  http://127.0.0.1:$Puerto/mapa" -ForegroundColor White -BackgroundColor DarkGreen
    Write-Host ''
    Write-Host '  Deja esta ventana abierta mientras juegas. Ctrl+C para cerrar todo.' -ForegroundColor Gray
    Start-Process "http://127.0.0.1:$Puerto/mapa"
    while ($true) { Start-Sleep -Seconds 5 }
}
finally {
    Write-Host "`nCerrando..." -ForegroundColor Cyan
    foreach ($p in $procesos) { if ($p -and -not $p.HasExited) { & taskkill /PID $p.Id /T /F 2>$null | Out-Null } }
    Write-Host 'Todo cerrado.' -ForegroundColor Cyan
}
