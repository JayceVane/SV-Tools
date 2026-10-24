# Changelog

All notable changes to the SystemVerilog VSCode Extension will be documented in this file.

## [4.0.0-beta.16] - 2026-10-24

**变更内容：** 多行task/function形参的默认值等号按列对齐；省略方向词的标量形参预留整组位宽列，twakeup等名称与向量参数对齐，遵循portNameGap。

**为什么：** 原实现将默认值视为普通尾部文本，只对齐带逗号的参数名；隐式input类型分支又没有把位宽列计入最大前缀，标量名称会左移。

**影响面：** 复用共享词法扫描，仅识别声明顶层的默认值等号，保留表达式、字符串、注释和非布局字符顺序；单行参数保持单行，reindentOnly不新增列对齐。用户的原始m_send及追加twakeup两种形态均加入golden。

## [4.0.0-beta.15] - 2026-10-24

**变更内容：** 文件头模板设置改用多行输入框，新增 `svtools.headerTemplateFile` 读取独立UTF-8文本；支持绝对路径、当前文件所属工作区相对路径和 `${workspaceFolder}`。保留空行与字面转义，补齐末尾换行，模板修改下次插入立即生效。

**为什么：** 此问题未被beta.14发布审查覆盖：单行设置控件会丢失粘贴文本中的换行，且原命令从未读取外部模板文件。末尾缺少换行的行注释还会与原文件第一行粘连。

**影响面：** 保留已有内联字符串与内置模板回退；配置按文档资源读取，避免多根工作区串用模板。显式文件无效时明确报错且不修改源码，不回退为默认头。已有被单行控件压平的内容无法推断原换行，升级后需重新粘贴或改用文件模板。

## [4.0.0-beta.14] - 2026-10-24

**变更内容：** 修复Windows批处理从PATH按名称调用时的脚本自身目录定位，确保干净CI环境可构建原生模块。

**为什么：** beta.13的本地构建和宿主验收通过，但远程CI揭示npm.cmd在环境中转边界下把兄弟npm脚本定位到工程目录，原生构建直接失败。

**影响面：** 批处理保留特殊字符传参规则，补PATH-only调用与兄弟文件定位的真实回归；以独立beta.14重建并再次进行CI验收，保留旧候选产物。

## [4.0.0-beta.13] - 2026-10-24

**变更内容：** 发布前复核继续修复非ANSI端口在独立net/reg声明中的位宽和符号，不能完整解析的数组/type参数明确拒绝，避免成功结果静默省略参数。默认VCD模板直接记录波形；vvp配置中的plusargs按运行参数阶段传递；运行时dumpfile覆盖纳入旧波形关闭与产物发现。

**为什么：** beta.12的ANSI端口和参数平衡处理仍未涵盖独立声明与不可表达参数；参数片段被省略、独立signed信息丢失，会使模板与实际声明不一致。

**影响面：** 继承beta.12发布审查修复；补真实Icarus位宽自检与拒绝生成回归，换独立预览号重新构建、回归和打包。beta.12作为内部检查产物保留，不作为本轮交付候选。审查结论及证据见 `docs/V4_RELEASE_AUDIT.md`。

## [4.0.0-beta.12] - 2026-10-23

**变更内容：** 发布审查修复格式化把 `+ +` 合成 `++`、拆开 `===`/`>>>` 等运算符的问题；字符守恒之外新增词法与保护区校验。嵌套参数、字符串、整数端口位宽、非ANSI端口及Testbench控制信号生成修正，不能忠实表达的数组/接口/用户类型明确拒绝。默认波形改为VCD，修正dump层级参数、无时钟和多时钟仿真骨架。

**为什么：** 字符顺序未变不代表词法或仿真行为未变；生成器此前可能返回成功却丢端口、降位宽，或输出无法运行的骨架。Vivado先删源引用再添加目标会在失败时丢工程成员，BAT重复展开会改变合法路径。

**影响面：** Vivado文件集移动先验证目标、失败恢复源引用和常用属性；通用BAT边界和Vivado私有Tcl桥接保留特殊路径，无法保真时明确拒绝。条件dumpfile还未执行时也保护默认dump.vcd。更新开发依赖并禁止Release覆盖同名附件。新增真实Icarus语义等价、自检模板与真实编辑器事务验收；详见 `docs/V4_RELEASE_AUDIT.md`。现阶段仍为发布候选，不自动创建正式tag。

## [4.0.0-beta.11] - 2026-10-23

**变更内容：** VCD自定义编辑器设为默认，点击文件直接进入波形页。Icarus编译成功后、vvp启动前关闭对应波形/文本标签并等待worker退出，仿真后读取新文件；支持字面dumpfile子目录产物。

**为什么：** 可选编辑器不会默认接管VCD。关闭面板仅触发异步worker退出，仿真若立即写入，可能与尚未结束的旧读取竞争。

**影响面：** 有界源码发现提供输出路径，波形注册表负责关闭屏障与写入租约；取消、超时、失败都会释放租约。静态路径精确关闭，动态路径结合历史关联与当前仿真目录回退。文本标签关闭取消时不启动仿真。真实Qoder默认打开及Icarus覆盖100MiB旧波形已验证，详情见 `docs/V4_BETA11.md`。

## [4.0.0-beta.10] - 2026-10-23

**变更内容：** 多时钟域模块例化模板逐端口连接同名信号，修复 `.i_clk_b(i_clk_a)`、`.i_rst_n_b(i_rst_n_a)` 等错误映射，生成的信号声明与实际连接一致。

**为什么：** 解析器已正确识别独立时钟和复位，但生成器把分类列表当成别名表，统一选取首个信号，错误地折叠了CDC的两个域。

**影响面：** 普通端口与时钟/复位统一使用原名，保留参数、端口顺序、声明开关及实例前缀。Testbench共用实例构造，额外域保留独立信号声明，仍需用户按设计补充其激励。新增Rust、NAPI回归及真实Icarus连接验证；交付清单见 `docs/V4_BETA10.md`。

## [4.0.0-beta.9] - 2026-10-23

**变更内容：** 修复注释或空行之后，参数覆盖的右括号另起一行时，模块例化端口未对齐、结束括号缩进未恢复的问题。加入用户完整 `cdc_hs_bits` 语料及跨行参数回归。

**为什么：** 结构识别已经得到完整实例，但待对齐缓冲区的起点定位仅检测单独一行；跨行参数头不满足匹配，注释被一并传给实例布局器后触发保守返回。

**影响面：** 定位候选行时读取完整代码后缀，继续使用同一实例识别规则和词法掩码；前缀注释保持原文，单行实例、布局开关及字符保全约束不变。验证和逐文件清单见 `docs/V4_BETA9.md`。

## [4.0.0-beta.8] - 2026-10-23

**变更内容：** 波形与电路工具栏新增“导出图片”，选择文档黑白线稿或当前界面主题，保存为SVG或高清PNG。波形默认取有效A/B区间，按名称和行高调整画幅，也可选择当前时间视口或仅导出所选信号。电路导出当前模块完整布局，保留屏外节点、位宽、总线粗细及寄存器语义。

**为什么：** 技术文档需要可读、可编辑的图形；直接截屏受视口、缩放、滚动与主题背景影响，不能完整表达所需时序和电路。

**影响面：** 波形独立查询worker数据并复用同一绘制器，电路从完整布局重新创建独立场景；不改写当前相机、游标、信号设置或源文件。共用风格选项、SVG/PNG转换和宿主保存边界。密集跳变仍明确标示，超预算给出提示而不静默截断。SVG/PNG浏览器、真实Qoder文件系统与协议回归见 `docs/V4_BETA8.md`。

## [4.0.0-beta.7] - 2026-10-21

**变更内容：** 总线收起保留子位颜色、格式、行高与分组，分组可收起并整体排序；保存/加载 `.svwave.json` 复用显示布局并报告未匹配声明。静态波形与游标/读值画布分层，模拟量范围按窗口缓存。补全、lint、电路依赖和波形角色共用源码发现清单，优先当前工程成员；仿真自动打开波形传递实际仿真入口。

**为什么：** 重复仿真不应重建调试布局，移动游标不应重画所有时序；多个模块各自发现源码会混入替代实现并重复扫描。真实宿主验收发现的首次扫描竞争及外部 include 缓存失效已补回归。

**影响面：** 工具继续拥有各自的解析和资源预算；无法唯一确定的RTL角色保留未知。新增2万独立信号、4000别名和密集跳变语料及真实Qoder宿主验收。预览打包入口校验版本、要求干净提交、拒绝覆盖同号产物，并记录源码commit与SHA256。验证边界和逐文件清单见 `docs/V4_BETA7.md`。

## [4.0.0-beta.6] - 2026-10-17

**变更内容：** 波形右键支持六种背景色及批量清除，名称和波形区域同步标记并随布局保存；总线可通过三角、Enter或右键展开/收起，每bit独立着色、选择、排序和分组。输入、输出、双向和内部信号显示不同图标。总线展开三角使用独立20px字号，扩大点击范围，信号文字和行高保持原值。

**为什么：** 控制总线的延时打拍需要逐位对照，颜色和角色标记可减少在大量信号中反复检索。普通VCD没有端口方向字段，不能仅凭wire/reg或i_/o_名字猜测。

**影响面：** 派生位共用原始VCD id与事件存储，投影只缓存当前可见窗口；精确位边沿直接读取压缩载荷并分块续查。展开遵守2000行预算，不改动memory目录。方向在worker中匹配工作区RTL，支持同id别名、ANSI/非ANSI端口；歧义、缺源码、条件编译或扫描不完整均保留未知。源发现不打开文档、不触发lint，不修改源码；完整验证及文件清单见`docs/V4_BETA6.md`。

## [4.0.0-beta.5] - 2026-10-16

**变更内容：** 生成目录排除策略覆盖文件发现、跨文件定义检索、已打开补全缓存、自动/手动工具入口和诊断发布。内部文档返回skipped，清理其旧诊断；正常RTL仍按原配置检查。

**为什么：** 用户清单的32条xvlog错误全部来自26个.svtools/circuit临时文件。旧定义检索仅排除node_modules，会打开任务快照，继而触发lintOnOpen；重启及配置切换又会重查已打开文档。/source0是Yosys WASM虚拟路径，外部Vivado无法直接编译这些包装文件。

**影响面：** 共享目录表同时生成glob及直接路径判定，兼容Windows大小写与分隔符，按完整目录段匹配。自动lint和诊断仅跳过.svtools/.Xil；显式node_modules等依赖源码仍可检查，真实错误正常显示。忽略目录不污染项目补全，但手工打开后的当前文档仍可解析；真实源码错误、任务失败状态及完整日志保留。修复记录和清单见`docs/V4_BETA5.md`。

## [4.0.0-beta.4] - 2026-10-16

**变更内容：** 电路选中/悬停状态使用独立高亮色，亮色主题为深蓝，暗色为亮蓝，高对比暗色为黄色；连线、总线位宽标记、端点、连接条和关联节点统一处理。

**为什么：** 原选中色复用了IDE的focusBorder。该主题变量存在但为白色、透明或背景同色时，CSS var回退不会触发，选中后图形与背景对比度成为1:1，表现为连线消失。

**影响面：** 仅调整电路CSS配色，保留选择、位连接、主干/分支线宽和工具数据。已用正式页面交叉验证系统明暗偏好、四种IDE主题类别以及白色/透明/背景同色焦点变量。验证与清单见`docs/V4_BETA4.md`。

## [4.0.0-beta.3] - 2026-10-16

**变更内容：** 多位端口的切片、拼接、重排与重复驱动通过独立总线连接节点显示，完整主干使用真实位宽粗线，分支标出线宽与端口位位置。普通引脚标明多比特位数，重复常量标出复制次数，详情可查逐位映射；节点标题增加文字轮廓。

**为什么：** CDC两位D/Q被按端点集合拆成单比特组，原图又把它们接到同一个完整端口，全部连线因此显示为细线，拼接/切片关系不可见。复位常量去重后的一位源也无法表达重复驱动两位。

**影响面：** 领域模型、原始位序和工具参数不变；新节点只表达连线关系，不新增硬件单元。选择分支可高亮经过的主干但不扩散到其它位，普通引脚保留局部选择。展示节点/边/引脚继续受原预算约束。新增真实CDC源码Slang→Worker→ELK及位映射回归，交付与清单见`docs/V4_BETA3.md`。

## [4.0.0-beta.2] - 2026-10-16

**变更内容：** 按用户确定的发布版本策略，将当前电路查看器与格式化完善汇总为4.0第二个预览阶段，扩展、原生模块、CLI及锁文件统一为4.0.0-beta.2。包含离线内置Yosys/Slang、工作区依赖收集、Vivado两种top入口、时序符号、复杂画布交互优化、总线位宽区分及Aurora例化对齐Golden。

**为什么：** 当前功能仍在预览阶段，正式版本统一以4.0.0交付。此前4.1.0-alpha1至alpha9保留为开发历史，后续不继续使用4.1作为当前发布系列。

**影响面：** 本轮只同步版本、文档和发布产物，运行逻辑与alpha9一致。GitHub标记prerelease，尚不发布Marketplace；旧preview.1及原工程保持。SemVer将beta.2排在preview.1和4.1 alpha之前，已有这些版本的用户需手动安装VSIX并确认替换。发布说明见`docs/releases/v4.0.0-beta.2.md`，验证和文件清单见`docs/V4_BETA2.md`。

## [4.1.0-alpha9] - 2026-10-16

**变更内容：** 区分单比特细线与多比特粗线，选中/搜索时保持粗细差异；多比特端点同步加粗，I/O显示实际位数。总线在可读长段添加斜杠与位宽，标记可点击选网，文字使用轮廓衬底而非方形背景。总览逐级隐藏文字，粗线身份保留。

**为什么：** 原总线仅2px、单线1.3px，选中后都变成2.7px，容易混淆。新标记按实际位数组而非名称决定，不给切片伪造原端口总宽度。真实ELK存在浮点近似水平段及共线路由；共享几何容许微小误差并避让标签。

**影响面：** 不改位连接、位序或工具数据。标记布局由渲染与视口索引共享，高倍率可见文字不提前裁掉；短线或拥挤区域保留粗线、悬停与详情位宽。基准新增可选总线位宽以验收复杂页面，数据和完整清单见`docs/V4_1_ALPHA9.md`。

## [4.1.0-alpha8] - 2026-10-16

**变更内容：** 修复generate内多个always与assign之后的实例端口未对齐。过程块在Generate上下文中完成时及时提交，后续实例正常进入布局。选区按首个真实代码识别，忽略分组注释；完整实例选区复用正文格式化器，端口表继续使用端口列对齐。

**为什么：** Aurora示例的后续支持模块被残留Always状态吞入，单独格式化实例却正常。带注释/实例头的选区原先落入赋值分支，而该分支使用Rust regex不支持的前瞻，异常后守卫原样回退，表现为无法对齐。赋值分支改用共享词法掩码与原文捕获，无需前瞻。

**影响面：** 保留四种ASCII排版字符之外的所有字符及顺序，字符串、注释和宏保护继续生效；不放宽保全守卫。补充Rust和NAPI回归，验证换行、TAB、GNU现有布局、关闭端口对齐及仅缩进开关。完整验证与清单见`docs/V4_1_ALPHA8.md`。

## [4.1.0-alpha7] - 2026-10-16

**变更内容：** 修复触发器时钟三角固定在左下角的错误，按实际CLK端口定位；明确低有效控制/下降沿时钟使用空心气泡，普通端点用直线连接。Yosys已知字级时序单元从原参数生成展示语义，区分DFF、LATCH、SR及隐式全局时钟FF；控制标签完整显示，详情显示触发沿、控制作用、原工具参数。

**为什么：** sync_resetn的原网表连接正确，但图形没有表达ALOAD低有效，时钟三角靠近AD，且所有空心连接点容易误读为反相。符号不能仅凭register类别或引脚名称推断。ELK端口中心用于命中，外边缘用于接线，两者分开以避免可见断线。

**影响面：** 保留真实单元类型、引脚名及全部连接，不将异步装载改写为其他单元。缺少极性参数显示问号，不假定上升沿/高有效；未知单元及Vivado未提供极性的单元保持通用符号。修复$adlatch归类。验证和完整清单见`docs/V4_1_ALPHA7.md`。

## [4.1.0-alpha6] - 2026-10-16

**变更内容：** 修复当前文件Yosys只编译自身、找不到工作区子模块的问题。sources留空时在Worker收集模块、接口和包依赖闭包，依赖先于使用方；显式列表保持原顺序。复用现有SystemVerilog语义解析，处理参数化/generate实例、不同文件名的定义与限定包名，重复定义明确提示。选中的脏依赖写入独立快照，同名文件不互相覆盖。

**为什么：** full_adder引用half_adder时，旧入口没有提供子模块。另一个相邻问题是Slang可能先输出通用ERROR，再输出真正的源码错误；原摘要只保留第一条。现在优先源码行列并回映射原文件，保留完整日志；不会自动导入类型、改枚举或失败后换前端。

**影响面：** 自动发现限定当前工作区文件夹和4096文件/单文件2 MiB/总量32 MiB预算，超限可显式配置sources。只收集依赖文件，不计算条件编译或generate；宏生成引用和复杂include上下文可用显式列表。字面include避免重复独立读入。含include的脏依赖要求先保存，避免快照位置改变同名头文件解析。源码、配置及原工程不被修改。详细验证与清单见`docs/V4_1_ALPHA6.md`。

## [4.1.0-alpha5] - 2026-10-16

**变更内容：** 优化电路画布拖拽、缩放和选择。相机更新按动画帧合并，输入热路径复用视口尺寸；屏外节点与连线从活动SVG移出，移回时按原顺序挂载。低倍率逐级隐藏难以辨认的标签与引脚；选择高亮只更新变化对象，搜索、连接和别名详情复用模块索引。

**为什么：** 旧版逐事件写入SVG、反复同步读取布局，且选择时扫描整图；复杂电路的全部SVG长期参与渲染。仅设置display:none仍有明显缩放成本，因此采用保留对象索引的视口虚拟化。

**影响面：** 电路语义、布局预算及工具入口不变。正常倍率恢复完整细节；搜索会将屏外对象移入视口。新增可复现的本机Chromium交互基准和边界回归，结果及完整清单见`docs/V4_1_ALPHA5.md`。

## [4.1.0-alpha4] - 2026-10-16

**变更内容：** Yosys前端默认改为auto，内置工具使用Slang，外部工具兼容旧前端。修复标准SystemVerilog的编译单元/模块内timeunit与timeprecision被默认入口拒绝；保留源码及未保存正文。失败摘要优先具体源码错误，完整日志保留WASI运行时提示。

**为什么：** `read_verilog -sv`只支持部分SystemVerilog，内置包虽已有Slang但默认未使用。现在根据明确的后端能力选择一次，不删除语法、不在失败后换前端重试。显式slang/verilog配置仍生效。

**影响面：** 新增auto枚举与中英文说明；外部Yosys默认仍用旧前端，显式slang需工具支持。真实回归核对时序声明、上升沿/低有效异步复位、电路连接和源位置。交付与清单见`docs/V4_1_ALPHA4.md`。

## [4.1.0-alpha3] - 2026-10-16

**变更内容：** 编辑器右上角默认使用内置Yosys，RTL右键提供当前文件Vivado，工程面板继续使用工程top。修复工程中已加入、却未被旧top引用的模块出现`Synth 8-439 module not found`；错误提示优先显示具体工具诊断。

**为什么：** `synth_design -rtl -top`只覆盖详细化入口，不会重新启用旧层级自动禁用的源文件。当前文件查看改用任务工程副本重设top与编译顺序，保留原工程的宏、include、文件类型及IP上下文。

**影响面：** 原工程仍只读，副本保存在电路任务目录并排除run结果，不保存用户正文。Tcl导出器显式UTF-8加载。完整验证与文件清单见`docs/V4_1_ALPHA3.md`。

## [4.1.0-alpha2] - 2026-10-16

**变更内容：** 默认集成固定版本 Yosys WASM 与完整工具资源，离线生成无需 Python、系统 PATH 或运行时下载。新增编辑器标题栏 Vivado 入口，按当前文件同名模块、唯一模块或用户选择确定本次 top；工程面板和 top 节点入口继续使用工程 top。修复 RTL 右键 URI 误走 JSON 导入，导入菜单与错误提示明确区分源文件和网表，外部工具缺失给出配置项及日志位置。

**为什么：** 用户实际遇到源文件头 `//` 被当成 JSON、`spawn yosys ENOENT` 两个相邻问题；仅修正错误文字不能提供可用的查看流程。内置工具将路径映射与编译放在独立进程，保留取消、宏、include、相对 readmem 和未保存正文回映射；领域模型与页面不依赖具体后端。

**影响面：** 最低VS Code提高至1.106，固定WASM需要新版V8的异常引用支持；开发基线Node22.20，CI覆盖22/24。VSIX 增加 YoWASP 0.68.1207 的原始 WASM、share 和第三方许可；外部 Yosys 路径仍可覆盖默认。Vivado 只读流程不保存、更改工程 top 或增删文件；当前文件入口要求已保存的工程综合源，工程外/未保存内容可用内置 Yosys。两条 top 策略已在真实 Vivado 2022.1.2 验证且工程文件 SHA256 不变。详情与验收见 `docs/V4_1_ALPHA2.md`。

## [4.1.0-alpha1] - 2026-10-15

**变更内容：** 新增内嵌电路结构查看器。先以真实 Yosys JSON 和 netlistsvg 验证连接，再将 Yosys、Vivado 适配到独立电路模型，使用 ELK.js + SVG 布局显示。提供 RTL 生成、JSON 导入、Vivado 只读详细化、层级浏览、网络搜索高亮和源码定位；模型保留位序、升降序总线、常量、参数和别名。

**为什么：** 让用户在编辑器内核对 RTL 电路结构，同时使前端、布局器和工具方言各自独立。解析、验证和布局移入有容量与超时限制的 Worker，避免网表阻塞扩展宿主；生成复用已有任务取消、日志和进程管理。

**影响面：** 新增四个电路命令与 `svtools.circuit.*` 设置，固定 ELK 运行资源随 VSIX 分发，Yosys 和 netlistsvg 不随包分发。Vivado 首版是平坦 RTL 视图；大电路按模块查看并实施展示预算。源码与补全索引统一排除 `.svtools`、`.Xil` 等生成目录，避免任务快照造成重复模块。CI 增加根依赖安装。4.0 preview 的发布资产不变；配置与验收见 `docs/CIRCUIT.md`、`docs/V4_1_ALPHA1.md`。

## [4.0.0-preview.1] - 2026-10-15

**变更内容：** 汇总 alpha1–alpha13 为首个 GitHub 预览版，同步 3.5.0 正式发布基线；扩展、native、CLI 与锁文件统一版本。发布流程校验 tag、构建 Windows x64 包、执行完整回归并提供 SHA256 清单，带后缀的版本标为 prerelease。

**为什么：** 将当前格式化、补全、工具链、Vivado 管理和波形改造交付为可安装版本，并从统一基线开始下一版本的电路视图开发。

**影响面：** 通过 PR 合入原工程，3.5.0 的提交与已有发布保留。此次仅发布 GitHub，不发布 Marketplace；电路视图不进入此包。安装、功能与已知限制见 `docs/releases/v4.0.0-preview.1.md`。

发布 CI 同时校验 Node 20：FP16 穷举参考值改为按位精确提升至 Float32 后交给平台解码；新运行时额外对照原生 Float16。生产解码算法不变。
Rust 属性/维度解析回归改为独立公开语料，移除对本机私有厂商工程的依赖；CI 与发布复用 Cargo 缓存。

## [4.0.0-alpha13] — if条件头紧凑

**变更内容：** `if (...) begin`条件独立参与行内紧凑，清除嵌套拼接逗号前的空格，折叠逗号后、移位运算符旁的冗余空格；支持同一行多个条件、else if、限定词及多行条件，保留保护区和用户换行。

**为什么：** 旧入口只紧凑以分号结束的完整单行语句，块状if头被漏掉。现在if条件与always事件头共享词法屏蔽、平衡括号和紧凑算法，范围止于条件闭括号，不需要复制一套正则重排逻辑。

**影响面：** `inlineCompact=false`保持原条件空白；异常/不完整语法仍保守处理，alpha12字符保全规则保持最高优先级。新增用户片段golden和真实管线/保护区合同，详情与修改清单见 `docs/V4_ALPHA13.md`。

## [4.0.0-alpha12] — 格式化字符保全

**变更内容：** 新增不可配置的提交条件：仅ASCII空格、Tab、CR、LF可以变化，其它字符的内容、数量和顺序必须与原文完全一致。全部乱码和不完整语法同样适用；候选不安全或布局异常时返回原文并记录诊断。

**为什么：** Unicode空白和控制字符可能被宽泛的空白处理吞掉，声明拆分会重复类型并改写标点；NAPI普通String转换还可能在Rust校验前替换孤立UTF-16代理项。Rust核心、NAPI原文边界、编辑器全文/选区和对齐命令现在分层保护，代码生成命令保持原用途。

**影响面：** 所有布局配置服从字符保全，改写正文的声明拆分候选将被拒绝。无效UTF-8输入不覆盖源文件或既有输出。新增异常、乱码、随机变异、真实native/CLI与错误native替换回归；详情和清单见 `docs/V4_ALPHA12.md`。

## [4.0.0-alpha11] — 拖动栏宽与更窄的菜单

**变更内容：** 左侧信号目录和名称/A-B读值栏支持拖动边界调整宽度并保存，双击/Home恢复默认，方向键微调，Escape/失焦/指针取消回滚。主菜单272→232px、格式子菜单282→244px，字号和图标尺寸保持不变。

**为什么：** 长层级名和宽位信号需要按调试场景分配空间，固定名称栏无法调整；原目录只有底角原生缩放且未统一保存。两条边界现在共用纯几何和独立控制器，视口暂时缩窄不会丢失用户设定。

**影响面：** Canvas时间轴、游标映射、分隔线和采样预算共用有效宽度，拖动不逐帧查询或保存，结束时仅更新窗口采样。VCD存储和精确读值未改，无新增依赖；4.0工作树独立开发。验收与清单见 `docs/V4_ALPHA11.md`。

## [4.0.0-alpha10] — 保持字号的紧凑菜单

**变更内容：** 保持所有字号、字体、字距和图标尺寸，菜单项高度由36px调整为32px，收紧菜单外留白、标题、分区及页脚间距。

**为什么：** 用户希望菜单略紧凑，同时保留文字可读性。此次仅调整布局尺寸，宽度、层次、配色、悬停缓冲和键盘规则沿用alpha9。

**影响面：** 生产逻辑未改，无新增依赖或测试；真实页面检查字号和矩形尺寸，完整回归随打包执行。验证与完整清单见 `docs/V4_ALPHA10.md`。

## [4.0.0-alpha9] — 波形右键菜单细化

**变更内容：** 菜单增加信号名称/位宽摘要、选择数量和当前格式徽标，显示格式按整数/波形/浮点分区；分组操作使用统一线性图标，移除操作单独配色。明暗主题统一圆角、间距、边框、阴影、焦点与短入场反馈。

**为什么：** 原菜单的信息层次和操作识别较弱，指针斜向移入子菜单时容易触发其他条目立即收起。现在悬停展开90ms、切换收起150ms，进入子菜单撤销待收起任务，离开未展开条目取消延迟；键盘和关闭立即撤销定时器，避免迟到回调重开菜单。

**影响面：** 菜单DOM/焦点与波形操作分离，字幕按纯文本写入，子菜单向左展开时箭头同步反向。保留原格式、分组、批量目标与拖动规则；没有新增依赖。验收和完整清单见 `docs/V4_ALPHA9.md`。

## [4.0.0-alpha8] — 模拟量行高拖拽与排序动画

**变更内容：** Analog/real 行的下边界支持鼠标拖动调整高度并保存布局。信号排序增加浮动预览、所选数量、插入线、行让位与落下动画，多选作为整体移动，边缘支持自动滚动。

**为什么：** 原行高只能通过右键逐次增加，排序在松开后才突然更新。现在缩放边界可以直接发现和拖动，预览明确实际落点；行高和排序共用 Pointer 生命周期，出界释放、Escape、失焦与取消均能结束手势或恢复原布局。

**影响面：** 纯几何、手势控制和 Canvas 绘制分工，预览不逐帧持久化或请求 VCD，完成后再按可见信号刷新。行高限制为 60–480px，数字行保持固定高度；减少动态效果偏好跳过位移动画。没有新增运行依赖，3.x 原目录继续独立维护。验收与清单见 `docs/V4_ALPHA8.md`。

## [4.0.0-alpha7] — 浮点显示与波形多选交互

**变更内容：** 显示格式归入右键子菜单，波形与二维 mem 共用 FP64、FP32、TF32、BF16、FP16、FP8(E3M4) 解码。支持负零、非正规数、Inf/NaN，X/Z 保持可见；TF32 支持 19 位与低 13 位为零的 32 位 RTL 容器约定。

**为什么：** 平铺的格式菜单和不稳定的选择锚点使批量分组容易误选；固定深色矩形标签与浅色主题不协调。现在 Shift 范围可收缩，右键保留已选集合，混合位宽禁用不适用格式。分组对话框与整体拖动保留行顺序，菜单支持键盘与边缘定位；文字随主题配色并用细轮廓，科学计数法缩略保留指数。

**影响面：** 浮点目录、交互纯规则、菜单 DOM 和绘制各自负责；格式切换复用原位值，存储器继续有界分页。E3M4 采用用户确认的 Inf/NaN 约定，FSDB 仍取消。未改 3.x 原目录、VCD 事件存储或工具链实现。验证与完整清单见 `docs/V4_ALPHA7.md`。

## [4.0.0-alpha5] — 修复空工程树与管理面板交互

**变更内容：** 工程树首次异步加载、手动刷新和文件监听均发送数据变更事件，补齐稳定节点 ID 与父节点以支持展开/收起。新增明确的工程选择、真实文件集清单、当前工程源码层级预览和任务停止；缺失/损坏工程会显示原因并支持恢复。

**为什么：** 原数据提供器仅替换内部 roots，VS Code 保留首次读取的空列表。右键加入未读取 nodeData.file，工程发现总取第一个 .xpr，层级还混入全工作区单元。管理动作使用固定脚本和目录启发式文件集，也会使并发或过期节点操作错误成员。现在工程选择、纯模型快照与视图/命令分工；写操作核对当前 XPR 事实，脚本与报告目录独立。

**影响面：** 面板与编辑器增量命令共用工程选择和忙碌状态，自定义文件集名称贯穿仿真 Tcl。xelab 接收实际 top 与所选集成员，无需切换默认 lint 引擎，停止路由到对应任务。源码预览按单元区间屏蔽注释/字符串，仿真设计依赖只作引用展示；预览有文件/字节/节点预算，实际层级仍以工具详细化为准。真实 VS Code 宿主和 Vivado/XSim 验证通过；不改 3.x 原目录。使用、验证与文件清单见 `docs/V4_ALPHA5.md`。

## [4.0.0-alpha4] — 工具链任务可靠性与有界日志

**变更内容：** Icarus、xvlog/xelab 与 Vivado batch 统一任务成败：依赖错误、非零退出、启动失败、超时和不完整诊断均使检查失败。每次任务使用独立产物目录，停止覆盖准备、探测、编译和运行；文档变化及替换请求取消过期任务，按触发文档合并依赖诊断。

**为什么：** 原 xvlog 仅用当前文件错误数判断通过，准备失败也返回空的成功结果；共享 .prj/xsim.dir 和临时文件会让并发任务相互覆盖。完整 stdout/stderr 累积以及逐 chunk 刷新通道也使长时间仿真占用增长。现在进程、日志、任务、诊断与编辑器接线各自负责，流式捕获错误和依赖，完整日志写盘并带背压，显示和内存摘要有界。

**影响面：** 编译或运行失败不会自动打开残留/部分波形；成功时按文件元数据实际变化识别产物。保留仿真 cwd，使相对 `$readmemh`/`$dumpfile` 继续工作；未保存文档的仿真仍明确使用磁盘内容。xvlog 增量缓存限同次任务，跨任务复用暂取消以确保隔离。没有新增依赖；真实 Icarus、xvlog/xelab、Vivado 验收通过。操作、验证与完整文件清单见 `docs/TOOLCHAINS.md`、`docs/V4_ALPHA4.md`。

## [4.0.0-alpha3] — VCD 存储器查看

**变更内容：** 新增存储器视图，把 `mem[addr]` 字数组与 `mem[row][col]` 展开记录按地址显示，共享波形的 A/B 游标。支持 Hex/Bin/Dec/SDec、地址定位、分页、变化标记、单元添加波形与状态恢复。

**为什么：** 大量 memory 单元逐行添加波形不便于对照地址和内容。数组索引识别、页面交互与精确读值分别负责，页面只查询当前页，避免展开整个矩阵。

**影响面：** 原 VCD 数据服务与波形导航保持兼容；未 dump 单元和无初值分别显示。packed 切片不会误作数组地址，定义冲突的数组仍可在普通波形中查看。用户取消 FSDB 开发，本版本不新增 FSDB 查看支持。验证与文件清单见 `docs/V4_ALPHA3.md`。

## [4.0.0-alpha2] — always 事件头与大文件波形查看器

**变更内容：** `inlineCompact` 开启时删除 always 事件控制头的冗余水平空白，保留注释、字符串、宏、转义标识符及用户换行。波形查看器改用 worker 流式解析与紧凑分块存储，页面按需请求可见时间窗，增加双游标 Δt、信号检索、精确边沿导航、布局恢复与明暗主题。

**为什么：** always 块头没有分号，原先未进入完整单行语句的紧凑规则。原波形路径同步读取与 split 全文、逐事件分配对象、向页面传递全量数据，造成宿主卡顿和多份内存。对齐职责与波形的数据服务、交互和绘制现在分别处理。

**影响面：** 格式化保持原有 golden；关闭 `inlineCompact` 仍保留事件头空格。VCD 解析统一处理 chunk 边界、别名、同刻最终值和损坏输入，错误显示位置。密集跳变区明确标记，游标和边沿始终从完整数据查询；加载可取消，关闭释放 worker。100/500 MiB 性能与资源验收边界记录于 `docs/WAVEFORM.md`，4.0 仍为本地 alpha。

## [4.0.0-alpha1] — 独立开发分支

**变更内容：** 源码与构建产物分为 `src/`、`bin/`；Rust 格式化器按词法扫描、预处理、类型化结构状态、行/块布局和空行裁决分工，napi-rs 入口独立为 host 适配层。编辑器、波形、工具链和工作区索引按职责拆分，工具进程复用 UTF-8 流、超时、停止及 Windows 进程树处理。

**为什么：** 原主循环同时识别语法、决定布局并控制输出；多个阶段分别判断字符串、注释和宏，造成 UTF-8 字符串损坏、`begin` 并入注释以及对齐阶段重新修改受保护的原文。标点字符串使用 `Box::leak`，也使长期格式化留下永久分配。

**影响面：** 4.0 继续保留已有命令和默认格式化样例，修复字符串、注释、宏、转义标识符及嵌套参数的保真问题。空行只由最终规则裁决；单行实例与后续 `assign` 之间的用户空行现在按配置保留。原工程目录继续维护 3.x，4.0 在独立 worktree 开发。新增完整管线、编辑器、工具进程、波形和索引合同测试；发布物为当前平台原生模块、CLI 和 VSIX，尚未发布到市场。

## [3.5.0] - 2026-10-14

### Added
- **Vivado 工程管理侧边栏**（活动栏 $(chip)）：解析 .xpr 按**模块实例依赖**组织文件树（设计源/仿真源/未加入工程三类根节点，.xpr 变更 800ms 防抖刷新）；右键文件管理——加入工程（选目标 fileset）/移出工程/设置综合或仿真 top/sources↔sim 移动；**写操作跑完重解析 .xpr 按事实验证**（Vivado batch Tcl 出错也返回 0，只看退出码会假成功，用户曾遇「移出显示成功但仍在树中」）；top 级快捷操作区——xelab 详细化/工程综合/综合报告/布局布线/布局布线报告/时序报告/生成 Bitstream；报告类操作在**独立报告页**展示（行级分类着色，表头/违例识别覆盖 Vivado 两种表格形态，观感对齐 Vivado，明暗主题跟随）
- **OOC 综合读序修复**：`synth_design -mode out_of_context` 前的 `read_verilog` 按「package 文件前置 + import 语句拓扑排序」重排（Vivado 逐文件即时编译，importer 先读必报 Synth 8-36 'pkg' is not declared——与 xvlog prj 顺序、iverilog 单遍同一约束的第三个漏网点）；综合前强制刷新工作区设计单元索引（重操作不吃 10s 缓存）
- 波形查看器、器件选型页**明暗主题适配**（PAL 调色板读 CSS 变量 + 主题热切换重绘）

### Fixed
- **格式化五连修**（对齐/幂等形态，全部真机语料验证）：
  - **声明对齐按空行分组**：空行切断声明对齐组，各组独立计算列宽（原实现同缩进跨空行共用列宽，`localparam` 组的 `=` 列、`reg` 组的位宽补位、分号悬挂全被别组撑宽——用户 sfifo 的 `wr_ptr` 分号被拉到 40+ 列外）
  - **声明维度前不再莫名多空格**：带数组维度的行（`mirror_q [$]`、`mem [0:255]`）名字只对齐到组内带维度行的名宽，不被无维度行的名字列宽推远
  - **例化声明区不再输出 `localparam parameter` 重复关键字**（`parse_param` 正则加锚点 + ptype 剥离关键字残留；带类型参数 `localparam integer W` 不受影响）
  - **always 块内赋值分号贴合表达式**：移除过程赋值的分号悬挂对齐（`i_data    ;` → `i_data;`），`<=`/`=` 运算符列对齐保留；声明区的表格化悬挂不受影响
  - **begin/end 块内 assign 组间空行保留**：空行删除发生在对齐（按空行分组）之后，两轮格式化分组视图漂移导致非幂等（adder.sv 等号列来回变化）；两侧都是 assign 的空行保留（折叠至上限），其余照删
- **波形查看器总线值徽章配色看不清**：徽章文字原取 `--busSoft`（总线带柔和填充色），亮色主题下是深棕 `#8d6e63` 叠深灰底对比度仅约 2:1；文字固定浅橘 `#ffe0b2`、底加深，明暗主题下均 ≥7:1（新增 test/render-vcd-badge.js 渲染断言）
- golden 用例扩充至 18 个（新增 ex12 声明维度混组），门禁 golden 36/36、cargo 70/70、宿主 14/14

## [3.4.8] - 2026-10-09

### Added
- **xvlog lint 引擎可选**（`svtools.lint.engine`：`iverilog` 默认 / `xvlog`）：直调 Vivado 的 xvlog 做语法检查，VRFC 诊断进 Problems 面板；状态栏 ⚡ 一键切换引擎；prj 工程文件绕开 Windows 命令行长度限制，未保存缓冲区写临时文件（md5 命名）参与检查
- **xelab 详细化检查**（编辑器工具栏按钮，仅 xvlog 引擎显示）：编译通过后跑 xelab 静态细化，捕捉类型/端口/位宽/未定义引用等深度错误；**依赖迭代解析（≤6 轮）**——从当前文件出发，按 xvlog 与 xelab 两阶段的缺单元报错（`Module <X> not found` / `'X' is not declared`）自动补入缺失定义文件重试，无关文件的语法错不再阻断当前文件的检查
- **UVM 工程自动支持**：文件含 `uvm_*` 标识符即自动附加 `-L UVM`（预编译库）+ `-i <vivado>/data/system_verilog/uvm_1.2`（`uvm_macros.svh` 解析，多版本布局探测）+ xelab `--timescale`（取当前文件声明值，默认 1ns/1ps）——UVM 预编译库全库无 `timescale，与带 timescale 的用户代码混合细化必报 XSIM 43-4100（工程流由 Vivado 后台注入默认值，批处理须自带）
- **工作区设计单元索引扩展**：`module`/`interface`/`package`/`program` 统一收录，import 本地 package、实例化本地 interface 均可按定义文件命中（文件名≠单元名亦可）
- **单文件 lint 自动补依赖**：双引擎下当前文件引用本工作区定义单元时自动补定义文件重试（`--incr`/精确补文件，均 ≤3 轮），不再把跨文件引用误报成语法错；`svtools.lint.currentFileOnly`（默认开）语义为「不附带 -y 扫描目录、诊断不外溢」，关闭后附带工作区目录做全工作区解析
- **仿真运行中的停止按钮**：状态栏变为「■ 停止仿真」+ 编辑器工具栏停止按钮（按 `svtools.simRunning` 显隐）

### Changed
- **vvp 仿真实时输出**：Cygwin 构建的 vvp 在 stdout 接管道时块缓冲——短输出要等进程退出才可见、进程被强杀则整个丢失（表现为「仿真无输出」）；自动用 cygwin 目录下的 `stdbuf -oL` 强制行缓冲，`$display`/`$monitor` 实时流到输出通道（无 stdbuf 回退直跑）
- README 精简重写（688→147 行）：版本横幅与版本标记全部移除（版本历史只由 CHANGELOG 承载，README 不随发布变更），配置表收敛为核心 7 项
- 诊断位置解析新增 XSIM 消息体内嵌格式（`File "..." Line N :` 与 `File : path, Line : N,`），此类条目不再落到主文件第 1 行
- cargo 测试基线全绿（修正 2 个过时断言，67/67）

### Fixed
- **xvlog 按 prj 顺序分析导致的 package 解析失败**：package 必须排在 importer 之前——补入依赖 prepend 到最前、工作区模式当前文件移到最后（此前 `[top, pkg]` 顺序下加齐文件仍报 `'X' is not declared`）
- **xsim 仿真 `run all` 被 wave 配置块阻断**：`launch_simulation` 自动生成的 `<top>.tcl` 里 `add_wave` 排在 `run all` 之前，模块含不可 trace 对象（动态数组/队列，xsim 不支持）时脚本中断、仿真永不执行（显示成功但无 $display 输出）；改为生成最小 `xsim_run.tcl`（`run <时长>` + `quit`）挂到 `xsim.simulate.custom_tcl`（绝对路径），结束后 `reset_property` 清除
- **停止仿真留孤儿进程**：stdbuf 包装时 cygwin `exec` 更换 Windows PID 且参数不进命令行，`kill()` 杀的是已退出的壳——停止改为 `kill()` + `taskkill /T` 进程树 + 按 `ParentProcessId` 定位 exec 后的 vvp 三重击杀；仿真运行中点状态栏曾会静默重跑（真正的 Stop 藏在命令面板），现状态栏/工具栏直接是停止按钮
- **Vivado/xvlog 超时只杀 cmd.exe 壳**：vivado/xsim/xvlog 本体孤儿化继续运行（xsim「无法停止」根因）——超时路径统一 `taskkill /T` 按进程树终止
- **currentFileOnly 单文件模式跨文件模块误报**（3.4.8 迭代中引入、发布前修）：单文件 lint 曾连缺模块重试一起去掉，实例化工作区模块报 `Unknown module type`；现仍按设计单元索引精确补定义文件（宿主回归 14/14 覆盖）

## [3.4.7] - 2026-10-02

### Added
- **端口/参数表名称列间距配置 `svtools.portNameGap`**（1–8，默认 2，CLI `--port-name-gap`）：模块/接口头端口表与 task/function 参数表中名称列与最宽前缀（方向/类型/位宽）之间的空格数；设 1 即紧凑单空格风格
- **npm scripts**：`npm test`（golden 用例 + 幂等断言）、`npm run build:native`（napi 构建并把 `.node` 复制到根目录）、`npm run package`；`vsce` 打包前经 `vscode:prepublish` 自动跑 golden 测试
- **CI**（`.github/workflows/ci.yml`）：windows-latest 上从源码构建原生模块后运行 golden 测试，格式化回归在 PR 上即被拦住
- 45 项配置在设置面板按使用动线分组排列（缩进与空行 → 换行与对齐 → 代码生成 → Icarus Verilog → Vivado），由 `order` 字段固定顺序
- golden 格式化用例扩充至 17 个：新增 ex14（连续单行例化不粘连不误展开）、ex15（端口名称列边界列宽）、ex16（`pragma protect 加密区逐字节透传）

### Changed
- **仓库瘦身**：移除 v2 Python 后端（`python/`）与其进程管理器 `processManager.js`、根目录一次性调试脚本与输出文件
- **原生模块不再入库**：`svtools.win32-x64-msvc.node`（23MB）改为由 `npm run build:native` 产出或从 GitHub Releases 下载，`.gitignore` 收掉全部 `*.node`；新增 `.github/workflows/release.yml`，随 tag 构建并把 `.node` 与 vsix 上传为 Release 附件
- 原生模块缺失时的报错从 "native module not loaded" 改为给出可执行补救路径（构建命令 / Releases）
- `svtools.reset` / `svtools.sreset` 默认值改为 `["rst_n","reset_n"]` / `["sreset","srst"]`，与 README 及 Rust 内置默认一致；此前清单里的空数组覆盖了内置默认，例化/testbench 生成不会自动识别复位
- `svtools.maxConsecutiveEmptyLines` 下限放开到 `-1`（完全不处理空行，spec §3 早已定义）
- 文档同步：README 版本号/配置表补全（`inlineCompact`、`blankCompact`、`portNameGap`、`vivado.*`）/项目结构/源码安装步骤改为 `npm run build:native`；INSTALL、CONTRIBUTING、PUBLISH 去除 Python 时代内容

### Fixed
- **`pragma protect` 加密区逐字节透传**（Xilinx/Synopsys 加密 IP，如 `*_syn_rfs.v`）：BASE64 载荷行长（`line_length=76`）是编码规范的一部分，重排会破坏解密；且长串无 `;`/关键字的行使对齐器二次方变慢——万行加密文件（ibert/ila 等）格式化 45+ 分钟不返回，透传后 81ms 且输出与输入逐字节一致（未闭合区域同样透传，区外代码段边界镜像用户空行分隔）
- **端口/参数表名称列距漂移**：名称列原按缩进宽度向上取整（18→20 列），与最宽前缀的间距随组宽在 2..5 间漂移、恰在边界时多出一整格；改为可配置固定间距（默认 2）——模块头与 task/function 参数表两处对齐器一致（后者此前漏网仍保留取整逻辑）
- **连续单行模块例化粘连与误展开**：实例行（名字后紧跟 `(`）被误判为声明滞留 Decl 状态，连续单行实例被攒进同一次对齐调用而粘连；新增窄化实例头正则并在 `;` 处独立走实例对齐
- **for 头空格归一化覆盖 `begin` 块状体**：`for(...) begin` 形态此前整行跳过——task 内块状 for 头的多余空格不删、运算符空格不归一，与同文件单行 for 风格分裂；现统一归一化（词间空白折叠、运算符/分号前后单空格含补齐），for 头跨行（用户显式换行）不动
- **for 归一化破坏字符串字面量**（既有缺陷）：`for(i=0;i<2;i++) $display("a=b  c");` 曾被改成 `"a = b c"`——respace 无字符串保护；现字符串段逐字节保留，括号平衡扫描亦跳过字符串内的括号；for 归一化并入 `inlineCompact` 开关（关闭时保持原有空格）
- `stripEmptyLine` 配置项在设置界面可见但从未传给原生模块（勾了没反应），现按配置生效

## [3.4.6] - 2026-09-29

### Added
- **格式化规范 `docs/FORMAT_SPEC.md`**：格式化器唯一权威行为定义——术语（语句/块/容器）、11+2 个配置项、预处理/缩进/空行/对齐/单行保留全量规则、专项构造规则、golden 测试约定；实现与规范冲突先修实现对齐规范
- **单行/多行双轨对齐架构**：用户未换行的语句走单行对齐逻辑（紧凑），显式换行的走多行对齐逻辑（列对齐）
- **行内紧凑开关 `svtools.inlineCompact`**（默认开）：单行语句（系统任务调用、`else $error(...)`、单行模块例化、task 头等）词间空白折叠、括号/逗号/分号紧邻空格删除、只删不补；关闭则保持原有空格
- **行间紧凑开关 `svtools.blankCompact`**（默认开）：关闭为保持模式——不插入、不删除空行仅折叠，硬不变量"格式化不得新增空行"；为此格式化器内部空行伪影源头全部消除（声明组尾部换行、对齐多趟 split 尾空元素、行中 flush 种子空行、EOF 尾随换行）
- CLI 新增 `--no-inline-compact` / `--no-blank-compact`
- golden 格式化用例扩充至 14 个：新增 ex7（assign 多行拼接）、ex8（类/约束/covergroup）、ex9（interface/clocking/modport/SVA）、ex10（testbench/fork/mailbox/队列）、ex11（tb_top + 单/多行 constraint）、ex12（property/sequence 空格归一化）、ex13（单行紧凑），全部含幂等校验

### Fixed
- **空行规则统一裁决**（`blank_rules.rs`，spec §6）：块内（task/function/property/sequence/covergroup/clocking 体、begin/end、case、fork、constraint `{}`、多行括号续行）删除全部空行；块级边界保证 [1, max] 空行分隔；语句间保留折叠——替换原先依赖两处"事故性空行"（align_decl 尾部伪影 + flush 后种子空行）的不一致行为
- **单行写法保留**：单行 `constraint {...;}`、单行参数列表 `function new(bit [7:0] a = 0);`、单行模块例化保持单行不展开；用户显式换行才展开（constraint 内联 `}` 拆独立行、参数逐行对齐）。根因：preprocess 花括号深度跨行累计、行尾 `\}` 不在语句结束正则、task_func_param 无条件展开
- **sequence/property 块头与块体之间多出空行**（块头形似声明被分进 Decl 对齐）
- **property/sequence 体内空格归一化**：`property   p;` → `property p;`、`$rose(valid  )` → `$rose(valid)`、`|=>   wdata` → `|=> wdata`（只删不补，字符串/注释保护）
- **`end else if (...) begin` 的 else 落在第 0 列**（generate 链常见写法，buf_wrapper 三件套非幂等根因）；else 分支前不留空行
- **modport 列表续行中的 `clocking` 字样被误判为 clocking 块头**，上下文永不闭合导致后续空行整段被删
- **对齐分组空行敏感导致的幂等破坏**：空行曾把对齐组切断（空行缩进算 0），空行增删使两遍格式化算出不同列宽（sfp_dma_rx 的 dbg 声明组、reg_ctrl 的 case default 等 7 文件）——现对齐分组对空行透明，Decl 块不在空行切断
- **`$display("x", f());` 在 `repeat + wait fork` 后被从字符串闭合处断行**：string-end 处理器语句中途回收 line 所致；comment-block-end 同机理（属性 + 行中块注释的 `;` 甩到独立行）——中途回收收窄为仅整体 flush 时进行；`is_decl_line` 判定前剥离行中块注释
- **assign 多行拼接 `{` 破行空行**（issue #3 花括号变体）：闭合行 `};` 独占一行时不再被切断产生空行；悬空运算符判定改取最后一条非空行；未写完语句内部的空行残留自动清除（被旧版损坏的文件重新格式化即可自愈）
- **SystemVerilog 验证代码六处破坏修复**（用类/约束/covergroup/clocking/断言/fork 压测发现）：
  - `module m;` 无端口头部模块名被吞，且无名 Module 块吞掉后续声明行
  - 空 bw 捕获组幻影空格：无位宽用户类型声明多补一列（`class  c;` / `return  sum;`）
  - 限定类型（`pkg::type`）列宽不含 scope 前缀，名字与类型粘连（`pkt_tq`）、二次格式化吞行
  - 裸 `fork` 块被误判为模块实例（DOTALL 跨行匹配），整块被实例对齐重排；`join_none repeat()` 同理
  - `wait fork;` / `disable fork;` 不再推 fork 块状态
  - `covergroup with function sample(...)` 的采样头子句不再误推块状态；`clocking` 块体正确缩进
- 实测工程 120 文件幂等校验从 38 文件样本扩展：111/120 稳定（余 9 个为历史存量问题，见 spec 待办）

## [3.4.5] - 2026-09-28

### Fixed
- **格式化引擎按用户校对后的 golden 基准全面对齐**（`node test/golden_test.js` 7 用例 14 项全绿，含幂等；真实工程样例输出零漂移）：
  - **CRLF 输入产生伪空行**：preprocess 入口统一行尾归一——此前 `\r` 被语句拆分当作行内剩余内容，每条语句后多出空行，同一文件 LF/CRLF 输出不一致
  - **语句拆行规则**：单行 `begin ... end` 紧凑写法整行保留；`begin` 后同行有语句且本行无闭合 `end` 才断行；`endcase`/`end` 前有内容时断行（`end end` 拆两行）
  - **case 项对齐此前从未生效**：对齐正则含 `(?!:)` 前瞻，Rust regex 不支持导致整趟对齐被静默跳过；改为无前瞻正则 + 紧凑/规范双模式——同行多语句的紧凑风格保留（`4'd0:result<=x;`），一句一行时补运算符空格（`result <= x;`）
  - **续行空白压缩破坏既有对齐**：assign 对齐的非匹配行统一压缩空格，会把已对齐的 assign 组 / case 项 / 实例端口列填充压掉；现仅对破行表达式中间片段（行尾悬空运算符）压缩，完整语句行原样保留
  - **行续接（反斜杠结尾）被拆断**：宏 / 断言多行语句整行保留
  - **语句块内赋值列对齐**：for / if 体等语句块的 `<=`/`=` 操作符列对齐
  - **单行 for 头运算符空格规范化**：`for(int i=0;i<len;i++) sum+=data[i];` → `for(int i = 0; i < len; i++) sum += data[i];`
  - **modport 按方向拆行**：`modport master(output a,b,input c);` → `output a, b,` 与 `input c` 两行，逗号后补空格
  - **紧凑声明参与对齐**：`logic[ID_W-1:0] awid;`（类型与位宽间无空格、无初值）现参与声明对齐（位宽右对齐、名字/分号列）；带初值的保持原样
  - **interface 端口丢空格**：`axi_if.master axi` 不再被格式化成 `axi_if.masteraxi`
- golden 用例扩充至 7 个（新增 ex1.1 条件块展开、ex5 参数注释列对齐、ex6 声明对齐 / modport / interface 端口），全部含幂等校验；ex2 与 ex6 的 interface 输入段相同，target 已统一为对齐形式

## [3.4.4] - 2026-09-28

### Fixed
- **module/interface `#(...)` 参数列表三处严重破坏**（用户报告于 issue #3 后续反馈）：
  - **参数值错位/丢失**：参数对齐重建误输出"当前值与下一个参数值的字典序最小者"（`values[i].min(values[i+1])` 移植笔误）——`parameter BC = DATA_WIDTH>>3` 会变成 `= 0`、最后一个参数值变成空
  - **尾逗号丢失**：`parameter A = 16 ,// comment` 形态下补逗号判定被行尾注释遮挡，且逗号会被补到注释之后；现按去注释文本判定并插在注释之前
  - **同行多参数整体丢失**：`parameter ADDR_W=32,parameter ID_W=4` 同行写多个参数时，行首锚定的解析每行只识别第一个，其余参数在格式化后消失（ex2 的 `ID_W=4` 场景）；现已预拆行，全部保留
- **assign 表达式破行格式化后多出空行**（issue #3）：`assign x = (` 或行尾 `||` 等悬空运算符的破行不再被错误切断语句块

### Added
- **Golden 格式化测试基建**：`example/` 放格式化前输入、`example/target/` 放期望输出，`node test/golden_test.js` 自动比对 + 幂等双检；新增 issue #3 破行 assign、aurora 参数注释、interface 同行参数三个回归用例，后续新发现的格式化问题按此流程持续加用例

## [3.4.3] - 2026-09-28

### Added
- **Vivado TCL 集成与工程创建**
  - **TCL 脚本运行**：命令面板 "Vivado: 运行 TCL 脚本"（工作区内选择）或 `.tcl` 编辑器右键 "运行当前 TCL 脚本"；以 `vivado -mode batch -nolog -nojournal -source` 执行，输出流式进入独立通道，状态栏显示运行状态，支持停止（Windows 进程树终止）与超时（`timeoutMs`，默认不限时）
  - **工程创建向导**：工程名 → 工程目录 → 源文件多选（按工程结构模板预分类）→ **器件选型详情页（webview 单页：系列/封装/速度筛选下拉联动 + 搜索框输入即联想 + 器件表格可排序 + 选中详情条，双击或回车确定；首次经 `get_parts` 导出器件库并缓存，之后秒开）** → 顶层模块（工作区自动识别候选，被实例化的模块自动降权）；生成 `create_project` TCL 到 `.svtools/vivado/create_prj.tcl` 并可一键执行；工作区无源文件时可按模板创建目录骨架（`src/`、`sim/`、`prj/`）
  - **代码结构**：Vivado 能力按大项拆分为 `vivado/` 文件夹多模块（`index.js` 集成层 + `toolchain.js` 工具链定位 + `tclgen.js` TCL 生成 + `structure.js` 工程结构模板 + `parts.js` 器件库 + `scan.js` 工作区扫描），纯函数层不依赖 vscode 可独立单测；`require('./vivado')` 兼容不变
  - **工程结构模板**（`svtools.vivado.structure`，可完全自定义）：目录 glob 把文件划入 sources_1 / sim_1 / constrs_1 文件集与工程输出目录，默认 `src`/`rtl`→RTL、`sim`/`tb`→测试台（重叠时优先归 sim）、`constraints`/`xdc`/`*.xdc`→约束、工程目录 `prj`；未匹配文件以 tb_ 前缀启发兜底或手动勾选
  - Vivado 自动探测（配置 `svtools.vivado.path` → `XILINX_VIVADO` → `PATH` → 常见安装位置），Windows 经 `cmd /c` 逐参引号调用 `vivado.bat`（Node 24 安全限制），脚本相对路径以其所在目录为 cwd
  - **sv/v 标签页右上角按钮**：▶ 仿真按钮弹出引擎选择（Icarus Verilog / Vivado xsim，xsim 将当前文件模块自动置为 sim_1 顶层并补入缺失文件，`simRuntime` 默认空 = 跑到 `$finish`，可设具体时长如 1000ns）；工作区存在 Vivado 工程（.xpr）时额外显示 ⊕ 加入工程（左键添加 / 右键移除，文件集按结构模板预判可选），无工程时不显示；`.tcl` 标签页右上角 ▶ 直接运行当前脚本（右键按钮弹出工作区脚本选择）
  - runScript 返回 `Promise<{code, ms, issues}>` 结构化结果（供后续 AI Agent 工具复用）
- **配置与命令中文本地化**：设置界面（Settings）中的全部配置项标题/描述与命令面板命令标题支持中文（`package.nls.zh-cn.json`），VSCode 界面语言为中文时自动生效，英文界面保持英文
- **波形查看器**（3.4.3 测试期间迭代）：
  - **总线跳变改为 X 交叉**：陡峭对角交叉线替代六边形斜坡过渡，密集跳变不再有"波浪/曲线"视觉；填充改为整条带半透明一次铺满
  - **x/z 状态分色**：x 红（#ef5350）、z 深蓝（#7986cb），标量与总线一致，总线混合值含 x 优先红
  - **全名切换入口加到波形区底部工具栏**（Fit 旁"全名/简称"按钮，与信号树顶部按钮状态同步）——信号树面板收起时也能切换
  - **"全部显示"按钮仅在单独显示（solo）模式激活时出现**，平时不占位

### Fixed
- **工程创建向导崩溃**（cannot open …/create_prj.tcl）：脚本落盘改为 `writeFile` 直接写入——原先 `openTextDocument` 对尚不存在的文件直接抛错
- **xsim 仿真被 1000ns 截断**：`simRuntime` 默认改为空 = `run all` 跑到测试台 `$finish`（原固定 1000ns 提前截断；runtime 空串直接传 `{}` 会导致 tb.tcl 无 run 命令、一条激励都不跑）
- **timescale 单位变体兼容**：`parseTimescaleSeconds` 支持 VCD 标准的 `sec`/`msec`/`nsec` 等长写法（原只认短写法，遇长写法静默按 ns 假定导致刻度错 10^n 倍）；无法识别时标题区显式提示"按 ns 假定，刻度可能不准"

## [3.4.2] - 2026-09-26

### Added
- **Icarus Verilog 集成：语法检查与仿真验证**
  - **输入（防抖）/ 打开 / 保存 `.v` / `.sv` 文件时自动运行** `iverilog -tnull` lint，诊断进入 Problems 面板（可点击跳转、按行高亮）；未保存的缓冲区内容经临时文件参与检查，输出路径自动回映射到原文件
  - **跨文件模块解析**：工作区内所有含 Verilog 文件的目录自动加入 `-y`/`-I`（文件名=模块名约定）；模块名与文件名不一致时按工作区模块索引自动补编译定义文件（缺模块报错触发迭代重试，最多 3 轮），lint 与仿真均生效（`scanWorkspace` 可关闭）
  - **内置 VCD 波形查看器**：**双击 `.vcd` 直接以波形面板打开**（.vcd 默认编辑器），标签页右上角波形 ↔ 文本一键切换；仿真产生 `.vcd` 后自动打开波形面板（Canvas 渲染，零外部依赖）——信号树按 scope 层级缩进、单击折叠/展开层级、点击加/删波形行；**常量开关**（parameter 批量显示/隐藏，默认隐藏、显示时沉底带"(常量)"标签）；**右键信号二级菜单切换显示格式**（Hex / Bin / Dec 无符号 / SDec 有符号 / Analog 模拟量阶梯折线自动量程，x/z 断开，格式徽标与游标读值联动）；**模拟量行高拖拽**（行底边拖拽 24~240px）；**名称栏拖拽调序**（类似 Vivado，虚线箭头指示插入位，手动排序优先于分组/排序）；**全名/简称切换**（名称栏显示完整层级路径或短名，全名模式自动加宽名称栏）；**Shift 多选 + 右键分组**（Ctrl+点击单选加/减、Shift+点击范围多选，信号树与波形行统一；分组聚拢到第一个成员位置且其余行相对顺序不变，分组后原位输入组名，支持重命名/解除）；**双击层级单独显示该模块**（含子层级，"全部显示"退出并恢复原勾选）；**名称排序 / 按模块分组**；**边沿导航 + 边沿吸附**（点击自动吸附 8px 内最近跳变，◀ 沿 / 沿 ▶ 或 ←/→ 键跳沿并自动居中）；标量/总线/x-z 状态绘制、总线居中标签、游标读值、Ctrl+滚轮缩放、Fit 适配、拖拽平移、**滚轮方向区分（上下滚=滚动信号行，左右滚/Shift+滚轮=平移时间轴）**、刻度尺定位；视口窗口渲染模型，任意时间跨度（数十亿 ticks）流畅缩放，时间刻度尺按 `$timescale` 换算真实物理时间；`autoOpenWaveform` 可关闭，`waveViewer` 配置外部程序（如 GTKWave）时改走外部
  - 仿真编译失败且存在未解析模块时，输出通道给出 `simFiles` 配置提示
  - 每次 lint 在输出通道记录 `[lint] 文件 → N 错误, M 警告 (耗时)` 轨迹，自动触发是否生效一目了然
  - 一键仿真：状态栏 ▶ 按钮 / 命令面板 "Icarus Verilog: Run Simulation"，编译 + vvp 流式输出到独立通道，支持停止与超时自动终止
  - 多文件工程支持：`simFiles` glob 附加源文件、`simTop` 指定顶层、`includePaths` / `libraryPaths` 头文件与模块库目录
  - 仿真产生的 `.vcd` / `.fst` 波形自动检测并提示，可调起外部波形查看器（`waveViewer`）
  - 工具链自动探测（配置 → `IVERILOG_HOME` → `PATH` → 常见目录）；Cygwin 构建 iverilog 缺 `cygwin1.dll` 时自动定位同级 Cygwin 安装注入 PATH（`0xC0000135` 退出码 + DLL 目录启发式）
  - 语言标准自动选择（`.sv`→`-g2012`、`.v`→`-g2005`），`svtools.iverilog.standard` 可覆盖

### Fixed
- **波形查看器：总线信号被渲染成实心色块**——`drawBus` 形参错位导致填充色接收到行高数字、canvas 静默忽略赋值后停留在实心描边色，现已恢复半透明六边形总线带
- **波形区 Shift 多选与分组**——原先多选/分组只能在左侧信号树触发（波形行上 Shift+点击只放游标、分组项永不出现）；现在波形行同样支持 Shift+点击累积多选（名称栏浅蓝高亮反馈）、右键分组/批量改格式，普通点击清除多选
- 手动 lint 命令现在会清除缓存的工具链探测失败状态并强制重新探测，环境修复后无需重载窗口即可恢复自动 lint
- **波形面板折叠 bug**：折叠层级后该 scope 行被一并移除，导致无法再次展开（折叠顶层后整个列表清空）；现在折叠时保留 scope 行（▸ 指示），单击即可再展开

## [3.4.1] - 2026-08-15

### Fixed
- **Syntax Highlighting**: `always@(*)` 敏感列表不再被误判为属性 `(* ... *)` 的开始——原先从该行到文件结尾会全部被吞入属性作用域,`begin`/`end`/`assign`/`endmodule` 等关键字及所有标识符高亮错乱
- **Language Configuration**: 修复括号自动补齐失效——`contributes.languages` 缺少 `configuration` 字段,`language-configuration.json` 从未被 VS Code 加载,选中文字后输入 `(` 无法自动闭合

## [3.4.0] - 2026-07-24

### Added
- Tree-sitter 语法分析器:符号提取、语法高亮、上下文感知补全、悬停提示、跳转到定义
- 新增 `svtools.win32-x64-msvc.node` 原生模块与 CLI 二进制

## [3.3.2] - 2026-07-23

### Fixed
- **Formatter**: Fix extension host crash (panic: index out of bounds) when module parameter list contains comment lines (e.g. `//pragma translate_off`)

## [3.3.1] - 2026-07-23

### Fixed
- **Formatter**: `endmodule` no longer split into `end` + `module` when always block uses `if...begin...end` without `else`
- **Formatter**: Correct indentation after always block with `begin...end` — subsequent statements no longer over-indented
- **Formatter**: `rfind("end")` now uses word-boundary matching to avoid false matches on `endmodule`/`endtask`/`endfunction` etc.

## [3.2.16] - 2025-04-15

### Fixed
- **Module Instantiation**: Remove stray instance prefix from module type line when using parameters (`module_name #(...)` instead of `module_name u_ #(...)`)
- **Parameter Alignment**: Align parameter names in instance parameter list to longest name

## [3.2.15] - 2025-04-15

### Fixed
- **Semicolon Alignment**: Blank lines now separate independent alignment groups — non-contiguous assignment blocks align semicolons independently

## [3.2.14] - 2025-04-15

### Fixed
- **Port Alignment**: Use fixed column widths (direction/var/type/bw) instead of variable prefix length — lines without `reg`/`wire` now correctly preserve column space
- **Semicolon Alignment**: All lines now use unified rebuild output with `trim_end() + padding + ;`, fixing longest-line not being aligned

## [3.2.13] - 2025-04-15

### Changed
- Rewrote port alignment using Python-style prefix length calculation
- Testbench instantiation now uses `build_instance_code` for consistent formatting
- Fixed attribute `(* ... *)` block_state handling in beautifier

## [3.2.12] - 2025-04-15

### Fixed
- **Attribute Alignment**: Fixed `(* ... *)` attribute state management — residual `(` state after attribute end now properly popped
- **Semicolon Alignment**: Added `align_semicolons` function for always block assignment statements

## [3.2.11] - 2025-04-15

### Fixed
- **Beautifier**: Attribute ending now correctly pops residual `(` state from stack
- **Assign Alignment**: Rewrote `align_semicolons` — spaces padded before semicolon instead of after

## [3.2.10] - 2025-04-15

### Fixed
- **Decl Alignment**: Added `attr` capture group to declaration regex for `(* ... *)` attribute prefix support
- **Beautifier**: Fixed block_state for attribute lines — attribute text now stays in block for `align_decl` processing
- **Extension**: Fixed native module load path from `src-rust/` to root directory

## [3.2.9] - 2025-04-15

### Changed
- Simplified testbench init task — only contains `// TODO: add initialization logic` placeholder
- Reset polarity auto-detection: signals ending with `_n` are active-low
- Removed `task_init` function

## [3.2.8] - 2025-04-15

### Fixed
- Testbench instantiation uses `build_instance_code` with port alignment and comments
- Reset polarity auto-detection logic

## [3.2.5] - 2025-04-15

### Changed
- Changed default `instPrefix` from `inst_` to `u_`
- Configuration prefix unified to `svtools`

### Fixed
- Module instantiation port name/signal name alignment with three-column comment alignment
- Parser `psize` not reset causing bit-width inheritance issue
- Removed Python backend files from master branch

## [3.2.0] - 2025-04-01

### Added
- Enhanced Unicode support for comments in all languages

### Fixed
- Minor formatting edge cases

## [3.1.0] - 2025-03-15

### Added
- Improved testbench generation with better signal detection
- Enhanced module instantiation with configurable prefix

### Fixed
- Alignment issues with nested port declarations

## [3.0.0] - 2025-03-01

### BREAKING CHANGES
- **Rust Native Backend**: Complete rewrite using Rust with napi-rs
  - Removed Python dependency entirely
  - Native Node.js addon for maximum performance
  - No external runtime required

### Added
- Rust-based core engine with napi-rs bindings
- Native `.node` module for Windows (x64), Linux (x64), macOS (x64/arm64)
- Zero-dependency installation (no Python needed)

### Removed
- Python daemon process (`daemon.py`)
- `svtools.pythonPath` configuration option
- All Python source files from the extension package

### Changed
- Architecture: Python subprocess → Rust native module
- Startup time: Instant (no Python initialization)
- Memory footprint: Significantly reduced
- Distribution: Single `.node` file per platform

### Technical Details
- Core formatting logic ported to Rust
- Tokenizer rewritten with regex-based approach
- Parser restructured for better maintainability
- Code generation modules (testbench, module_inst, repeat, align, header) ported
- Build system: Cargo with napi-build

## [2.4.1] - 2025-02-24

### Fixed
- **Signal Declaration Spacing**: Fixed spacing in generated signal declarations
  - Added space between type (`reg`/`wire`) and bit specification (`[7:0]`)
  - Now generates: `reg [7:0] data_in;` instead of `reg[7:0] data_in;`
  - Properly formats: `reg clk;`, `wire valid;`

### Before/After
```
// Before:
reg[7:0] data_in;
wire[7:0] data_out;

// After:
reg [7:0] data_in;
wire [7:0] data_out;
```

## [2.4.0] - 2025-02-24

### Added
- **Port Declarations in Module Instantiation**: Enhanced module instantiation with automatic signal declarations
  - Input ports now generate `reg` declarations
  - Output ports now generate `wire` declarations
  - Inout ports now generate `wire` declarations
  - Each declaration on a separate line
  - Parameters generate `localparam` declarations
  - New configuration: `svtools.includePortDeclarations` (default: true)

### Example
```systemverilog
// Before (instantiation only):
my_module u_my_module (
    .clk (clk),
    .rst_n (rst_n),
    .data (data)
);

// After (with declarations):
// Signal declarations
localparam WIDTH = 8;
reg  clk;
reg  rst_n;
wire [7:0] data;

my_module u_my_module (
    .clk (clk),
    .rst_n (rst_n),
    .data (data)
);
```

## [2.3.0] - 2025-02-24

### Fixed
- **Daemon Import Error**: Fixed critical import issue preventing daemon from starting
  - Fixed syntax error in `vg_core.py` (extra closing bracket)
  - Fixed import path in `daemon.py` for `vg_core` module
  - Daemon now initializes successfully on startup

### Technical Details
- Removed duplicate `]` in function signature at line 347 of `vg_core.py`
- Changed import from `verilogutil.vg_core` to `vg_core` in `daemon.py`

## [2.2.0] - 2025-02-24

### Added
- **Module Instantiation**: Generate module instantiation code from module definition
  - New command: `svtools.moduleInstantiation`
  - Keyboard shortcut: `Ctrl+Shift+C` (Windows/Linux) / `Cmd+Shift+C` (macOS)
  - Automatically detects clock and reset signals
  - Copies instantiation code to clipboard

- **Testbench Generation**: Generate complete testbench from module definition
  - New command: `svtools.generateTestbench`
  - Keyboard shortcut: `Ctrl+Shift+T` (Windows/Linux) / `Cmd+Shift+T` (macOS)
  - Auto-generates clock and reset logic
  - Configurable waveform dump type (fsdb/vpd/shm/vcd)
  - Generates init and drive tasks

- **Code Repetition**: Repeat code with number formatting
  - New command: `svtools.repeatCode`
  - Keyboard shortcut: `Ctrl+F12` (Windows/Linux) / `Cmd+F12` (macOS)
  - Supports format placeholders: `{:d}`, `{0:03x}`, `{cb}`
  - Configurable row/column step increments

- **Code Alignment**: Align selected code using verilog-beautifier
  - New command: `svtools.alignCode`
  - Keyboard shortcut: `Ctrl+Shift+X` (Windows/Linux) / `Cmd+Shift+X` (macOS)
  - Supports port declarations, signal declarations, assignments, instance connections

- **File Header Insertion**: Insert standardized file headers
  - New command: `svtools.insertHeader`
  - Keyboard shortcut: `Ctrl+Shift+Insert` (Windows/Linux) / `Cmd+Shift+Insert` (macOS)
  - Template placeholders: `{FILE}`, `{DATE}`, `{TIME}`, `{YEAR}`, `{TABS}`
  - Customizable header template

### Changed
- **Plugin Rename**: Unified plugin name to "SystemVerilog Tools"
  - Package name: `sv-align` → `svtools`
  - All commands now use `svtools` prefix
  - All configurations now use `svtools` prefix
  - Command category: "SystemVerilog Tools"

- **Configuration Consolidation**: Merged all configuration under `svtools` prefix
  - `svAlign.*` → `svtools.*`
  - `svGadget.*` → `svtools.*`
  - Single unified configuration namespace

### Technical Details
- Added `vg_core.py` module with Verilog-Gadget functionality ported from Sublime Text
- Extended daemon.py with new JSON-RPC methods: `module_inst`, `testbench_gen`, `repeat_code`, `align_code`, `generate_header`
- Added header template in `templates/header_template.txt`
- Context menu submenu: `svtools.submenu` for productivity tools

## [2.0.5] - 2025-02-02

### Added
- **Maximum Consecutive Empty Lines Control**: New configurable option to control empty lines
  - New configuration: `svAlign.maxConsecutiveEmptyLines`
  - Default value: 1 (allow at most 1 consecutive empty line)
  - Range: 0-10 (0 = remove all empty lines)
  - Post-processing removes excessive empty lines after beautification
  - Provides fine-grained control over code spacing and readability

### Technical Details
- Added `postprocess_text()` method in daemon.py
- Processes formatted text to enforce empty line limits
- Runs after main beautification to ensure consistent formatting

## [2.0.4] - 2025-02-02

### Fixed
- **Always Keyword Support**: Fixed regex pattern to support all forms of `always` keyword
  - Traditional Verilog: `always @(posedge clk)`, `always @(*)`, `always @(a or b)`
  - SystemVerilog: `always_ff`, `always_comb`, `always_latch`
  - All forms now correctly merge `begin` to the same line in 1tbs mode

## [2.0.3] - 2025-02-02

### Fixed
- **Extended Keyword Support**: Added missing keywords for GNU-to-1tbs conversion
  - Added support for: `fork`, `repeat`, `while`, `do`, `foreach`
  - All common SystemVerilog control flow keywords now supported
  - Verified with comprehensive test suite

## [2.0.2] - 2025-02-02

### Added
- **GNU-to-1tbs Style Conversion**: Automatic preprocessing to convert GNU-formatted code to 1tbs style
  - When using `indentStyle: "1tbs"`, standalone `begin` statements are automatically merged to the previous line
  - Supports keywords: `always_ff`, `always_comb`, `always_latch`, `if`, `else`, `case`, `for`, `forever`, `task`, `function`, `interface`, `module`, `class`, `package`, `program`, `clocking`, `initial`, `final`, and more
  - Enables conversion of existing GNU-formatted code to 1tbs style without manual editing

### Fixed
- Fixed regex syntax error in preprocessing keyword patterns
- Added `else` keyword to 1tbs merging list

### Technical Details
- Preprocessing occurs before main beautification in the daemon
- Only active when `indentStyle` is set to `"1tbs"` (default)
- GNU style (`indentStyle: "gnu"`) is unaffected by preprocessing

## [2.0.1] - 2025-02-02

### Fixed
- **Critical**: Fixed default tabSize configuration not taking effect
  - Updated daemon default nbSpace from 3 to 4
  - Fixed daemon configuration update logic to respect user settings
  - Daemon now recreates beautifier instance on each format request with current options

### Changed
- Default tabSize changed from 3 to 4 spaces
- Configuration changes now take effect immediately without reloading window

## [2.0.0] - 2025-02-02

### Added
- **Performance**: Persistent Python daemon process for faster formatting
  - 87-93% performance improvement (from ~150ms to 10-30ms)
  - JSON-RPC protocol for efficient communication
  - Singleton VerilogBeautifier instance (no repeated module loading)

### Changed
- Architecture: Replaced subprocess spawning with daemon-based approach
- Removed temporary file I/O operations
- Improved resource management and cleanup

### Technical Details
- Daemon process starts once and stays running for the session
- Async formatting with proper timeout handling
- Automatic daemon restart on crashes
- Full UTF-8/Unicode support preserved

## [1.0.0] - 2025-02-02

### Added
- Initial release of VSCode extension
- Full UTF-8/Unicode support for comments (Chinese, Japanese, Korean, emoji, etc.)
- Automatic formatting for Verilog and SystemVerilog files
- Configurable formatting options
- Format on save support
- Format selection support

### Fixed
- **Critical**: Fixed Chinese/Unicode character encoding issues on Windows
  - Forced UTF-8 encoding in Python stdout/stderr
  - Set PYTHONIOENCODING environment variable
  - Ensured proper UTF-8 file I/O operations

### Technical Details
- Extension uses Python subprocess for formatting
- Core formatting logic from Sublime Text SystemVerilog plugin
- Zero modification to original beautifier code
