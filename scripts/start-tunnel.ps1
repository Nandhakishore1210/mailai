<#
    Starts a Cloudflare quick tunnel for the local backend and prints the exact
    endpoint to paste into the Gmail Pub/Sub push subscription.

    A quick tunnel gets a NEW hostname every run, so whenever you restart it you
    must update the subscription endpoint or Gmail push silently stops working.
    This script does the fiddly parts: finds cloudflared, waits for the URL, and
    reads GMAIL_PUSH_TOKEN out of backend/.env so the URL is ready to paste.

    Usage:   powershell -ExecutionPolicy Bypass -File scripts/start-tunnel.ps1
    Stop:    Ctrl+C (the tunnel dies with this window)
#>

param([int]$Port = 8000)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root "backend\.env"

# --- locate cloudflared -------------------------------------------------------
$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) {
    foreach ($p in @("$env:ProgramFiles\cloudflared\cloudflared.exe",
                     "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe")) {
        if (Test-Path $p) { $cf = $p; break }
    }
}
if (-not $cf) {
    Write-Host "cloudflared not found. Install it with:" -ForegroundColor Red
    Write-Host "    winget install --id Cloudflare.cloudflared"
    exit 1
}

# --- read the push token ------------------------------------------------------
$token = $null
if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern '^GMAIL_PUSH_TOKEN=(.+)$' | Select-Object -First 1
    if ($line) { $token = $line.Matches[0].Groups[1].Value.Trim() }
}
if (-not $token) {
    Write-Host "No GMAIL_PUSH_TOKEN in backend/.env - the webhook will be unprotected." -ForegroundColor Yellow
}

# --- start the tunnel ---------------------------------------------------------
$log = Join-Path $env:TEMP "mailai-tunnel.log"
if (Test-Path $log) { Remove-Item $log -Force }

Write-Host "Starting tunnel to http://localhost:$Port ..." -ForegroundColor Cyan
$proc = Start-Process -FilePath $cf `
    -ArgumentList @("tunnel", "--url", "http://localhost:$Port", "--no-autoupdate") `
    -RedirectStandardError $log -RedirectStandardOutput "$log.out" `
    -NoNewWindow -PassThru

$url = $null
foreach ($i in 1..30) {
    Start-Sleep -Seconds 2
    if (Test-Path $log) {
        $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' |
             Select-Object -First 1
        if ($m) { $url = $m.Matches[0].Value; break }
    }
}

if (-not $url) {
    Write-Host "Tunnel did not report a URL. See $log" -ForegroundColor Red
    exit 1
}

$endpoint = if ($token) { "$url/webhook/gmail?token=$token" } else { "$url/webhook/gmail" }

Write-Host ""
Write-Host "Tunnel is up: $url" -ForegroundColor Green
Write-Host ""
Write-Host "Paste this as the Pub/Sub push endpoint:" -ForegroundColor Yellow
Write-Host "  $endpoint"
Write-Host ""
Write-Host "Console > Pub/Sub > Subscriptions > gmail-push-web > Edit > Endpoint URL"
Write-Host ""
Write-Host "Check it worked with:  GET /mail/sync/status  (seconds_since_last_push"
Write-Host "should stop being null once a mailbox change occurs)."
Write-Host ""
Write-Host "Leave this window open. Closing it kills the tunnel." -ForegroundColor Cyan

try { Wait-Process -Id $proc.Id } finally {
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    Write-Host "Tunnel stopped. Gmail push is now dead until you restart it." -ForegroundColor Yellow
}
