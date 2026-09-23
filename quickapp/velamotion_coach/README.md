# VelaMotion Coach / 腕动教练

面向 openvela 智能手表/手环的 AI 运动教练快应用。应用在腕上自动识别跑步、跳绳、静坐/恢复等运动状态，生成训练片段时间线、疲劳/异常提醒、图表复盘和本地历史；没有真机时可使用 openvela Watch Emulator 与官方 Mock 链路完成演示。

## 参赛信息与评审入口

- 比赛：2026 首届 openvela AI 硬件开发者大赛；方向：手表应用创新。
- 队伍：DDLqudong（289）；专属仓：[open-vela/contest2026_289_DDLqudong](https://github.com/open-vela/contest2026_289_DDLqudong)。
- [作品介绍 PDF](docs/作品介绍.pdf) / [Word](docs/作品介绍.docx) / [官方要求对应](docs/contest_requirements.md)。
- [演示视频](artifacts/final_demo/auto_carousel/velamotion_core_demo.mp4)：四张本轮模拟器实测画面的短片串联，非连续录屏。
- [2026-09-20 验收](docs/submission_validation_2026-09-20.md)、[AI 协作与日志状态](docs/ai_coding_disclosure.md)、[可复用验收 Skill](skills/openvela-watch-acceptance/SKILL.md)。
- 许可：Apache-2.0，见 [LICENSE](LICENSE)。

## 一句话定位

VelaMotion Coach 是给普通运动用户的 openvela 腕上 AI 运动教练：减少手动选择运动模式的负担，用手表传感器实时识别运动状态，并在训练强度异常或节奏下降时给出可理解的腕上反馈。

## 当前完成度

已完成模拟器可演示闭环：

```text
应用内 Mock ACC/GYRO/HR/Steps → 3s 滑窗 → IMU 特征 → tiny_classifier/可替换模型后端 → TRL 后处理 → 疲劳/异常提醒 → 振动 → 图表复盘 → 本地历史 → 手机摘要导出/隐私说明
```

核心能力：

- 四页信息架构：`首页 → 教练 → 时间线 → 同步复盘`。场景和 AI 分析折叠进教练页；本地复盘折叠进时间线；同步、历史、诊断和隐私折叠进同步复盘页，训练中四页都保留即时停止入口。
- 手表优先 UI：每页只保留一个核心结论，使用动作大字、场景波形、概率条、分段条、强度柱、复盘图和状态点替代长段说明。
- 自动运动识别：支持无活动、羽毛球、跳绳、飞鸟、跑步、乒乓球 6 类标签；比赛演示重点覆盖静坐、跑步、跳绳、混合训练、疲劳跑。
- TRL 时间线：7 点居中均值 + 5 点居中中值平滑，沿用基线转移矩阵做 Viterbi 解码；只回溯最近 32 个窗口并冻结更早的稳定前缀，随后执行短片段过滤和相邻片段合并。
- F5 疲劳/异常提醒：静止高心率、过高心率、疲劳跑步、高强度提醒；首页与教练页均可见。
- 腕上振动：接入 `@system.vibrator`，风险触发短振提醒；模拟器无触感时 UI 降级为“模拟提醒”。
- F7 图表复盘：时间线页内展示运动占比条形图、心率强度趋势与风险事件记录。
- 本地历史：接入 `@system.storage`，只保存摘要/片段/风险事件，不保存原始传感器波形。
- 健康接口：封装 `@service.health` HEART_RATE / SPO2 / STRESS；不可用时自动降级。
- 真机采集/诊断：同步复盘页的诊断面板可核验 service.health、真实 ACC、真实步数、振动、屏幕尺寸和电量/功耗基线。完整真机运动识别必须同时具备 ACC 与 GYRO；缺少 GYRO 时入口会在启动引擎、健康订阅和传感器数据流之前阻断，且不会生成训练记录。
- F8 手机同步/导出：接入可选 `@system.interconnect`；同步复盘页只展示连接状态和时长/片段/提醒三项摘要，完整载荷由同步模块发送。
- 可选 AI 总结：接入 `@system.velaclaw`，不可用时回退到端侧模板总结。
- 原模型迁移接口：`model_backend.js` 已预留 native/量化模型桥；当前运行仍默认 `tiny_classifier`，不声称已完整运行 PyTorch 原模型。

## 快速运行

```bash
cd quickapp/velamotion_coach
npm ci
npm run test:core
npm run test:motion
npm run model:inventory
npm run mock:official:dry
npm run build
npm run release
```

建议 Node.js 22。原作者签名私钥不随提交包分发：可直接安装已签名 RPK；需要重新执行 release 时，请先在 AIoT-IDE 的“发布”流程生成自己的签名。

release 包位置：

```text
dist/com.velamotion.coach.release.1.0.0.rpk
```

## 模拟器启动与安装

AIoT-IDE 中打开本目录：

```bash
aiot-ide "./openvela_velamotion_coach"
```

命令行部署时使用项目内 ADB：

```bash
cd quickapp/velamotion_coach
./node_modules/@miwt/adb/bin/linux/adb devices
./node_modules/@miwt/adb/bin/linux/adb -s emulator-5554 push dist/com.velamotion.coach.release.1.0.0.rpk /data/tmp/com.velamotion.coach.release.1.0.0.rpk
./node_modules/@miwt/adb/bin/linux/adb -s emulator-5554 shell pm uninstall com.velamotion.coach
./node_modules/@miwt/adb/bin/linux/adb -s emulator-5554 shell pm install /data/tmp/com.velamotion.coach.release.1.0.0.rpk
```

当前 Vela5 工具链可用启动命令：

```bash
./node_modules/@miwt/adb/bin/linux/adb -s emulator-5554 shell am start com.velamotion.coach
```

若使用旧版 openvela 串口控制台，也可在模拟器控制台内执行：

```bash
vapp hap://app/com.velamotion.coach
```

## 官方 Mock 验收

此验收证明模拟器 gRPC 注入与回读。应用界面和分类链路由应用内 Mock 驱动；不能将两项验收合并表述为应用已消费官方全部六轴数据。现有 SDK 为本机预编译 Vela5 镜像，不宣称其源码版本已锁定到大赛分支。

干跑验证曲线和报告：

```bash
npm run mock:official:dry
```

连接模拟器 gRPC 注入：

```bash
MOCK_SCENE=fatigue_running MOCK_DURATION_MS=45000 npm run mock:official
```

报告位置：

```text
artifacts/mock_verification/official_mock_report.json
```

当前本地模拟器 proto 可注入 `ACCELERATION`、`GYROSCOPE`、`HEART_RATE` 和 `PhysicalModel HEART_RATE`。脚本会自动探测步数相关 enum；本地 proto 暂未发现 `STEP_COUNT/STEP_COUNTER/PEDOMETER`，因此步数仍由应用内 `MockSensorProvider` 按同一曲线生成。

## 最终演示截图/视频

模拟器在线且已完成 `npm run release` 后执行：

```bash
npm run demo:capture
```

脚本会自动推送 release RPK、卸载旧包、重新安装、优先执行 `adb shell am start com.velamotion.coach` 启动应用；若该方式不可用再兜底尝试串口 `vapp hap://app/com.velamotion.coach`，随后通过 8554 gRPC 截图并合成 MP4。

若模拟器已安装最新 Release，可减少反复安装造成的 ADB 忙循环：

```bash
DEMO_SKIP_INSTALL=1 npm run demo:capture
```

该模式仍会解包本地 RPK，并强制核对设备端 bundle SHA-256；哈希不一致时拒绝截图。

输出目录：

```text
artifacts/final_demo/auto_carousel/
```

当前验收截图严格对应四个顶层页面：

```text
core_01_home.png
core_02_coach.png
core_03_timeline.png
core_04_sync_review.png
```

如已安装 `ffmpeg`，会生成：

```text
artifacts/final_demo/auto_carousel/velamotion_core_demo.mp4
```

目录中可能仍保留 2026-08-09 的旧 11 页截图和
`velamotion_final_demo.mp4`，仅用于历史追溯；当前截图、视频、故事板和提交检查均不引用这些旧制品。

## 提交材料整理

```bash
npm run submit:prepare
npm run submit:check
```

`submit:prepare` 会生成：

```text
artifacts/submission/velamotion_submission_manifest.json
artifacts/submission/velamotion_coach_submission/
artifacts/submission/velamotion_coach_submission.zip   # 如果系统安装 zip
```

提交包排除 `node_modules/`、构建中间目录、解包目录和 `sign/release/private.pem`。

## 目录结构

```text
src/
  common/
    ai/summary_provider.js
    algorithm/
    device/
    sensor/
    storage/session_store.js
    sync/interconnect_sync.js
  pages/index/index.ux
scripts/
  smoke_motion_engine.mjs
  inject_official_sensor_mock.js
  final_demo_capture.js
  model_migration_inventory.js
  prepare_submission_package.js
docs/
  official_mock_acceptance.md
  demo_storyboard.md
  test_report.md
  true_device_validation.md
  model_migration.md
  sync_export.md
  privacy_statement.md
  device_boundary.md
  submission_package.md
```

## 关键边界

- 当前主要验证环境是 openvela Watch Emulator；没有物理小米手表/手环，不能声明已完成真机功耗、真实振动触感、真实健康传感器采样质量验证。
- 当前公开 JS sensor 类型未发现 gyroscope 订阅接口；Mock 可注入 GYRO，真机 GYRO 需要目标 SDK 或原生适配层。在六轴能力补齐前，“真机采集”只展示明确的能力不足状态，不会用全零 GYRO 继续识别或保存。
- 当前分类器是 `tiny_classifier` 特征/规则模型；若要声称完整移植论文模型，需要 native/量化推理模块，并通过 `setNativeModelBackend()` 或 `globalThis.velamotionModel.classifyWindow()` 接入。
- F8 手机同步是可选增强；无手机端时不影响手表端独立运行。
- 默认不上传原始传感器数据；历史只保存摘要级信息。

更多说明见 `docs/submission_package.md`、`docs/true_device_validation.md`、`docs/model_migration.md`、`docs/sync_export.md`。
