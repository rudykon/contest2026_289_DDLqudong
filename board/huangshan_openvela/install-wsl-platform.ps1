$ErrorActionPreference='Stop'
$setup='D:\wsl_ubuntu\setup'
New-Item -ItemType Directory -Force -Path "$setup\temp" | Out-Null
$env:TEMP="$setup\temp"
$env:TMP="$setup\temp"
$status=Join-Path $setup 'platform-status.json'
try {
    if(-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))) {throw 'Administrator token was not granted.'}
    @{stage='installing-wsl-platform';started=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $status -Encoding utf8
    & "$env:SystemRoot\System32\wsl.exe" --install --no-distribution --web-download *> "$setup\platform-install.log"
    $code=$LASTEXITCODE
    $features=foreach($feature in @('Microsoft-Windows-Subsystem-Linux','VirtualMachinePlatform')) {
        $item=Get-WindowsOptionalFeature -Online -FeatureName $feature
        @{name=$feature;state=$item.State.ToString()}
    }
    @{stage='finished';exitCode=$code;features=@($features);finished=(Get-Date).ToString('o')} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $status -Encoding utf8
} catch {
    @{stage='error';message=$_.Exception.Message;finished=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $status -Encoding utf8
    exit 1
}
