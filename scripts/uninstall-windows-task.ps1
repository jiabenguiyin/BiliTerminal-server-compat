#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

$TaskName = "BiliTerminalCompatServer"
$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $Task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task: $TaskName"
} else {
    Write-Host "Scheduled task was not found: $TaskName"
}

Get-NetFirewallRule -DisplayName "BiliTerminal Compat Server TCP *" -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule

Write-Host "Removed matching firewall rules."
