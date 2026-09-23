param([string]$BuildRoot='D:\wsl_ubuntu\app-work\velamotion_coach')
$ErrorActionPreference='Stop'
$source=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../quickapp/velamotion_coach'))
$cache='D:\wsl_ubuntu\npm-cache'
$env:npm_config_cache=$cache
New-Item -ItemType Directory -Force $BuildRoot | Out-Null
& robocopy $source $BuildRoot /E /XD node_modules artifacts dist /XF '*.pem' /NFL /NDL /NJH /NJS | Out-Null
if($LASTEXITCODE -ge 8){throw 'Copying app sources failed'}
& 'C:\Users\24470\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' (Join-Path $PSScriptRoot 'optimize-watch-styles.py') (Join-Path $BuildRoot 'src/pages/index/index.ux')
if($LASTEXITCODE -ne 0){throw 'Watch style optimization failed'}
$npm=(Get-Command npm.cmd -ErrorAction Stop).Source
if(!(Test-Path (Join-Path $BuildRoot 'node_modules/aiot-toolkit'))) {
    & $npm --prefix $BuildRoot ci --ignore-scripts --no-audit --no-fund
    if($LASTEXITCODE -ne 0){throw 'npm ci failed'}
}
# The original author's release key is deliberately absent. Use the toolkit's
# public development credentials for this local board test, not publication.
$bundled=Join-Path $BuildRoot 'node_modules/@aiot-toolkit/aiotpack/lib/compiler/javascript/vela/utils/signature/pem'
$sign=Join-Path $BuildRoot 'sign/release'
New-Item -ItemType Directory -Force $sign | Out-Null
foreach($name in @('private.pem','certificate.pem')) {
    $target=Join-Path $sign $name
    if(!(Test-Path $target)){Copy-Item -LiteralPath (Join-Path $bundled $name) -Destination $target}
}
$started=[DateTime]::UtcNow
& $npm --prefix $BuildRoot run release
if($LASTEXITCODE -ne 0){throw 'App build failed'}
$rpk=Join-Path $BuildRoot 'dist/com.velamotion.coach.release.1.0.0.rpk'
if(!(Test-Path $rpk) -or (Get-Item $rpk).LastWriteTimeUtc -lt $started) {
    throw 'Toolkit did not produce a new RPK; inspect its build log.'
}
$output=Join-Path $source 'dist/com.velamotion.coach.huangshan-dev.1.0.0.rpk'
Copy-Item -LiteralPath $rpk -Destination $output
Get-FileHash -LiteralPath $output -Algorithm SHA256
