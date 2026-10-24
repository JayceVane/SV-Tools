# 4.0.0-beta.3：总线拼接与拆分

2026-10-16。独立codex/feat-circuit-viewer分支和[草稿PR11](https://github.com/JayceVane/SV-Tools/pull/11)继续保留。4.0.0-beta.2已公开发布，本轮beta.3提供本地VSIX，正式版目标4.0.0。

## 行为

用户LEVEL=2的CDC例子现在有D/Q/AD三个2bit主干，D的两个1bit分支分别对应i_bit与Q[0]，Q[1]输出o_bit；复位常量明确1b×2。连接条标签标出完整位数，分支标出自身宽度与端口位位置。位位置从LSB=0计数，不冒充声明范围。详情保留逐位映射，主干和分支按各自真实位数决定粗细。

分支选择可经过主干但不扩散到其它位，普通引脚保留局部高亮。连接条不代表新增硬件，不改变领域位序、工具参数、来源或原工程。节点/连线/引脚继续计入2000/6000/16384展示预算；多片段总线会增加布局规模，普通完整总线不创建连接条。

## 验证

| 检查 | 结果 / bin本地证据 |
|---|---|
| JS语法 | 154文件；circuit-beta3-package.log |
| Golden | 40/40，20用例 |
| 既有Node | 516项：515通过、1可选目录重建跳过 |
| 电路Node | 169/169，比beta.2增加15项；其中真实用户CDC源码经Slang→Worker→ELK自动回归 |
| Rust | 125/125；circuit-beta3-rust.log |
| Node22.20相关回归 | 63/63；circuit-beta3-node22.log |
| 实际Qoder运行时 | Node24.15.0/Electron42.2.0，包内native ABI及内置编译/布局通过；circuit-beta3-qoder-native.log、qoder-cdc.log |
| 真实CDC图 | 9节点/9连线，3个总线连接节点，完整主干2bit；硬件单元仍1个 |
| 正式页面 | Edge155，明暗主题、线宽、标签点击/避让及缩放通过；circuit-beta3-packaged-browser.log |
| 复杂页面 | 最终解包页面2000节点/5994条32bit线，取消拖动、屏外搜索、网络点击及深色主题通过；circuit-beta3-benchmark.log |
| 依赖与质量 | 无循环依赖；新增映射职责独立。既有client/projection/renderer仍有复杂度热点，未声称整体质量门槛全部通过 |
| VSIX | 443文件、18,530,152字节，427运行文件逐字节一致；circuit-beta3-package-report.json |
| CLI版本 | svtools 4.0.0-beta.3 |
| 远程CI | Node22/24最终状态见[草稿PR11](https://github.com/JayceVane/SV-Tools/pull/11) |

安装包：`bin/svtools-4.0.0-beta.3-win32-x64.vsix`，安装后重载窗口并重新生成电路。

SHA256：`8b86e48233e6614ff92f20d3869ebbc251aafd01694f331cf84c34bf4ff27e58`。

截图：`bin/circuit-interaction/beta3-packaged-cdc.png`及`beta3-packaged-cdc-dark.png`。Qoder使用Electron的Node模式，浏览器验证包内正式页面；这些不等于完整IDE Webview宿主验收。原工程与用户RTL不变。

复杂图单次合成事件复验：首次绘制169.0ms，活动DOM1743；拖拽帧中位/P95为16.7/16.8ms，缩放为16.7/16.8ms，选择处理中位0.3ms。此场景检验页面索引与交互，不含新增连接节点的ELK布局成本，也不作为新的加速或任意宿主60fps承诺；原始数据保留在`bin/circuit-interaction/beta3-bus32-2000.json`。


## 完整文件清单（相对beta.2）

| 文件 | 修改 |
|---|---|
| `ARCHITECTURE.md` | 补充总线展示投影与成员索引边界 |
| `CHANGELOG.md` | beta.3变更、原因与影响 |
| `CONTEXT.md` | 本轮复现和交接 |
| `README.md` | 当前开发预览与拼接/拆分能力 |
| `docs/CIRCUIT.md` | 主干/分支、位位置及重复驱动操作说明 |
| `docs/ROADMAP.md` | 同步beta.3完善进展 |
| `docs/bugs/logic-circuit-bus-connections.md` | 真实CDC数据、根因及修复取舍 |
| `docs/V4_BETA3.md` | 验证、边界与完整清单 |
| `package.json` | 扩展版本beta.3 |
| `package-lock.json` | 扩展锁版本同步 |
| `src/native/Cargo.toml` | 原生crate及CLI版本同步 |
| `src/native/Cargo.lock` | Rust锁版本同步 |
| `src/native/package.json` | 原生npm版本同步 |
| `src/native/package-lock.json` | 原生npm锁版本同步 |
| `src/circuit/bus-routing.js` | 新增独立拼接/拆分、重复/重排展示投影 |
| `src/circuit/projection.js` | 接入连接条并计入原展示预算 |
| `src/circuit/graph-index.js` | 主干成员索引和不跨位扩散的选择 |
| `src/circuit/renderer.js` | 连接条、分支位置与引脚位宽 |
| `src/circuit/client.js` | 总线类型和有界逐位映射详情 |
| `src/circuit/view.css` | 主干/分支线型、映射标签和标题轮廓 |
| `test/circuit_bus_routing_test.js` | 新增位序、重复/重排、预算和选择回归 |
| `test/circuit_bundled_test.js` | 真实用户CDC源码经Slang/Worker/ELK回归 |
| `test/circuit_layout_test.js` | 显式主干计数与原位数组/别名合同 |
| `test/circuit_view_test.js` | 连接条线型、分支标签及映射详情回归 |

原生模块、CLI、VSIX、电路JSON、截图、探针和验收日志位于已忽略的bin/，不提交。
