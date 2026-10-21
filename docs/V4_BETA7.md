# 4.0.0-beta.7 交付记录

本轮继续独立 `codex/feat-circuit-viewer`，基线 `67232e5`。原 `D:/Workspace/FPGA/02_svtools` 未改。
正式版目标仍是4.0.0；beta.7为开发预览，不自动合并或创建GitHub Release。

## 技术方向与实现结果

- 保留总线收起后的子位设置，分组可收起、展开及整体排序。
- `.svwave.json` 以声明路径、范围、位宽和偏移匹配，跨VCD id与timescale复用；缺失/歧义明确报告。
- 静态波形和游标精确读值分层；模拟量统计按窗口弱缓存，精确查询及密集标识保留。
- 四个入口共用路径清单及XPR成员适配，解析模型与预算仍独立；自动仿真传递实际入口以定位仿真集。
- 多信号语料及真实Qoder波形、补全、电路宿主覆盖；真实宿主发现并修复两处缓存失效问题。
- 预览交付使用干净提交、唯一版本、SHA256清单，拒绝同号覆盖。

实现愿景是让重复仿真可继续原调试布局，游标操作无需重画时序，工具看到一致的工程候选。
手动打开VCD不能唯一判断多个仿真集时不猜测；角色仍按精确RTL事实保守标记。

## 验证

| 项目 | 实际结果 |
|---|---|
| JS语法 | 167文件 |
| 格式化golden | 20语料、40/40断言 |
| Node完整合同 | 558项，557通过，1项官方目录重建可选跳过 |
| 电路合同 | 169/169 |
| Rust | 125/125 |
| Node22.20.0新布局/缓存/宿主边界 | 48/48 |
| 真实Qoder波形宿主 | 3/3；实际Webview脚本、VCD worker、角色、窗口及读值、布局文件系统 |
| 真实Qoder补全宿主 | 22/22，含接受补全后Icarus13真实编译 |
| 真实Qoder电路宿主 | 5/5，含内置Yosys对dirty正文生成及ELK/Webview |
| Edge155正式页面 | 亮/暗主题、多选颜色、展开位、40ns目标位边沿、收起重载恢复、分组及布局文件读写 |

Qoder报告的VS Code API版本1.106.3、Node24.15.0、Electron42.2.0；测试使用独立用户和扩展目录，
没有安装到用户当前IDE。VS Code主程序仍被 `vscode-updating` 更新锁阻止启动，保留失败日志。
真实IDE验收不是Electron Node模式。浏览器Pointer验收与IDE宿主协议/文件系统验收分别记录，
未声称在IDE里自动操作所有菜单。

新增多信号语料包含20,000独立id、4000别名、24,000声明、最长261字符路径、679,968事件。
12.6MiB加载650ms，类型存储51,438,152 bytes，32信号/800像素窗口约67ms，精确值和10000tick边沿正确。
Edge视口1164×706、16可见行，50次静态全绘中位148.3ms/p95 239.7ms；50次游标层中位约0.1ms，
静态重绘数为0。这是该密集语料的局部CPU测量，包含验收绘制记录开销，不等于整机帧率承诺。

| 既有大型VCD | 加载 | 存储 | 256位投影 | 精确位边沿 |
|---|---:|---:|---:|---:|
| 104,857,613 bytes | 1147.49ms | 79,629,794 bytes | 9.21ms | 10240ticks |
| 524,288,003 bytes | 7041.42ms | 384,699,874 bytes | 8.8ms | 10240ticks |

这些是64独立id的体积语料，与新增多信号语料互补；不将文件大小当作信号规模。

静态AI模式扫描原始wave报告63项（11 Blocker/4 Critical/48 Warning），workspace报告2 Warning。
人工核对：空对象/展开表达式被识别为空实现，HTML input placeholder被识别为未实现，DOM contains和菜单contains适配被识别为数组API；
只读CustomDocument.dispose没有资源需要释放。高等级15项均为这些具体误报，未通过改名或删正常逻辑规避检测。
原始报告的gate_passed为false，人工确认的实际假实现/占位逻辑/虚构API均为0；未以机器分数代替验收。

## 交付产物

Windows x64 VSIX、CLI、原生模块及manifest在忽略的bin中。`npm run package:preview`在干净提交后
运行完整prepublish检查，拒绝已有版本产物，并将源码commit、尺寸和SHA256写入独立manifest。
包内逐文件比对与解包宿主验收完成后，补充实际hash及报告路径。

## 本轮文件清单

| 文件 | 说明 |
|---|---|
| `ARCHITECTURE.md` | 记录共享发现、失效协议、布局模型与分层绘制边界 |
| `CHANGELOG.md` | 新增beta7行为、动机和影响说明 |
| `CONTEXT.md` | 记录工作树进展、验证结果和宿主限制 |
| `README.md` | 更新beta7版本及布局复用入口 |
| `docs/ROADMAP.md` | 登记本轮六项优化完成范围 |
| `docs/V4_BETA7.md` | 交付证据、边界和完整逐文件清单 |
| `docs/WAVEFORM.md` | 说明布局文件、分组收起、隐藏位和缓存策略 |
| `docs/bugs/logic-completion-discovery-race.md` | 记录首次扫描竞争与外部include失效的根因及回归 |
| `package-lock.json` | 同步扩展版本 |
| `package.json` | 统一beta7版本，注册新增回归与预览打包入口 |
| `scripts/benchmark-waveform-corpus.js` | 生成并验证多信号、长路径、别名和密集跳变语料 |
| `scripts/package-preview.js` | 版本一致、干净提交、禁止覆盖和SHA256追溯门禁 |
| `scripts/preview-waveform.js` | 真实布局文件读写适配与外部VCD语料入口 |
| `scripts/verify-waveform-host.ps1` | 隔离真实IDE宿主启动、日志及报告收集 |
| `scripts/verify-waveform-signals.js` | 亮暗主题、隐藏位、分组、布局文件及真实Canvas性能验收 |
| `src/circuit/index.js` | 组合入口注入共享源码清单 |
| `src/circuit/source-context.js` | 使用共享路径发现，保留依赖worker和预算 |
| `src/editor/completion/index.js` | 共享发现、定向失效、外部目录传播及有界重试 |
| `src/editor/completion/provider.js` | 传递共享源码依赖 |
| `src/editor/language.js` | 语言入口向补全注入共享清单 |
| `src/extension.js` | 组合共享目录、XPR适配与四个消费者，并公开波形API |
| `src/native/Cargo.lock` | 同步Rust锁文件版本 |
| `src/native/Cargo.toml` | 同步Rust crate及CLI版本 |
| `src/native/package-lock.json` | 同步napi锁文件版本 |
| `src/native/package.json` | 同步napi包版本 |
| `src/toolchains/iverilog-controller.js` | 共享lint索引、仿真入口传递和文件事件失效 |
| `src/toolchains/iverilog-runner.js` | 自动打开波形时传递实际仿真源文件 |
| `src/vivado/projects.js` | 工程选择变更通知 |
| `src/waveform/client.js` | 保留隐藏位、分组收起、布局操作与静态失效控制 |
| `src/waveform/host.js` | 布局消息边界、初始化握手与查询状态 |
| `src/waveform/index.js` | 接通文件服务、源入口和公开绑定 |
| `src/waveform/layout-files.js` | 用户选择的本地布局有界读写及覆盖VCD保护 |
| `src/waveform/layout-state.js` | v1布局合同、声明身份、跨id/时间单位恢复及缺失清单 |
| `src/waveform/renderer.js` | 静态与游标层分离、模拟量统计缓存及摘要绘制 |
| `src/waveform/row-gesture.js` | 分组摘要整体排序及真实成员槽位 |
| `src/waveform/row-layout.js` | 折叠分组的可见投影和成员计数 |
| `src/waveform/source-roles.js` | 复用共享发现及仿真源提示，维持保守角色匹配 |
| `src/waveform/view.css` | 静态、覆盖画布共用sticky容器 |
| `src/waveform/view.js` | 布局工具栏、双层画布和持久缺失提示 |
| `src/workspace/project-sources.js` | 只读XPR成员及仿真入口适配 |
| `src/workspace/source-catalog.js` | 有界共享发现缓存和分类型失效通知 |
| `src/workspace/sources.js` | lint设计单元索引复用共享路径清单 |
| `test/completion_index_test.js` | 读取途中代次变更回归 |
| `test/helpers/waveform-client-harness.js` | 加载布局纯模型供真实client测试 |
| `test/source_catalog_test.js` | 缓存、取消、外部include和真实XPR集成回归 |
| `test/vscode_waveform_host.js` | 真实IDE Webview、Worker、方向与文件系统验收 |
| `test/waveform_layout_test.js` | 跨id/时间单位、文件边界、分组折叠及排序回归 |
| `test/waveform_renderer_test.js` | 覆盖层不触碰静态绘制及大窗口统计缓存回归 |
| `test/waveform_signal_test.js` | 隐藏位设置跨收起、重载和再展开回归 |

本机语料、日志、浏览器profile、原生构建和安装包均在忽略bin中，不提交。
