#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/openvela/venv/bin:$PATH"
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
python3 "$script_dir/prepare-app-linux.py"
cmake --build /opt/openvela/build --target resetconfig > /opt/openvela/logs/app-config.log 2>&1
cmake -B /opt/openvela/build -S /opt/openvela/src/nuttx -GNinja >> /opt/openvela/logs/app-config.log 2>&1
cmake --build /opt/openvela/build -j6 > /opt/openvela/logs/app-build.log 2>&1
python3 "$script_dir/verify-image-resources-linux.py"
arm-none-eabi-size /opt/openvela/build/nuttx
cp /opt/openvela/build/nuttx.bin /mnt/d/wsl_ubuntu/setup/velamotion-openvela.bin
sha256sum /mnt/d/wsl_ubuntu/setup/velamotion-openvela.bin
