param(
    [ValidatePattern('^[a-z0-9-]+$')][string]$CaptureName='home',
    [string[]]$Actions=@(),
    [string]$PortName='COM5'
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
        Start-Sleep -Milliseconds 40
    }
    [void]$result.Append($port.ReadExisting())
}
function Receive-Until([string]$Expected,[int]$From) {
    $deadline=[Diagnostics.Stopwatch]::StartNew()
    do {
        Receive-For 100
        if($result.ToString($From,$result.Length-$From).Contains($Expected)){return}
    } while($deadline.ElapsedMilliseconds -lt 20000)
    throw "Board did not acknowledge: $Expected"
}
try {
    $port.Open()
    Receive-For 100
    foreach($action in $Actions) {
        $command='echo "'+$action+'" > /data/ui-command'
        if($command.Length -ge 64){throw 'NSH command exceeds board line limit'}
        $from=$result.Length
        $port.Write($command+"`r`n")
        if($action -match '^tap (\d+) (\d+)$') {
            Receive-Until "VMC_PROBE tap complete x=$($Matches[1]) y=$($Matches[2])" $from
        } elseif($action -match '^swipe \d+ \d+ \d+ \d+$') {
            Receive-Until 'VMC_PROBE swipe complete' $from
        }
        # Page creation and font layout may lag behind input acknowledgement
        # while inference is active. Capture the settled page, not that midpoint.
        Receive-For 5000
    }
    $from=$result.Length
    $port.Write("echo snapshot > /data/ui-command`r`n")
    Receive-Until 'VMC_PROBE snapshot ok=1' $from
    Receive-For 500
    $port.Write("hexdump /data/ui-frame.z`r`n")
    Receive-For 10000
} finally {
    if($port.IsOpen){$port.Close()}
    $port.Dispose()
    # Preserve partial diagnostics even when an action times out.
    $result.ToString() | Set-Content -LiteralPath (Join-Path $PSScriptRoot ('logs/'+$CaptureName+'-hexdump.log')) -Encoding utf8
}
$log=Join-Path $PSScriptRoot ('logs/'+$CaptureName+'-hexdump.log')
$result.ToString() | Set-Content -LiteralPath $log -Encoding utf8
$image=Join-Path $PSScriptRoot ('validation/'+$CaptureName+'.png')
& 'C:\Users\24470\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' (Join-Path $PSScriptRoot 'decode-frame.py') $log $image
if($LASTEXITCODE -ne 0){throw 'Board snapshot decode/checksum failed'}
$result.ToString().Split("`n") | Where-Object {$_ -match 'VMC_|failed|error|OutOfMemory'}
