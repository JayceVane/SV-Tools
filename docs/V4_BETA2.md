# 4.0.0-beta.2 交付记录

2026-10-16。当前预览版统一为4.0.0-beta.2，正式版目标4.0.0。独立worktree与codex/feat-circuit-viewer继续保留；现有草稿PR11不自动合并，原工程和旧preview.1不变。

运行逻辑与4.1.0-alpha9一致，本次只同步版本、发布说明与重建产物。总线显示、几何避让及性能的详细证据保留在[V4_1_ALPHA9.md](V4_1_ALPHA9.md)，不将历史样本冒充beta.2的新测量。

## 验证

| 检查 | 结果 / bin本地证据 |
|---|---|
| 版本一致性 | 扩展、npm锁、Rust crate/锁、CLI均为4.0.0-beta.2；SemVer有效 |
| 原生构建 | release模块及CLI重建；circuit-beta2-build.log |
| JS语法 | 152文件；circuit-beta2-package.log |
| Golden | 20用例、40/40 |
| 既有Node | 516项，515通过、1可选目录重建跳过 |
| 电路Node | 154/154 |
| Rust | 125/125；circuit-beta2-rust.log |
| CLI | svtools --version输出svtools 4.0.0-beta.2 |
| 实际Qoder运行时 | Node24.15.0/Electron42.2.0，native ABI及解包内置Slang/Yosys→Worker→ELK通过；circuit-beta2-qoder-native.log、circuit-beta2-qoder.log |
| 真实工具数据 | 10节点/12连线，1/8/24/32位路由 |
| 正式页面 | Edge155，总线/单比特、普通/选中线宽、位宽点击、避让、明暗主题与缩放通过；circuit-beta2-packaged-browser.log |
| VSIX | 442文件、18,526,349字节；426运行文件逐字节一致；circuit-beta2-package-report.json |
| 远程CI | Node22/24矩阵，最终状态见[草稿PR11](https://github.com/JayceVane/SV-Tools/pull/11) |
| 发布流程 | v4.0.0-beta.2标签触发既有Release工作流，重建、回归、生成SHA256并标记prerelease；最终资产见[GitHub预发布](https://github.com/JayceVane/SV-Tools/releases/tag/v4.0.0-beta.2) |

本地安装包：`bin/svtools-v4.0.0-beta.2-win32-x64.vsix`。

本地VSIX SHA256：`e1658fe073a70bcb71e777ff4ea51a14bcd9b1ca3a6f48d8a9f2ea9bc07175fb`。GitHub资产由Release工作流独立构建，构建工具链/ZIP时间戳可能不同，以随发布上传的`SHA256SUMS.txt`为准。

截图：`bin/circuit-interaction/beta2-packaged-bus.png`与`beta2-packaged-bus-dark.png`。实际Qoder以Electron的Node模式运行，浏览器验证包内页面；这些不等于完整IDE Webview宿主验收。


## 完整文件清单（相对alpha9）

| 文件 | 修改 |
|---|---|
| `package.json` | 扩展版本4.0.0-beta.2 |
| `package-lock.json` | 根包与锁版本同步 |
| `src/native/Cargo.toml` | 原生crate和CLI版本同步 |
| `src/native/Cargo.lock` | Rust锁版本同步 |
| `src/native/package.json` | 原生npm包版本同步 |
| `src/native/package-lock.json` | 原生npm锁版本同步 |
| `README.md` | 当前4.0预览系列及安装入口 |
| `CHANGELOG.md` | 版本策略、内容与升级影响 |
| `CONTEXT.md` | 本轮授权、版本和发布交接 |
| `docs/CIRCUIT.md` | 当前版本与宿主要求 |
| `docs/ROADMAP.md` | 正式版4.0.0目标及历史编号说明 |
| `docs/releases/v4.0.0-beta.2.md` | GitHub预发布说明、安装与边界 |
| `docs/V4_BETA2.md` | 验证结果与完整清单 |

原生模块、CLI、VSIX、校验清单与验收日志位于已忽略的bin/，不提交。历史性能记录补充提交af448da随本次分支推送同步；该提交只更改CONTEXT.md与docs/V4_1_ALPHA9.md。
