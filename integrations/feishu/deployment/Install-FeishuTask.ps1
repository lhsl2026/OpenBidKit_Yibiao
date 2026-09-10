[CmdletBinding()]
param([string]$NodePath, [string]$EnvironmentFile, [string]$DataRoot, [switch]$StartDocker)
. (Join-Path $PSScriptRoot 'Process-Feishu.ps1')
$context = Get-FeishuContext -NodePath $NodePath -EnvironmentFile $EnvironmentFile -DataRoot $DataRoot
$taskName = 'OpenBidKitFeishu'
$startPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'Start-Feishu.ps1')).Path
$shellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not $EnvironmentFile) { $EnvironmentFile = Join-Path $context.IntegrationRoot '.env' }
$environmentPath = [IO.Path]::GetFullPath($EnvironmentFile)
foreach ($value in @($startPath, $context.executable, $environmentPath, $context.dataRoot)) {
    if ($value.Contains('"') -or $value.Contains("`r") -or $value.Contains("`n")) { throw 'Unsupported task argument.' }
}
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -NodePath "{1}" -EnvironmentFile "{2}" -DataRoot "{3}"' -f $startPath, $context.executable, $environmentPath, $context.dataRoot
if ($StartDocker) { $arguments += ' -StartDocker' }
$taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$taskUser = $taskIdentity.Name
function Test-CurrentTaskUser([string]$Value) {
    try {
        $sid = if ($Value.StartsWith('S-1-')) { $Value } else { ([Security.Principal.NTAccount]::new($Value)).Translate([Security.Principal.SecurityIdentifier]).Value }
        return $sid -ceq $taskIdentity.User.Value
    } catch { return $false }
}
$existing = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($existing) {
    $matches = $existing.Actions.Count -eq 1 -and $existing.Actions[0].Execute -ieq $shellPath -and $existing.Actions[0].Arguments -ceq $arguments -and $existing.Actions[0].WorkingDirectory -ieq $context.IntegrationRoot
    $matches = $matches -and (Test-CurrentTaskUser $existing.Principal.UserId) -and [int]$existing.Principal.LogonType -eq 3 -and [int]$existing.Principal.RunLevel -eq 0
    $matches = $matches -and $existing.Triggers.Count -eq 1 -and $existing.Triggers[0].CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger'
    if ($matches) { $matches = $existing.Triggers[0].Enabled -and (Test-CurrentTaskUser $existing.Triggers[0].UserId) }
    $matches = $matches -and $existing.Settings.Enabled -and $existing.Settings.Hidden -and [int]$existing.Settings.MultipleInstances -eq 2 -and $existing.Settings.ExecutionTimeLimit -eq 'PT0S' -and $existing.Settings.RestartCount -eq 3 -and $existing.Settings.RestartInterval -eq 'PT1M' -and -not $existing.Settings.DisallowStartIfOnBatteries -and -not $existing.Settings.StopIfGoingOnBatteries
    if (-not $matches) {
        throw 'A different scheduled task already uses this name; it was not changed.'
    }
    Write-Output 'OpenBidKitFeishu is already registered.'
    return
}
$action = New-ScheduledTaskAction -Execute $shellPath -Argument $arguments -WorkingDirectory $context.IntegrationRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $taskUser
$principal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'OpenBidKit Feishu integration supervisor; starts for this user at logon.' | Out-Null
Write-Output 'OpenBidKitFeishu registered. Start with Start-ScheduledTask -TaskName OpenBidKitFeishu -TaskPath \.'
