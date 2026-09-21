[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][PSCredential]$Credential,
    [string]$NodePath,
    [string]$EnvironmentFile,
    [string]$DataRoot,
    [switch]$StartDocker,
    [string]$PowerShellPath
)
. (Join-Path $PSScriptRoot 'Process-Feishu.ps1')
$context = Get-FeishuContext -NodePath $NodePath -EnvironmentFile $EnvironmentFile -DataRoot $DataRoot
$taskName = 'OpenBidKitFeishu'
$startPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'Start-Feishu.ps1')).Path
if (-not $PowerShellPath) { $PowerShellPath = (Get-Process -Id $PID -ErrorAction Stop).Path }
$shellPath = (Resolve-Path -LiteralPath $PowerShellPath -ErrorAction Stop).ProviderPath
if ([IO.Path]::GetFileName($shellPath) -notin @('powershell.exe', 'pwsh.exe')) { throw 'PowerShellPath must name powershell.exe or pwsh.exe.' }
if (-not $EnvironmentFile) { $EnvironmentFile = Join-Path $context.IntegrationRoot '.env' }
$environmentPath = [IO.Path]::GetFullPath($EnvironmentFile)
foreach ($value in @($shellPath, $startPath, $context.executable, $environmentPath, $context.dataRoot)) {
    if ($value.Contains('"') -or $value.Contains("`r") -or $value.Contains("`n")) { throw 'Unsupported task argument.' }
}

$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
try { $credentialSid = ([Security.Principal.NTAccount]::new($Credential.UserName)).Translate([Security.Principal.SecurityIdentifier]).Value }
catch { throw 'Credential must identify the current Windows user so existing Codex and Lark authorizations remain available.' }
if ($credentialSid -cne $currentIdentity.User.Value) { throw 'Credential must identify the current Windows user so existing Codex and Lark authorizations remain available.' }

$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -NodePath "{1}" -EnvironmentFile "{2}" -DataRoot "{3}"' -f $startPath, $context.executable, $environmentPath, $context.dataRoot
if ($StartDocker) { $arguments += ' -StartDocker' }
$existing = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($existing) {
    $owned = $existing.Actions.Count -eq 1 -and $existing.Actions[0].Execute -ieq $shellPath -and $existing.Actions[0].WorkingDirectory -ieq $context.IntegrationRoot
    $owned = $owned -and $existing.Actions[0].Arguments -match [regex]::Escape($startPath) -and $existing.Actions[0].Arguments -match [regex]::Escape($context.executable)
    if (-not $owned) { throw 'A different scheduled task already uses this name; it was not changed.' }
}

$action = New-ScheduledTaskAction -Execute $shellPath -Argument $arguments -WorkingDirectory $context.IntegrationRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
$passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Credential.Password)
try {
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)
    Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action -Trigger $trigger -Settings $settings -User $Credential.UserName -Password $plainPassword -RunLevel Limited -Force -Description 'OpenBidKit Feishu integration supervisor; starts at boot under the authorized current user.' | Out-Null
} finally {
    $plainPassword = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr)
}
$installed = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction Stop
if ([string]$installed.Principal.LogonType -ne 'Password' -or -not ($installed.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' })) {
    throw 'Unattended task verification failed.'
}
Start-ScheduledTask -TaskName $taskName -TaskPath '\'
Write-Output 'OpenBidKitFeishu registered for startup and started. Run production-check.cjs before cutover.'
