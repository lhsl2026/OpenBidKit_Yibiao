[CmdletBinding()]
param([string]$DataRoot, [string]$EnvironmentFile, [string]$NodePath)
. (Join-Path $PSScriptRoot 'Process-Feishu.ps1')

$context = Get-FeishuContext -DataRoot $DataRoot -EnvironmentFile $EnvironmentFile -NodePath $NodePath
$state = Read-FeishuState $context
if (-not $state) { Write-Output 'No recorded Feishu supervisor; no process was stopped.'; return }
$supervisorVerified = Test-FeishuProcess $context $state.pid $state.birth $context.supervisorPath
if ($supervisorVerified) {
    $status = Invoke-FeishuControl $context 'status'
    if ($status.pid -ne $state.pid -or $status.instance -cne $state.instance) { throw 'Supervisor identity changed; no process was stopped.' }
    if ($status.childPid -and -not (Test-FeishuProcess $context $status.childPid $status.childBirth $context.mainPath)) { throw 'Child identity could not be verified; no process was stopped.' }
    Invoke-FeishuControl $context 'stop' | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(35)
    while ((Test-FeishuProcess $context $state.pid $state.birth $context.supervisorPath) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 300 }
    if (Test-FeishuProcess $context $state.pid $state.birth $context.supervisorPath) { throw 'Supervisor has not stopped. No unrelated PID was killed; inspect its logs.' }
} else {
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$($state.pid)"
    if ($existing) { throw 'Recorded supervisor PID belongs to another process; no process was stopped.' }
}
# Cleanup holds the same kernel lock and rechecks the recorded process birth before touching an orphan.
Invoke-FeishuControl $context 'cleanup' | Out-Null
Write-Output 'Feishu supervisor and its recorded main process are stopped.'
