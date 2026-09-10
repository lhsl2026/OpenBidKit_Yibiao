Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-FeishuContext {
    param([string]$DataRoot, [string]$EnvironmentFile, [string]$NodePath)
    $integrationRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
    if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
    $nodeExecutable = (Resolve-Path -LiteralPath $NodePath).Path
    if (-not $EnvironmentFile) { $EnvironmentFile = Join-Path $integrationRoot '.env' }
    $environmentPath = [IO.Path]::GetFullPath($EnvironmentFile)
    $supervisorPath = Join-Path $integrationRoot 'supervisor.cjs'
    $arguments = @("--env-file-if-exists=$environmentPath", $supervisorPath)
    $describeArguments = $arguments + @('describe')
    if ($DataRoot) { $describeArguments += @('--data-root', [IO.Path]::GetFullPath($DataRoot)) }
    $description = & $nodeExecutable @describeArguments
    if ($LASTEXITCODE -ne 0) { throw 'Unable to resolve Feishu supervisor configuration.' }
    $context = $description | ConvertFrom-Json
    if ($context.executable -ine $nodeExecutable -or $context.supervisorPath -ine $supervisorPath) { throw 'Unexpected supervisor installation.' }
    $context | Add-Member -NotePropertyName Arguments -NotePropertyValue $arguments
    $context | Add-Member -NotePropertyName IntegrationRoot -NotePropertyValue $integrationRoot
    return $context
}

function Test-FeishuProcess {
    param($Context, [int]$ProcessId, [string]$Birth, [string]$EntryPath)
    if ($ProcessId -le 0 -or -not $Birth) { return $false }
    $info = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
    if (-not $info -or $info.ExecutablePath -ine $Context.executable) { return $false }
    if ($info.CreationDate.ToUniversalTime().ToString('o') -cne $Birth) { return $false }
    $exe = [regex]::Escape($Context.executable)
    $entry = [regex]::Escape($EntryPath)
    $pattern = '^\s*(?:"' + $exe + '"|' + $exe + ')(?:\s+(?:"--env-file-if-exists=[^"]*"|--env-file-if-exists=\S+))?\s+(?:"' + $entry + '"|' + $entry + ')(?=\s|$)'
    return $info.CommandLine -match $pattern
}

function Read-FeishuState {
    param($Context)
    if (-not (Test-Path -LiteralPath $Context.pidFile -PathType Leaf)) { return $null }
    $state = Get-Content -LiteralPath $Context.pidFile -Raw | ConvertFrom-Json
    if ($state.dataRoot -ine $Context.dataRoot -or $state.supervisorPath -ine $Context.supervisorPath -or $state.childPath -ine $Context.mainPath -or $state.executable -ine $Context.executable) {
        throw 'PID metadata does not belong to this installation; no process was stopped.'
    }
    return $state
}

function Invoke-FeishuControl {
    param($Context, [string]$Command)
    $arguments = $Context.Arguments + @($Command, '--data-root', $Context.dataRoot)
    $result = & $Context.executable @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Supervisor control request failed.' }
    return $result | ConvertFrom-Json
}
