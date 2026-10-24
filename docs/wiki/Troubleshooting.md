# 故障排查

先记录扩展版本、IDE/扩展宿主版本、所用工具版本、当前工作区和完整日志位置，再做最小复现。不要把私有工程、访问令牌或许可证文件上传到公开 issue。

| 现象 | 优先检查 |
|---|---|
| 格式化完全不生效 | 语言模式、默认格式化器、扩展是否启用；安全回退可能保留原文 |
| 仍是旧菜单/旧模板控件 | 确认安装的是4.0.0，重载窗口；检查是否同时运行多个IDE/远端扩展宿主 |
| 原生模块加载失败 | 下载Windows x64匹配的VSIX，检查缺失/ABI错误路径；完整VSIX自带.node |
| 内置Yosys出现不支持WASM特性 | 升级到满足要求的IDE/宿主，或配置兼容的外部Yosys与前端 |
| `spawn yosys ENOENT` | 将`svtools.circuit.yosysPath`恢复为`bundled`，或填写真实外部可执行路径 |
| `unknown module 'half_adder'` | 检查子模块文件、包顺序、重复定义；必要时显式配置`circuit.sources` |
| `unknown type`/自定义参数类型不可见 | 先编译类型定义的package并正确import；文件名顺序不等于包可见性 |
| `Unexpected token '/', ...not valid JSON` | RTL使用“查看RTL电路”；JSON导入只选择实际网表JSON |
| 仅看到`Design elaboration failed` | 打开完整Yosys日志，查前面具体源码错误、模块和行列 |
| Vivado详细化失败 | 核对工程选择、当前文件已保存且属于综合源、IP/宏/include、器件与许可；读完整Vivado日志 |
| Vivado面板为空 | 打开项目文件夹，确认有XPR，执行选择工程/刷新；多工程明确选择 |
| Icarus找不到或秒退无stderr | 检查`iverilog.path`、vvp同目录、Cygwin DLL路径与工具自身可运行性 |
| 仿真找不到头文件/子模块 | 区分include目录、库目录和编译源列表，核对simTop |
| 生成的测试台没有业务激励 | 它是可编辑骨架，需自行补充协议驱动、检查与结束条件 |
| VCD无法重新写入 | 使用插件仿真入口关闭旧视图；检查外部查看器是否占用文件 |
| VCD有数据但mem为空 | 必须dump所需元素；查看VCD是否真的有数组索引声明 |
| 二维mem只显示一维 | 仿真器可能已将索引展平，VCD丢失的行列信息无法恢复 |
| 浮点格式禁用 | 核对声明位宽，real类型无需按位转换；混合多选需全部兼容 |
| 波形在缩小后看不到窄脉冲 | 查看密集区标记，放大，再用A/B精确值和真实边沿导航核验 |
| 文件头成一行 | 多行控件使用实际换行；settings.json使用JSON的`\n`；旧压平内容需重新粘贴 |
| 文件头读文件失败 | 检查UTF-8编码、BOM、当前文档所属工作区、路径和文件是否为空 |

## 日志在哪

- Icarus/xvlog/xelab：通常为 `<工作区>/.svtools/tasks/<任务>/`。
- 电路：`<工作区>/.svtools/circuit/<任务>/`。
- Vivado Tcl：输出通道会给出本次独立任务目录与日志。

日志会保留，需要自行管理磁盘占用。只清理已经结束的任务目录，保留用于复现的原始日志。清理源码目录或XPR不是排错步骤。

## 提交问题

在[Issues](https://github.com/JayceVane/SV-Tools/issues)提供：操作入口、预期/实际、最小公开源码、相关设置、插件/IDE/工具版本、完整日志或必要片段。格式化问题最好提供格式化前后文本；电路问题同时提供生成入口与Top策略；波形问题附timescale、信号范围及可分享的小VCD。
