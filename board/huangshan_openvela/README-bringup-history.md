# 黄山派 openvela 实板部署记录

2026-09-20：openvela/NuttX 硬件启动验证固件已编译、烧录、回读验证，并进入 NSH。用户确认屏幕显示彩色嵌套矩形。**QuickApp 运行环境及 VelaMotion Coach 尚未部署到此固件。**

## 已验证结果

- SF32LB52，COM5，串口 1,000,000 baud / 8N1，无流控。
- `firmware/nuttx-bringup.bin`，402,316 字节，烧录地址 `0x12010000`。
- SHA256：`0a42a5da6dae956653d46ed34e3c6793228694630c437826e1be7035d69bd005`。
- sftool 写入校验通过；另外回读 `0x63000` 字节，固件范围逐字节一致。
- NSH 启动成功，`uname -a`、`help`、`ls /dev`、`free` 正常返回。源码来自官方 `dev-ai-contest-2026` 分支，归档下载不带 Git 版本元数据，因此启动版本字符串为 `NuttX 0.0.0`。
- `/dev/fb0`：390×450、RGB565、351,000 字节；`fb` 测试完成，用户已确认显示正常。
- `/dev/input0` 已注册；尚未完成本系统上的触摸事件交互验收。
- `/dev/lsm6dsl0` 连续读数正常，日志中加速度 Z 轴静止值约 -1000；陀螺仪数据也有返回。传感器数据单位、标定及快应用接口仍需适配，不将示例读数直接当作算法输入。
- 可用堆内存 8,444,944 字节。

证据保存在 `logs/boot-serial.log`、`logs/imu-serial.log`、`logs/verification.txt` 和 `logs/last-serial-check.log`。`firmware/readback.bin` 是实际芯片回读数据。完整构建日志、源码包 SHA256 和本地构建补丁也在本目录。

## 使用

在本目录运行 `./flash.ps1` 可重新烧录已经验证的启动固件，随后自动检查串口并运行屏幕测试。默认调用工作区 `board-test/tools/sftool.exe`，可用 `-SfTool` 指定路径。

`./serial-check.ps1` 会复位开发板、检查系统和设备节点并运行 `fb`。当前启动验证固件没有配置屏幕测试自启动；重新上电后可通过此脚本显示测试图案。

`./build.ps1` 使用本机已准备好的源码和工具重编译，默认工作目录：

`C:\Users\24470\.codex\visualizations\2026\09\20\01a0bdd9-97b8-7931-8986-190cb9fdc268\openvela-work`

脚本使用临时 O: 短路径，依赖该目录中的 `venv`、`w64devkit`、`src`，以及上一级的 ARM GCC `toolchain`。它不会替换本目录已验收的固件。源码树中的配置位置是 `vendor/sifli/boards/sf32lb52/lckfb_huangshan_pi/configs/bringup/defconfig`，对应本目录 `bringup.defconfig`。

完整 QuickApp 配置保留在源码树的 `configs/nsh/defconfig`。`windows-build.patch` 记录实际使用的构建兼容修改，可在匹配版本的 openvela 工作树根目录应用：修正 Windows 主机检测、显式 Python 调用、头文件复制、符号解析和无 ROMFS 时的条件构建。GCC 14 的诊断兼容参数记录在 `build.ps1`，并未把这些警告称为已经修复的驱动问题。

此前 Watch UI 的恢复入口仍为工作区 `watch-ui/flash.ps1`；最初工厂固件的 16 MiB 备份仍在 `board-test/original-flash-16MiB.bin`。

## QuickApp 后续适配与当前阻塞

1. 官方 JIDL 生成器 `prebuilts_tools/rust/bin/jidl/jidl_gen_cpp` 已下载检查，文件格式为 Linux x86-64 ELF，需要 Linux 执行环境。用户已授权在 D 盘安装：WSL 本体已安装到 `D:\wsl_ubuntu\WSL`，Ubuntu 镜像已下载校验；当前需重启 Windows 激活组件，然后导入 Ubuntu。详见 [WSL 安装记录](WSL安装记录.md) 与 `resume-wsl.ps1`，不要再次询问是否允许安装。
2. 官方 QuickApp 运行库已经取得，`libgui_wrapper.a` 在源码归档中是 Git LFS 指针，其 124,984,128 字节实体仍需下载。官方媒体端点和 GitHub raw 重定向均发生连接超时，尚未取得该实体；期望 SHA256 为 `a195aa82de249920444adf2a8c6fcfeacffc82b4521ffb3496bda8c379a14f82`。
3. 当前官方 NOR 驱动检测到 FLASH2 XIP 执行时主动跳过初始化，日志明确为 `NOR write/erase disabled`；`/data` 是临时内存文件系统。快应用历史记录的断电持久化不能视为可用，需要修复驱动或验证另一种可写存储路径。
4. 运行库构建通过后，应先验证官方 QuickApp 示例，再将 `com.velamotion.coach` 打入 ROMFS 并设置启动入口，验证 390×450 布局、触摸、存储和真实六轴数据接入。不得用模拟数据代替真实采集验收。

参考：[黄山派官方 openvela 板级说明](https://github.com/open-vela/vendor_sifli/blob/dev-ai-contest-2026/boards/sf32lb52/lckfb_huangshan_pi/README_zh-cn.md)、[QuickApp 运行时](https://github.com/open-vela/frameworks_runtimes_quickapp)。
