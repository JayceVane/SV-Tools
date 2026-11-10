# XSim 断言失败时 Vivado 仍可能返回 0

Vivado 2022.1.2 实测，XSim 的 SVA 失败动作调用 $error 后，工程仿真日志包含行首 Error:，外层 Vivado 批处理仍以退出码 0 结束。旧解析只识别大写 ERROR:，因此把有断言错误的仿真判为成功。

Vivado 批处理现在按大小写无关的行首级别匹配日志，统一为 ERROR 或 CRITICAL WARNING 后参与任务判定。结果仍保留厂商工具的实际退出码。嵌在普通日志中的 Error: 不作为独立诊断。

test/toolchain_task_test.js 覆盖退出码 0、完成标记和 XSim 错误同时出现的情况。真机用同一测试台分别运行通过与失败断言，两次均退出 0，插件分别返回成功和失败。失败的两个 bind 实例各保留一条错误。
