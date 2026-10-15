# 4.0 代码补全

补全从关键词正则改为规范目录、容错语义模型、工程缓存和 VS Code 适配四个部分。原生格式化器缺失时补全仍可运行。默认 `.v/.vh` 使用 Verilog 2005，`.sv/.svh` 使用 SystemVerilog 2023，UVM 默认使用 1.2。

## 标准目录

| 表面 | 范围 | 依据 |
| --- | --- | --- |
| Verilog 关键词 | 1995、2001-noconfig、2001、2005；2005 共 124 项 | 固定参考编译器版本表，逐项重建核验 |
| SystemVerilog 关键词 | 2005、2009、2012、2017、2023；2023 共 248 项 | 同上 |
| 系统调用 | SV 236 项，Verilog 基线 169 项；specify 的 12 项仅在对应作用域出现 | 固定公开注册表、描述性签名 |
| 编译指令 | 28 项，含标准指令和 `__FILE__` / `__LINE__` | 版本化目录 |
| UVM 1.2 | 223 类、1737 类/枚举成员、175 宏，另含包函数与常量 | Accellera 公开参考库 |
| UVM 1800.2 | 251 类、2303 类/枚举成员、208 宏，另含包函数与常量 | Accellera 2020.3.2 公开参考库 |

目录中保留接口版本、继承、类型参数、字段/返回类型、静态性、来源、弃用及 IEEE/贡献/扩展/兼容类别。参考库扩展没有冒充 IEEE 标准接口。历史版本的关键词表完整枚举；系统调用和内建方法没有逐版穷举全部历史变化。

公开来源、归档校验、许可证和目录重建见 [COMPLETION_SOURCES.md](COMPLETION_SOURCES.md)。参考库源代码只用于生成与验收，不随扩展发布；发布 JSON 不含第三方函数实现体。

## 语义与插入行为

| 场景 | 已验收行为 |
| --- | --- |
| 词法与编辑状态 | 屏蔽注释/字符串/宏定义正文；转义名称、未闭合括号、未完成声明保留准确替换区间 |
| 作用域 | root/module/interface/package/program/class/function/task/block 等；局部声明和循环索引不会泄漏 |
| package | 指定或 wildcard import、`pkg::` 成员、跨文件类型；未导入的包内容不会作为普通局部名称出现 |
| 类 | public/protected/local、this/super、静态成员、继承、参数化类型/基类、同文件类外方法实现 |
| 类型 | typedef、enum、匿名/嵌套 struct/union；字段、方法返回值和调用链逐层解析 |
| 例化 | 平衡括号识别命名端口/参数；超过 30 行的列表、嵌套表达式、多实例及不完整连接；去除已经连接的项和 localparam |
| 数组与二维 mem | packed 与 unpacked 分开；fixed/dynamic/associative/queue 使用各自合法方法；逐维下标和弹出元素保留剩余维度 |
| 内建对象 | string、enum、mailbox、semaphore、process/state、event、sequence；std 包和 2023 weak_reference |
| 验证对象 | covergroup/coverpoint/cross 方法及各自 option/type_option；constraint_mode、随机字段 rand_mode |
| interface | virtual interface、modport 曝光信号/方法过滤 |
| UVM | package、factory type_id/create、config_db/resource_db、phase/objection、sequence/driver 的 REQ/RSP、TLM 字段/方法、RAL、回调、宏签名 |
| 代码骨架 | 保留 RTL 模板，补 package/class/constraint/coverage/SVA/clocking/checker/program/UVM 类和 phase 模板 |
| 接受补全 | 方法/宏参数为可编辑片段；已有括号不重复插入；中间编辑替换整个词；`$`/反引号不重复；转义名称包含终止空白 |

这些是已实现并验收的场景清单，不代表任意表达式已经具备编译器级类型推导。

## 配置

```json
{
  "svtools.completion.standard": "auto",
  "svtools.completion.uvmVersion": "1.2",
  "svtools.completion.includePaths": ["include", "${workspaceFolder}/verification"],
  "svtools.completion.maxFiles": 5000,
  "svtools.completion.maxFileSizeKB": 2048,
  "svtools.completion.maxTotalSourceMB": 32,
  "svtools.completion.maxItems": 1000
}
```

`standard` 可显式选择表中语言版本；auto 按文档语言和当前 `begin_keywords` / `end_keywords` 区间选择。`uvmVersion` 可选 `1.2`、`1800.2`、`off`。两者独立于编译器配置，改变补全目录不会替换仿真器或 UVM 库。

`includePaths` 为额外 HDL 库/头文件目录，相对路径按各工作区文件夹展开，支持绝对路径。工程文件和外部 include 目录均监听新增、修改和删除；配置变化重建对应监听。补全不依赖 `iverilog.scanWorkspace`。

未保存文档优先于磁盘，按文档版本复用语义模型。关闭文件以实际 UTF-8 字节数执行容量预算；`maxTotalSourceMB` 是源码容量预算，不是进程堆内存限制。当前打开的文档参与索引，不受关闭文件大小上限截断。

达到文件、源码或候选预算时返回 `CompletionList.isIncomplete`。继续输入前缀可以定位完整索引中的其他候选；超出文件容量预算而未索引的声明需要调整预算。取消请求不会返回过期列表。

## 性能与验收

`npm test` 包含目录重建、词法/作用域、解析协同、工程缓存和编辑器区间合同，沿用格式化、波形和工具链回归。

独立 VS Code 宿主通过 `vscode.executeCompletionItemProvider` 检查真实 CompletionList、区间和接受补全，并用 Icarus 编译接受补全后的代码。宿主使用独立用户目录/扩展目录，不安装到用户 IDE。

```powershell
scripts/verify-completion-host.ps1 -CodePath 'D:/Tools/Microsoft VS Code/Code.exe' -IcarusPath 'D:/DevKit/iverilog/bin/iverilog.exe' -CygwinPath 'D:/DevKit/cygwin64/bin'
node scripts/verify-completion-performance.js
```

性能脚本实际生成/读取 512 个 HDL 文件和十万行活动文档，监测冷索引、热请求、单文件变化、脏文档、I/O 与内存。它运行真实 provider/index/engine，VS Code 适配类使用轻量构造器；该耗时不是 IDE 绘制端到端延迟。交付版本的数值和报告位置见 [V4_ALPHA6.md](V4_ALPHA6.md)。

## 尚未覆盖的语义

- 不执行工程宏展开、条件编译选择、文本 include 拼接或完整 elaboration。索引额外目录不等于仿真器的预处理结果。
- 不执行参数表达式求值、generate 展开、任意重载/复杂 cast/表达式的完整类型推导；数组 `with` 的隐式 iterator、跨文件类外方法实现归并仍有边界。
- 复杂 modport 表达式、enum 名称范围自动展开、覆盖率 bin elaboration 和专有工具扩展没有宣称全覆盖。
- UVM 条件功能、DPI 和参考库扩展的可用性由实际工程及仿真器决定。目录签名描述可选/可变参数，部分历史系统任务只提供名称和编辑点。

因此，这次完成了标准关键词和固定公开参考库接口的目录覆盖，以及上表的语义补全；不能将它称作 IEEE 所有语义场景的 100% 实现。
