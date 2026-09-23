$ErrorActionPreference='Stop'
$setup='D:\wsl_ubuntu\setup'
$env:TEMP="$setup\temp"
$env:TMP="$setup\temp"
try {
    @{stage='enabling-features';started=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content "$setup\features-status.json" -Encoding utf8
    $result=Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform,Microsoft-Windows-Subsystem-Linux -All -NoRestart -LogPath "$setup\features-dism.log"
    $features=foreach($name in @('VirtualMachinePlatform','Microsoft-Windows-Subsystem-Linux')) {
        $feature=Get-WindowsOptionalFeature -Online -FeatureName $name
        @{name=$name;state=$feature.State.ToString()}
    }
    @{stage='finished';restartNeeded=$result.RestartNeeded;features=@($features);finished=(Get-Date).ToString('o')} | ConvertTo-Json -Depth 4 | Set-Content "$setup\features-status.json" -Encoding utf8
} catch {
    @{stage='error';message=$_.Exception.Message;finished=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content "$setup\features-status.json" -Encoding utf8
    exit 1
}
