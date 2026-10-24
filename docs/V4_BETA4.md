# 4.0.0-beta.4：选中高亮对比度

2026-10-16。修复电路图亮色主题下选线不可见，继续独立codex/feat-circuit-viewer分支与草稿PR11；本轮提供本地VSIX，公开Release仍为beta.2，正式版目标4.0.0。

## 修复与边界

电路图不再将IDE焦点边框作为选中颜色。亮色采用#005fb8，暗色#59c9ff，高对比暗色#ffff00；连线、端点、连接条、关联节点与位宽文字同步高亮。选择算法、线宽和网表数据没有改动。

旧beta.3解包页面实际点击复现：焦点色白色/透明/背景同色时，选中对象还在DOM，但计算stroke与背景不可区分，对比度1:1。修复后检查系统明暗偏好各一轮，每轮四类IDE主题及白色/透明/背景同色焦点变量共6种组合，12种均通过。当前场景最小对比度5.93:1，不代表任意自定义背景都已验收。

## 最终验证

| 检查 | 结果 / bin本地证据 |
|---|---|
| 原生重建 | release模块/CLI版本均为4.0.0-beta.4；circuit-beta4-build.log |
| JS语法 | 154文件；circuit-beta4-package.log |
| Golden | 40/40，20用例 |
| 既有Node | 516项，515通过、1可选目录重建跳过 |
| 电路Node | 169/169 |
| Rust | 125/125；circuit-beta4-rust.log |
| 实际Qoder运行时 | Node24.15.0/Electron42.2.0加载包内native ABI并验证格式化；circuit-beta4-qoder-native.log |
| 正式页面主题 | Edge155，系统明/暗偏好×6种IDE主题/焦点变量场景，12种均通过；circuit-beta4-themes-light.log、themes-dark.log |
| 选中颜色与线宽 | 总线4.2px/单比特2.7px保持；连线、位宽文字及相关端点计算颜色均可见，最小对比度5.93:1 |
| VSIX | 443文件、18,530,616字节，427运行文件逐字节一致；circuit-beta4-package-report.json |
| CLI | svtools --version输出svtools 4.0.0-beta.4 |
| 远程CI | Node22/24最终状态见[草稿PR11](https://github.com/JayceVane/SV-Tools/pull/11) |

安装包：`bin/svtools-4.0.0-beta.4-win32-x64.vsix`。安装后重载窗口并重新打开电路页。

SHA256：`609cc64ee191c67bf6866216340d6bf7ab7b6b2c3ace02f2b7d1cdcfa163577b`。

旧包失败记录：`bin/circuit-selection-before.log`与`bin/circuit-interaction/beta3-selection-before.json`。最终正式页面数据：`bin/circuit-interaction/beta4-packaged-selection-light.json`和`beta4-packaged-selection-dark.json`；前者/后者的light/dark表示模拟的系统偏好，两份均覆盖四类IDE主题。亮色选中截图：`beta4-packaged-selection-dark-selected.png`，包含系统暗色/IDE亮色的交叉场景。

实际Qoder使用Electron的Node运行时，浏览器注入宿主主题变量；这些不等于用户真实IDE Webview主题已直接复验。原工程、RTL、选择及连线逻辑均未修改。


## 完整文件清单（相对beta.3）

| 文件 | 修改 |
|---|---|
| `src/circuit/view.css` | 独立电路选中/悬停高亮色，覆盖连线、端点、节点与位宽文字 |
| `package.json` | 扩展版本beta.4 |
| `package-lock.json` | 扩展锁版本同步 |
| `src/native/Cargo.toml` | 原生crate/CLI版本同步 |
| `src/native/Cargo.lock` | Rust锁版本同步 |
| `src/native/package.json` | 原生npm版本同步 |
| `src/native/package-lock.json` | 原生npm锁版本同步 |
| `README.md` | 当前预览和修复说明 |
| `CHANGELOG.md` | beta.4变更、原因与影响 |
| `CONTEXT.md` | 复现、修复与交接 |
| `docs/CIRCUIT.md` | 主题高亮使用说明 |
| `docs/ROADMAP.md` | 同步完善进度 |
| `docs/bugs/logic-circuit-selection-contrast.md` | 根因、遗漏的验收场景及修复笔记 |
| `docs/V4_BETA4.md` | 验证、边界与完整清单 |

原生模块、CLI、VSIX、主题探针、截图及日志在已忽略的bin/，不提交。
