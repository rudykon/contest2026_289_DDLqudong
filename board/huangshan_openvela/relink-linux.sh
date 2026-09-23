#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/openvela/venv/bin:$PATH"
cmake --build /opt/openvela/build -j6 > /opt/openvela/logs/link.log 2>&1
arm-none-eabi-size /opt/openvela/build/nuttx
ls -l /opt/openvela/build/nuttx.bin
sha256sum /opt/openvela/build/nuttx.bin
