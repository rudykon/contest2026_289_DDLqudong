# 真机不可用时的边界说明

## 当前验证环境

- 主要验证设备：openvela Watch Emulator / `emulator-5554`
- 当前构建工具：AIoT Toolkit 2.0.5
- 当前 release 包：`dist/com.velamotion.coach.release.1.0.0.rpk`
- 物理小米手表/手环：当前服务器未连接

## 已完成的验证/实现

- 快应用 build/release 打包链路。
- 应用在当前 Vela5 模拟器中通过 `adb shell am start com.velamotion.coach` 启动；旧版串口环境可兜底使用 `vapp hap://app/com.velamotion.coach`。
- 项目内 Mock ACC/GYRO/HR/steps 数据曲线。
- 官方模拟器 gRPC 注入 ACC/GYRO/HR，并自动探测步数 enum。
- `@system.vibrator` 调用和 UI 降级提示。
- `@system.storage` 历史记录读写。
- `@service.health` HEART_RATE/SPO2/STRESS 封装和失败降级。
- `@system.interconnect` 可选手机摘要同步/导出面板。
- “真机采集”入口，以及第四页“同步复盘”内的“真机验收/设备诊断”面板。

## 需要说明的边界

1. `service.health`

模拟器中健康接口可能没有真实样本，应用会降级到 Mock HR 数据。真机阶段必须重新核验 HEART_RATE / SPO2 / STRESS 的订阅、最近采样和权限表现。

2. 官方步数 Mock

当前本地模拟器 proto 未发现 `STEP_COUNT/STEP_COUNTER/PEDOMETER` 相关枚举，因此官方 gRPC 脚本不能直接注入步数。脚本已实现自动探测；如果后续 SDK 增加步数 enum，会自动注入。当前演示中的步数由应用内 `MockSensorProvider` 按同一运动曲线生成。

3. 真实 IMU

已接入 `RealSensorProvider`，用于探测真实 ACC、步数和接口状态。完整运动分类依赖 ACC/GYRO 六轴输入；当前公开 JS API 未发现 gyroscope 订阅，因此“真机采集”启动时会先检查 `getCapabilities()`，缺少 GYRO 时立即返回失败。此分支不会启动运动引擎、`service.health` 订阅或真实传感器数据流，也不会创建可保存的训练会话。真实 GYRO 仍需目标设备 SDK 或原生适配层。

4. 功耗

同步复盘页的诊断面板可读取电量状态，但模拟器不能证明真实功耗。功耗需要在真机上进行至少 15 分钟连续运动复测，记录起止电量、发热、掉帧和振动次数。

5. 原模型推理

当前 `tiny_classifier` 是端侧轻量规则/特征模型。若要求论文模型等价复现，需要把 `.pth` 转成 openvela 可运行的 native/量化推理模块，并通过 `setNativeModelBackend()` 或 `globalThis.velamotionModel.classifyWindow()` 接入。

6. 手机同步

已实现摘要发送和 JSON 导出预览。没有配套手机端或互联能力不可用时，应用不上传数据，仍可独立运行。

## 降级策略

| 能力缺失 | 降级策略 |
|---|---|
| `service.health` 不可用 | 使用 Mock HR/SPO2/STRESS |
| 官方步数 Mock enum 不存在 | 应用内 MockProvider 生成 steps |
| 真机无步数接口 | UI 显示边界；仅在 ACC/GYRO 六轴能力完整时，分类可不依赖步数继续运行 |
| 真实 GYRO JS API 不存在 | 阻断完整真机识别并显示“不会保存”；不以全零 GYRO 冒充六轴采样，等待原生适配 |
| 振动不可用 | UI 显示“模拟提醒” |
| velaclaw 不可用 | 本地模板总结 |
| 手机互联不可用 | 展示 JSON 摘要，不影响手表端独立运行 |
