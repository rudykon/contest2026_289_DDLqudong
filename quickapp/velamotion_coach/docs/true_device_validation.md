# 真机验证计划与验收表

当前服务器没有物理小米手表/手环，因此不能声称已完成真机跑表。本项目已在第四页“同步复盘”内置“真机验收/设备诊断”面板，拿到真机后按下表验收。

## 应用内诊断

打开快应用后滑到第四页“同步复盘”，展开诊断面板并点击“重新诊断”。页面会核验：

| 项目 | 当前实现 | 通过标准 |
|---|---|---|
| service.health | `getRecentSamples` + `subscribeSample` | HEART_RATE/SPO2/STRESS 至少有一类返回，或明确返回不支持码 |
| 真实 ACC | `@system.sensor.subscribeAccelerometer({ interval: 'game' })` | 1.2 秒内有回调，页面显示帧数和 x/y/z |
| 真实步数 | `@system.sensor.subscribeStepCounter` | 走动后步数累计变化 |
| 真实 GYRO | 当前 JS 标准接口未提供 | 需目标真机 SDK 或原生适配层补 `gyroX/Y/Z` |
| 腕上振动 | `@system.vibrator.vibrate({ mode: 'short' })` | 人工确认有触感 |
| 屏幕尺寸 | `@system.device.getInfo` | 显示 screenWidth/screenHeight/screenShape，UI 不遮挡 |
| 电量/功耗 | `@system.battery.getStatus` | 能读取电量；功耗需长时测试 |

完整真机训练的通过条件是 ACC 与 GYRO 同时可用且 `fullActivityRecognition=true`。任一条件不满足时，页面必须显示“完整识别未启动/不会保存”，并保持引擎、健康订阅和真实数据流未启动；不得用全零 GYRO 代替缺失通道。

## 功耗复测建议

1. 满电或记录起始电量，关闭无关后台任务。
2. 在六轴能力检查通过后运行混合训练 15 分钟，采样频率保持默认 16Hz 推理网格。
3. 记录结束电量、发热、掉帧、振动触发次数。
4. 若掉电异常，优先降低 ACC 订阅频率、减少 UI 刷新和日志输出。

## 不能在模拟器证明的内容

- 心率硬件采样质量。
- 真实陀螺仪接口可用性。
- 真实振动触感。
- 长时功耗和发热。
