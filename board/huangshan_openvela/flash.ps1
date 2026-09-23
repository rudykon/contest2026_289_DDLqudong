param([string]$PortName='COM5',[string]$SfTool='')
$ErrorActionPreference='Stop'
if(!$SfTool){$SfTool=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../board-test/tools/sftool.exe'))}
$firmware=Join-Path $PSScriptRoot 'firmware/nuttx-bringup.bin'
$manifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'firmware-manifest.json') -Raw | ConvertFrom-Json
if((Get-FileHash -LiteralPath $firmware -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sha256){throw 'Firmware hash mismatch'}
& $SfTool -c SF32LB52 -p $PortName -b 1000000 write_flash --verify "${firmware}@0x12010000"
if($LASTEXITCODE -ne 0){throw "sftool failed: $LASTEXITCODE"}
& (Join-Path $PSScriptRoot 'serial-check.ps1') -PortName $PortName
