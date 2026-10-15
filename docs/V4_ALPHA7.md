# 4.0.0-alpha7 交付记录

本轮在 `codex/refactor-v4` 的独立 worktree 完成波形浮点显示、多选分组和文字配色。
3.x 原目录继续由用户维护；本轮只读检查原目录状态，未安装到用户 IDE、推送、合并或发布。

## 结果

- “显示格式”成为子菜单，整数、模拟量和浮点按类别排列，当前项以单选状态标记。
- 波形和二维 mem 共用 FP64、FP32、TF32、BF16、FP16、FP8(E3M4)，位宽不适用时禁用。
- 支持正常数、非正规数、正负零、Inf/NaN；未知位保持 X/Z。E3M4 按用户确认使用偏置 3、全 1 指数保留给 Inf/NaN。
- TF32 支持 19 位紧凑编码和低 13 位为零的 32 位 RTL 容器；非法容器有明确提示。位布局约定与来源见 [WAVEFORM.md](WAVEFORM.md#浮点显示)。
- Shift 范围从独立锚点选择并可收缩，Ctrl/Command 切换选择；在已选信号上右键保留集合，未选信号上右键只操作该行。
- 新建分组使用有校验的对话框，支持加入已有组、解除分组、多行整体拖动；组内顺序保留。
- 菜单支持键盘、焦点恢复和屏幕边缘翻转；输入框保留自己的快捷键。菜单打开时固定目标，防止选择变化误操作。
- 数值取消矩形底色，随明暗主题使用清晰文字与细轮廓，保留总线淡填充和 X/Z 颜色；科学计数法缩略保留完整指数。

## 模块分离

浮点位域与特殊值分类集中在 `value-format.js`，统一格式目录和适用性由 `model.js` 提供。
纯选择/分组/排序规则位于 `interaction.js`，`menu.js` 负责 DOM 层级与焦点，client 负责操作和保存。
renderer 测量字宽、选择颜色与缩略文本；memory 复用格式目录和精确位值，不增加转换分支。
格式切换和同一组可见 ID 的重排复用查询结果，浮点解码不会重新请求 VCD。
没有新增运行依赖；事件存储、后台流式加载及有界查询继续沿用原实现。

## 验收

| 检查 | 结果 |
|---|---|
| JS 语法 | 92 个文件通过 |
| 格式化 golden 与幂等 | 36/36，18 组样例 |
| Node 回归 | 421/421，0 fail，0 skip |
| 浮点解码新增合同 | 11 项，含穷举与独立解码对照 |
| 多选与分组新增合同 | 15 项 |
| Canvas 绘制新增合同 | 10 项，含科学计数法安全缩略 |
| 共享格式与 memory 新增合同 | 3 项，覆盖目录、位宽、缓存 A/B 和状态恢复 |
| Rust | 112/112；版本同步并重建，原生实现未改 |
| CLI | `svtools 4.0.0-alpha7` |
| 真实浏览器 + VCD Worker | 明暗主题、浮点特殊值、菜单、多选、分组、布局恢复与二维 mem A/B 通过；无 console 警告或错误 |

FP16/BF16 各穷举 65536 个编码，E3M4 穷举 256 个编码；FP64/FP32 使用独立 DataView 对照，
TF32 验证两种布局对应以及非零填充拒绝。生产解码不依赖 `DataView.getFloat16`。
全量日志为 `bin/alpha7-package.log`，Rust 日志为 `bin/alpha7-rust-tests.log`。
独立 Rust 测试进程有 Node-API 动态符号探测提示，112 项测试仍全部完成，native 在 Node golden 管线中实际加载通过。

浏览器运行实际生产 client/renderer/menu，数据经过实际 VCD Worker；loopback 适配仅替换 VS Code 消息桥。
页面夹具含六种浮点、TF32 两种布局、特殊值及 2×2 FP32 memory。实际验收包括：

- Shift 扩展后缩小范围，右键保留多选；19/32 位混选仅允许共同适用的 TF32 等格式。
- 建立“计算输入”组，再把第三条信号加入；重新打开页面后恢复格式、组及 A/B。
- mem 在 A=0ns、B=100ns 显示 1→2、2→3、3→4、4→5，并标记 Δ。
- Shift+F10 打开菜单，右键屏幕最右侧后子菜单向左展开，Esc 逐层返回且恢复 Canvas 焦点。
- 深浅主题中最小非正规数指数完整，X/Z 和正常文字保持区分。

报告和截图位于 `bin/waveform-acceptance/run-gbrTl4/`；临时浏览器和服务已关闭。
复现入口：`node scripts/preview-waveform.js`。页面仅绑定 loopback，工具和夹具不进入 VSIX。
alpha2 的 100/500 MiB 数据服务历史测量保留在 WAVEFORM.md；本轮验收针对显示与交互。
实际 VS Code webview、用户 RTL 与其他平台仍需实机使用反馈。

## 发布包核验

- 文件：`bin/svtools-4.0.0-alpha7.vsix`，Windows x64 本地测试包。
- 大小：2292675 字节，78 个 ZIP 条目。
- SHA-256：`d89702add6ebc6732f5b75eaecf797ce118dd19cae47bd936ce5b6d8ca47aff9`。
- 74 个打包文件逐字节一致，其中 56 个 `src` JS/CSS；native、资源、标准目录、许可证、配置与入口均核对。
- README/CHANGELOG 由 VSCE 改写链接和换行，已核对 alpha7 标题；包清单和源码版本一致，中英文 106 个配置引用均完整。
- 没有 scripts/tests/docs、native 源码、开发依赖、VCD、日志或 CLI 可执行文件混入。
- 报告：`bin/alpha7-package-report.json`。构建产物留在忽略的 `bin/`，源码提交不含二进制。

## 质量复核

架构技能原始报告 `bin/waveform-quality-raw.json` 保留 7 个 Blocker、4 个 Critical。
4 项 Critical 均是把真实输入提示 `placeholder` 误当占位实现；2 项 Blocker 把 DOM 或自定义对象的
`contains` 误当数组 API；4 项把空配置/可选字段字面量误当函数；剩余一项为只持 URI 的
CustomDocument 无资源 `dispose`，worker 生命周期由面板负责，关闭/取消合同继续通过。
逐项源代码与运行证据见 `bin/waveform-quality-review.json`，未解决 Blocker/Critical 为 0。
保留菜单 item、消息 event.data 和 VCD var 的领域上下文命名，原始结果未改写。
科学计数法截断的定位与取舍见 [调试记录](bugs/logic-waveform-scientific-label-clipping.md)。

## 修改文件

以下清单对应本轮 Git 差异；忽略的构建、日志和截图另列于上文。

| 文件 | 本轮变更 |
|---|---|
| `ARCHITECTURE.md` | 记录浮点、交互、菜单与绘制模块边界。 |
| `CHANGELOG.md` | 记录 alpha7 行为、原因与影响面。 |
| `CONTEXT.md` | 更新开发交接、验证与当前测试包。 |
| `README.md` | 开发版本更新到 alpha7。 |
| `docs/WAVEFORM.md` | 补齐操作、浮点编码、位宽与文字显示说明。 |
| `docs/V4_ALPHA7.md` | 本轮结果、验收、包核验与完整清单。 |
| `docs/bugs/logic-waveform-scientific-label-clipping.md` | 记录指数截断的根因与安全缩略。 |
| `package.json` | 注册三组回归测试，更新版本。 |
| `package-lock.json` | 同步根版本。 |
| `scripts/preview-waveform.js` | 真实生产页面与 Worker 的 loopback 验收入口。 |
| `src/native/Cargo.toml` | 同步 crate 版本。 |
| `src/native/Cargo.lock` | 同步 crate 锁版本。 |
| `src/native/package.json` | 同步 native 包版本。 |
| `src/native/package-lock.json` | 同步 native 锁版本。 |
| `src/waveform/value-format.js` | 浮点目录、校验、分类与解码。 |
| `src/waveform/model.js` | 统一显示格式目录、适用性与解码入口。 |
| `src/waveform/interaction.js` | 提取选择锚点、目标冻结、分组与排序规则。 |
| `src/waveform/menu.js` | 子菜单、键盘、焦点和定位。 |
| `src/waveform/client.js` | 接入多选/分组/菜单，复用查询并校验恢复格式。 |
| `src/waveform/memory-view.js` | 共用浮点目录，缓存 A/B 重新格式化。 |
| `src/waveform/renderer.js` | 主题文字与细轮廓，保留科学计数法指数。 |
| `src/waveform/view.css` | 菜单、分组对话框与主题文字配色。 |
| `src/waveform/view.js` | 装配新模块，统一 memory 格式入口与操作提示。 |
| `test/waveform_float_test.js` | 浮点穷举、独立对照与边界合同。 |
| `test/waveform_interaction_test.js` | 多选、右键、分组、排序和适用性合同。 |
| `test/waveform_renderer_test.js` | Canvas 文字、轮廓、主题和安全缩略合同。 |
| `test/waveform_memory_view_test.js` | mem 浮点、双游标、禁用格式和恢复合同。 |
| `test/waveform_ui_test.js` | 共享目录与模型解码合同。 |
