# Same firmware, alternating GPU state, fresh boot for each run.
$ErrorActionPreference='Stop'
$runs = @(
    @{Name='epic-final-native-off'; GpuMode='off'; NativeOnly=$true},
    @{Name='epic-final-native-on'; GpuMode='on'; NativeOnly=$true},
    @{Name='epic-final-app-off'; GpuMode='off'},
    @{Name='epic-final-app-on'; GpuMode='on'},
    @{Name='epic-final-app-on2'; GpuMode='on'},
    @{Name='epic-final-app-off2'; GpuMode='off'}
)
foreach($run in $runs) {
    Write-Output ("Running " + $run.Name)
    & "$PSScriptRoot/benchmark-ui.ps1" -Reset @run
    $log = Get-Content -Raw -LiteralPath "$PSScriptRoot/logs/$($run.Name).log"
    if($log -notmatch 'VMC_EPIC selftest=1 cases=9' -or $log -match 'Assertion failed|Hard Fault|mismatch') {
        throw "EPIC boot validation failed: $($run.Name)"
    }
    $stats = [regex]::Matches($log, 'VMC_EPIC enabled=\d verified=\d[^\r\n]+')
    $last = $stats[$stats.Count-1].Value
    if($last -notmatch 'verified=1' -or $last -notmatch 'faults=0(?: |$)') {throw "EPIC runtime error: $last"}
    if($run.GpuMode -eq 'on' -and $last -notmatch 'enabled=1.*fills=[1-9]') {throw "EPIC not used: $last"}
    Write-Output $last
}
