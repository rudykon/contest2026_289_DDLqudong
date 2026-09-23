param([string]$Python='C:\Users\24470\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe')
$ErrorActionPreference='Stop'
$env:PYTHONUTF8='1'
$env:TEMP='D:\wsl_ubuntu\setup\temp'
$env:TMP=$env:TEMP
$runner=Join-Path $PSScriptRoot 'wsl-command.py'
$name='Ubuntu-24.04'
$location='D:\wsl_ubuntu\Ubuntu-24.04'
$image='D:\wsl_ubuntu\setup\ubuntu-24.04-amd64.wsl'
$registered=Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object DistributionName -eq $name
if($registered) {
    $basePath=$registered.BasePath -replace '^\\\\\?\\',''
    if($basePath.TrimEnd('\') -ne $location){throw "Existing Ubuntu is at $basePath; refusing to change another installation."}
} else {
    if((Get-FileHash -LiteralPath $image).Hash -ne 'bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e'){throw 'Ubuntu image hash mismatch'}
    & $Python $runner --import $name $location $image --version 2
    if($LASTEXITCODE -ne 0){throw 'Ubuntu import failed. Ensure Windows was restarted after enabling WSL features.'}
}
& $Python $runner --distribution $name --user root --exec /bin/sh -c 'cat /etc/os-release; uname -r; df -h /'
if($LASTEXITCODE -ne 0){throw 'Ubuntu could not start.'}
Get-ChildItem -LiteralPath $location -Filter '*.vhdx' | Select-Object FullName,Length
Write-Output 'Ubuntu starts successfully and its virtual disk is on D:. Continue openvela toolchain setup inside this distribution.'
