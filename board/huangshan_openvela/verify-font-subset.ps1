# Run from the native desktop after reboot; COM5 is owned exclusively per step.
param([ValidateSet('native','app','ready')][string]$Stage)
$ErrorActionPreference='Stop'
$env:PYTHONUTF8='1'
function Actions([string]$Name,[string[]]$Items) {
    $commands=@($Items | ForEach-Object {'echo "'+$_+'" > /data/ui-command'})
    & "$PSScriptRoot/serial-runtime.ps1" -ObserveSeconds 0 -Commands $commands -LogName "font-subset-$Name.log"
}
function Capture([string]$Name) { & "$PSScriptRoot/capture-screen.ps1" -CaptureName "font-subset-$Name" }
switch ($Stage) {
    'native' {
        Capture 'home'
        Actions 'tools' @('tap 114 263')
        Capture 'tools'
        Actions 'about' @('tap 195 301')
        Capture 'about'
        Actions 'stopwatch' @('tap 195 411','tap 195 125')
        Capture 'stopwatch'
        Actions 'countdown' @('tap 195 411','tap 195 213')
        Capture 'countdown'
        Actions 'settings' @('tap 195 411','tap 195 411','tap 276 263')
        Capture 'settings'
        Actions 'clock' @('tap 195 316')
        Capture 'clock'
        Actions 'native-home' @('tap 195 411','tap 195 411')
    }
    'app' {
        & "$PSScriptRoot/capture-screen.ps1" -CaptureName font-subset-app -Actions @('tap 195 342')
        & "$PSScriptRoot/capture-screen.ps1" -CaptureName font-subset-coach -Actions @('tap 263 406')
        & "$PSScriptRoot/capture-screen.ps1" -CaptureName font-subset-timeline -Actions @('tap 263 406')
        & "$PSScriptRoot/capture-screen.ps1" -CaptureName font-subset-sync -Actions @('tap 263 406')
        & "$PSScriptRoot/capture-screen.ps1" -CaptureName font-subset-training -Actions @('tap 263 406','tap 195 333')
        & "$PSScriptRoot/capture-screen.ps1" -CaptureName font-subset-stopped -Actions @('tap 195 333')
        Actions 'app-home' @('tap 127 406')
    }
    'ready' {
        & "$PSScriptRoot/sync-clock.ps1"
        Capture 'ready'
        & "$PSScriptRoot/serial-runtime.ps1" -ObserveSeconds 0 -Commands @('free','ps','ls /etc/data/app') -LogName font-subset-memory.log
    }
}
