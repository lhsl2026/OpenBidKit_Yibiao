param(
  [Parameter(Mandatory=$true)][string]$ConsumerRoot,
  [string]$BaseImage = 'local/preread-agent:standalone',
  [string]$Image = 'local/preread-agent:codex-compat-20260910'
)
$ErrorActionPreference = 'Stop'
$consumerPath = (Resolve-Path -LiteralPath $ConsumerRoot).Path
if (!(Test-Path -LiteralPath (Join-Path $consumerPath 'dist/server/main.js'))) { throw 'Compile the standalone server first.' }
# Dependencies and runtime platform are inherited from the existing Linux image.
# This consumer patch changes only TypeScript; package.json/package-lock.json are unchanged.
$dependencyChanges = & git -C $consumerPath diff HEAD -- package.json package-lock.json
if ($LASTEXITCODE -ne 0 -or $dependencyChanges) { throw 'Dependency changes require the full standalone image build.' }
$baseId = & docker image inspect $BaseImage --format '{{.Id}}'
if ($LASTEXITCODE -ne 0) { throw 'Existing base image unavailable.' }
$contextPath = Join-Path $consumerPath ('tmp/compat-image-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $contextPath -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $consumerPath 'dist') -Destination (Join-Path $contextPath 'dist') -Recurse
@'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY --chown=node:node dist/ /app/dist/
'@ | Set-Content -LiteralPath (Join-Path $contextPath 'Dockerfile') -Encoding utf8
& docker build --build-arg "BASE_IMAGE=$BaseImage" --tag $Image $contextPath
if ($LASTEXITCODE -ne 0) { throw 'Compatibility image build failed.' }
$imageId = & docker image inspect $Image --format '{{.Id}}'
if ($LASTEXITCODE -ne 0) { throw 'Built image unavailable.' }
[pscustomobject]@{ baseImage=$BaseImage; baseImageId=$baseId; image=$Image; imageId=$imageId } | ConvertTo-Json
