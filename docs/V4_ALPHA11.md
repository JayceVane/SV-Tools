# 4.0.0-alpha11 交付记录

## 实现与操作

目录右边界、信号名称/A-B读值栏右边界均可直接拖动。悬停或获得焦点时边界高亮，
拖出区域后松开仍能完成；双击或 Home 恢复默认，方向键调整8px、Shift调整32px。
Escape、失焦、pointercancel和捕获丢失恢复拖动前的请求宽度，不保存中间布局。

同一文件保存两栏宽度。窗口变窄时只限制有效宽度，为波形留出空间；恢复窗口后重新
使用原设定。没有设置名称栏宽度时保留原42%比例和270/340px上限。全名显示不覆盖
用户明确设定的宽度；目录默认252px，窄窗口默认185px，实际值受可用空间约束。

主菜单272→232px，格式子菜单282→244px。菜单项保持32px高，正文保持12px；
49条字体、字号、字距和line-height声明与f27a77d完全相同。整数/浮点名称、当前格式
徽标和适用数量均未截断；长分组名称有省略和完整提示，明暗主题沿用现有配色。

## 技术方向

`column-layout.js`统一裁决恢复、默认值、有效宽度和波形空间，renderer与分隔线共用。
`column-resize.js`只管理Pointer/键盘生命周期，client负责保存、重绘和查询。请求宽度
与视口限制分开；预览只重绘，完成后按新的绘图区像素数请求窗口，精确A/B值继续复用。
没有新增运行依赖或更改VCD解析、事件存储、二维mem与浮点编码。

## 验证

- 102个JS语法检查、golden36/36、Node476/476通过；新增纯几何7项、独立控制器11项、真实client集成10项。波形交互针对性回归74/74。
- 新合同覆盖同文件恢复、非法保存值、视口边界、指针身份、捕获、无变化释放、拖出去再回到原位、取消、键盘、销毁与异常提交清理，以及查询/保存次数。
- 真实生产页面与VCD Worker中目录252→320px、名称栏270→350px，各增加一次窗口请求：window2→4，values保持4，edge保持0；时间窗、A/B与行高不变。
- 刷新页面恢复320/350px；500px窗口临时限制为180/139px，恢复1280px后仍为320/350px。Home、双击、8/32px键盘微调通过。
- 打开二维mem时名称分隔线底部与存储器顶部同为315px，不覆盖存储器交互；关闭后恢复整个波形高度。
- 明暗主题菜单实测232/244px、325/437px高、12px正文；无标签截断。右侧边缘向左展开，键盘End跳过禁用格式到TF32，Escape逐层关闭并恢复Canvas焦点；无console警告/错误。
- native/CLI同步重建，CLI为4.0.0-alpha11；Rust实现未变，本轮没有重复运行Rust测试。

验收截图、菜单矩形、前后Worker计数与最终状态在 `bin/waveform-acceptance/run-PFgZRR/`。
字体报告 `bin/alpha11-font-report.json`；完整回归日志 `bin/alpha11-test.log`，构建日志
`bin/alpha11-native-build.log`。新两模块健康分100，MI分别39.47/30.05。
质量原始报告与人工复核在 `bin/alpha11-*-quality.json`、`bin/alpha11-waveform-risk.json`、
`bin/alpha11-waveform-ai-raw.json`、`bin/alpha11-quality-review.json`。

全波形风险脚本原始健康分0仍保留，不代表新增模块分数；它将不同单位的12/32等数值
视为跨职责重复，也报告旧菜单构建复杂度。本轮新增命名常量已按用途集中。AI扫描8个
Blocker/4个Critical逐条复核为数据空对象、生命周期接口、真实placeholder属性和contains
API等误报；新增的 `columns: {}` 是实际布局数据。有效Blocker/Critical为0，未改原始报告。
旧组合入口的复杂度继续作为技术债，本轮不扩展成无关重构。

## 安装包

Windows x64安装包：`bin/svtools-4.0.0-alpha11.vsix`，2307480字节、82个ZIP条目。
SHA-256：`1e612992623e066e4a5676d5ced4b3928653195418c33117a8e98326a3e9186e`。
78项逐字节一致，其中60个src运行JS/CSS；版本与中英文106个配置引用通过。
README/CHANGELOG由VSCE处理链接与换行，未混入测试、开发源或日志。
核验见 `bin/alpha11-package-report.json`；打包再次执行的476项回归全部通过。

全部开发在4.0独立worktree进行；3.x原目录未改动。未安装到用户IDE、推送、合并或发布。
临时浏览器与服务在验收后关闭。

## 修改清单

| 文件 | 变更 |
|---|---|
| `src/waveform/column-layout.js` | 新增两栏恢复、边界与共享几何。 |
| `src/waveform/column-resize.js` | 新增分隔线手势、键盘、取消与结束生命周期。 |
| `src/waveform/client.js` | 接线两栏、保存请求宽度、预览与完成查询。 |
| `src/waveform/renderer.js` | Canvas、时间轴与游标映射共用列几何。 |
| `src/waveform/view.js` | 注册模块与两个可访问分隔线。 |
| `src/waveform/view.css` | 可发现分隔线、收窄菜单，字体保持。 |
| `src/waveform/menu.js` | 完整操作名称/详情提示，支持截断的长组名。 |
| `test/waveform_column_layout_test.js` | 新增7项纯几何合同。 |
| `test/waveform_column_resize_test.js` | 新增11项控制器生命周期合同。 |
| `test/waveform_column_client_test.js` | 新增10项保存、查询与交互集成合同。 |
| `test/helpers/waveform-client-harness.js` | 复用真实控制器并模拟两栏尺寸变化。 |
| `test/waveform_renderer_test.js` | 接入共享列几何，保留既有标签断言。 |
| `test/waveform_interaction_test.js` | 验证完整菜单提示。 |
| `ARCHITECTURE.md` | 更新两栏几何/控制器的依赖与职责。 |
| `docs/WAVEFORM.md` | 更新栏宽操作与模块清单。 |
| `docs/V4_ALPHA11.md` | 本轮验收、包核验与完整修改清单。 |
| `CONTEXT.md` | 更新当前里程碑、验证与下一步。 |
| `CHANGELOG.md` | 记录栏宽交互与菜单变窄。 |
| `README.md` | 同步开发版本。 |
| `package.json` | 同步版本并注册新合同。 |
| `package-lock.json` | 同步根锁版本。 |
| `src/native/Cargo.toml` | 同步crate版本。 |
| `src/native/Cargo.lock` | 同步crate锁版本。 |
| `src/native/package.json` | 同步native包版本。 |
| `src/native/package-lock.json` | 同步native锁版本。 |
