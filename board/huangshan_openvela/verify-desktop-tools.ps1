# Start from the native home screen with no active countdown. Uses COM5 exclusively.
param([ValidateSet('clock','lock','countdown','countdown-pause','stopwatch','app','ready')][string]$Stage)
$ErrorActionPreference='Stop'
$env:PYTHONUTF8='1'
function Actions([string]$Name,[string[]]$Items) {
    $commands=@($Items | ForEach-Object {'echo "'+$_+'" > /data/ui-command'})
    & "$PSScriptRoot/serial-runtime.ps1" -ObserveSeconds 0 -Commands $commands -LogName "tools-final-$Name.log"
}
function Capture([string]$Name) { & "$PSScriptRoot/capture-screen.ps1" -CaptureName "tools-final-$Name" }
switch ($Stage) {
    'clock' {
        Actions 'settings' @('tap 276 263','tap 114 176','tap 114 176','tap 114 176','tap 114 176')
        Capture 'dim'
        Actions 'bright' @('tap 276 176','tap 276 176','tap 276 176','tap 276 176','tap 276 176')
        Capture 'bright'
        Actions 'clock-edit' @('tap 114 176','tap 195 316','tap 195 169','tap 195 169','tap 195 169','tap 195 169','tap 276 246')
        Capture 'clock'
        Actions 'clock-save' @('tap 195 350')
        Capture 'clock-saved'
        & "$PSScriptRoot/sync-clock.ps1"
    }
    'lock' {
        Actions 'lock' @('tap 195 414','tap 195 385','swipe 280 230 110 230')
        Capture 'locked'
        Actions 'unlock' @('swipe 195 385 195 385')
        Capture 'unlocked'
    }
    'countdown' {
        Actions 'countdown-ready' @('swipe 290 215 100 215','tap 195 213','tap 114 254')
        Capture 'countdown'
        Actions 'countdown-background' @('tap 114 334','tap 195 411','tap 195 411','tap 195 414')
        & "$PSScriptRoot/serial-runtime.ps1" -ObserveSeconds 8 -Commands @() -LogName tools-final-countdown-wait.log
        Capture 'alert'
        Actions 'alert-ack' @('tap 195 333')
        Capture 'alert-return-lock'
        Actions 'alert-unlock' @('swipe 195 385 195 385')
    }
    'stopwatch' {
        Actions 'stopwatch-start' @('tap 114 263','tap 195 125','tap 114 313')
        Capture 'stopwatch'
        Actions 'stopwatch-background' @('tap 195 411','tap 195 411','tap 114 263','tap 195 125','tap 114 313')
        Capture 'stopwatch-paused'
        & "$PSScriptRoot/serial-runtime.ps1" -ObserveSeconds 3 -Commands @() -LogName tools-final-stopwatch-wait.log
        Capture 'stopwatch-still-paused'
        Actions 'stopwatch-reset' @('tap 276 313')
        Capture 'stopwatch-zero'
        Actions 'stopwatch-home' @('swipe 100 215 290 215','tap 195 411')
    }
    'countdown-pause' {
        Actions 'countdown-pause' @('tap 114 263','tap 195 213','tap 276 254','tap 114 334','tap 114 334')
        Capture 'countdown-paused'
        Actions 'countdown-revisit' @('tap 195 411','tap 195 213')
        Capture 'countdown-still-paused'
        Actions 'countdown-reset' @('tap 276 334','tap 114 254','tap 195 411','tap 195 411')
    }
    'app' {
        & "$PSScriptRoot/capture-screen.ps1" -CaptureName tools-final-app -Actions @('tap 195 342')
        & "$PSScriptRoot/capture-screen.ps1" -CaptureName tools-final-training -Actions @('tap 195 333','tap 127 406')
        # Countdown runs for 10 seconds on top of the warm, still-running app.
        Actions 'app-countdown' @('tap 114 263','tap 195 213','tap 114 334','tap 195 411','tap 195 411','tap 195 342')
        & "$PSScriptRoot/serial-runtime.ps1" -ObserveSeconds 7 -Commands @() -LogName tools-final-app-alert-wait.log
        Capture 'app-alert'
        & "$PSScriptRoot/capture-screen.ps1" -CaptureName tools-final-app-resumed -Actions @('tap 195 333')
        & "$PSScriptRoot/capture-screen.ps1" -CaptureName tools-final-app-stopped -Actions @('tap 195 333')
        Actions 'app-home' @('tap 127 406')
    }
    'ready' {
        Actions 'about' @('tap 114 263','tap 195 301')
        Capture 'about'
        Actions 'ready' @('tap 195 411','tap 195 411')
        & "$PSScriptRoot/sync-clock.ps1"
        Capture 'ready'
        & "$PSScriptRoot/serial-runtime.ps1" -ObserveSeconds 0 -Commands @('free','ps') -LogName tools-final-memory.log
    }
}
