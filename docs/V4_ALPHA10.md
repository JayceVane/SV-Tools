# 4.0.0-alpha10 交付记录

按照用户“字号不缩小，布局稍紧凑”的要求，本轮只调整右键菜单的CSS留白。
菜单项上下padding由8px改为6px，高度36→32px；收紧标题、分区、外边距和页脚。
全部字体、字号、字距、line-height声明与alpha9相同，宽度、图标尺寸及生产JS逻辑均未改。

## 验证与效果

同一FP32信号右键上下文、1280×720视口，真实生产页面与VCD Worker：

| 指标 | alpha9 | alpha10 |
|---|---:|---:|
| 主菜单高度 | 380px | 325px |
| 格式子菜单高度 | 505px | 437px |
| 菜单项高度 | 36px | 32px |
| 主菜单/子菜单宽度 | 272/282px | 272/282px |
| 正文/分区字号 | 12/10px | 12/10px |

字体声明逐项比对报告：`bin/alpha10-font-report.json`，基线提交ff45942。
浏览器矩形与字号记录、明暗截图和Worker报告：`bin/waveform-acceptance/run-hk45QS/`。
无console警告或错误；临时页面与服务已关闭。实际VS Code webview继续由使用反馈验收。

打包时97个JS语法检查、golden36/36、Node448/448通过；native/CLI版本同步重建，
CLI为4.0.0-alpha10，Rust实现未改。本轮没有新增测试，日志为 `bin/alpha10-package.log`。

## 安装包

- Windows x64：`bin/svtools-4.0.0-alpha10.vsix`，2302137字节、80个ZIP条目。
- SHA-256：`0e5ebffc036a60ead241b16557d75849f39d49a3e40fc2977c2638e5bfff001e`。
- 76个文件逐字节一致，其中58个src运行JS/CSS；版本与中英文106个配置引用核对通过。
- README/CHANGELOG由VSCE处理链接与换行，无开发资源或日志混入。
- 核验报告：`bin/alpha10-package-report.json`。

本轮开发在4.0 worktree完成，3.x原目录未改动；未安装到用户IDE、推送、合并或发布。

## 修改清单

| 文件 | 变更 |
|---|---|
| `src/waveform/view.css` | 保持字体，仅收紧菜单留白。 |
| `CHANGELOG.md` | 记录本轮要求与影响。 |
| `CONTEXT.md` | 更新交接、实测与当前包。 |
| `README.md` | 开发版本更新到alpha10。 |
| `docs/WAVEFORM.md` | 更新版本与紧凑菜单说明。 |
| `docs/V4_ALPHA10.md` | 本轮验收和完整清单。 |
| `package.json` | 同步扩展版本。 |
| `package-lock.json` | 同步根锁版本。 |
| `src/native/Cargo.toml` | 同步crate版本。 |
| `src/native/Cargo.lock` | 同步crate锁版本。 |
| `src/native/package.json` | 同步native包版本。 |
| `src/native/package-lock.json` | 同步native锁版本。 |
