# 4.1.0-alpha5：电路交互性能

2026-10-16。[草稿PR #11](https://github.com/JayceVane/SV-Tools/pull/11)，分支`codex/feat-circuit-viewer`，原工程保持4.0 preview。

## 实现与范围

针对用户反馈的拖拽、缩放和选择卡顿，完成四项改造：

1. 相机逻辑即时更新，rAF每帧只提交一次最新变换；视口几何只在换图/resize读取，滚轮不再交替读写布局。
2. 静态包围盒树查询视口与100px过扫描区，折线段相交保留跨屏连线；屏外SVG移出活动DOM，重入保留对象身份、原始绘制顺序和选择状态。
3. 小于65%隐藏引脚名称，小于35%隐藏文字、引脚和时钟符号；正常倍率自动恢复完整细节。
4. 共享模块拓扑/搜索/别名索引，增量高亮只更新选择差集；重复选择不重建详情。

领域模型、Yosys/Vivado语义、ELK布局和2000节点/6000边/16384引脚预算不变。未实现领域数据分页、逻辑锥或Canvas渲染；完整图与屏外DOM仍保留在内存。Tab经过当前已挂载单元，屏外对象可搜索定位。

## 浏览器实测

本机Windows、Edge155 headless，1440×1000窗口、DPR1。正式nonce CSP页面加载生成的已布局图，替换宿主消息桥；每节点2引脚，三路连接。每种操作90次，丢弃前5次，拖拽每帧8事件、滚轮每帧4事件。前后使用同一脚本，alpha4对照来自已验证VSIX解包目录。原始JSON与截图在`bin/circuit-interaction/`，不进入版本库和安装包。

| 指标，中位数 | alpha4解包 | alpha5解包，2000节点/5994边 |
|---|---:|---:|
| 缩放帧间隔 | 281.0ms | 31.2ms |
| 缩放输入处理 | 152.3ms | 0.1ms |
| 拖拽输入处理 | 0.4ms | 0.1ms |
| 选择处理 | 2.0ms | 0.3ms |
| 拖拽帧间隔 | 31.2ms | 31.3ms |
| 选择帧间隔P95 | 62.5ms | 31.6ms |
| 拖拽transform提交 | 712 | 90 |
| 缩放transform提交 | 360 | 90 |
| 活动SVG元素 | 54646 | 1558 |
| 数据展示就绪，含建图及两帧 | 427.5ms | 134.5ms |

最终同脚本对照见`baseline-final.json`、`packaged.json`；此前两次alpha4缩放中位数250.3/280.9ms，优化源页面为31.2ms，与解包结果一致。

500节点/1494边时同一局部视口也挂载1558个SVG元素，缩放帧中位数31.2ms。8%总览仍有6944个可见对象/47046个活动SVG元素，缩放中位数62.5ms、P95为93.9ms，说明全图总览仍受可见对象总量影响。本机rAF采样约31ms，不据此承诺60fps或任意设计同等提升。浏览器基准不包含Yosys与ELK，也不能代替实际IDE宿主验收。

500/2000节点的浏览器检查覆盖取消拖拽恢复相机、屏外搜索后对象可见、pointer事件点击网络详情与高亮、明暗主题，无页面异常。截图已人工检查。总览基准选择当前可见单元，避免假定固定节点一直在屏内。

复验：

```powershell
node scripts/benchmark-circuit-interaction.js --nodes 2000 --label current --acceptance
node scripts/benchmark-circuit-interaction.js --nodes 500 --label smaller --acceptance
node scripts/benchmark-circuit-interaction.js --scale .08 --label overview
node scripts/benchmark-circuit-interaction.js --extension-root <alpha4解包目录> --label baseline
```

## 架构审查

新增`graph-index.js`只处理拓扑、搜索与信号别名，`viewport.js`只处理几何，均不依赖DOM、VS Code或外部库；renderer适配SVG，client接线与相机生命周期。依赖扫描无环。新增模块MI分别35.19、37.57，无新增模块复杂度热点。

全电路静态扫描MI均值32.7、机械健康分35；createClient/renderGraph的嵌套回调累计及既有模型/投影长函数仍被标记，不能将该分数宣称整体门禁通过。人工审查本轮新增边界：无假实现、占位错误处理、循环依赖或新增运行依赖。后续事件接线仍需控制规模，本轮未扩张成整个模型/投影的重构。回归检查验证位序、来源和错误处理不受影响。

定位过程见[SVG交互调试记录](bugs/perf-circuit-svg-interaction.md)。按帧提交依据[requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)；SVG绘制和display边界见[SVG2绘制模型](https://www.w3.org/TR/SVG/render.html)。

## 验证与安装包

| 检查 | 结果 / bin本地证据 |
|---|---|
| JS语法 | 143文件，`circuit-alpha5-package.log` |
| Golden | 38/38，19用例 |
| 既有Node | 512项：511通过，1可选目录重建跳过 |
| 电路Node | 118/118；新增8项覆盖相机、虚拟化、几何与索引 |
| Rust | 121/121，`circuit-alpha5-rust.log` |
| 包内浏览器 | 正式HTML/新增脚本在nonce CSP下加载，性能及四项交互检查通过；`circuit-alpha5-browser-packaged.log` |
| 包内原生ABI | 实际Qoder CN IDE Node24.15.0/Electron42.2.0加载格式化模块并核对字符守恒；`circuit-alpha5-qoder-native.log` |
| VSIX | 437文件，18,510,592字节；421个运行文件逐字节匹配；`circuit-alpha5-package-report.json` |
| 远程CI | Node22/24矩阵，最终状态见草稿PR11；本地不替代远程结果 |

完整IDE Webview宿主未在本轮重新验收；此前VS Code独立宿主被安装更新锁阻挡。浏览器替代桥和Electron的Node模式均不能计作完整宿主通过。本轮未改工具适配器，真实Vivado/Yosys语义验证沿用alpha3/4，完整电路回归包含实际内置编译器。

包：`bin/svtools-4.1.0-alpha5-win32-x64.vsix`，安装后重载窗口。

```text
5a2f781e62c6d95e0e4a31fbeac10109a682f6b820419c4f5d192509d3a78d1b
```

## 完整文件清单（相对alpha4）

| 文件 | 修改 |
|---|---|
| `ARCHITECTURE.md` | 页面索引、几何、SVG与相机的职责边界 |
| `CHANGELOG.md` | alpha5性能行为与影响 |
| `CONTEXT.md` | alpha5交接和后续边界 |
| `README.md` | alpha5版本及视口按需挂载说明 |
| `docs/CIRCUIT.md` | 总览细节、键盘可见范围及基准复验入口 |
| `docs/ROADMAP.md` | 当前进展同步alpha5 |
| `docs/V4_1_ALPHA5.md` | 本轮数据、验证边界与完整清单 |
| `docs/bugs/perf-circuit-svg-interaction.md` | 同步布局、display裁剪与活动DOM的排查证据 |
| `package.json` | 扩展版本alpha5 |
| `package-lock.json` | 扩展版本同步 |
| `scripts/benchmark-circuit-interaction.js` | 独立Chromium性能基准、交互检查和截图 |
| `src/circuit/client.js` | 按帧相机、缓存视口、索引详情与生命周期清理 |
| `src/circuit/graph-index.js` | 拓扑邻接、搜索与位别名的共享索引 |
| `src/circuit/renderer.js` | 屏外SVG挂载、稳定绘制顺序与差集高亮 |
| `src/circuit/view.css` | 缩放细节级别与拖动命中样式 |
| `src/circuit/view.js` | nonce脚本顺序装配新增纯模块 |
| `src/circuit/viewport.js` | 静态包围盒树、视口及折线相交查询 |
| `src/native/Cargo.toml` | crate版本同步alpha5，Rust实现不变 |
| `src/native/Cargo.lock` | crate版本同步 |
| `src/native/package.json` | napi包版本同步 |
| `src/native/package-lock.json` | napi锁版本同步 |
| `test/circuit_view_test.js` | 相机合帧、生命周期、虚拟化与增量选择回归 |
| `test/circuit_viewport_test.js` | 几何穷举对照、穿屏折线与索引语义回归 |
