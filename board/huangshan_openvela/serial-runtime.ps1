param(
    [string]$PortName='COM5',
    [switch]$Reset,
    [int]$ObserveSeconds=12,
    [int]$AfterCommandMilliseconds=1500,
    [string[]]$Commands=@('ps','free'),
    [string]$LogName='quickapp-app-boot.log'
)
$ErrorActionPreference='Stop'
$port=[IO.Ports.SerialPort]::new($PortName,1000000,[IO.Ports.Parity]::None,8,[IO.Ports.StopBits]::One)
$port.DtrEnable=$false
$port.RtsEnable=$false
$port.ReadBufferSize=262144
$port.Encoding=[Text.Encoding]::UTF8
$result=[Text.StringBuilder]::new()
function Receive-For([int]$Milliseconds) {
    $timer=[Diagnostics.Stopwatch]::StartNew()
    while($timer.ElapsedMilliseconds -lt $Milliseconds) {
        [void]$result.Append($port.ReadExisting())
        Start-Sleep -Milliseconds 80
    }
    [void]$result.Append($port.ReadExisting())
}
try {
    $port.Open()
    if($Reset) {
        $port.RtsEnable=$true
        Start-Sleep -Milliseconds 150
        $port.RtsEnable=$false
    }
    Receive-For ($ObserveSeconds*1000)
    foreach($command in $Commands) {
        if($command.Length -ge 64){throw 'NSH command exceeds board line limit'}
        $port.Write($command+"`r`n")
        Receive-For $AfterCommandMilliseconds
    }
} finally {
    if($port.IsOpen){$port.Close()}
    $port.Dispose()
}
$result.ToString() | Set-Content -LiteralPath (Join-Path $PSScriptRoot ('logs/'+$LogName)) -Encoding utf8
Write-Output $result.ToString()
