param([ValidatePattern('^[a-z0-9-]+$')][string]$Name='perf-test',
    [ValidateSet('keep','full','partial')][string]$RenderMode='keep',
    [switch]$Reset, [switch]$Trace, [switch]$NativeOnly, [switch]$CpuProfile, [switch]$FullXipVerify, [switch]$StopOnCoach, [switch]$WaitFinalize,
    [ValidateSet('keep','single','dual','quad')][string]$XipMode='keep',
    [ValidateSet('keep','on','off')][string]$GpuMode='keep',
    [ValidateSet('keep','on','off')][string]$GpuMaskMode='keep')
$ErrorActionPreference='Stop'
$port=[IO.Ports.SerialPort]::new('COM5',1000000,[IO.Ports.Parity]::None,8,[IO.Ports.StopBits]::One)
$port.DtrEnable=$false
$port.RtsEnable=$false
$port.ReadBufferSize=262144
$port.Encoding=[Text.Encoding]::UTF8
$log=[Text.StringBuilder]::new()
$samples=[Collections.Generic.List[object]]::new()
function Receive([int]$Milliseconds) {
    $result=[Text.StringBuilder]::new()
    $timer=[Diagnostics.Stopwatch]::StartNew()
    while($timer.ElapsedMilliseconds -lt $Milliseconds) {
        [void]$result.Append($port.ReadExisting())
        Start-Sleep -Milliseconds 20
    }
    [void]$log.Append($result)
    return $result.ToString()
}
function Command([string]$Action,[string]$Expected='',[string]$Label='') {
    if($Expected -eq 'input_to_refresh_ms='){$Expected='input_to_refresh_ms=\d+ from=\d+ to=\d+\r?\n'}
    $port.Write(('echo "'+$Action+'" > /data/ui-command')+"`r`n")
    $response=''
    $timer=[Diagnostics.Stopwatch]::StartNew()
    do {
        $response += Receive 100
        if(!$Expected -or $response -match $Expected){break}
    } while($timer.ElapsedMilliseconds -lt 20000)
    if($Expected -and $response -notmatch $Expected){throw "Timeout: $Action`n$response"}
    foreach($m in [regex]::Matches($response,'input_to_refresh_ms=(\d+) from=(\d+) to=(\d+)')) {
        $row=[pscustomobject]@{label=$Label;ms=[int]$m.Groups[1].Value;before=[int]$m.Groups[2].Value;after=[int]$m.Groups[3].Value}
        $samples.Add($row)
        Write-Output ($row | ConvertTo-Json -Compress)
    }
    [void](Receive 800)
}
try {
    $port.Open()
    if($Reset) {
        $port.RtsEnable=$true
        Start-Sleep -Milliseconds 150
        $port.RtsEnable=$false
        [void](Receive 8000)
    } else { [void](Receive 200) }
    Command $(if($Trace){'perf trace'}else{'perf on'}) 'VMC_PERF enabled'
    if($GpuMode -ne 'keep'){Command "gpu $GpuMode" 'VMC_EPIC enabled='}
    if($GpuMaskMode -ne 'keep'){Command "gpu mask $GpuMaskMode" 'VMC_EPIC enabled='}
    if($GpuMode -ne 'keep'){Command 'gpu reset' 'VMC_EPIC enabled='}
    if($XipMode -ne 'keep'){Command "xip $XipMode" 'VMC_XIP mode=\d ok=1'}
    if($FullXipVerify){Command 'xip verify' 'VMC_XIP full_bytes=16777216 ok=1'}
    if($RenderMode -ne 'keep'){Command "render $RenderMode" "VMC_STAGE render_mode=$RenderMode"}
    if($NativeOnly) {
        for($i=0;$i -lt 3;$i++) {
            Command 'tap 114 263' 'input_to_refresh_ms=' 'native-tools'
            Command 'tap 195 125' 'input_to_refresh_ms=' 'native-stopwatch'
            Command 'tap 195 411' 'input_to_refresh_ms=' 'native-tools-back'
            Command 'tap 195 411' 'input_to_refresh_ms=' 'native-home'
            Command 'tap 276 263' 'input_to_refresh_ms=' 'native-settings'
            Command 'tap 195 411' 'input_to_refresh_ms=' 'native-home'
        }
    } else {
    Command 'tap 195 342' 'input_to_refresh_ms=' 'launch'
    if($CpuProfile){Command 'profile' 'VMC_CPU started'}
    for($i=0;$i -lt 8;$i++){Command 'tap 263 406' 'input_to_refresh_ms=' 'idle-next'}
    Command 'tap 195 333' 'input_to_refresh_ms=' 'start'
    Write-Output 'Training warmup...'
    [void](Receive 12000)
    if($CpuProfile){Command 'profile' 'VMC_CPU started'}
    for($i=0;$i -lt 8;$i++){Command 'tap 263 406' 'input_to_refresh_ms=' 'training-next'}
    Command 'tap 127 406' 'input_to_refresh_ms=' 'home'
    [void](Receive 10000)
    Command 'tap 195 342' 'input_to_refresh_ms=' 'resume'
    if($StopOnCoach){Command 'tap 263 406' 'input_to_refresh_ms=' 'before-global-stop'}
    Command 'tap 195 333' 'input_to_refresh_ms=' 'stop'
    if($WaitFinalize) {
        $finishWait=[Diagnostics.Stopwatch]::StartNew()
        while($log.ToString() -notmatch 'VMC_SESSION_FINALIZED elapsed_ms=' -and $finishWait.ElapsedMilliseconds -lt 20000) {
            [void](Receive 100)
        }
        if($log.ToString() -notmatch 'VMC_SESSION_FINALIZED elapsed_ms='){throw 'Session stopped but finalization did not complete'}
        if($log.ToString() -match 'VMC_SESSION_FINALIZE_ERROR'){throw 'Session finalization failed'}
    }
    Command 'perf stats' 'VMC_PERF refresh_count='
    Command 'tap 127 406' 'input_to_refresh_ms=' 'home-idle'
    }
    Command 'perf stats' 'VMC_PERF refresh_count='
    Command 'perf off'
    if($GpuMode -ne 'keep'){Command 'gpu stats' 'VMC_EPIC enabled='}
} finally {
    if($port.IsOpen){$port.Close()}
    $port.Dispose()
    $log.ToString() | Set-Content -Encoding utf8 (Join-Path $PSScriptRoot "logs/$Name.log")
    $samples.ToArray() | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $PSScriptRoot "validation/$Name.json")
}
