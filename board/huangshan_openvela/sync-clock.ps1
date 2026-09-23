param([string]$PortName='COM5')
$ErrorActionPreference='Stop'
$stamp=[DateTime]::UtcNow.ToString('MMM dd HH:mm:ss yyyy',[Globalization.CultureInfo]::InvariantCulture)
$command='date -u -s "'+$stamp+'"'
& (Join-Path $PSScriptRoot 'serial-runtime.ps1') -PortName $PortName -ObserveSeconds 0 -Commands @($command,'date -u') -LogName desktop-clock.log
