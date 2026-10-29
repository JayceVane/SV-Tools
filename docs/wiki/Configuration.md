# 配置参考

在设置中搜索 `svtools`，或编辑工作区 `.vscode/settings.json`。用户级与工作区级设置按 VS Code 的常规优先级合并；文件头两项支持资源作用域，可按多根工作区分别配置。

下面默认值来自4.1正式版的扩展清单；路径示例使用正斜杠可避免JSON反斜杠转义。补全标准不改变仿真器编译选项，include目录不等同于源文件表。

4.1新增的常用设置：`svtools.project.traceTrigger`默认为`"selection"`（选择即追踪），可设为`"manual"`；`svtools.tasks.retainedRuns`默认为`5`，设为`0`关闭工具任务目录自动封顶。

| 配置 | 默认值 | 说明 |
|---|---|---|
| `svtools.tabSize` | `4` | 缩进使用的空格数 |
| `svtools.useTab` | `false` | 缩进使用制表符（Tab） |
| `svtools.indentStyle` | `"1tbs"` | 缩进风格 |
| `svtools.ignoreTick` | `true` | 缩进计算时忽略预处理指令 |
| `svtools.maxConsecutiveEmptyLines` | `1` | 允许的最大连续空行数（0 = 允许处也不留空行；-1 = 完全不处理空行） |
| `svtools.stripEmptyLine` | `true` | 删除对齐端口/参数列表时产生的多余空行 |
| `svtools.inlineCompact` | `true` | 行内紧凑：单行语句内主动删除多余空格（关键词、变量、运算符之间，如 else $error("x", $time)） |
| `svtools.blankCompact` | `true` | 行间紧凑：主动删除多余空行（块内删除、块间折叠）。关闭则保持用户空行且不新增空行 |
| `svtools.portNameGap` | `2` | 模块/接口头端口表及 task/function 参数表中名称列与最宽前缀（方向/类型/位宽）之间的空格数（1-8） |
| `svtools.oneBindPerLine` | `true` | 模块实例化中每行只写一个端口连接 |
| `svtools.oneDeclPerLine` | `false` | 每行只写一个信号声明 |
| `svtools.paramOneLine` | `true` | 参数声明在可行时保持单行 |
| `svtools.importSameLine` | `false` | import 语句与 module 声明保持在同一行 |
| `svtools.alignComma` | `true` | 对齐逗号/分号 |
| `svtools.instAlignPort` | `true` | 对齐实例化端口 |
| `svtools.instPrefix` | `"u_"` | 模块实例名的默认前缀 |
| `svtools.includePortDeclarations` | `true` | 生成模块实例化时附带信号声明（input 生成 reg，output 生成 wire） |
| `svtools.clock` | `["clk","uclk","cclk"]` | 默认的时钟信号名列表 |
| `svtools.reset` | `["rst_n","reset_n"]` | 默认的异步复位信号名列表 |
| `svtools.sreset` | `["sreset","srst"]` | 默认的同步复位信号名列表 |
| `svtools.waveType` | `"vcd"` | 测试台生成的波形格式（默认 VCD；FSDB/VPD/SHM 需要对应的仿真器支持）。 |
| `svtools.taskInit` | `true` | 测试台中生成 init 任务 |
| `svtools.taskDrive` | `true` | 测试台中生成 drive 任务 |
| `svtools.headerTemplate` | `""` | 多行文件头模板，支持 {FILE}、{DATE}、{TIME}、{YEAR}。可直接粘贴带换行的文本；settings.json 中使用 JSON 的 \n 换行转义。留空使用内置模板；headerTemplateFile 优先。 |
| `svtools.headerTemplateFile` | `""` | UTF-8 文件头模板路径，每次插入时重新读取。支持绝对路径、相对于当前文档所属工作区的路径或 ${workspaceFolder}/templates/header.txt；工作区外的相对路径以源码目录为准。留空使用 headerTemplate；文件无效时明确报错，不插入默认模板。 |
| `svtools.lint.engine` | `"iverilog"` | Lint 引擎：Icarus Verilog（iverilog -tnull）或 Vivado xvlog（工具链位置取 svtools.vivado.path） |
| `svtools.lint.currentFileOnly` | `true` | 只对打开的文件做语法检查——快速、不产生工作区其他文件的诊断。关闭后跨文件解析（iverilog -y 扫描 / xvlog 附带工作区文件集） |
| `svtools.iverilog.path` | `""` | Icarus Verilog 的 bin 目录（或 iverilog 可执行文件的完整路径）。留空 = 从 IVERILOG_HOME、PATH 和常见安装位置自动探测。 |
| `svtools.iverilog.cygwinPath` | `""` | cygwin1.dll 所在目录，Cygwin 构建的 Icarus Verilog 安装在 Cygwin 根目录之外时需要。留空 = 自动探测。 |
| `svtools.iverilog.standard` | `"auto"` | 传给 -g 的语言标准。auto：.sv/.svh 使用 2012，.v/.vh 使用 2005；default：由 iverilog 自行决定 |
| `svtools.iverilog.lintOnSave` | `true` | 保存时运行 iverilog 语法检查，诊断结果显示在问题（Problems）面板 |
| `svtools.iverilog.lintOnChange` | `true` | 输入时运行 iverilog 语法检查（防抖，未保存的缓冲区内容经临时文件参与检查） |
| `svtools.iverilog.lintDebounceMs` | `800` | 输入触发语法检查的防抖延迟（毫秒） |
| `svtools.iverilog.lintOnOpen` | `true` | 打开 Verilog 文件时运行 iverilog 语法检查 |
| `svtools.iverilog.lintArgs` | `["-Wall"]` | lint 与仿真编译附加的 iverilog 参数（如 -Wall） |
| `svtools.iverilog.includePaths` | `[]` | 头文件包含目录（-I），相对工作区根目录。文件所在目录始终会被包含。 |
| `svtools.iverilog.libraryPaths` | `[]` | 模块库目录（-y，按文件名解析模块），相对工作区根目录。文件所在目录始终会被包含。 |
| `svtools.iverilog.scanWorkspace` | `true` | 扫描工作区内的 Verilog 源码：将所有包含源文件的目录加入 -y/-I，并按模块定义索引解析缺失模块（支持文件名与模块名不一致的情况） |
| `svtools.iverilog.simFiles` | `[]` | 仿真时与当前文件一同编译的附加源文件 glob 模式（如 src/*.v、tb/*.sv） |
| `svtools.iverilog.simTop` | `""` | 仿真的顶层模块（-s）。留空 = 由 iverilog 自动选择根模块。 |
| `svtools.iverilog.simArgs` | `[]` | 仿真扩展参数，置于 .vvp 输入文件后（如 +trace、+seed=73、-fst）。已知 vvp CLI 选项（带值的 -l/-M/-m 及 -h/-i/-n/-N/-q/-s/-v/-V）自动置于文件前；-- 之后的值均按扩展参数原序传递。 |
| `svtools.iverilog.simTimeoutMs` | `0` | 仿真超时时间（毫秒）；0 = 运行到 $finish 结束（可通过命令或状态栏停止） |
| `svtools.iverilog.autoOpenWaveform` | `true` | 仿真产生新的 .vcd 文件时自动打开内置波形查看器 |
| `svtools.iverilog.waveViewer` | `""` | 外部波形查看器可执行文件（如 GTKWave）。留空 = 使用内置 VCD 波形查看器（webview 面板；.fst 文件使用外部程序打开） |
| `svtools.vivado.path` | `""` | Vivado 安装目录（如 D:/Xilinx/Vivado/2022.1，也接受其 bin 目录或 vivado.bat 全路径）。留空 = 从 XILINX_VIVADO、PATH 和常见安装位置自动探测。 |
| `svtools.vivado.part` | `""` | 工程创建向导的默认器件型号（-part，如 xc7a35tcsg324-1）。留空 = 建好后在 Vivado 中选择。 |
| `svtools.vivado.timeoutMs` | `0` | Vivado batch 超时时间（毫秒）；0 = 不限时（可通过命令或状态栏停止） |
| `svtools.vivado.simRuntime` | `""` | Vivado xsim 仿真运行时长（xsim.simulate.runtime），如 1000ns。留空 = 跑到 $finish（xsim -runall） |
| `svtools.vivado.structure` | `{"sources":["src","rtl","rtl/**","src/**"],"sim":["sim","tb","sim/**","tb/**"],"constraints":["constraints","xdc","constraints/**","xdc/**","*.xdc"],"projectDir":"prj"}` | 工程创建向导使用的工程结构模板：按目录 glob 把文件划入 sources / sim / constraints 文件集，并指定 Vivado 工程输出目录。默认遵循 src/sim/prj 布局。 |
| `svtools.completion.uvmVersion` | `"1.2"` | UVM 补全接口版本：UVM 1.2、IEEE 1800.2-2020（Accellera 2020.3.2）或关闭。独立于编译器配置。 |
| `svtools.completion.includePaths` | `[]` | 补全索引额外读取的 HDL 头文件/库目录。相对路径基于工作区文件夹，支持 ${workspaceFolder}。 |
| `svtools.completion.maxFiles` | `5000` | 补全工程索引的 HDL 文件数量上限。超过预算时标记补全列表不完整。 |
| `svtools.completion.maxFileSizeKB` | `2048` | 补全索引读取的单个未打开 HDL 文件大小上限（KiB）。已打开文件使用当前未保存内容。 |
| `svtools.completion.maxTotalSourceMB` | `32` | 未打开文件补全索引的 UTF-8 源码总预算（MiB）；这是源码容量预算，不是堆内存上限。 |
| `svtools.completion.standard` | `"auto"` | 补全关键词的语言标准。auto 根据文档语言及当前 `begin_keywords 指令选择。独立于编译器选项。 |
| `svtools.completion.maxItems` | `1000` | 单次补全的候选项上限。宽泛请求会标记不完整，继续输入前缀可定位索引内其余声明。 |
| `svtools.circuit.yosysPath` | `"bundled"` | 默认 bundled 使用插件内置 Yosys，无需 Python 或额外安装；也可指定外部 Yosys 可执行文件路径。 |
| `svtools.circuit.frontend` | `"auto"` | auto：内置Yosys默认使用Slang解析SystemVerilog，外部工具沿用read_verilog -sv。slang/verilog显式覆盖；外部slang需工具提供read_slang。 |
| `svtools.circuit.sources` | `[]` | 有序 RTL 源文件列表。留空时自动收集当前工作区文件夹内的模块、接口及包依赖；非空时遵守此顺序，当前文件未列出则追加，不再自动扫描。 |
| `svtools.circuit.includeDirs` | `[]` | HDL include 目录，可相对工作区或使用绝对路径。 |
| `svtools.circuit.defines` | `[]` | 预处理宏，例如 SYNTHESIS 或 WIDTH=8。 |
| `svtools.circuit.top` | `""` | RTL 电路顶层模块；留空则从当前文件选择。 |
| `svtools.circuit.generationTimeout` | `120` | 电路生成超时，单位秒。 |

具体操作见[格式化](https://github.com/JayceVane/SV-Tools/wiki/Formatting)、[文件头](https://github.com/JayceVane/SV-Tools/wiki/Code-Generation)、[补全](https://github.com/JayceVane/SV-Tools/wiki/Completion)、[仿真](https://github.com/JayceVane/SV-Tools/wiki/Simulation)、[Vivado](https://github.com/JayceVane/SV-Tools/wiki/Vivado)和[电路](https://github.com/JayceVane/SV-Tools/wiki/Circuits)。
