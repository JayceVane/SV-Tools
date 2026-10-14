# 标准补全目录的来源与重建

补全器使用版本化的数据目录，编辑器适配层和工程语义索引共同消费它。目录覆盖标准语言表面和参考库公开接口；数据条目数量不表示完成了 IEEE 全部语义规则、仿真器功能或任意预处理宏的展开。

## 规范和参考实现

- SystemVerilog 基线为 IEEE 1800-2023；保留 1800-2005、2009、2012、2017 关键词档位。Verilog 基线为 IEEE 1364-2005，同时保留 1364-1995、2001 和 2001-noconfig。标准获取入口：[Accellera IEEE Standards](https://accellera.org/downloads/ieee)。
- 关键词、系统名称、specify 时序检查名称采用 [slang 官方源码固定提交](https://github.com/MikePopoloski/slang/tree/fd809bc29cc39cc2a467aa29773524144e631e97) 的版本表和注册表作为可复现核验依据。slang 是独立的 SystemVerilog 编译器参考实现，不能代替 IEEE LRM。关键词来自 `source/parsing/LexerFacts.cpp`，系统名称来自 `scripts/systemnames.txt`，时序检查来自 `source/ast/symbols/SpecifySymbols.cpp`，内建方法签名和合法接收者对照 `source/ast/builtins/`。该目录不引入 slang 运行时依赖。
- UVM 1.2 使用 Accellera 官方公开归档 `uvm-1.2.tar.gz`；IEEE 1800.2-2020 档位使用官方 `1800.2-2020.3.2 Release.gz`。发布入口和各版本参考库：[Accellera UVM 下载页](https://accellera.org/downloads/standards/uvm)。
- 1800.2 参考库自身采用 `@uvm-ieee`、`@uvm-contrib`、`@uvm-accellera`、`@uvm-compat` 标注 API 来源；其含义见 [Accellera 官方库说明](https://github.com/accellera-official/uvm-core#library-release-description)。目录保留这些类别、章节号、静态性、可见性、继承、类型参数、字段类型和返回类型。库中未标规范但在公开文档中出现的条目标为 `reference`；由库接口宏生成的成员标为 `reference-generated`。`src/deprecated/` 的兼容宏明确保留弃用标注。上述扩展类别均不宣称属于 IEEE 标准。

本机 Vivado 的 UVM 源码没有用作发布目录来源，也没有复制仿真器专有实现。

## 固定来源校验

| 来源 | SHA-256 |
| --- | --- |
| UVM 1.2 归档 | `502a2e605ce552bfd9767803c7e99a053715b00f7a9c4c511c3fbfddfb30157c` |
| UVM 2020.3.2 归档 | `4664ac015f23c72106dd785906aa874d70932ea63f74b85de1e32fa5339c15eb` |
| slang 固定提交 tar.gz | `2be251cc1e626e862adc39f300e5d41e5fffd212ff286fda86029cde626fa58c` |
| slang LexerFacts.cpp | `4ef64322234dd1c5cb243898fd6effdf04350b30b5cd7190664768d6ba9f66ab` |

slang 提交为 `fd809bc29cc39cc2a467aa29773524144e631e97`。UVM 归档在生成前检查上述哈希，来源有变化直接失败，避免静默采用新的参考实现。

## 实际数据规模

| 数据 | 实际数量 |
| --- | ---: |
| Verilog 1364-2005 关键词 | 124 |
| SystemVerilog 1800-2023 关键词 | 248 |
| 系统调用及 specify 时序检查 | 236 |
| 另列的实现扩展系统调用 | 4 |
| 编译指令及 `__FILE__` / `__LINE__` | 28 |
| UVM 1.2 公开类 / 全部顶层符号 | 223 / 279 |
| UVM 1.2 类/枚举成员、包级函数、常量、宏 | 1737 / 21 / 126 / 175 |
| UVM 2020.3.2 公开类 / 全部顶层符号 | 251 / 317 |
| UVM 2020.3.2 类/枚举成员、包级函数、常量、宏 | 2303 / 26 / 139 / 208 |

系统调用数量按固定源码登记范围统计，包含语言标准化的历史交互/PLA/排队任务和 12 种 specify 时序检查。`$psprintf`、`$static_assert`、`$deposit`、`$showvars` 作为实现扩展单独分类，默认目录关闭；2023 新接口随标准档位过滤。旧关键词档位可严格切换，系统函数和内建成员的完整历史版本差异尚未逐版穷举，不能把所有旧档位描述为对应 LRM 的精确 API 快照。

Verilog 过滤经过独立核验：`$swrite` / `$sformat` / `$sscanf` / `$fscanf` / `$fread` 和文件操作族保留在 Verilog 基线；它们支持 Verilog 的 packed register 字符串/内存，不能因为 SystemVerilog 后来增加了 `string` 数据类型就把这些调用归为 SV 专属。Accellera 委员会的 [1364-2001 格式化/扫描章节说明](https://www.accellera.org/images/eda/sv-ec/0841.html) 明确关联 `$sformat` 与 `$sscanf` 到 Verilog-2001 的 17.2.3、17.2.4.3；[文件读取扩展讨论](https://www.accellera.org/images/eda/sv-bc/0576.html) 区分已有 `$fread` 的 register/memory 形式和后续 SV 类型扩展；[`$swrite` 等已有 Verilog 系统任务的修订提案](https://www.accellera.org/images/eda/sv-bc/att-5377/331_display.pdf) 进一步说明该格式化任务族。`$sformatf`、类型/数组查询、SVA 采样函数、覆盖率和 SV 随机化函数则排除于 Verilog 档位。历史交互控制的 optional 系统任务另标 `standard-optional`；描述性签名展示参数类型/可选参数，不表示仿真器支持所有 optional 任务。

内建接收者覆盖 string、固定/动态/关联数组、queue、enum、mailbox、semaphore、process、event、sequence、covergroup、class 随机化，以及 2023 的数组 `map()`、`weak_reference#(T)`、覆盖率 `cross_retain_auto_bins`。有类型链所需的 `string`、`self`、`element` 返回类型和静态标注。`triggered` 是属性，插入时不会加括号；关联数组不提供 `sort()`；固定数组不提供 queue 的增删接口。

覆盖率对象还分别提供 covergroup、coverpoint、cross 的方法，以及各自的 `option` / `type_option` 结构。属性按具体接收者分开，例如 coverpoint 不提供 `per_instance`，cross 不提供 `auto_bin_max`；保留 `get_coverage` 的静态性、`distribute_first` 与 2023 的 `real_interval`。约束对象的 `constraint_mode()` 和 rand 字段的 `rand_mode()` 独立提供，避免给普通变量推荐随机化方法。

生成器扫描 UVM 1.2 的 145 个源码文件，排除 106 个缺少公开依据的类声明；2020.3.2 扫描 174 个文件，排除 112 个此类声明。公开类中的未公开/local/protected 方法声明也记录排除数量。扫描范围和实际发布条目数量保存在各 JSON 的 `metadata`，所有候选来源及类别可追踪。UVM 的条件编译可选功能、DPI 可用性、参数化类型实例化规则仍由工程设置和仿真器决定。

## 重建

将三个固定来源归档下载至 `bin/completion-reference/`。归档名称和目录必须如下，第三方源码只作生成和验收依据，不打包：

```text
bin/completion-reference/
  uvm-1.2.tar.gz
  uvm-2020.3.2.tar.gz
  slang.tar.gz
  uvm-1.2/
  1800.2-2020.3.2/
  slang-fd809bc29cc39cc2a467aa29773524144e631e97/
```

来源地址：

```text
https://accellera.org/images/downloads/standards/uvm/uvm-1.2.tar.gz
https://accellera.org/images/downloads/standards/uvm/1800.2-2020.3.2%20Release.gz
https://codeload.github.com/MikePopoloski/slang/tar.gz/fd809bc29cc39cc2a467aa29773524144e631e97
```

在工程根运行：

```powershell
node scripts/generate-completion-catalog.js
node --test --test-isolation=none test/completion_catalog_test.js
```

生成器没有网络调用和外部依赖，可传入另一公开参考目录作为参数。生成过程依赖固定参考库声明形态，未实现任意 SystemVerilog 编译器前端。它保留注释位置，忽略字符串/注释伪声明，平衡类参数和实参括号，识别 extern/pure/DPI 原型，并只在公开类中展开库接口宏。宏展开深度和结果大小有上限，不执行外部命令。

验证包含固定来源逐项重建校验、稀有关键词、系统任务族、语言排除、内建接收者、UVM RAL/TLM/phase/factory/config/callback 面、`REQ/RSP/T` 类型保留、DPI 原型、private/protected 排除、宏字符串和约束插入形式。没有参考源码的环境会明确跳过源码重建检查，其余目录合同仍运行。

发布数据为 `src/editor/completion/language-standard.json`、`uvm-1-2.json`、`uvm-1800-2.json`。API 名称与声明来自 Apache-2.0 UVM 库及 MIT slang 源码；许可证全文和两个 UVM 版本的 NOTICE 保留在同目录 `catalog-licenses.json`，随发布包提供。数据中不含第三方函数实现体。
