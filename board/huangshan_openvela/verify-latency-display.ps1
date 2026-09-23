# Start on the native desktop. Captures are board-rendered, not panel photos.
param([ValidatePattern('^[a-z0-9-]+$')][string]$Prefix='latency')
$ErrorActionPreference='Stop'
$env:PYTHONUTF8='1'
& "$PSScriptRoot/capture-screen.ps1" -CaptureName "$Prefix-tools" -Actions @('tap 114 263')
& "$PSScriptRoot/capture-screen.ps1" -CaptureName "$Prefix-app" -Actions @('tap 195 411','tap 195 342')
& "$PSScriptRoot/capture-screen.ps1" -CaptureName "$Prefix-coach" -Actions @('swipe 300 220 100 220')
& "$PSScriptRoot/capture-screen.ps1" -CaptureName "$Prefix-timeline" -Actions @('swipe 300 220 100 220')
& "$PSScriptRoot/capture-screen.ps1" -CaptureName "$Prefix-swipe-back" -Actions @('swipe 100 220 300 220')
& "$PSScriptRoot/sync-clock.ps1"
& "$PSScriptRoot/capture-screen.ps1" -CaptureName "$Prefix-ready" -Actions @('tap 127 406')
& "$PSScriptRoot/serial-runtime.ps1" -ObserveSeconds 0 -Commands @('free','ps') -LogName "$Prefix-memory.log"
