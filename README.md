# SystemVerilog Tools for VSCode

一款适用于 Visual Studio Code 的 Verilog/SystemVerilog 代码格式化和生产力工具插件，改编自 Sublime Text SystemVerilog 插件和 Verilog-Gadget 插件。

**版本**: v3.4.2

> **v3.0 重大更新**: 核心引擎使用 Rust 重构，无需 Python 依赖，性能大幅提升！
>
> **v3.4.0 重大更新**: 新增 tree-sitter 符号分析引擎、语法高亮、Go to Definition、Hover 悬浮、上下文感知补全、CLI 格式化器！
>
> **v3.4.2 重大更新**: **Icarus Verilog 工具链集成**（输入/保存自动 lint、一键仿真、跨文件模块解析）+ **内置 VCD 波形查看器**（双击 .vcd 直接打开，多选分组/拖拽调序/显示格式切换/边沿导航，零外部依赖）！

## 功能特性

### 中文支持
- 设置界面（Settings）与命令面板的标题/描述跟随 VSCode 界面语言自动切换中文/英文（42 项配置 + 16 个命令）

### Vivado TCL 集成与工程创建
- **运行 TCL 脚本**：命令面板 "Vivado: 运行 TCL 脚本"（工作区内选择）或 `.tcl` 编辑器右键 "运行当前 TCL 脚本"；batch 模式执行，输出流式进入独立通道，状态栏运行指示，支持停止与超时
- **sv/v 标签页按钮**：▶ 仿真（弹出引擎选择 Icarus Verilog / Vivado xsim——xsim 自动把当前文件模块置为 sim_1 顶层并补入缺失文件，`simRuntime` 控制时长）；工作区有 Vivado 工程时显示 ⊕（左键加入工程 / 右键移出），无工程时不显示
- **工程创建向导**（"Vivado: 创建工程"）：工程名 → 工程目录 → 源文件多选（自动预分类）→ 器件 → 顶层模块（自动识别候选）；生成 `create_project` 脚本到 `.svtools/vivado/create_prj.tcl` 并可一键执行；工作区为空时可按模板创建目录骨架
- **工程结构模板**（`svtools.vivado.structure`，可自定义）：默认按 `src`/`rtl` → RTL 源码、`sim`/`tb` → 测试台、`constraints`/`xdc` → 约束、`prj` → 工程输出目录的布局（与常见工程模板一致）；目录 glob 可任意改写适配自定义结构
- Vivado 自动探测（配置 → `XILINX_VIVADO` → `PATH` → 常见安装位置），`svtools.vivado.path` 可显式指定如 `D:\DevKit\Xilinx\Vivado\2022.1`

### 格式化功能
- 自动格式化 Verilog 和 SystemVerilog 文件
- **完整 Unicode 支持** - 完美支持中文、日文、韩文等 UTF-8 编码的注释
- 对齐功能：
  - 模块端口声明
  - 信号/变量声明
  - 模块实例化端口
  - 参数定义
  - 赋值语句
  - case 语句
  - always 块
- 可配置的缩进风格（空格或制表符）
- 删除空行选项
- 每行单声明/单绑定选项
- **Rust Native 后端**：使用 Rust 编译的原生模块，无需 Python，启动快、性能高

### Verilog-Gadget 生产力工具

#### 1. 模块实例化生成 (Generate Module Instantiation)
- 自动解析模块定义
- 生成模块实例化代码
- 自动识别时钟和复位信号
- **自动生成端口声明**：
  - input 端口自动生成 `reg` 声明
  - output 端口自动生成 `wire` 声明
  - inout 端口自动生成 `wire` 声明
  - 每个声明单独一行
- 复制到剪贴板，方便粘贴

**快捷键**: `Ctrl+Shift+C` (Windows/Linux) / `Cmd+Shift+C` (macOS)

**使用方法**:
1. 打开包含模块定义的文件
2. 按下快捷键或从命令面板选择 "SystemVerilog Tools: Generate Module Instantiation"
3. 实例化代码会自动复制到剪贴板

#### 2. 测试台生成 (Generate Testbench)
- 自动生成完整的测试台代码
- 自动生成时钟和复位逻辑
- 可配置的波形dump类型 (fsdb/vpd/shm/vcd)
- 自动生成 init 和 drive 任务

**快捷键**: `Ctrl+Shift+T` (Windows/Linux) / `Cmd+Shift+T` (macOS)

**使用方法**:
1. 打开包含模块定义的文件
2. 按下快捷键或从命令面板选择 "SystemVerilog Tools: Generate Testbench"
3. 新的测试台文件会自动创建

#### 3. 代码重复编号 (Repeat Code with Numbers)
- 使用格式化占位符重复代码
- 支持多种格式化选项（十进制、十六进制等）
- 支持行列步进控制
- 支持剪贴板内容插入

**快捷键**: `Ctrl+F12` (Windows/Linux) / `Cmd+F12` (macOS)

**占位符格式**:
- `{:d}` - 十进制整数
- `{0:03x}` - 十六进制，3位，前导零
- `{cb}` - 剪贴板内容（每行）

**使用方法**:
1. 选中包含占位符的代码
2. 按下快捷键或从命令面板选择 "SystemVerilog Tools: Repeat Code with Numbers"
3. 输入范围和步进（格式：`start~end,row_step,col_step`）
4. 代码会自动生成

**示例**:
```
选中: assign signal_{:d} = {:d};
输入: 0~8
结果:
assign signal_0 = 0;
assign signal_1 = 1;
...
assign signal_8 = 8;
```

#### 4. 代码对齐 (Align Selected Code)
- 使用 verilog-beautifier 格式化引擎
- 智能识别代码类型并自动对齐
- 支持端口声明对齐
- 支持信号声明对齐
- 支持实例化端口对齐
- 支持赋值语句对齐

**快捷键**: `Ctrl+Shift+X` (Windows/Linux) / `Cmd+Shift+X` (macOS)

**使用方法**:
1. 选中需要对齐的代码块
2. 按下快捷键或从命令面板选择 "SystemVerilog Tools: Align Selected Code"
3. 代码会自动对齐

#### 5. 文件头插入 (Insert File Header)
- 插入标准化的文件头注释
- 支持自定义模板
- 自动填充文件名、日期、时间等信息

**快捷键**: `Ctrl+Shift+Insert` (Windows/Linux) / `Cmd+Shift+Insert` (macOS)

**模板占位符**:
- `{FILE}` - 文件名
- `{DATE}` - 创建日期 (YYYY-MM-DD)
- `{TIME}` - 创建时间 (HH:MM:SS)
- `{YEAR}` - 年份
- `{TABS}` - 制表符大小

**使用方法**:
1. 打开文件或新建文件
2. 按下快捷键或从命令面板选择 "SystemVerilog Tools: Insert File Header"
3. 文件头会自动插入到文件开头

### 语法高亮 (v3.4.0+)

- 内置 TextMate 语法文件，Verilog 和 SystemVerilog 共用
- 覆盖：注释、字符串、Verilog 数字（`8'hFF`、`1'b0`）、预处理器指令、属性 `(* ... *)`、关键字、数据类型、端口方向、系统任务（`$display`）、运算符
- **模块例化高亮**：模块类型名、实例名、端口连接 `.port_name()` 分别着色

### 大纲视图 / Outline (v3.4.0+)

- 基于 **tree-sitter** 的 AST 解析，提取 module / interface / package / class / task / function / port / parameter / net / instance 等符号
- 在 VSCode 侧边栏 **Outline** 面板展示代码结构树
- 支持面包屑导航

### Go to Definition (v3.4.0+)

- **Ctrl+Click** 模块例化中的模块类型名或实例名
- 自动扫描工作区 `.v/.sv/.vh/.svh` 文件，跳转到 `module <name>` 定义处
- 启发式识别例化上下文，跳过关键字和普通信号名

### Hover 悬浮提示 (v3.4.0+)

- 悬浮**实例名**或**模块类型名** → 显示目标模块的端口列表、参数列表、内部信号摘要、源文件链接
- 悬浮**信号/端口/参数名** → 显示声明详情及所属模块、行号
- 支持跨文件查找

### 上下文感知补全 (v3.4.0+)

- **4 种代码场景**自动识别，提供不同的补全内容：
  - 顶层（module 外）：module / interface / package 模板、timescale、testbench
  - 模块头：input / output / parameter、数据类型
  - 模块体：always 系列、assign、wire / reg / logic、generate、FSM
  - always 块内：if / else / case / for / begin-end
- **例化端口/参数补全**：在例化括号内输入 `.` 触发，跨文件查找目标模块端口/参数列表，自动过滤已连接端口
- **31 个代码片段**：always 系列、module 模板、FSM 三段式、testbench、typedef、声明模板等
- 当前文件符号补全：端口、参数、信号、实例、task / function 名

### CLI 格式化器 (v3.4.0+)

- 独立 `svtools.exe`（Windows x64），无需 VSCode 即可格式化
- 用法：
  ```bash
  svtools.exe file.sv                  # 格式化并输出到 stdout
  svtools.exe -i file1.sv file2.sv     # 原地格式化
  svtools.exe -c *.sv                  # 检查是否需要格式化
  svtools.exe --tab-size 2 file.sv     # 2 空格缩进
  cat file.sv | svtools.exe            # 从 stdin 读取
  ```

### 语法检查与仿真 (Icarus Verilog)

内置 [Icarus Verilog](http://iverilog.icarus.com/) 集成，无需额外插件即可完成 **lint** 与 **仿真验证**：

#### Lint 语法检查
- **输入（防抖）/ 打开 / 保存 `.v` / `.sv` 文件时自动运行** `iverilog -tnull`，诊断结果进入 Problems 面板，可点击跳转；未保存的缓冲区内容通过临时文件参与检查，边改边看
- 每次 lint 会在 "SystemVerilog Tools · Icarus Verilog" 输出通道留一行 `[lint] 文件 → N 错误, M 警告 (耗时)` 轨迹，方便确认自动触发是否生效
- 自动按扩展名选择语言标准（`.sv` → `-g2012`，`.v` → `-g2005`），可用 `svtools.iverilog.standard` 覆盖
- **跨文件模块解析**：工作区内所有含 Verilog 文件的目录自动加入 `-y`/`-I`（文件名=模块名约定）；模块名与文件名不一致时，通过工作区模块索引自动把定义文件补进编译（lint 与仿真均生效，可关闭 `scanWorkspace`）
- 同目录模块自动解析（`-y <文件目录> -Y .sv`），支持 include / 库目录配置
- 也可手动执行：命令面板 → "SystemVerilog Tools: Icarus Verilog: Lint Current File"（手动触发会强制重新探测工具链）

#### 仿真验证
- 状态栏 **▶ iverilog 仿真** 按钮（或命令面板 "Icarus Verilog: Run Simulation"）一键完成 **编译 + vvp 运行**
- 输出流式打印到 "SystemVerilog Tools · Icarus Verilog" 输出通道，回显实际命令行
- 编译错误同样进入 Problems 面板；运行中可随时停止（Stop Simulation 命令 / 再次点击状态栏重新运行）
- 支持超时自动停止（`simTimeoutMs`）、多文件工程（`simFiles` glob）、自定义 top（`simTop`）与 vvp 参数（`simArgs`）

#### 内置波形查看器
- **双击 `.vcd` 文件直接以波形面板打开**（内置查看器是 .vcd 的默认编辑器）；标签页右上角有 **波形 ↔ 文本** 切换按钮
- 仿真产生 `.vcd` 后**自动打开波形面板**（`autoOpenWaveform` 可关闭），零外部依赖
- Canvas 渲染：标量时钟/信号画高低电平与 x/z 中轴带，总线画六边形段（半透明填充）并居中标注 `0x` 十六进制与二进制值
- **常量开关**：工具条"常量"按钮批量显示/隐藏 parameter 常量（默认隐藏，显示时沉底到列表末尾并带"(常量)"分组标签）
- **右键切换显示格式**：右键任意信号（信号树或波形行）→ 二级菜单选择 Hex 十六进制 / Bin 二进制 / Dec 无符号十进制 / SDec 有符号十进制 / **Analog 模拟量**（阶梯折线，按信号全量程自动缩放，x/z 断开）；名称栏显示格式徽标（B/D/S/A），游标读值随格式联动
- **拖拽调整行顺序**：按住波形名称栏（光标变 ✋）上下拖拽即可调序（类似 Vivado），虚线+箭头指示插入位置；手动排序优先，"名称排序"/"按模块分组"/新建分组会恢复自动排序
- **全名/简称切换**：工具栏"全名"按钮切换波形名称栏显示完整层级路径（如 `tb_sfifo.u_sfifo.wdata`）或短名，全名模式自动加宽名称栏
- **模拟量行高拖拽**：模拟量行底边（光标变 ↕）可拖拽调整行高（24~240px），看得更清楚
- **Ctrl 单选 / Shift 范围多选 + 右键分组**：信号树与波形行统一——Ctrl+点击加/减选单个信号，Shift+点击选锚点至当前的范围（名称栏浅蓝高亮反馈）；右键"✦ 分组"把组员**聚拢到第一个成员位置**（其余行相对顺序不变，Vivado 式），分组后可**原位输入组名**（回车确认），右键还提供"重命名分组/解除分组"；普通点击清除多选
- **边沿吸附**：左键点击波形时自动吸附到 8px 内最近的信号跳变沿，游标精确落在边沿上
- **滚轮方向区分**：**上下滚轮滚动查看上方/下方信号行**，**左右滚轮（倾斜轮/触控板横扫，或 Shift+滚轮）平移时间轴**，Ctrl+滚轮缩放（在刻度尺上滚动同样有效）；波形内容不满一屏时上下滚为无操作
- 左侧信号树按 scope 层级缩进展示，**单击折叠/展开层级（▸/▾）**；点击信号加/删波形行（带类型圆点/方点标记）
- **快速单独显示某模块**：双击信号树中的层级，波形区只显示该模块（含子层级）的信号；"全部显示"退出并恢复之前的勾选状态
- **排序与分组**：树面板工具条支持按名称排序、按模块分组（波形区绘制分组分隔线与层级标签），一键切回原始顺序
- **边沿导航**：点击波形行选目标信号，`◀ 沿 / 沿 ▶` 按钮（或 ←/→ 方向键）跳转到该信号的上一/下一个边沿并自动居中
- 点击波形放置游标并显示该时刻信号值；Ctrl+滚轮缩放、Fit 一键适配、拖拽/滚轮平移、点击刻度尺定位
- 偏好外部工具（如 GTKWave）时配置 `waveViewer` 即可改走外部程序（`.fst` 等格式也走外部）；也可随时命令面板 "Open VCD Waveform Viewer" 手动打开任意 `.vcd`

#### 工具链定位
自动探测顺序：`svtools.iverilog.path` 配置 → `IVERILOG_HOME` 环境变量 → `PATH` → 常见安装目录。
**Cygwin 构建的 iverilog**（安装在 Cygwin 根目录之外）缺 `cygwin1.dll` 时会自动定位同级的 Cygwin 安装目录并注入子进程 PATH；也可通过 `svtools.iverilog.cygwinPath` 显式指定。

> 提示：仿真会在工作区下生成 `.svtools/sim/` 缓存目录（存放 `.vvp` 编译产物），建议加入 `.gitignore`。

## 系统要求

- Visual Studio Code 1.74.0 或更高版本
- **无需安装 Python**（v3.0+ 使用 Rust 原生模块）
- 语法检查 / 仿真功能需要 [Icarus Verilog](http://iverilog.icarus.com/)（可选，未安装不影响其他功能）

## 安装方法

### 从 VSCode Marketplace 安装（推荐）

在 VSCode 扩展市场搜索 "SystemVerilog Tools" 并安装。

### 从源码安装

1. 克隆或下载本仓库
2. 打开 VSCode
3. 按 `F5` 打开新的扩展开发宿主窗口，插件会自动加载
4. 或者打包插件：
   ```bash
   cd vscode-extension
   npm install
   # 构建 Rust 原生模块（需要 Rust 工具链）
   cd src-rust && cargo build --release
   cp target/release/svtools.dll ../  # Windows
   # 或 cp target/release/libsvtools.so ../  # Linux
   # 或 cp target/release/libsvtools.dylib ../  # macOS
   
   vsce package
   ```
   然后在 VSCode 中安装生成的 `.vsix` 文件

## 使用方法

### 保存时自动格式化

在 VSCode 的 `settings.json` 中添加以下配置：

```json
{
  "[verilog]": {
    "editor.formatOnSave": true
  },
  "[systemverilog]": {
    "editor.formatOnSave": true
  }
}
```

### 手动格式化

- Windows/Linux: `Shift+Alt+F`
- macOS: `Shift+Option+F`
- 或在编辑器中右键选择"格式化文档"

### 格式化选中区域

选中一段代码后使用格式化命令，仅格式化选中的代码块。

## 配置选项

所有配置都在 `svtools` 配置项下，可在 VSCode 设置中搜索 `svtools` 进行配置：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `tabSize` | number | 4 | 缩进使用的空格数量 |
| `useTab` | boolean | false | 使用 Tab 字符进行缩进 |
| `oneBindPerLine` | boolean | true | 模块实例化时每个端口绑定单独一行 |
| `oneDeclPerLine` | boolean | false | 每个信号声明单独一行 |
| `paramOneLine` | boolean | true | 尽可能将参数保持在一行 |
| `indentStyle` | string | "1tbs" | 缩进风格（"1tbs" 或 "gnu"） |
| `stripEmptyLine` | boolean | true | 删除多余的空行 |
| `maxConsecutiveEmptyLines` | number | 1 | 允许的最大连续空行数（0 = 移除所有空行） |
| `instAlignPort` | boolean | true | 对齐模块实例化端口 |
| `ignoreTick` | boolean | true | 缩进时忽略预处理器指令 |
| `importSameLine` | boolean | false | 将 import 语句与模块声明保持在同一行 |
| `alignComma` | boolean | true | 对齐逗号/分号 |
| `instPrefix` | string | "u_" | 模块实例名称默认前缀 |
| `includePortDeclarations` | boolean | true | 生成模块实例化时是否包含端口声明 |
| `reset` | array | ["rst_n", "reset_n"] | 异步复位信号名称列表 |
| `sreset` | array | ["sreset", "srst"] | 同步复位信号名称列表 |
| `clock` | array | ["clk", "uclk", "cclk"] | 时钟信号名称列表 |
| `waveType` | string | "fsdb" | 波形dump类型 (fsdb/vpd/shm/vcd) |
| `taskInit` | boolean | true | 在测试台中生成 init 任务 |
| `taskDrive` | boolean | true | 在测试台中生成 drive 任务 |
| `headerTemplate` | string | "" | 文件头模板（使用占位符） |
| `iverilog.path` | string | "" | Icarus Verilog bin 目录或 iverilog 全路径；空 = 自动探测 |
| `iverilog.cygwinPath` | string | "" | cygwin1.dll 所在目录（Cygwin 构建装在 Cygwin 根外时需要）；空 = 自动探测 |
| `iverilog.lintOnSave` | boolean | true | 保存时自动 lint |
| `iverilog.scanWorkspace` | boolean | true | 扫描工作区源码：所有含 Verilog 文件的目录自动加入 -y/-I；模块名≠文件名时按模块索引补编译（lint 与仿真都生效） |
| `iverilog.lintOnChange` | boolean | true | 输入时自动 lint（防抖，检查未保存的缓冲区内容） |
| `iverilog.lintDebounceMs` | number | 800 | 输入触发 lint 的防抖延迟（毫秒） |
| `iverilog.lintOnOpen` | boolean | true | 打开文件时自动 lint |
| `iverilog.standard` | string | "auto" | 语言标准（-g）；auto: `.sv`→2012 / `.v`→2005 |
| `iverilog.lintArgs` | array | ["-Wall"] | lint 与仿真编译的额外 iverilog 参数 |
| `iverilog.includePaths` | array | [] | include 目录（-I），相对工作区根 |
| `iverilog.libraryPaths` | array | [] | 模块库目录（-y），相对工作区根 |
| `iverilog.simFiles` | array | [] | 仿真时额外编译的源文件 glob（如 `src/*.v`） |
| `iverilog.simTop` | string | "" | 仿真 top 模块（-s）；空 = iverilog 自动选根模块 |
| `iverilog.simArgs` | array | [] | vvp 运行参数（如 plusargs） |
| `iverilog.simTimeoutMs` | number | 0 | 仿真超时毫秒数；0 = 不限制 |
| `iverilog.waveViewer` | string | "" | 外部波形查看器路径；空 = 使用内置 VCD 波形面板（.fst 等格式仍走外部） |
| `iverilog.autoOpenWaveform` | boolean | true | 仿真产生新 `.vcd` 后自动打开内置波形查看器 |

> **注意**: v3.0+ 已移除 `pythonPath` 配置项，因为不再需要 Python 依赖。

### 配置示例

在 VSCode 的 `settings.json` 中添加：

```json
{
  "svtools.tabSize": 4,
  "svtools.useTab": false,
  "svtools.oneBindPerLine": true,
  "svtools.oneDeclPerLine": false,
  "svtools.paramOneLine": false,
  "svtools.indentStyle": "1tbs",
  "svtools.stripEmptyLine": true,
  "svtools.instAlignPort": true,
  "svtools.instPrefix": "u_",
  "svtools.clock": ["clk", "sys_clk"],
  "svtools.reset": ["rst_n", "arst_n"],
  "svtools.waveType": "fsdb"
}
```

### 格式化命令
- `svtools.formatDocument` - 格式化当前文档

### 生产力工具命令
- `svtools.moduleInstantiation` - 生成模块实例化代码
- `svtools.generateTestbench` - 生成测试台
- `svtools.repeatCode` - 重复代码并编号
- `svtools.alignCode` - 对齐选中的代码
- `svtools.insertHeader` - 插入文件头

### 仿真命令（Icarus Verilog）
- `svtools.iverilog.lint` - 对当前文件运行 iverilog 语法检查
- `svtools.iverilog.simulate` - 编译并运行仿真（vvp），返回 Promise 供脚本/Agent 调用
- `svtools.iverilog.stopSimulation` - 停止正在运行的仿真
- `svtools.iverilog.openWaveform` - 打开 VCD 文件到内置波形查看器

## 快捷键

| 命令 | Windows/Linux | macOS |
|------|---------------|-------|
| 生成模块实例化 | `Ctrl+Shift+C` | `Cmd+Shift+C` |
| 生成测试台 | `Ctrl+Shift+T` | `Cmd+Shift+T` |
| 重复代码编号 | `Ctrl+F12` | `Cmd+F12` |
| 对齐代码 | `Ctrl+Shift+X` | `Cmd+Shift+X` |
| 插入文件头 | `Ctrl+Shift+Insert` | `Cmd+Shift+Insert` |

## 架构

本项目使用 **Rust Native Backend**：

- 核心格式化和代码生成逻辑使用 Rust 编写
- 通过 napi-rs 编译为原生 Node.js 模块
- 无需外部运行时依赖（Python 等）
- 启动速度快，内存占用低

## 格式化示例

### 示例 1: 模块端口对齐 + always 块 + case 语句

**格式化前**：
```systemverilog
module alu #(parameter W=8,localparam DW=W*2)(
input clk,rst_n,
input [W-1:0] opcode,
input [DW-1:0] operand_a,operand_b,
output reg [DW-1:0] result,
output zero,overflow);
reg zero_flag,overflow_flag;
always @(posedge clk or negedge rst_n) begin
if(!rst_n) begin result<=0;zero_flag<=0;overflow_flag<=0; end else begin
case(opcode)
4'd0:result<=operand_a+operand_b;
4'd1:result<=operand_a-operand_b;
4'd2:result<=operand_a&operand_b;
4'd3:result<=operand_a|operand_b;
default:result<=0; endcase
zero_flag<=(result==0); end end
assign zero=zero_flag; assign overflow=overflow_flag;
endmodule
```

**格式化后**：
```systemverilog
module alu #(parameter W=8,localparam DW=W*2
) (
  input                clk, rst_n,
  input      [ W-1:0]  opcode   ,
  input      [DW-1:0]  operand_a, operand_b,
  output reg [DW-1:0]  result   ,
  output               zero, overflow
);

  reg zero_flag,overflow_flag;

  always @(posedge clk or negedge rst_n) begin
    if(!rst_n) begin result<=0;zero_flag<=0;overflow_flag<=0; end else begin
      case(opcode)
        4'd0:result<=operand_a+operand_b;
        4'd1:result<=operand_a-operand_b;
        4'd2:result<=operand_a&operand_b;
        4'd3:result<=operand_a|operand_b;
        default:result<=0; endcase
      zero_flag <= (result==0); end end

  assign zero = zero_flag; assign overflow=overflow_flag;

endmodule
```

### 示例 2: 接口 + 模块实例化端口对齐

**格式化前**：
```systemverilog
interface axi_if #(parameter DATA_W=32,parameter ADDR_W=32,parameter ID_W=4)();
logic[ID_W-1:0] awid;logic[ADDR_W-1:0] awaddr;
logic[7:0] awlen;logic[2:0] awsize;logic awvalid;logic awready;
modport master(output awid,awaddr,awlen,awsize,awvalid,input awready);
endinterface

module top #(parameter W=16) (
input clk,rst_n,
input [31:0] arbase,
output [63:0] tx_data);
axi_if #(.DATA_W(64),.ADDR_W(32),.ID_W(4)) axi_bus ();
simple_module #(.W(W)) u_inst(
.clk(clk),.rst_n(rst_n),
.data_in(arbase[15:0]),
.data_out());
endmodule
```

**格式化后**：
```systemverilog
interface axi_if #(parameter DATA_W=32,parameter ADDR_W=32,parameter ID_W=4
) ();

  logic[ID_W-1:0] awid;logic[ADDR_W-1:0] awaddr;
  logic[7:0] awlen;logic[2:0] awsize;logic awvalid; logic awready;

  modport master(output awid,awaddr,awlen,awsize,awvalid,input awready);
endinterface

module top #(parameter W=16
) (
  input          clk, rst_n,
  input  [31:0]  arbase ,
  output [63:0]  tx_data
);

  axi_if #(.DATA_W(64), .ADDR_W(32), .ID_W(4)) axi_bus ();

  simple_module #(.W(W)) u_inst (
    .clk     (clk         ),
    .rst_n   (rst_n       ),
    .data_in (arbase[15:0]),
    .data_out(            )
  );

endmodule
```

### 示例 3: Task / Function 参数对齐

**格式化前**：
```systemverilog
task automatic drive(input int iter,
input logic[31:0] base_addr,input logic[31:0] burst_len);
for(int i=0;i<iter;i++) begin
@(posedge clk);arbase<=base_addr+i*burst_len*4;
arvalid<=1'b1;@(posedge clk);arvalid<=1'b0;
wait(arready);end
endtask

function automatic logic[7:0] get_checksum(
input logic[7:0] data[],input int len);
logic[7:0] sum=0;
for(int i=0;i<len;i++) sum+=data[i];
return sum;
endfunction
```

**格式化后**：
```systemverilog
task automatic drive (
  input int            iter     ,
  input logic [31:0]   base_addr,
  input logic [31:0]   burst_len
);

  for(int i=0;i<iter;i++) begin
    @(posedge clk);arbase<=base_addr+i*burst_len*4;
    arvalid<=1'b1;@(posedge clk);arvalid<=1'b0;
    wait(arready);end

endtask

function automatic logic[7:0] get_checksum (
  input logic [7:0]  data [],
  input int          len
);

  logic[7:0] sum=0;
  for(int i=0;i<len;i++) sum+=data[i];
  return  sum;
endfunction
```

**格式化特性**：
- ✅ 端口声明对齐（位宽、名称、注释）
- ✅ 参数列表格式化
- ✅ always 块自动缩进
- ✅ case 语句格式化
- ✅ 赋值语句对齐
- ✅ 模块实例化端口对齐
- ✅ Task / Function 参数缩进
- ✅ 接口 (interface) 格式化
- ✅ 自动插入空行分隔逻辑块

## 项目结构

```
vscode-extension/
├── extension.js           # VSCode 扩展入口（格式化 + Provider 注册）
├── package.json           # 扩展清单文件
├── svtools.win32-x64-msvc.node  # Rust 编译的原生模块
├── syntaxes/              # TextMate 语法文件
│   └── systemverilog.tmLanguage.json
├── templates/             # 模板文件
│   └── header_template.txt
└── src-rust/              # Rust 源码
    ├── Cargo.toml
    ├── src/
    │   ├── lib.rs         # napi-rs 入口
    │   ├── main.rs        # CLI 格式化器入口
    │   ├── beautifier.rs  # 格式化核心
    │   ├── tokenizer.rs   # 词法分析
    │   ├── parser/        # 语法解析
    │   ├── align/         # 对齐算法
    │   ├── codegen/       # 代码生成
    │   └── analyzer/      # tree-sitter 符号分析 (v3.4.0+)
    └── build.rs
```

## 调试

1. 在 VSCode 中打开插件源码
2. 在 `extension.js` 或 `src-rust/src/` 中设置断点
3. 按 `F5` 启动调试
4. 查看"输出"面板中的错误信息

## 常见问题

### 格式化没有生效
1. 确认扩展已正确安装并激活
2. 检查文件语言模式是否为 Verilog 或 SystemVerilog
3. 查看 VSCode 输出面板的错误信息

### 中文注释乱码
本插件已修复 Windows 平台中文乱码问题，强制使用 UTF-8 编码。如仍有问题，请检查文件保存编码是否为 UTF-8。

### 找不到原生模块
确保 `svtools.win32-x64-msvc.node`（Windows）或对应的 `.node` 文件存在于扩展目录中。

## 致谢

本 VSCode 插件改编自以下 Sublime Text 插件的核心逻辑：

1. [TheClams 的 Sublime Text SystemVerilog 插件](https://github.com/TheClams/SystemVerilog) - 格式化功能
2. [poucotm 的 Verilog-Gadget 插件](https://github.com/poucotm/Verilog-Gadget) - 生产力工具

v3.4.0 使用了以下开源项目：

3. [tree-sitter](https://github.com/tree-sitter/tree-sitter) (MIT) - 增量解析库
4. [tree-sitter-systemverilog](https://github.com/gmlarumbe/tree-sitter-systemverilog) (MIT) - SystemVerilog 语法

### 原作者
- **TheClams** - [Sublime Text SystemVerilog Plugin](https://github.com/TheClams/SystemVerilog)
- **poucotm** - [Verilog-Gadget Plugin](https://github.com/poucotm/Verilog-Gadget)
- **Max Brunsfeld** - [tree-sitter](https://github.com/tree-sitter/tree-sitter)
- **Gonzalo M. Larumbe** - [tree-sitter-systemverilog](https://github.com/gmlarumbe/tree-sitter-systemverilog)

### VSCode 扩展开发
- **JayceVane** - [VSCode 集成封装](https://github.com/JayceVane)
  - 邮箱: [JayceVane@163.com](mailto:JayceVane@163.com)

### AI 辅助开发
本项目的开发过程中使用了以下 AI 工具辅助编码、调试和文档编写：
- [OpenCode](https://github.com/opencode-ai/opencode) - AI 编程助手
- [GLM (智谱 AI)](https://zhipuai.cn) - 大语言模型

## 许可证

Copyright (c) 2025 JayceVane

本软件采用 [Apache License, Version 2.0](LICENSE) 许可。关于第三方代码的信息，请参阅 [NOTICE](NOTICE) 文件。

本插件包含 Sublime Text SystemVerilog 插件和 Verilog-Gadget 插件的核心逻辑，同样采用 Apache License, Version 2.0 许可。

v3.4.0 新增的 tree-sitter 和 tree-sitter-systemverilog 依赖采用 MIT 许可（详见 [NOTICE](NOTICE)）。

### 许可证摘要

您可以：
- ✅ 在个人和商业项目中使用本插件
- ✅ 修改和分发代码
- ✅ 对代码进行子许可

您必须：
- ⚠️ 包含原始版权和许可声明
- ⚠️ 说明对文件所做的重大更改

完整条款请参阅 [Apache License 2.0](http://www.apache.org/licenses/LICENSE-2.0)。
