param([string]$PortName='COM5')
$ErrorActionPreference='Stop'
$port=[IO.Ports.SerialPort]::new($PortName,1000000,[IO.Ports.Parity]::None,8,[IO.Ports.StopBits]::One)
$port.DtrEnable=$false
$port.RtsEnable=$false
$port.ReadTimeout=500
$result=''
try {
    $port.Open()
    $port.RtsEnable=$true
    Start-Sleep -Milliseconds 150
    $port.RtsEnable=$false
    Start-Sleep -Seconds 4
    $result+=$port.ReadExisting()
    foreach($command in @('uname -a','ls /dev','free','fb')) {
        $port.Write($command+"`r`n")
        Start-Sleep -Seconds 2
        $result+=$port.ReadExisting()
    }
    $wait=[Diagnostics.Stopwatch]::StartNew()
    while($result -notmatch 'FB test finished' -and $wait.Elapsed.TotalSeconds -lt 8) {
        Start-Sleep -Milliseconds 200
        $result+=$port.ReadExisting()
    }
} finally {
    if($port.IsOpen){$port.Close()}
    $port.Dispose()
}
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'logs') | Out-Null
$result | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'logs/last-serial-check.log') -Encoding utf8
Write-Output $result
if($result -notmatch 'NuttShell' -or $result -notmatch 'FB test finished') {
    throw 'Expected NuttShell startup and framebuffer test were not both received.'
}
