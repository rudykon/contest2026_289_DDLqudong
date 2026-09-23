# 黄山派 openvela + VelaMotion Coach 实板部署

2026-09-23 当前版：EPIC 增加部分字形/圆角 A8 掩码和整体透明度混合，停止训练拆为六个事件循环阶段，移除原生存储接口整条 JSON 的同步串口输出。已烧录固件 5,871,668 B；最终两轮停止反馈为 540/547 ms，保存 API 回调在停止入口后 838/857 ms 完成，仍不代表断电保存。普通缓存翻页约 454 ms，新 GPU 覆盖没有证明普遍提速；尚未达到市售手表流畅度。字号、粗体、字体文件和四角留白保持。完整实现、性能限制、图像差异与测试见 [GPU扩展与主线程优化验收](validation/GPU扩展与主线程优化验收.md)。`benchmark-ui.ps1 -Reset -Trace -WaitFinalize -GpuMode on -GpuMaskMode on/off` 可复测。回退包为 `firmware/velamotion-before-epic-expanded.bin` 和 `manifest-before-epic-expanded.json`。以下为此前各轮记录。

2026-09-22 当前固件已接入 EPIC：默认加速大面积不透明 RGB565 填充及 RAM 图像复制，保留现有 LVGL 软件回退、局部刷新和双线 XIP。固件 5,864,108 B，比上一版增加 11,888 B。相同镜像的 GPU 开关对照中，缓存桌面切页中位数 226→205.5ms，快应用缓存切页 473.5→450ms；训练停止仍可能超过 1 秒，尚未达到市售手表流畅度。字体、透明混合、掩码和变换尚未交给 GPU。完整范围、正确性、性能及回退说明见 [EPIC适配验收](validation/EPIC适配验收.md)。`verify-epic.ps1` 执行六轮重启对照，`analyze-epic.py` 汇总结果；`benchmark-ui.ps1 -GpuMode on/off` 可单独切换。上一版回退镜像是 `firmware/velamotion-before-epic.bin`，配套 `manifest-before-epic.json`。

2026-09-22 响应延迟诊断：已定位按钮按下/松开时的重复整屏重绘，以及快应用业务与 UI 共用事件循环的阻塞。默认改为局部刷新，字号、粗体与 RPK 保持不变。该轮固件 5,850,412 B；普通缓存翻页中位数由 883ms 降至 713ms，停止训练仍可能接近 2 秒，尚未达到流畅目标。分阶段证据、对照限制及回退方法见 `validation/响应延迟诊断.md`。`benchmark-ui.ps1 -Reset` 复测默认固件，`-Trace` 开启逐帧计时，`-NativeOnly` 只测桌面。

2026-09-22 字库与资源精简：保留 MiSans Regular/Demibold 两种字重以及现有字号，字体改为“现有全部源码/打包文字 + GB2312 一级 3,755 个常用汉字 + 原字库全部非汉字符号”的子集。两套字体从 5,171,940 B 降为 2,076,708 B。ROMFS 只打包小芽，原计算器与 Lyra 示例源码仍保留；关闭 LVGL 演示和未使用的 Montserrat 16/20/24/28/48，保留运行库依赖的默认 Montserrat 14。新固件 5,849,516 B，具体校验和板端验收见 `validation/字库资源精简验收.md`。

`subset-fonts-linux.py` 每次完整构建或仅更新资源时自动收集文字，检查字形轮廓、字宽、提示指令、行高和字重一致性；发现新增字符不被原字体支持时终止构建。两份完整字库保留在 D 盘 WSL `/opt/openvela/font-originals`，旧固件是 `firmware/velamotion-before-font-subset.bin`，旧清单 `manifest-before-font-subset.json`。动态输入的少见汉字不保证在子集中，可按需要扩展字符集合；源代码中新增的静态文字会自动加入。

字体工具固定为 WSL 虚拟环境中的 `fonttools==4.65.0`，通用安装包保存在 `D:\wsl_ubuntu\setup\fonttools\fonttools-4.65.0-py3-none-any.whl`。可用 `/opt/openvela/venv/bin/python -m pip install --no-index /mnt/d/wsl_ubuntu/setup/fonttools/fonttools-4.65.0-py3-none-any.whl` 离线重装。字体裁剪采用 [FontTools 官方子集工具](https://fonttools.readthedocs.io/en/latest/subset/index.html)。

2026-09-22：桌面增加原生实用工具与快捷设置，仍然是本项目自定义桌面。首页提供时钟、日期、工具、设置、小芽入口和防误触锁屏；工具页提供秒表、倒计时、系统信息。秒表支持开始/暂停/归零，倒计时支持调整、开始/暂停/复位，到时弹出屏幕提醒。离开工具页面、锁屏或打开小芽后，计时继续；提醒确认后回到原页面。没有声音或振动提醒。

设置支持 20%–100% 五档真实屏幕亮度和手动设置北京时间。校时页点击中央字段切换年/月/日/时/分，再用加减按钮调整并保存。计时使用单调时钟，修改日期不会改变秒表或倒计时。锁屏需要长按“长按解锁”，只用于防误触；不等同于密码锁或休眠。桌面左滑进入工具，子页右滑返回；所有操作也有大按钮。文字仍避开四角。亮度重启后恢复 80%，时间及计时状态需要重设。

原生界面源文件为 `watch_desktop.cpp`，计时和日期逻辑为 `watch_tools.h`；`test_watch_tools.cpp` 验证暂停/恢复、边界、单次到时事件及闰年日期。`prepare-brightness-linux.py` 将 CO5300 的硬件亮度命令接入 LCD contrast ioctl，不改变 QuickApp 亮度 API 的支持状态。旧固件保存在 `firmware/velamotion-before-desktop-tools.bin`，配套清单为 `manifest-before-desktop-tools.json`。

当前系统时间为有符号 32 位，手动校时限定在 2025–2037 年。倒计时以分钟调整，最短 10 秒、最长 99 分钟；暂停后调节会设定新的完整时长。`verify-desktop-tools.ps1` 保存了本次串口验收步骤，按 `clock`、`lock`、`countdown`、`stopwatch`、`countdown-pause`、`app`、`ready` 顺序运行，各阶段开始于桌面。`app` 阶段会启动并停止演示训练，请在没有待保留的训练时执行。最终固件 22 张截图、计时和小芽共存验证见 `validation/桌面基础功能验收.md`。

2026-09-21：已完成 D 盘 WSL/Ubuntu 构建环境、真正的 openvela/NuttX、QuickApp 运行时及 `com.velamotion.coach`（小芽）的集成，并增加独立桌面和左右滑动翻页。上电先显示原生时钟桌面，点击“小芽运动”打开应用；应用左下角“桌面”键返回，点击“返回小芽”恢复页面和训练状态。当前使用 390×450 AMOLED，串口 COM5，1,000,000 baud / 8N1。本轮记录见 `validation/桌面版验收.md`。

当前交付保留黄山派 390×450 圆角屏幕的大字布局：标题居中、四角留白，主要文字约 24–41 像素，开始／停止按钮高约 62 像素，底部按钮向中间收拢。时间线、历史和设备诊断使用可滑动列表，复盘建议按大字分行。最终固件及校验信息见 `quickapp-firmware-manifest.json`，布局历史记录见 `validation/圆角大字版验收.md`。`validation/*.png` 是串口取回的**板端 LVGL 渲染截图**，不是模拟器截图，也不是物理屏幕照片。

## 重新烧录

应用内左滑进入下一页、右滑返回上一页，四页循环；列表内上下滑动查看内容。开始／停止、发送、清空等应用按钮在手指抬起且未发生拖动时执行操作。左下角原“上一页”按钮现为容器直接处理的“桌面”键；上一页使用右滑。纵向滚动一旦确定方向，后续斜移也不会误翻页。手势版历史验收记录见 `validation/手势版验收.md`。

在本目录的 PowerShell 中执行：

```powershell
.\flash-quickapp.ps1
```

脚本先检查固件大小和 SHA256，再通过 sftool 写入 `0x12010000`、校验并复位，采集 30 秒启动日志，再同步本机 UTC 时间供桌面显示北京时间。单独校时可运行 `sync-clock.ps1`，请在未开始训练时执行。串口变化时使用 `-PortName COMx`。必须先关闭占用串口的串口助手。

仅观察运行状态，不复位：

```powershell
.\serial-runtime.ps1 -ObserveSeconds 12 -Commands @('ps','free')
.\capture-screen.ps1 -CaptureName current
```

界面截图与自动点击依赖固件中随附的本地开发探针；例如 `-Actions @('tap 263 406')` 点击底部下一页。桌面键约为 `(127,406)`，桌面打开／返回小芽为 `(195,342)`，全局停止约为 `(195,336)`，首页开始／停止约为 `(195,333)`。列表内可向上滑动，例如 `-Actions @('swipe 200 270 200 150')`。探针在 GUI 线程执行，通过 `/data/ui-command` 接收本地命令，没有网络监听端口。脚本等待探针完成后再发送下一条操作；仍应检查截图确认应用确实响应。模拟点击只能验证 UI 事件链路，不能代替物理触摸传感器验收。

## 修改后重编译

应用源文件仍在项目 `quickapp/velamotion_coach/src`。构建脚本将它们复制到 D 盘并生成压缩 RPK：

```powershell
.\build-quickapp.ps1
wsl.exe -d Ubuntu-24.04 -u root --exec bash '/mnt/c/Users/24470/Desktop/小米openvela比赛/contest2026_289_DDLqudong/board/huangshan_openvela/build-app-linux.sh'
```

生成的固件在 `D:\wsl_ubuntu\setup\velamotion-openvela.bin`。脚本不会自动覆盖本目录已验收的固件和清单；发布新固件时应复制镜像、更新大小/SHA256 并重新验收。只更新应用资源时可执行 `prepare-app-linux.py --assets-only` 后重编译；如新增资源路径，应执行完整脚本以刷新启动复制命令。

WSL 主程序、Ubuntu 虚拟磁盘、交换文件、Linux 源码和工具链、npm 依赖与缓存均放在 `D:\wsl_ubuntu` 下。Linux 路径为 `/opt/openvela/src` 和 `/opt/openvela/build`。具体位置及安装校验见 `WSL安装记录.md`。旧的 Windows 启动验证缓存保留，未删除用户文件。

本地板端 RPK 使用工具包自带的公开开发测试证书签名并启用 release 压缩，文件名为 `com.velamotion.coach.huangshan-dev.1.0.0.rpk`；不是作者的正式发布签名。原项目 release RPK 保留。

## 适配内容

性能优化版本增加了按需创建并保留的页面缓存、仅当前页可见字段更新、后台界面更新合并，以及每 8 个样本让出执行时间的特征提取。触摸后 200ms 内推迟下一段模型计算，计算结果和后台训练状态仍保留。装饰动效默认关闭，可在更多设置中恢复；大字体、圆角安全区及手势保持。桌面时钟按分钟变化刷新。

`build-quickapp.ps1` 在 D 盘构建副本中运行 `optimize-watch-styles.py`，去掉未使用和被覆盖的样式，并保留剩余规则顺序。源码中的设计样式仍可编辑。`check-style-equivalence.py` 对照工具链编译后的样式检查页面布局一致性。

性能复测先复位到桌面，再执行 `benchmark-ui.ps1 -Name perf-check`。它会打开应用、翻页、启动演示训练、返回桌面、恢复及停止，生成 `logs` 日志和 `validation` JSON。计时从本地合成输入注入到 LVGL 页面标志变化后的绘制回调，包含 100ms 合成按压，不包含手指触控硬件延迟；不能将它当作物理触摸延迟或帧率。开发探针计时默认关闭，测试结束自动关闭。

- 启用本地 socketpair，解决 GUI 图片缓存线程阻塞在 TCP accept 的启动问题。
- 启动 KVDB 服务并提供设备属性，解决运行时等待属性服务的问题。
- JS 堆设为 3 MiB，并修正预编译库仍硬编码 1 MiB 上限导致的启动 OOM。
- 从源代码链接 vapp 入口，避免预编译 `libapps_vapp.a` 覆盖本地修复。
- 应用从 ROMFS 复制到 RAM 后启动；storage 与应用可写目录改到 `/data/quickapp`，解决只读文件系统错误。
- 补充 MiSans Demibold 字体，按钮使用可显示的中文字符，适配 390×450 页面。
- 缺少 health、vibrator、brightness、battery 时安全降级，禁止伪造真实传感器数据。
- 修正开始按钮的透明动画覆盖层，空闲时移除该层。手势版由 touchstart 记录候选动作，touchmove 区分滑动，touchend 确认点击；输入控件和页面共用一次性结算，避免冒泡重复执行。

改动由 `prepare-app-linux.py`、`quickapp_limits.c`、`vmc_probe.cpp` 及应用源码保存。官方源码版本和归档校验值见 `sources-lock.json`；构建配置和启动脚本副本在 `firmware` 中。

## 当前能力边界

- 演示模式使用明确标识的模拟运动/健康数据。真实六轴原生设备 `/dev/lsm6dsl0` 曾验证能读，但还没有接入 QuickApp 的 JS 六轴 API；真实训练模式会拒绝在能力不完整时启动。
- 心率/血氧/压力、振动、手机互联等能力尚未完成实板支持，不能据演示界面判定真实硬件可用。
- `/data` 是 RAM 文件系统，当前 NOR 驱动在 FLASH2 XIP 时禁用写擦。历史记录在本次运行内可读写，**复位或断电即丢失**。
- 桌面使用 RTC 并显示北京时间；串口校时不等于联网自动校时。无有效时间时桌面显示“时间未设置”。应用自身的历史日期仍受其运行时区影响；训练时长使用设备运行计时。
- 此前用户确认过 openvela 原生彩色矩形显示及原 Watch UI 触摸。本次完整快应用版本使用板端截图和合成点击自主验证，尚未重新获得物理屏幕/手指触摸确认。

## 恢复与历史

`README-bringup-history.md` 和 `flash.ps1` 对应早期只有硬件测试的 openvela 固件；不要用它们重新部署本次快应用。`serial-check.ps1` 会运行原生 framebuffer 测试，也不用于当前应用验收。

此前 RT-Thread Watch UI 的恢复入口是工作区 `watch-ui/flash.ps1`。最初工厂 16 MiB 备份仍在工作区 `board-test/original-flash-16MiB.bin`，未改动。
