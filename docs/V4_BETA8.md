# 4.0.0-beta.8 图片导出交付

本轮在独立codex/feat-circuit-viewer分支，基线d3b3802；原D:/Workspace/FPGA/02_svtools未修改。
版本从已交付beta.7推进为beta.8，不覆盖旧VSIX，不自动合并或创建Release。

## 技术方向与实现结果

波形与电路工具栏均提供“导出图片”，选择文档黑白线稿/当前界面主题以及SVG/PNG。
波形默认有效AB区间，倒序AB可归一化；未设AB时默认当前视口。可导出全部已添加或所选信号，
按名称和行高自动画幅，遵循展开/分组收起，保留模拟量高度和完整屏外行。
电路导出当前模块完整布局，独立场景绕开现场裁剪与LOD，保留总线、位宽和寄存器标记。

实现愿景是直接生成可用于技术文档的可读图形，避免人工拼截图；SVG便于继续编辑，PNG便于粘贴。
波形独立查询worker的范围、窗口和A/B精确值，复用既有绘制器及浮点/位投影模型。
电路复用完整graph及renderer，不再次综合或猜测连接。共用graphics边界处理选项、编码和文件保存。

## 边界

- 电路范围是当前模块，不是自动把所有子层扁平展开；先进入所需模块再导出。
- 密集时序不伪装精确边沿；黑白用斜线纹理，主题用原有显式密集标记。
- SVG不依赖编辑器样式表；黑白去除彩色背景，交互握柄和展开箭头不导出。
- PNG通常2倍，单边16384、总32M像素；低于1倍仍超预算时明确拒绝并建议SVG，不裁剪内容。
- 写入限32 MiB，矢量生成另有24 MiB/25万图元预算。取消、格式错误、磁盘失败不清空原视图。
- 图形生成经真实Edge验收；真实IDE使用隔离Qoder宿主验证页面加载、worker与图片文件服务。
  未声称在IDE内自动点击所有导出菜单或完成VS Code主程序验收。

## 验证记录

| 验证 | 结果 |
|---|---|
| JS语法 | 174文件 |
| 格式化golden | 20语料40/40断言 |
| Node完整合同 | 最终prepublish记录在bin/beta8-package.log |
| 电路合同 | 最终prepublish记录在bin/beta8-package.log |
| 导出与host重点合同 | 26/26，含真实VCD worker |
| Node22.20.0重点合同 | 26/26 |
| Rust | 125/125 |
| 真实Qoder波形宿主 | 4/4，含SVG/PNG保存及字节读回 |
| 真实Qoder电路宿主 | 5/5，含包内Yosys/ELK/Webview |
| 波形真实Edge页面 | 亮暗×黑白/主题×SVG/PNG共8项；AB独立查询、bit完整且不改现场布局 |
| 浮点/模拟量/mem页面 | 同样8项；FP64/FP32/TF32/BF16/FP16/FP8显示及模拟量高度保留 |
| 电路真实Edge页面 | 同样8项；屏幕仅6节点时导出完整15节点，原相机不变 |
| 小寄存器电路目视复核 | 4节点完整导出，8位总线/单线时钟粗细及位宽可辨 |

SVG文字转义、剪裁、字体、透明度及坐标有限性有合同。PNG均核对签名/尺寸并实际生成，
黑白SVG在亮暗主题下内容一致。实际PNG目视核对文字、线稿、A/B标签位置和图形边界。
graphics静态质量扫描无Blocker/Critical，9项Warning为图形尺寸/字体等数字风格规则；
不以分数替代浏览器、真实宿主和worker证据。没有新运行依赖。

本机证据在bin/beta8-wave-export-final/、bin/beta8-float-export/、bin/beta8-circuit-export-final/、
bin/beta8-circuit-export-small/、bin/beta8-wave-host.log、bin/beta8-circuit-host.log、
bin/beta8-export-contracts.log、bin/beta8-node22.log、bin/beta8-rust.log。图片和profile不提交。

## 安装包

beta8 Windows x64 VSIX通过唯一版本入口生成；源码commit和产物SHA在manifest中。
生成后补充逐文件核对与解包验证结果。

## 逐文件清单

| 文件 | 说明 |
|---|---|
| `ARCHITECTURE.md` | 记录共用导出边界与两个renderer的数据职责 |
| `CHANGELOG.md` | 新增beta8功能、动机及影响范围 |
| `CONTEXT.md` | 记录本轮实现、验证与后续交付状态 |
| `README.md` | 更新版本和导出入口使用说明 |
| `docs/CIRCUIT.md` | 说明全模块导出、两种风格和资源预算 |
| `docs/V4_BETA8.md` | 交付验证和完整逐文件清单 |
| `docs/WAVEFORM.md` | 说明AB、自动画幅、信号范围和SVG/PNG边界 |
| `package-lock.json` | 同步扩展beta8版本 |
| `package.json` | 注册导出合同并升级beta8 |
| `scripts/preview-circuit.js` | 真实完整电路与图片保存预览，支持解包内容 |
| `scripts/preview-waveform.js` | 真实worker图片保存及区间查询记录 |
| `scripts/verify-circuit-image.js` | 两主题/两风格/两格式及屏外节点、相机保持验收 |
| `scripts/verify-waveform-signals.js` | 增加AB、bit、浮点/模拟量/mem及图像文件验收 |
| `src/circuit/client.js` | 导出选项、图片请求状态和失败提示 |
| `src/circuit/host.js` | 独立回复图片保存，不影响设计加载 |
| `src/circuit/image-export.js` | 完整布局独立场景、样式固化与黑白转换 |
| `src/circuit/index.js` | 组合入口注入用户图片文件服务 |
| `src/circuit/view.js` | 导出按钮、共用资源与blob图片CSP |
| `src/graphics/image-export.css` | 共用模态导出选项布局 |
| `src/graphics/image-export.js` | 风格/格式选项、SVG封装与有界PNG转换 |
| `src/graphics/image-files.js` | 本地用户文件选择、格式及字节预算 |
| `src/graphics/svg-canvas.js` | 波形绘制所需1:1 Canvas矢量记录与剪裁/文字转义 |
| `src/native/Cargo.lock` | 同步Rust锁文件beta8版本 |
| `src/native/Cargo.toml` | 同步Rust crate/CLI版本 |
| `src/native/package-lock.json` | 同步napi锁文件beta8版本 |
| `src/native/package.json` | 同步napi包版本 |
| `src/waveform/client.js` | 波形导出入口与原布局隔离 |
| `src/waveform/host.js` | 图片保存协议与原worker查询服务共存 |
| `src/waveform/image-export.js` | AB区间、自动画幅、独立worker查询与SVG生成 |
| `src/waveform/index.js` | 注入用户图片文件保存服务 |
| `src/waveform/renderer.js` | 显式导出配色/几何、线稿密集纹理与交互控件省略 |
| `src/waveform/view.js` | 导出按钮、共用资源与blob图片CSP |
| `test/circuit_host_test.js` | 图片保存成功/取消/失败不重新布局 |
| `test/circuit_view_test.js` | CSP与新增自含资源数量合同 |
| `test/image_export_test.js` | 矢量记录、AB/画幅、真实worker、PNG预算和文件边界 |
| `test/vscode_waveform_host.js` | 真实IDE的SVG/PNG文件保存与读回 |
| `test/waveform_host_test.js` | 图片保存失败不破坏已加载波形 |
