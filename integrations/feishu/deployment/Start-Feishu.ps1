[CmdletBinding()]
param([string]$DataRoot, [string]$EnvironmentFile, [string]$NodePath, [switch]$StartDocker)
. (Join-Path $PSScriptRoot 'Process-Feishu.ps1')

# Foreground entry for an existing terminal or a hidden Task Scheduler action.
# The supervisor itself owns identity checks, the instance lock and child shutdown.
$context = Get-FeishuContext -DataRoot $DataRoot -EnvironmentFile $EnvironmentFile -NodePath $NodePath
if ($StartDocker) {
    $dockerDesktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (-not (Test-Path -LiteralPath $dockerDesktop -PathType Leaf)) { throw 'Docker Desktop is not installed at its standard path.' }
    Start-Process -FilePath $dockerDesktop -WindowStyle Hidden | Out-Null
}
$arguments = $context.Arguments + @('run', '--data-root', $context.dataRoot)
& $context.executable @arguments
exit $LASTEXITCODE
