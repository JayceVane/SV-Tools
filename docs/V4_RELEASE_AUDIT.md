# 4.0正式发布前审查 — beta.14

审查日期：2026-10-23至24日。基线 `e7eba3b` / `4.0.0-beta.11`，独立分支 `codex/feat-circuit-viewer`。
只在4.0 worktree修复和构建，未改用户维护的3.x目录或corelib RTL。

## 当前判断

基线完整测试虽通过，仍复现了源码词法损坏、错误模板和工程引用丢失。本轮必须先修复这些问题，不能直接以beta.11发布4.0。
修复后，以下明确复现的问题及其回归均已解决；在本轮覆盖范围内未发现尚未修复的P0/P1。
beta.14作为新的可追溯发布候选，后续正式版仍需独立4.0.0版本、重建和发布验收。本轮不自动合并、创建正式tag或公开Release。
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

在本轮明确覆盖的Windows x64和工具版本范围内，未发现仍阻断正式发布的已确认P0/P1；建议以通过最终CI的beta.14作为封版基线。正式4.0.0仍须独立版本化、重建与发布，不重命名或覆盖候选包。

## beta.14干净构建复核

PATH-only BAT的真实原始复现退出37，修复后名称/绝对/相对三种入口均正确定位兄弟文件。两项新增回归及toolchain_test 25/25通过。
清理npm_execpath/npm_node_execpath后直接执行与CI相同的`node scripts/build-native.js`成功，未改构建脚本绕过问题。
beta.14完整本地回归：JS182文件，golden42/42，Node650通过/1可选跳过，电路170/170，Rust153/153。
真实Icarus、xvlog/xelab、Vivado工具链验收通过；故意语法错误及Vivado退出0的ERROR均按失败识别。
证据：`beta14-native-build.log`、`beta14-full.log`、`beta14-rust.log`、`beta14-toolchains.log`，以及`bin/release-audit-circuit/path-batch-4hJY5n`（修复前）和`path-batch-spZgXf`（修复后）。
候选包和远程CI的最终结果将在完成后记录。
