param([string]$PortName='COM5',[string]$SfTool='')
$ErrorActionPreference='Stop'
if(!$SfTool){$SfTool=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../board-test/tools/sftool.exe'))}
$manifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'quickapp-firmware-manifest.json') -Raw | ConvertFrom-Json
$firmware=Join-Path $PSScriptRoot ('firmware/'+$manifest.name)
if($manifest.bytes -gt 0x990000){throw 'Firmware overlaps the board MTD partition'}
if((Get-Item -LiteralPath $firmware).Length -ne $manifest.bytes){throw 'Firmware size mismatch'}
if((Get-FileHash -LiteralPath $firmware -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.sha256){throw 'Firmware hash mismatch'}
& $SfTool -c SF32LB52 -p $PortName -b 1000000 write_flash --verify "${firmware}@$($manifest.address)"
if($LASTEXITCODE -ne 0){throw "sftool failed: $LASTEXITCODE"}
& (Join-Path $PSScriptRoot 'serial-runtime.ps1') -PortName $PortName -Reset -ObserveSeconds 30
& (Join-Path $PSScriptRoot 'sync-clock.ps1') -PortName $PortName
