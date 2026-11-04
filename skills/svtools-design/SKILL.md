---
name: svtools-design
description: RTL 架构建模与图表交付：packed struct 虚拟端口骨架（design scaffold）、架构分析（design arch）、接口级/信号级 SVG/PNG 渲染、结构检查 design check（悬空/多驱动/缺失模块）、架构 diff 与报告证据包 design report。
---

# 架构建模与图表（M3）

入口技能 `svtools-agent` 提供 CLI 调用约定；执行架构设计或图表交付前，先读取 [references/architecture.md](references/architecture.md)（生成规格、方向约束、时钟/复位处理、验收与当前限制）。

新建骨架默认声明 **packed struct 虚拟端口**，一个逻辑接口一个端口、一条连接；整体 inout 可用于架构中的双向接口，成员内容和收发约定写入架构文档。不要为出图强制拆开请求/响应或展开完整协议引脚，不要把主/从角色等同于电气方向。分析已有 RTL 则保留其真实端口。

实际命令为 `design scaffold --spec <json|file>`、`design arch --top <module>` 和 `design render --top <module>`。SVG 默认采用接口级连线（--detail interfaces）：接口表外一条汇总线，方向缩写（`i`/`o`/`io`）在表内逐行标注；--detail signals 用于信号级排查。`--format png` 用内置 resvg 2x 栅格化（`sourceSha256` 关联源 SVG；中文依赖系统字体，文档首选 SVG）。默认黑白 document 风格；`--style presentation` 用于演示。`--fold-ports` 仅作可选的显示折叠，不能替代虚拟端口声明；`--bundle-name` 仅与折叠选项同时生效。输入快照及哈希绑定生成模型，源码变化后应重新运行。

结构检查用 `design check --top <module>`：诊断逐条指认悬空 input（error）、无驱动网络（error）、多驱动（error）、缺失模块（error）与悬空 output、顶层无驱动输出、隐式位宽补常量（warning）；有 error 时退出码 1、`status=failed`，检查完成不等于结构干净，warning 也不得当作已验证。常量驱动不产生假诊断。

架构比较用 `design arch --save <name>` 保存快照，改动后 `design diff --top <module> --baseline <name>` 报告实例/模块/端口/接口增删改与 `implemented[]`（空骨架补实现）；diff 只报告差异，好坏由设计判断。

交付文档用 `design report --top <module> [--out <dir>]` 一次导出 SVG+PNG+`architecture.json`+`architecture.md`+`report.json`（清单含每份产物哈希；Markdown 检查表与 `checksSummary` 呈现结构结论，报告生成不等于结构合格）；引用产物时按清单哈希核对。任意深度层级展开尚未交付，不得编造调用或通过结论。

架构产物进入验证交付时，证据身份与必需项见 `svtools-delivery` 技能。
