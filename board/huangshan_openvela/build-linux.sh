#!/usr/bin/env bash
set -euo pipefail
export PATH=/opt/openvela/venv/bin:$PATH
cd /opt/openvela/src
cmake -B /opt/openvela/build -S nuttx -GNinja \
  -DBOARD_CONFIG=../vendor/sifli/boards/sf32lb52/lckfb_huangshan_pi/configs/nsh \
  '-DEXTRA_FLAGS=-Wno-cpp -Wno-deprecated-declarations' \
  > /opt/openvela/logs/configure.log 2>&1
cmake --build /opt/openvela/build -j6 > /opt/openvela/logs/build.log 2>&1
arm-none-eabi-size /opt/openvela/build/nuttx
sha256sum /opt/openvela/build/nuttx.bin
