param([string]$WorkRoot='C:\Users\24470\.codex\visualizations\2026\09\20\01a0bdd9-97b8-7931-8986-190cb9fdc268\openvela-work')
$ErrorActionPreference='Stop'
$WorkRoot=[IO.Path]::GetFullPath($WorkRoot)
if(!(Test-Path -LiteralPath "$WorkRoot\src\nuttx\CMakeLists.txt")){throw 'Prepared openvela source tree is missing.'}
if(!(Test-Path O:\)) {
    subst O: $WorkRoot
    if($LASTEXITCODE -ne 0){throw 'Cannot create short build path O:'}
}
$mapping = subst | Out-String
if($mapping -notmatch ('(?im)^O:\\: => '+[regex]::Escape($WorkRoot)+'\s*$')) {
    throw "O: is not mapped to $WorkRoot; choose an unused drive before building."
}
$runtimeRoot=Split-Path $WorkRoot
$env:PATH="O:\venv\Scripts;O:\w64devkit\bin;$runtimeRoot\toolchain\bin;"+$env:PATH
$env:PYTHONUTF8='1'
$env:PYTHONPATH=''
$env:CMAKE_GENERATOR='Ninja'
cmake -S O:/src/nuttx -B O:/bringup -GNinja '-DBOARD_CONFIG=../vendor/sifli/boards/sf32lb52/lckfb_huangshan_pi/configs/bringup' '-DPython3_EXECUTABLE=O:/venv/Scripts/python.exe' '-DEXTRA_FLAGS=-Wno-cpp -Wno-deprecated-declarations -Wno-error=implicit-function-declaration -Wno-error=return-mismatch -Wno-error=incompatible-pointer-types -Wno-error=int-conversion'
if($LASTEXITCODE -ne 0){throw 'Configuration failed'}
cmake --build O:/bringup -j8
if($LASTEXITCODE -ne 0){throw 'Build failed'}
Write-Output "Built $WorkRoot\bringup\nuttx.bin. The validated firmware in this project is preserved."
