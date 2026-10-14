# 4.0.0-alpha9 交付记录

本轮在独立4.0 worktree细化波形右键菜单。原3.x目录继续由用户维护，本轮未安装、推送、合并或发布。

## 菜单

- 顶部显示信号名称与位宽或批量选择摘要，选择数量和当前格式采用小徽标。
- 格式子菜单按整数、波形、浮点分区；当前项高亮，禁用项保留适用数量提示。
- 分组操作使用统一线性SVG图标，移除操作单独配色；圆角、间距、边框、阴影和焦点适配明暗主题。
- 悬停展开90ms、切换收起150ms，进入子菜单取消待收起任务，离开条目取消尚未展开的延迟。
- 键盘导航即时响应，关闭清理定时器，迟到回调不会重开菜单。向左展开时箭头同步反向。
- 名称/摘要按纯文本写入，长摘要可通过提示查看；减少动态效果偏好关闭100ms入场与颜色过渡。

菜单只处理展示、层级与焦点，client提供格式、图标和摘要；图标使用本地固定路径，没有新增依赖或外部资源。
原批量目标、位宽裁决、分组、行高拖动和排序继续沿用既有规则。

## 验证

| 检查 | 结果 |
|---|---|
| JS语法 | 97个文件通过 |
| 格式化golden与幂等 | 36/36，18组样例 |
| Node完整回归 | 448/448，0 fail，0 skip |
| 针对性交互/手势/绘制 | 46/46 |
| 新增菜单合同 | 4项：悬停缓冲、关闭竞态、标签/图标语义与纯文本摘要、当前格式及混合摘要 |
| native/CLI | 同步重建，CLI为4.0.0-alpha9；Rust实现未改 |

真实浏览器运行生产页面与实际VCD Worker，完成明暗主题、分区、当前FP32、禁用项提示、
键盘End跳过禁用项、Esc逐层收起并恢复Canvas焦点、右侧边缘向左展开与箭头反向。
边缘定位实测根菜单右边1274px，子菜单左边722px/右边1004px/底边714px，处于1280×720视口内。
无console警告或错误。报告及明暗截图：`bin/waveform-acceptance/run-4aTFwu/`。
全量日志：`bin/alpha9-package.log`；构建日志：`bin/alpha9-native-build.log`。
临时浏览器和loopback服务已关闭。实际VS Code webview及用户工程继续通过使用反馈验收。

## 安装包核验

- `bin/svtools-4.0.0-alpha9.vsix`：Windows x64本地测试包，2301920字节、80个ZIP条目。
- SHA-256：`bd65b2c8f84fbaa15bb8c543a2b4d54cade78af42a58fa95bdbd4893a915245b`。
- 76个文件逐字节一致，其中58个src运行JS/CSS；native和菜单源码与当前构建一致。
- 包版本、README/CHANGELOG标题核对通过；中英文106个配置引用完整。
- README/CHANGELOG链接与换行由VSCE处理；无测试、源码工具、日志、VCD或开发依赖混入。
- 核验报告：`bin/alpha9-package-report.json`。

代码质量原始报告保留于 `bin/waveform-alpha9-quality-raw.json`。既有输入placeholder、
DOM/菜单contains、空数据回退和只持URI的dispose按源代码与合同逐项复核，未解决高严重性发现为0；
依据保留于 `bin/waveform-alpha9-quality-review.json`，原始报告未改写。

## 修改清单

| 文件 | 变更 |
|---|---|
| `CHANGELOG.md` | 记录菜单行为、原因与影响。 |
| `CONTEXT.md` | 更新当前里程碑与验收交接。 |
| `README.md` | 开发版本更新到alpha9。 |
| `docs/WAVEFORM.md` | 补充菜单摘要和悬停操作说明。 |
| `docs/V4_ALPHA9.md` | 本轮交付与验证记录。 |
| `package.json` | 同步扩展版本。 |
| `package-lock.json` | 同步根锁版本。 |
| `src/native/Cargo.toml` | 同步crate版本。 |
| `src/native/Cargo.lock` | 同步crate锁版本。 |
| `src/native/package.json` | 同步native包版本。 |
| `src/native/package-lock.json` | 同步native锁版本。 |
| `src/waveform/client.js` | 提供信号摘要、当前格式、图标和分区。 |
| `src/waveform/menu.js` | 图标、层次、纯文本摘要及悬停/焦点生命周期。 |
| `src/waveform/view.css` | 明暗菜单配色、几何、图标、徽标与动效。 |
| `test/waveform_interaction_test.js` | 菜单悬停、竞态、可访问标签和摘要合同。 |
