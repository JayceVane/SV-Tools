# logic-vvp-runtime-arguments

> **发现方式**：4.0发布审查沿生成Testbench到真实仿真入口复核。
> **定位耗时**：本轮集中排查。
> **修复位置**：toolchains/iverilog-runner与native/codegen/testbench。

## 症状与排查

配置simArgs明确描述支持plusargs，但真实runner用`vvp -n +trace +seed=73 case.vvp`。
真实Icarus日志为 `+trace: Unable to open input file.`，退出255。
单独用`vvp case.vvp +vcd`运行生成器验收会通过，因此此前没有覆盖实际runner的参数顺序。
再沿默认操作链检查，发现默认VCD模板要求+vcd，而默认仿真设置为空，运行成功也没有波形。

## 根因与修复

vvp将输入文件之前的参数解释为CLI选项/输入文件，将之后的参数交给仿真程序。
现在保留固定-n和已知CLI选项在前，plusargs与extended格式选项在输入文件之后，维持各阶段内的原顺序。
-l/-M/-m分离和附着值明确处理，-lxt/-lxt2等extended项不能误当日志文件选项。
VCD模板直接调用dumpfile/dumpvars；显式选择的专用仿真器格式保持其工具语义。

## 验证与教训

通过生产createIcarusRunner执行实际Icarus编译与vvp运行，检查test/value plusargs和extended参数，而不只断言数组文本。
默认生成的Testbench在没有+vcd的情况下也必须产出有效VCD。运行时-dumpfile覆盖同样接入关闭屏障和产物发现；无后缀时保留原名及可能后缀候选，不凭文档假定所有版本都会自动补扩展名。
依据：[官方vvp参数阶段说明](https://steveicarus.github.io/iverilog/usage/vvp_flags.html)。
验证单一工具或单独骨架还不足以证明插件默认工作流可用，应沿真实入口检查参数和默认配置的组合。
