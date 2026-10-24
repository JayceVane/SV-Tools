# 4.0.0-beta.6：波形标记与逐位调试

2026-10-17。增加六色背景标记与清除、2000行内的总线bit展开/收起，以及输入/输出/双向/内部/未知图标。操作和边界见[WAVEFORM.md](WAVEFORM.md)。延续beta.5电路临时文件过滤；不改原工程或用户RTL。开发分支codex/feat-circuit-viewer，草稿PR11；本轮仅本地VSIX，公开Release仍beta.2，正式版目标4.0.0。

展开三角已由11px字形放大为独立20px字形，同时扩展命中区，保留行顶部空白拖选带；信号文字字号和38px数字行高不变。本次微调复用既有回归：66项相关检查与完整检查通过，最终解包页面明暗主题及操作通过。图标微调日志为`bin/wave-beta6-icon-package.log`、`bin/wave-beta6-icon-browser/report.json`，截图同目录；首次热区验证日志保留为`bin/wave-beta6-icon-package-first.log`，最终热区保留行顶端空白以兼容点选和拖动。

## 验证

| 检查 | 结果 |
|---|---|
| JS语法 | 158文件通过 |
| Golden | 40/40，20例 |
| Node功能 | 544项：543通过，1项可选官方目录重建跳过 |
| 电路 | 169/169 |
| Rust | 125/125 |
| Node22.20相关 | 112/112 |
| 最终VSIX | 445文件，429运行文件逐字节一致 |
| 最终包正式页面 | Edge明暗、真实Pointer、批量颜色、角色、bit边沿、重载和收起通过 |
| 实际Qoder Node运行时 | Node24.15.0/Electron42.2.0，解包native ABI、波形worker、input角色及目标位20ns边沿通过 |
| CLI | svtools 4.0.0-beta.6 |

最终包：`bin/svtools-4.0.0-beta.6-win32-x64.vsix`。安装后重载窗口，再重开波形。

首次完整运行遇到既有工具链超时用例的进程退出超时；单独26/26复查通过，确认无残留进程后，第二次完整检查通过。最终审阅另补上活动信号切换使旧位边沿请求失效的回归（旧代码游标错误跳到80，修复后保持0），随后再跑最终完整检查。原始失败证据保留`bin/wave-beta6-package-first.log`及`bin/wave-beta6-edge-selection-red.log`。

Node22相关112/112通过。`scripts/verify-waveform-signals.js`使用本机隐藏Edge、正式页面、真实Pointer、loopback桥和真实VCD worker，明暗主题都通过：多选着色不额外查询、正确角色、4位展开、目标位跳过其它位变化后到40ns、重载恢复和收起。不是完整IDE Webview宿主验收。

100/500MiB确定性语料为64个独立id加1条alias，含256bit重复计数总线、时钟、稀疏控制和real；不是任意工程性能保证。加载时包含只读源方向匹配；只3/65个声明有匹配RTL，其余正确保留未知。两个文件均展开256位并校验160ns位值、目标位首边沿10240ns及全文件无边沿续查。

| 文件 | 字节 | 加载ms | 紧凑存储字节 | worker堆字节 | 窗口字节 | 窗口ms | 256位投影ms | 全位扫描ms / 块数 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 100MiB | 104857613 | 1172.97 | 79629794 | 10531576 | 728834 | 12.81 | 8.88 | 8.12 / 3 |
| 500MiB | 524288003 | 6813.85 | 384699874 | 5815136 | 731406 | 13.48 | 8.91 | 25.06 / 11 |

单次本机测量不作加速比或任意宿主帧率承诺。边沿从压缩载荷取位；百万位测试禁止整值解码仍通过。bit密集标记保守沿用父窗口，过宽总线展开菜单明确禁用。方向不执行完整详细化，扫描不完整即保留未知。

证据位于忽略的bin/：wave-beta6-node22.log、wave-beta6-browser/report.json及明暗截图、wave-beta6-large-report.json、wave-beta6-build.log。最终包核验：`bin/wave-beta6-package-report.json`、`bin/wave-beta6-qoder.log`、`bin/wave-beta6-final-browser/report.json`及明暗截图；完整回归日志`bin/wave-beta6-package.log`、`bin/wave-beta6-rust.log`。包大小18,542,752字节，SHA256：`7e208b461087e416cb6bdf5b20c78b32905ea4f1e79ec55321b17d7c390785ee`。Rust测试包含既有N-API宿主提示，实际Qoder加载另外核验通过。

## 完整文件清单（相对beta.5）

| 文件 | 修改 |
|---|---|
| `ARCHITECTURE.md` | 派生位、压缩查询及只读角色边界 |
| `CHANGELOG.md` | beta.6变更、原因和影响 |
| `CONTEXT.md` | 交接状态 |
| `README.md` | 当前版本与波形入口说明 |
| `docs/ROADMAP.md` | 同步完善状态 |
| `docs/bugs/logic-waveform-edge-selection.md` | 迟到边沿结果失效的根因与回归记录 |
| `docs/V4_BETA6.md` | 交付证据及完整修改清单 |
| `docs/WAVEFORM.md` | 操作、方向来源及容量边界 |
| `package-lock.json` | 扩展锁版本同步 |
| `package.json` | beta.6版本及新增回归纳入完整检查 |
| `scripts/preview-waveform.js` | 方向/别名/范围语料及最终包运行入口 |
| `scripts/verify-waveform-signals.js` | 真实浏览器明暗及Pointer验收 |
| `src/native/Cargo.lock` | Rust锁版本同步 |
| `src/native/Cargo.toml` | 原生crate与CLI版本同步 |
| `src/native/package-lock.json` | 原生npm锁版本同步 |
| `src/native/package.json` | 原生npm版本同步 |
| `src/waveform/client.js` | 多选背景、bit管理、恢复与位查询续查 |
| `src/waveform/host.js` | 源上下文传递、日志和取消期间抑制迟到启动 |
| `src/waveform/index.js` | 为面板提供只读源上下文 |
| `src/waveform/menu.js` | 新增图标及白名单色块 |
| `src/waveform/model.js` | 共用派生位读值和恢复有效键 |
| `src/waveform/renderer.js` | 整行淡底、角色、展开标记及可见位缓存 |
| `src/waveform/row-gesture.js` | 三角点击、悬停角色与既有排序/缩放兼容 |
| `src/waveform/session.js` | 打开时传源上下文，位边沿查询合同 |
| `src/waveform/signal-display.js` | 颜色/图标目录、派生位身份及窗口投影 |
| `src/waveform/source-roles.js` | 只读源发现、受限解析和精确角色匹配 |
| `src/waveform/store.js` | 压缩载荷取位、有界边沿续查 |
| `src/waveform/view.css` | 角色与颜色样式，保持字号 |
| `src/waveform/view.js` | 在CSP页面内注册展示模块 |
| `src/waveform/worker.js` | 后台方向匹配与降级说明 |
| `test/helpers/waveform-client-harness.js` | 测试边界加载展示模型 |
| `test/waveform_host_test.js` | 源上下文等待期间取消回归 |
| `test/waveform_renderer_test.js` | 真实Canvas背景和bit单线/读值回归 |
| `test/waveform_signal_test.js` | 位序/投影/恢复/角色/交互/压缩与worker回归 |

原生模块、CLI、VSIX、浏览器profile与本机验收语料位于忽略的bin/，不提交。
