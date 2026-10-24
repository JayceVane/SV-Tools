# 4.0正式发布前审查 — beta.16

审查日期：2026-10-23至24日。基线 `e7eba3b` / `4.0.0-beta.11`，独立分支 `codex/feat-circuit-viewer`。
只在4.0 worktree修复和构建，未改用户维护的3.x目录或corelib RTL。

## 当前判断

基线完整测试虽通过，仍复现了源码词法损坏、错误模板和工程引用丢失。本轮必须先修复这些问题，不能直接以beta.11发布4.0。
修复后，以下明确复现的问题及其回归均已解决；在本轮覆盖范围内未发现尚未修复的P0/P1。
beta.16补齐task/function形参默认值及标量/向量名称列对齐，继承beta.15文件头修复，作为新的可追溯发布候选；此前产物保留。后续正式版仍需独立4.0.0版本、重建和发布验收。本轮不自动合并、创建正式tag或公开Release。
beta.12内部打包后复核又发现独立net/reg符号信息补全不完整、数组参数静默略过，故未放行；继续实测也发现simArgs中的plusargs放在vvp输入文件之前会被当成文件名，默认VCD模板又需要未提供的+vcd。beta.13补齐这些问题，旧产物保留。
远程CI复核补充：beta.13的Node22/24均在原生构建入口失败，npm.cmd的兄弟脚本路径落入工程目录；本地宿主通过并不能证明干净环境可重建。故继续修复此构建阻断并改用独立beta.14，不覆盖beta.13。
这是一轮有边界的工程审查，不是无缺陷或所有SV/UVM语法完全支持的保证。

## 发现、影响与处理

| 等级 | 复现与影响 | 修复与防复发 |
|---|---|---|
| P1 | `[8 + +1:0]`紧凑为`[8++1:0]`，原文编译成功而产物失败 | 共享最长匹配token，保留必要分隔；字符守恒之外再检查词法和保护区 |
| P1 | for行把`===`、`>>>`拆成`== =`、`>> >` | 按完整运算符布局；长操作符回归及真实仿真输出对比 |
| P1 | 嵌套参数头误作端口、字符串参数被normalize改写；数组丢接口、int降成1bit却返回成功 | 平衡扫描和原文切片，移除破坏字符串的中转；整数正确位宽，不可表示接口明确拒绝；跳过同名task/function声明 |
| P1 | Vivado跨文件集移动先删源，目标添加失败后close_project持久化引用丢失 | 磁盘与源/目标预检查；先验证目标、最后移除源，后续错误恢复源引用和常用属性 |
| P2 | Testbench参数重复/缺分号、无时钟空posedge、多域部分时钟悬空、低有效复位判断及dump层级错误 | 可编译可执行骨架，输入初始化、独立域驱动、无时钟延时；VCD默认并使用实际层级标识符 |
| P2 | cmd双引号仍展开`%ENV%`，Vivado内部CALL又解释`%`/`!`，合法工程路径被改写 | 通用env传参；Vivado专用私有Tcl桥接，完成/失败/取消/启动异常清理，不能保真时明确拒绝 |
| P2 | 条件`$dumpfile`不执行时实际生成默认dump.vcd，静态扫描漏掉旧默认波形 | 只要出现dumpvars同时考虑默认dump.vcd，沿用关闭屏障和写入租约 |
| P2 | simArgs中的`+trace`被当成vvp输入文件，默认VCD模板又受未提供的+vcd门控 | 区分vvp CLI选项和extended/plusargs，按正确阶段传参；选择VCD就直接记录，真实runner与无+vcd模板验收 |
| P1（构建阻断） | PATH-only BAT执行后自身%~dp0错指cwd，npm.cmd在干净CI查找错误兄弟脚本 | 先用调用cwd/Path解析绝对普通文件，再安全中转；真实兄弟文件回归及干净构建验收 |
| P2 | 文件头设置的单行控件丢失粘贴换行，无外部文件模板入口；末尾行注释可能粘连源码 | 多行控件与资源作用域UTF-8文件配置；保留空行、补齐末尾换行，文件错误拒绝插入；真实双根宿主验收 |
| 构建风险 | npm审计21项（16 high / 5 moderate），来自开发/打包依赖 | vsce 4.0.0、兼容安全补丁及netlistsvg JSON5/yargs override；完整依赖树审计清零，真实验证链通过 |

根因笔记：
[词法守恒](bugs/logic-formatter-token-conservation.md)、[生成器边界](bugs/logic-codegen-module-boundaries.md)、
[Vivado移动事务](bugs/logic-vivado-fileset-transaction.md)、[BAT重复展开](bugs/compat-vivado-batch-expansion.md)、[vvp参数阶段](bugs/logic-vvp-runtime-arguments.md)、[PATH批处理目录](bugs/compat-batch-path-script-directory.md)。

## 验收结果

- 新NAPI与真实Icarus集成54/54：格式化原文/产物各自编译运行且输出相同；9组自检Testbench均产生有效VCD；既有CDC端口映射保持。
- 完整Rust153/153；完整npm：golden21个文件42/42，Node651项650通过、1项可选官方目录重建跳过，电路170/170。
- Node22.20.0变更范围139项：129通过，10项依赖显式外部工具路径的验收跳过；这些外部工具场景已在Node24完整验收启用并通过。
- 官方VS Code1.143.0（Node24.21.0 / Electron43.7.7）及Qoder API1.106.3（Node24.15.0 / Electron42.2.0）各5项真实编辑器事务通过：实际格式化、幂等和undo、乱码内容守恒、独立页模板、拒绝不支持接口。IDE会在创建文档时规范化孤立UTF16代理项；NAPI本身逐字返回的约束另有直接回归，不能混为同一层。
- 官方VS Code真实补全宿主22/22通过，含Snippet编辑与实际Icarus编译，未跳过外部工具验收。
- 真实Qoder生命周期4/4：默认CustomEditor，子目录VCD仿真前关闭/完成后新数据重开，文本标签同样关闭，不相关波形保留。100MiB旧数据还在加载时开始仿真，104857906字节被新262字节VCD替换。
- 当前500MiB合成VCD：524288003字节、65声明、25660920有效事件；加载5700ms，进程峰值RSS约479.6MiB，宿主最大定时器延迟12.44ms；16个可见ID/1200像素查询56.91ms，响应2507991字节，密集跳变明确标记。此为本机单次合成语料测量，不代表所有500MiB设计的内存上限或性能承诺。
- 真实生产runner和Icarus验证`+trace/+seed`、CLI分离/附着选项、`-dumpfile`覆盖与输出发现；默认VCD模板的9组实际运行均不传+vcd。无后缀默认名同时保护原名与可能的dumper后缀，实测Icarus13保留原名。CLI参数缺值在关闭波形前失败。
- 真实Vivado2022.1.2：缺文件保留源引用；正常移动；remove后故障注入回滚及LIBRARY/USED_IN恢复；特殊source/cwd保真；错误与取消均清理私有桥接。
- 更新依赖后的真实Yosys JSON → netlistsvg → 独立模型 → ELK通过，含参数层级、存储器、寄存器、宏表达式与非零/升序总线。
- 根目录及src/native的npm audit均0告警。OSV querybatch在2026-10-23检查Cargo.lock内60个registry crate版本，无已知漏洞命中；未把该结果当成WASM内部和厂商工具的安全审计。

## 机械扫描与人工判断

arch-optimize风险扫描覆盖src下140文件，原始320条（139 Critical、179 Warning、2 Suggestion）；代码风格启发扫描73文件，原始616条，机械gate=false。
这些原始等级不等于可复现运行缺陷：空对象/默认参数被判“空实现”，HTML placeholder被判占位业务，DOM.contains被判不存在API，SV/Yosys协议的snake_case被判命名混乱。
按源码边界和真实执行证据复核后，未将这些明显误报计为发布阻断；原始分数没有被改成通过。
较长客户端闭包、遗留正则解析和大型渲染函数仍是技术债。本轮只改已确认的正确性与持久状态问题，不为降低机械分数做大范围拆分。

复核纠正：最初“标量output配向量wire”的拆分语料被Icarus判为不合法，不能作为合法RTL丢位宽的证据。最终使用合法显式端口宽度、独立signed声明和有符号比较自检；仍保留参数数组/用户类型等明确拒绝的合同。

## 支持边界

- 正式交付目标为Windows x64。Linux/macOS二进制、全部Vivado版本与厂商IP库未做同等发布验收。
- 生成器不是完整SV详细化器；unpacked端口、用户类型、interface/modport、real接口，以及数组/type参数等不能忠实表达时明确失败。模板时钟周期、复位策略、CDC关联和业务激励仍由设计者配置。
- 格式化安全检查保证布局提交条件，不代替全语法解析或形式等价验证；不可证明安全的输入保持原文。
- 静态VCD路径发现有源码扫描预算，不执行条件编译或动态表达式；目录回退有明确提示。只关闭本扩展管理的视图，不处理外部查看器持有的句柄。
- Vivado回滚处理可观察的命令错误，不能承诺断电/进程崩溃时原子恢复；安装路径/额外BAT参数无法保真时会报错。
- FSDB查看未加入，二维mem和现有波形/电路功能保留。

## 本机证据与复跑

beta.13最终日志在bin：`beta13-native-build.log`、`beta13-semantics.log`、`beta13-rust.log`、`beta13-full.log`、`beta13-node22.log`、`beta13-lifecycle-host.log`、`beta13-runtime-wave-contracts.log`、`beta13-dump-override.log`、`beta13-npm-audit.json`与`beta13-native-npm-audit.json`。
以下beta.12与前序审查证据在同一目录保留，不进入VSIX：
`beta12-native-build.log`、`beta12-semantics.log`、`beta12-rust.log`、`beta12-full.log`、`beta12-node22.log`、
`beta12-release-host.log`、`beta12-vscode-host.log`、`beta12-lifecycle-host.log`、`beta12-vcd-worker.log`、
`release-audit-npm-final.json`、`release-audit-npm-native.json`、`release-audit-rust-osv.json`。
Vivado证据位于`bin/release-audit-circuit`，依赖兼容验证位于`bin/release-audit-circuit-dependencies`。

运行`npm test`与`cargo test --offline --manifest-path src/native/Cargo.toml`。
真实Icarus通过`SVTOOLS_CODEGEN_IVERILOG`、`SVTOOLS_CODEGEN_VVP`、`SVTOOLS_CODEGEN_CYGWIN`显式指定工具，再运行formatter_semantics_test/codegen_release_test。
真实编辑器：`scripts/verify-waveform-host.ps1 -CodePath <IDE> -TestPath test/vscode_release_host.js`；生命周期同脚本选择`test/vscode_waveform_lifecycle_host.js`并提供IcarusPath/CygwinPath。
## beta.13历史候选验收（未通过远程构建）

beta.13从干净源码提交 `f550a3b843af2ce121da1b560c91e9712c1afa4b` 构建；后续交付提交仅更新文档。未创建正式tag或Release，旧beta.11/.12产物保留。
VSIX共457文件，441个运行文件与源码/原生/vendor逐字节一致；开发依赖、测试、脚本和私有工程均未入包。默认VCD配置、平台和manifest全部核对。

| 产物 | 字节 | SHA256 |
|---|---:|---|
| svtools-4.0.0-beta.13-win32-x64.vsix | 18565683 | `fc32d252af9da2f84d0cb5fe9ad17832cdb265dcd3fb61ea3a50371f1bcb1363` |
| svtools.exe | 24017920 | `b717d2f97bbb4baa6d7f0789178444ec930de75ae1506a6fde202471a077c293` |
| svtools.win32-x64-msvc.node | 24163328 | `b7e4115e4c187e4d44626384ce8aa1ccc96e3df03689dac42c80ec092afa56d1` |

解包后的真实宿主验收18/18通过：官方VS Code编辑器事务5项、电路/Yosys/ELK5项、100MiB重新仿真生命周期4项，Qoder波形/布局/图片服务4项。上述host-report都记录extensionPath为解包目录及版本beta.13。
日志：`beta13-package.log`、`beta13-package-verification.log`、`waveform-beta13-package-report.json`、
`beta13-packaged-editor-host.log`、`beta13-packaged-circuit-host.log`、`beta13-packaged-lifecycle-host.log`、`beta13-packaged-waveform-host.log`。
远程Windows Node22/24检查可从[草稿PR11](https://github.com/JayceVane/SV-Tools/pull/11)复查。

在本轮明确覆盖的Windows x64和工具版本范围内，未发现仍阻断正式发布的已确认P0/P1；beta.14曾作为通过最终CI的封版基线；后续用户报告的文件头配置问题改由beta.15修复。正式4.0.0仍须独立版本化、重建与发布，不重命名或覆盖候选包。

## beta.14干净构建复核

PATH-only BAT的真实原始复现退出37，修复后名称/绝对/相对三种入口均正确定位兄弟文件。两项新增回归及toolchain_test 25/25通过。
清理npm_execpath/npm_node_execpath后直接执行与CI相同的`node scripts/build-native.js`成功，未改构建脚本绕过问题。
beta.14完整本地回归：JS182文件，golden42/42，Node650通过/1可选跳过，电路170/170，Rust153/153。
真实Icarus、xvlog/xelab、Vivado工具链验收通过；故意语法错误及Vivado退出0的ERROR均按失败识别。
证据：`beta14-native-build.log`、`beta14-full.log`、`beta14-rust.log`、`beta14-toolchains.log`，以及`bin/release-audit-circuit/path-batch-4hJY5n`（修复前）和`path-batch-spZgXf`（修复后）。
beta.14候选源提交 `43aff5f94b0143cb47fe352a201b8d3241eb4b3e`。VSIX457文件、441个运行文件与源码/原生/vendor逐字节一致；后续文档提交不改变包内运行代码。
解包实际宿主18/18通过：官方VS Code编辑器5项、电路/Yosys/ELK5项、100MiB重新仿真4项，Qoder波形/布局/图片4项。
Node22启动器专项25/25通过；完整包前回归再次通过。日志为`beta14-package.log`、`beta14-package-verification.log`、`beta14-node22.log`与`beta14-packaged-*-host.log`。

| beta.14产物 | 字节 | SHA256 |
|---|---:|---|
| svtools-4.0.0-beta.14-win32-x64.vsix | 18566313 | `21c9555417bfbabe8a92684f24cfbd5d40fcc27fac6586765df163b3425f2aa5` |
| svtools.exe | 24017920 | `884778452612b935212de527660c81b35d61ec46cfa543ec6e38f8c585fa3cf6` |
| svtools.win32-x64-msvc.node | 24163328 | `9b82aa57d626c3ba18d48eef3d17299f268a4faa25c96c1efd39cd8ed6767912` |

远程CI以最终推送的Windows Node22/24检查为准，入口为[PR11](https://github.com/JayceVane/SV-Tools/pull/11)。正式4.0.0尚未创建tag或Release。


## beta.15文件头配置补充审查

用户报告的外部文件模板和多行设置未被beta.14发现或修复，不能用已有原生字符串测试替代设置入口验收。
旧Rust替换器没有删除实际LF；换行在单行设置控件中已经丢失。详见[调试笔记](bugs/compat-header-template-multiline.md)。

`svtools.headerTemplate`现声明`multilineText`，新增`svtools.headerTemplateFile`；配置按当前文档资源读取。
支持绝对路径、`${workspaceFolder}`、所属工作区相对路径；工作区外使用源码目录。
外部文件优先、每次重读，严格UTF-8且允许BOM；缺失/空白/错误编码明确报错，不回退插入默认头。
只规范化换行，不解码字面反斜杠；模板末尾补LF，避免行注释吞掉源码。以前压平的模板需要重新粘贴。

真实宿主脚本：`scripts/verify-waveform-host.ps1 -CodePath <IDE.exe> -TestPath test/vscode_header_host.js -MultiRoot`。
双根工作区从启动时载入，避免测试期间切换工作区的窗口流程影响测试运行。
每个宿主6项：运行配置注册、配置JSON往返和一次撤销、BOM/中文路径/CRLF、实时重读、三类错误不修改源码、双根同名模板隔离。

变更文件清单：

- `src/editor/header-template.js`、`src/editor/commands.js`：模板加载、路径/编码边界与插入命令接入。
- `package.json`、`package.nls.json`、`package.nls.zh-cn.json`：配置控件、文件设置和双语说明。
- `test/editor_test.js`、`test/vscode_header_host.js`、`scripts/verify-waveform-host.ps1`、`.gitignore`：聚焦回归、隔离双根宿主与测试文件入库。
- `README.md`、`CHANGELOG.md`、`docs/bugs/compat-header-template-multiline.md`、本报告：用法、缺陷成因、交付边界和验收证据。
- `package-lock.json`、`src/native/package.json`、`src/native/package-lock.json`、`src/native/Cargo.toml`、`src/native/Cargo.lock`：候选版本统一为beta.15，防止覆盖旧安装包。

本轮本地完整回归：JS184文件，golden42/42，Node657通过/1项可选跳过，电路170/170，Rust153/153。
文件头聚焦回归在Node22/24均为21/21；VS Code1.143.0和Qoder API1.106.3的真实双根宿主各6/6。
日志：`bin/beta15-native-build.log`、`bin/beta15-full.log`、`bin/beta15-rust.log`。包内运行内容和解包宿主结果在打包后补记。


beta.15候选源提交 `3ce9ae66fd70577367cc558fa36f9d6df8f084a1`；VSIX 458文件，443个运行/模板文件与源码及原生/vendor逐字节一致。
包前默认回归647通过/11项可选跳过；启用真实Icarus的独立完整回归为657通过/1项可选跳过，均无失败。
解包后VS Code1.143.0和Qoder API1.106.3各6/6，总计12/12文件头宿主验收通过。
初次解包验收暴露测试的undo RPC完成早于文档通知，改为等待明确文档恢复事件，避免固定延时或重复撤销；
这次测试同步修订不改变包内运行内容，不覆盖同号产物。打包与解包验收日志为`beta15-package.log`、
`beta15-package-verification.log`、`beta15-packaged-vscode-header.log`、`beta15-packaged-qoder-header.log`。

| beta.15产物 | 字节 | SHA256 |
|---|---:|---|
| svtools-4.0.0-beta.15-win32-x64.vsix | 18568839 | `efc2032b2264209824f15c780fbdf4eb3d4a13eb7c38865beb2221faef19495f` |
| svtools.exe | 24017920 | `a5fc27f23673ff170429b1ffc9cbc9326d91bcc4115f0ac489f107466ad4de5a` |
| svtools.win32-x64-msvc.node | 24163328 | `018e28372088f633b0acfa15a2de3052c0aa37da6517a9b158530c265feb22f8` |

最终远程CI以PR11当前提交的Windows Node22/24检查为准；本轮仅推送既有开发分支与更新草稿PR，不创建正式tag或Release。


## beta.16形参默认值与标量列对齐

用户的m_send默认值等号无法对齐，新增标量twakeup后又暴露名称落入位宽列。
旧对齐器把默认值当作普通尾部文本，且隐式input类型分支没有将共享位宽计入前缀宽度。
现使用共享词法token定位声明顶层等号，完整左侧（包括unpacked维度及无默认值形参）参与列宽；
标量为空位宽列预留空间，遵循portNameGap，保留单行/reindentOnly行为。

两种用户样例已加入人工golden，覆盖整个扩展同款格式化管线；配置组合还覆盖Tab、列间距、alignComma及inlineCompact。
完整保留字符顺序与表达式/字符串/注释，比较符和嵌套括号内等号不作为默认值列。
修复过程见[调试笔记](bugs/logic-task-argument-columns.md)，布局合同见格式化规范§8.4。

变更文件清单：

- `src/native/src/align/task_func_param.rs`：补默认值列和标量位宽占位，附原生回归。
- `example/ex20_task_argument_defaults.sv`、`example/target/ex20_task_argument_defaults.sv`：两种用户写法与人工期望。
- `test/formatter_contract_test.js`：完整管线等号/名称列、配置、保全、幂等回归。
- `test/vscode_release_host.js`：真实编辑器命令与golden对照。
- `docs/FORMAT_SPEC.md`、`docs/bugs/logic-task-argument-columns.md`、本报告：布局合同、成因和验收证据。
- `README.md`、`CHANGELOG.md`：当前候选说明。
- `package.json`、`package-lock.json`、`src/native/package.json`、`src/native/package-lock.json`、`src/native/Cargo.toml`、`src/native/Cargo.lock`：统一beta.16候选版本，旧包保留。

本轮完整回归：JS184文件，golden44/44（22文件，新增文件含两种用户写法），Node666通过/1项可选跳过，电路170/170，Rust155/155。
格式化合同64/64，新增9项在Node22下9/9；真实VS Code编辑器验收6/6。
证据：`bin/beta16-native-build.log`、`beta16-golden.log`、`beta16-contract.log`、`beta16-full.log`、`beta16-rust.log`、`beta16-node22.log`、`beta16-source-editor-host.log`。


beta.16候选源码 `bb6a3281364cad4bdf879fcde0e6ffcac95fe571`，安装包458文件，443个运行/模板文件逐字节核对一致。
包前完整回归仍为Node666通过/1项可选跳过、电路170/170；解包后VS Code与Qoder编辑器各6/6（合计12/12），包括新增task golden。
独立CLI的两种task形态也与人工期望全文一致。日志：`beta16-package.log`、`beta16-package-verification.log`、
`beta16-packaged-vscode-editor.log`、`beta16-packaged-qoder-editor.log`。

| beta.16产物 | 字节 | SHA256 |
|---|---:|---|
| svtools-4.0.0-beta.16-win32-x64.vsix | 18571120 | `2d06cc700b7da5e90a2a5b070878466f486c9a68fabbd576fbf10161c21c3b34` |
| svtools.exe | 24020992 | `34f78af9c8b697d876d4129b2b498c03d535084a3d5de5b04ed04f672d60e141` |
| svtools.win32-x64-msvc.node | 24166400 | `1081fd2682e09f7392e9c619b6686afeb3e874d8a5520eb8acfb8d19e5313919` |

最终远程检查以PR11当前提交为准；本轮仅更新既有开发分支和草稿PR，正式4.0.0尚未tag或Release。

补充：编辑器golden验收在写入隔离文档前统一夹具行尾，避免干净Windows检出的CRLF使比较与目标LF不一致。此测试源调整不改变VSIX运行内容。
