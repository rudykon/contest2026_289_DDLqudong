# 腕动教练 · GitHub Pages 展示页

[打开在线展示](https://rudykon.github.io/contest2026_289_DDLqudong/)

项目介绍、可交互的腕上界面、真实 WebAssembly 计算演示、黄山派实物照片与固件入口。纯静态页面，无服务器推理、外部字体、统计脚本或第三方运行时 CDN。

## 本地运行

需要 Node.js 22 或更新版本：

```sh
cd website
npm ci
npm run build
npm test
npm run serve
```

浏览器打开 `http://127.0.0.1:4173`。请通过 HTTP 服务访问，直接打开 `file://` 不能正常加载模块和 Worker。

浏览器交互回归：

```sh
npx playwright install chromium
npm run test:browser
```

可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定已有 Chromium；通过 `BASE_URL` 指定带末尾 `/` 的已部署网站。测试覆盖完整混合会话、暂停/继续/重置、场景切换、后台暂停、计算跑分、导出、WASM 加载失败与重试、手机布局和运行时请求来源。

## 计算链路与边界

1. Worker 复用项目 `mock_scenarios.js`，按 16 Hz 虚拟时间生成六轴数据。种子固定为 289，每次重置可重放。`4×` 只加快演示时间推进，不改变算法采样率。
2. AssemblyScript 将项目 `imu_features.js` / `tiny_classifier.js` 的数值计算移植为 WASM：48 帧 × 6 通道，3 秒窗口、1 秒步长，23 个特征、六类候选评分。当前移植基线为 `03f3543`。这是一套特征规则模型，未部署深度模型。
3. 项目原有 JS `TemporalRecordLayer` 负责平滑、时序解码与片段整理；浏览器负责控件和 Canvas。末尾片段为当前解码结果，未额外伪造最终识别。
4. 每段会话有固定长度（混合训练 62 秒），完成后停止；页面转入后台自动暂停。重置与场景切换通过会话编号排除过期消息。
5. 计时来自 `performance.now()`。单窗口计时不含数据复制、JS 时序解码和绘图；批量计时为预热后重复执行当前窗口 3,000 次。它反映当前浏览器的内核执行耗时，不代表黄山派性能或人体识别准确率。

WASM 接口：`input_ptr()` 指向 288 个 f64（逐帧 accX/Y/Z、gyroX/Y/Z）；`classify(heartRate)` 返回类别下标；`output_ptr()` 指向六类归一化评分；`features_ptr()` 指向 23 个特征。`heartRate` 使用合成场景值，传 0 表示使用项目默认值。线性内存固定为 64 KiB，计算时不分配新缓冲区。ABI 版本为 1，分类顺序与原项目 `CLASS_NAMES` 一致。

`test/wasm.test.mjs` 对照原 JS 的 192 个有种子窗口和边界输入，逐项验证特征、评分与类别，同时验证固定内存和重复计算。WASM 加载失败时显示错误并停止演示，不使用伪装成 WASM 的 JS 替代路径。

网站不连接开发板、不读取真实传感器。黄山派当前固件仍运行 JS 实现，真实六轴到 JS、断电持久化及真人效果验证仍待完成。候选评分不是识别准确率。所有演示数据留在浏览器；导出通过本地 Blob 下载 JSON。

## 构建与部署

- `assembly/classifier.ts`：可审查的 WASM 数值实现。
- `public/`：页面、样式、Worker 与交互逻辑。
- `scripts/build.mjs`：编译 WASM，仅复制上述页面、三个算法/场景 JS 模块、三张已移除定位元数据的公开照片和许可证到 `dist/`。
- `dist/build-info.json`：WASM 文件大小与 SHA256，以及算法来源信息。
- `.github/workflows/pages.yml`：默认开发分支触发构建、数值对照、浏览器测试与 Pages 发布；只发布 `website/dist/`。

`dist/`、依赖、测试截图与临时下载不提交 Git。比赛报告、讲解视频、交付 ZIP 和开发日志不属于网站构建输入。源码遵循仓库 Apache-2.0 许可证；AssemblyScript 编译器为 Apache-2.0，构建/测试依赖版本锁定在 `package-lock.json`。
