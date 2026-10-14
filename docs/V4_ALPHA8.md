# 4.0.0-alpha8 交付记录

本轮在 `codex/refactor-v4` 完成模拟量行高拖拽和信号排序动画，3.x 原工程目录继续独立维护。
本地提交保存源码；未安装到用户 IDE、推送、合并或发布。

## 行为

Analog/real 行底边显示行高与拖动手柄，悬停时高亮并出现竖向缩放光标。
按住鼠标上下拖动实时调整高度，范围60–480px、默认100px，松开时保存一次。
数字行仍为38px；非法保存值、失效信号键和非有限值会被清理。

名称区拖动保留多选内部顺序，浮动卡片显示名称和数量，插入线明确落点。
其他行实时让位，松开后按180ms三次缓出动画归位；新的鼠标操作结束前次落下动画。
指针接近上下边缘时自动滚动，系统减少动态效果偏好使用直接归位。

手势使用指针捕获，拖出波形区后松开也能结束。Escape、pointercancel、失焦或丢失捕获
回滚未完成的高度、选择与滚动；排序预览只持有候选顺序，松开前不写入真实行顺序。
缩放和排序不误触游标或平移，输入框保留自己的快捷键。

## 分工与预算

- `row-layout.js`：行高、命中、插入位置、预览行布局、缓出位置和边缘滚动速度的纯规则。
- `row-gesture.js`：Pointer 生命周期、预览、动画、捕获释放和取消；client 传入提交边界。
- client：结束手势后刷新可见信号查询并保存状态，复用共享高度裁决。
- renderer：按动画当前位置和目标投影裁剪可见行，绘制手柄、选择反馈和插入线。

拖动中的行高和排序预览不逐帧查询VCD或保存会话。新进入视口但尚未查询的信号明确
提示“松开后加载新增可见信号…”，结束手势后合并更新。Canvas 位图随视口，不随总行高扩大。
测试夹具抽到一个共享文件，现有交互与新手势合同运行相同真实 client 和手势控制器。
没有新增运行依赖或改动 VCD 事件存储。

## 验收

| 检查 | 结果 |
|---|---|
| JS语法 | 97个文件通过 |
| 格式化golden及幂等 | 36/36，18组样例 |
| Node完整回归 | 444/444，0 fail，0 skip |
| 新增合同 | 行几何6、手势14、Canvas3，共23项 |
| 针对性交互/绘制/memory回归 | 71/71 |
| native/CLI | 版本同步重建；`svtools 4.0.0-alpha8` |
| Rust实现 | 原源码未改，沿用alpha7的112项通过基线 |

手势合同覆盖实时缩放、松开保存一次、数字行不缩放、负拖动钳到最小高度、无效恢复值、
多选最终落点不反跳、取消恢复高度/选择/滚动、非主指针拒绝、出界释放、2,000行边缘滚动、
零预览查询、固定Canvas尺寸、减少动态效果切换和原有波形平移。
全量日志：`bin/alpha8-package.log`；构建日志：`bin/alpha8-native-build.log`。

真实浏览器运行生产client/renderer/手势模块，VCD数据经过真实Worker。验收使用两条real
模拟量及原浮点/memory公开语料，完成100→220px实时放大、220→140px后Escape恢复220px、
重新打开恢复高度，两条FP64/FP32信号整体置顶且保留内部顺序，明暗主题切换及状态恢复。
A=0ns、B=100ns、0–700ns时间范围保持不变，Canvas CSS及位图高度均为518px。
同可见集合排序前后 window=2、values=4、edge=0，没有额外查询；无console警告/错误。

缩放报告：`bin/waveform-acceptance/run-kRRV2v/resize-report.json`。
最终报告、排序前后查询计数和明暗截图：`bin/waveform-acceptance/run-K0UTnZ/`。
候选生产文件均早于最终预览服务启动，界面验收与打包源码一致；临时浏览器及服务已关闭。
复现入口仍为 `node scripts/preview-waveform.js`。本轮实测针对本机浏览器和Worker，实际VS Code
webview及用户RTL仍需使用反馈；100/500MiB数据服务历史测量继续见WAVEFORM.md。

## 安装包

- `bin/svtools-4.0.0-alpha8.vsix`：Windows x64本地测试包。
- 2299680字节、80个ZIP条目。
- SHA-256：`56c87ff0f38005fc24bc39e0bd7d4d267bee2fe715f2f44e076edf92ababacb6`。
- 76个文件逐字节一致，其中58个src运行JS/CSS，包含两个新模块和重建native。
- README/CHANGELOG由VSCE改写链接和换行，alpha8标题核对通过；中英文106个配置引用完整。
- 没有tests/helper、scripts、docs、原生源码、开发依赖、VCD或日志混入。
- 核验报告：`bin/alpha8-package-report.json`。

架构技能原始报告保留在 `bin/waveform-alpha8-quality-raw.json`。两新模块无扫描发现；
既有7个Blocker/4个Critical与alpha7一致，分别为真实placeholder输入提示、DOM/菜单contains、
空数据字面量和只持URI的CustomDocument dispose，逐项依据及合同复核保留于
`bin/waveform-alpha8-quality-review.json`，未解决Blocker/Critical为0，原始结果未改写。

## 修改清单

| 文件 | 变更 |
|---|---|
| `.gitignore` | 允许共享控制器测试夹具入库。 |
| `ARCHITECTURE.md` | 记录行几何、手势和绘制边界。 |
| `CHANGELOG.md` | 记录alpha8行为、原因和影响。 |
| `CONTEXT.md` | 更新交接、验收与当前包。 |
| `README.md` | 开发版本更新为alpha8。 |
| `docs/WAVEFORM.md` | 补齐缩放、排序动画与取消操作说明。 |
| `docs/V4_ALPHA8.md` | 本轮交付和验收记录。 |
| `package.json` | 同步版本并登记两组新测试。 |
| `package-lock.json` | 同步根版本。 |
| `scripts/preview-waveform.js` | 增加两条real模拟量验收语料。 |
| `src/native/Cargo.toml` | 同步crate版本。 |
| `src/native/Cargo.lock` | 同步crate锁版本。 |
| `src/native/package.json` | 同步native包版本。 |
| `src/native/package-lock.json` | 同步native锁版本。 |
| `src/waveform/row-layout.js` | 行高、命中、插入、动画与滚动纯规则。 |
| `src/waveform/row-gesture.js` | Pointer预览、取消、捕获与提交生命周期。 |
| `src/waveform/client.js` | 装配手势，区分预览、查询与持久化。 |
| `src/waveform/renderer.js` | 绘制手柄、实时投影与插入反馈。 |
| `src/waveform/view.css` | 浮动排序卡片、触控和文本选择样式。 |
| `src/waveform/view.js` | 装配新模块与更新操作提示。 |
| `test/helpers/waveform-client-harness.js` | 共用真实client与手势运行夹具。 |
| `test/waveform_interaction_test.js` | 复用夹具，保留原交互合同。 |
| `test/waveform_renderer_test.js` | 增加行高手柄、动画裁剪与插入线合同。 |
| `test/waveform_row_layout_test.js` | 行几何、插入与动画纯规则合同。 |
| `test/waveform_row_gesture_test.js` | 缩放、排序、取消、滚动和查询预算合同。 |
