#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
mkdir -p /opt/openvela/logs /opt/openvela/src /opt/openvela/downloads
exec > /opt/openvela/logs/bootstrap.log 2>&1
echo 'Installing openvela build prerequisites'
apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 update
apt-get -y --no-install-recommends install build-essential cmake ninja-build python3 python3-venv python3-pip git curl ca-certificates unzip zip xxd genromfs gperf bison flex pkg-config libelf-dev gcc-arm-none-eabi libnewlib-arm-none-eabi
python3 -m venv /opt/openvela/venv
/opt/openvela/venv/bin/pip install kconfiglib pyelftools cxxfilt
echo 'Build prerequisites ready'
arm-none-eabi-gcc --version
cmake --version
