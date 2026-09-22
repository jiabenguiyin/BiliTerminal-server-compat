#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

$Root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$ConfigPath = Join-Path $Root "data\config.json"
$TaskName = "BiliTerminalCompatServer"

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Config file not found: $ConfigPath"
}

$Node = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $Node) {
    throw "node.exe was not found. Install Node.js 18+ first: https://nodejs.org/"
}

$Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$Port = if ($env:PORT) { [int]$env:PORT } else { [int]$Config.port }
if ($Port -le 0) { $Port = 3000 }

$FirewallName = "BiliTerminal Compat Server TCP $Port"
$ExistingRule = Get-NetFirewallRule -DisplayName $FirewallName -ErrorAction SilentlyContinue
if ($null -eq $ExistingRule) {
    New-NetFirewallRule `
        -DisplayName $FirewallName `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort $Port | Out-Null
}

$Action = New-ScheduledTaskAction `
    -Execute $Node.Source `
    -Argument "`"$Root\server.js`"" `
    -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DisallowStartIfOnBatteries:$false `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2

Write-Host "Installed and started $TaskName"
Write-Host "Listening URL should be: http://127.0.0.1:$Port"
Write-Host "For public access, put Caddy or another reverse proxy in front of this service."
Write-Host "Test locally: curl http://127.0.0.1:$Port/healthz"
