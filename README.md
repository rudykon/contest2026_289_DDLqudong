# VelaMotion Coach / 腕动教练

**2026 首届 openvela AI 硬件开发者大赛 · 手表应用创新方向**

队伍：**DDLqudong（289）** · GitHub：rudykon · 版本：1.0.0

腕动教练是一款 openvela 手表快应用：在腕上识别运动状态，自动生成训练片段，以短提醒和图表帮助用户复盘混合训练。以“小芽”运动伙伴引导开始和停止，核心训练闭环可在无手机、无云端 AI 服务的模拟器环境运行。

## 黄山派实机版

当前项目也已适配立创黄山派 SF32LB52：包含 openvela/NuttX 固件、QuickApp 运行时、自定义手表桌面、手势和大字界面，以及 EPIC 绘制后端。实机源码、D 盘 WSL 构建步骤、烧录脚本和验收记录见 [黄山派部署指南](board/huangshan_openvela/README.md)。仓库内的 [最新固件](board/huangshan_openvela/firmware/velamotion-openvela.bin) 使用公开开发测试证书打包应用，供这块开发板验证；正式发布仍需自己的签名。最新性能测试显示停止操作反馈约 0.55 秒，普通快应用翻页约 0.45 秒，尚未达到市售手表的流畅度。

## 评审入口

- [作品介绍 PDF](quickapp/velamotion_coach/docs/作品介绍.pdf) / [Word](quickapp/velamotion_coach/docs/作品介绍.docx)
- [演示 MP4](quickapp/velamotion_coach/artifacts/final_demo/auto_carousel/velamotion_core_demo.mp4)：四张本轮模拟器实测截图串联，每页 10 秒，非连续录屏。
- [生产 Release RPK](quickapp/velamotion_coach/dist/com.velamotion.coach.release.1.0.0.rpk)
- [源码与详细运行指南](quickapp/velamotion_coach/README.md)
- [完整交付 ZIP](quickapp/velamotion_coach/artifacts/submission/velamotion_coach_submission.zip)
- [本轮验收](quickapp/velamotion_coach/docs/submission_validation_2026-09-20.md) / [提交包检查](quickapp/velamotion_coach/artifacts/submission/submission_check_report.json) / [官方要求对应](quickapp/velamotion_coach/docs/contest_requirements.md)

| 首页 | 腕上教练 | 时间线 | 同步复盘 |
|---|---|---|---|
| ![首页](quickapp/velamotion_coach/artifacts/final_demo/auto_carousel/core_01_home.png) | ![教练](quickapp/velamotion_coach/artifacts/final_demo/auto_carousel/core_02_coach.png) | ![时间线](quickapp/velamotion_coach/artifacts/final_demo/auto_carousel/core_03_timeline.png) | ![同步复盘](quickapp/velamotion_coach/artifacts/final_demo/auto_carousel/core_04_sync_review.png) |

## 技术与交互

`应用内 Mock 六轴数据 → 16 Hz / 3 秒滑窗 → IMU 特征 → tiny_classifier → TRL 后处理 → 风险提示、时间线与本地摘要`

- 六类标签：无活动、羽毛球、跳绳、飞鸟、跑步、乒乓球；演示覆盖混合训练、跑步、跳绳和疲劳场景。
- TRL 居中平滑与 Viterbi 解码，固定尾部回溯；协作式推理、有界缓存与停止取消保护操作响应。
- 接入 openvela 图形框架、`@system.storage`、`@system.vibrator`、`@service.health`；可选手机摘要同步与 `@system.velaclaw` 总结有明确降级。
- 历史只保存摘要/片段/事件，不存原始连续波形。训练中每页均可停止，训练与诊断互斥。

## 运行与复现

建议 Node.js 22；打开 AIoT-IDE 的 Vela5 Watch Emulator。可直接安装上方已经签名的 RPK。

```bash
cd quickapp/velamotion_coach
npm ci
npm run test:core
npm run test:motion
```

使用项目带的 ADB 安装到当前 Vela5 模拟器：

```bash
ADB=./node_modules/@miwt/adb/bin/linux/adb
"$ADB" devices
"$ADB" -s emulator-5554 push dist/com.velamotion.coach.release.1.0.0.rpk /data/tmp/com.velamotion.coach.release.1.0.0.rpk
"$ADB" -s emulator-5554 shell pm install /data/tmp/com.velamotion.coach.release.1.0.0.rpk
"$ADB" -s emulator-5554 shell am start com.velamotion.coach
```

进入首页后点击开始，等待预热和动态识别，停止后查看时间线、历史。手机未连接或健康接口不可用时按页面说明使用模拟训练。对仅支持 ADB 推送的 arm64 镜像，按[官方手动开发文档](https://github.com/open-vela/docs/blob/dev-ai-contest-2026/zh-cn/contest_2026/quickapp/quickapp_manual.md)解包推送到 `/data/app/com.velamotion.coach/`，再在串口执行 `vapp hap://app/com.velamotion.coach`。

自行重建 Release 前，在 AIoT-IDE 的发布流程生成自己的签名；作者私钥不分发。

```bash
npm run release
npm run demo:capture
npm run submit:prepare
npm run submit:check
```

完整 openvela 工程按[保留的官方仓说明](docs/official_repository_guide.md)执行 `repo init` 和 `repo sync`，基线为 `dev-ai-contest-2026`。队伍清单已添加本应用到 `packages/apps/contest2026_289_velamotion_coach` 的 linkfile。

## 验证与边界

2026-09-20：核心回归 **53/53**、运动场景测试、生产构建、设备 bundle 哈希核对、动态跑步确认、四页严格截图检查及提交包一致性全部通过。官方 gRPC 注入/回读 ACC、GYRO 和心率通过，步数由应用内 Mock 生成。

当前使用轻量规则/特征分类器；未将研究工程 CNN-BiLSTM 原模型部署到手表。合成场景测试不代表真人识别准确率。官方 gRPC 注入和应用内 Mock 分类分别验证，不声称应用已消费全部官方六轴数据。本地预编译 SDK 镜像未追溯到大赛分支源码 commit。真机缺少 GYRO 时完整训练被阻断；真实功耗、振动触感、手机配对与真人性能尚未验证。

## AI Coding 与可复用经验

AI 协作用于采样边界修复、TRL 增量处理、生命周期和交互回归、模拟器部署与验收。[验收 Skill](skills/openvela-watch-acceptance/SKILL.md)沉淀设备 bundle 核对、动态画面双验证、传感器边界与提交包检查流程。

**按作者要求，本次不公开历史开发日志及其摘要**，日志仅本地保留。官方 AI Coding 日志材料尚未提交；详见 [AI 协作与日志状态](quickapp/velamotion_coach/docs/ai_coding_disclosure.md)。构建和演示通过不代表该项官方要求已满足。

## 目录与许可

- `quickapp/velamotion_coach/`：参赛应用及完整材料。
- `logs/README.md`：未提交日志的状态说明；`skills/`：复用验收流程。
- `app/hello_app/`、`quickapp/hello_quickapp/`、`board/contest_board/`：保留官方示例骨架。
- `contest2026_289_DDLqudong.xml`、`openvela.xml`：官方工程清单。

作品源码遵循 [Apache-2.0](LICENSE)，第三方依赖保留各自许可证。签名私钥、原始数据和构建依赖不入仓。
