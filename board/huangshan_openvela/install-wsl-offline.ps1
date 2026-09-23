$ErrorActionPreference='Stop'
$setup='D:\wsl_ubuntu\setup'
$msi="$setup\wsl.2.7.14.0.x64.msi"
$env:TEMP="$setup\temp"
$env:TMP="$setup\temp"
try {
    if((Get-FileHash -LiteralPath $msi).Hash -ne 'db084e536279a59e90a26ec598d8aa8a4dff8309f41d078fd06242953ac1ebcd'){throw 'MSI hash mismatch'}
    $signature=Get-AuthenticodeSignature -LiteralPath $msi
    if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation'){throw 'Microsoft signature validation failed'}
    @{stage='installing';started=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content "$setup\msi-status.json" -Encoding utf8
    $process=Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" -ArgumentList @('/i',$msi,'/qn','/norestart','INSTALLDIR=D:\wsl_ubuntu\WSL','/L*v',"$setup\wsl-msi.log") -Wait -PassThru -WindowStyle Hidden
    @{stage='finished';exitCode=$process.ExitCode;finished=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content "$setup\msi-status.json" -Encoding utf8
} catch {
    @{stage='error';message=$_.Exception.Message;finished=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content "$setup\msi-status.json" -Encoding utf8
    exit 1
}
