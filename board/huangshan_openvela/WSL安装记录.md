# WSL 安装状态（2026-09-20）

用户已授权安装 WSL，要求尽量使用 `D:\wsl_ubuntu`。此授权包含继续完成 Ubuntu 和 openvela 构建环境，不需要重问是否安装。

已完成：

- WSL 2.7.14.0 MSI 安装成功，退出码 0。
- WSL 服务的实际可执行路径：`D:\wsl_ubuntu\WSL\wslservice.exe`，服务已运行。
- `wsl --version` 能正常返回版本，Linux 内核版本 6.18.33.2-2。
- Windows `VirtualMachinePlatform` 和 `Microsoft-Windows-Subsystem-Linux` 均已启用；用户已完成重启。
- Ubuntu 24.04 官方镜像已下载至 `D:\wsl_ubuntu\setup\ubuntu-24.04-amd64.wsl`，388,975,696 字节，SHA256 校验通过。
- 新建用户 `.wslconfig`，将 WSL 交换文件设为 `D:\wsl_ubuntu\swap.vhdx`。原先没有 `.wslconfig`。
- 下载、安装日志和任务临时文件位于 `D:\wsl_ubuntu\setup`。安装前后 C 盘可用空间约 15.11 → 14.77 GiB；Windows 必需组件和 MSI 缓存仍会占用少量 C 盘空间。

重启后验证（已完成）：

- `Ubuntu-24.04` 已成功导入、启动，系统为 Ubuntu 24.04.5。
- 发行版磁盘在 `D:\wsl_ubuntu\Ubuntu-24.04\ext4.vhdx`，交换文件仍指定 D 盘。
- `/opt/openvela/src`、`/opt/openvela/build`、Linux ARM GCC 13.2.1 和 Python 环境都位于这块 D 盘虚拟磁盘内。
- 完整 QuickApp 固件已完成编译与实板烧录校验，Linux 编译器与 JIDL 生成器均正常。
- GUI 库 Git LFS 实体下载至 `D:\wsl_ubuntu\setup\libgui_wrapper.a`，124,984,128 字节，SHA256 `a195aa82de249920444adf2a8c6fcfeacffc82b4521ffb3496bda8c379a14f82`。
- 应用依赖和构建在 `D:\wsl_ubuntu\app-work\velamotion_coach`，npm 缓存在 `D:\wsl_ubuntu\npm-cache`。
- 已解决此前虚拟机服务不可用的阻塞；无需再次重启或导入。

可复用脚本：

- `resume-wsl.ps1`：导入与位置检查，已执行成功。
- `bootstrap-linux.sh`：Linux 构建依赖安装，已完成。
- `prepare-linux-sources.py`：从已缓存归档恢复官方 Linux 源码，不要对正在修改的源码树重复执行。
- `build-linux.sh`：完整官方配置构建；`build-app-linux.sh`：嵌入 VelaMotion Coach 并启用本地套接字后构建。

安装来源与校验：

- [微软 WSL 2.7.14 官方发布](https://github.com/microsoft/WSL/releases/tag/2.7.14)：`wsl.2.7.14.0.x64.msi`，258,990,080 字节；SHA256 `db084e536279a59e90a26ec598d8aa8a4dff8309f41d078fd06242953ac1ebcd`；Authenticode 签名有效，签名人为 Microsoft Corporation。
- Ubuntu 地址来自微软 `distributions/DistributionInfo.json`，镜像为 `https://releases.ubuntu.com/24.04.5/ubuntu-24.04.5-wsl-amd64.wsl`；SHA256 `bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e`。元数据副本在 D 盘 setup 目录。
- [微软 WSL 导入与位置参数说明](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)。

内置 `wsl --install` 下载曾返回 HTTP 403，已通过离线 MSI 安装解决。该错误并非用户拒绝授权或自动审批拒绝。
