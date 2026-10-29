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

## 显式dumpfile覆盖集中目录（2026-10-29）

Open.26试用反馈：Icarus波形仍留在测试台目录，而其它仿真入口已使用`.svtools/vcd`。
原实现仅注入vvp的默认`-dumpfile=`，源码显式`$dumpfile("xxx.vcd")`会覆盖它，生成的默认Testbench恰好包含该调用。
这是实际Icarus参数语义；不能通过调整同一默认参数解决，也不应改变cwd而破坏相对`$readmemh`。

现在保持原始运行语义，成功后只归档本轮新增或变化的VCD，再打开归档路径。
默认路径可直接写入；显式路径按源文件、Top及原路径生成稳定归档身份，保留可读文件名。
原始路径与归档目标的读取租约覆盖运行和移动阶段，动态发现的目标在替换前补充保护。
同卷rename不复制大文件，跨卷先复制到唯一临时文件、替换成功后才移除原始文件。
失败、取消、旧未变化文件及显式FST/LXT模式不会按成功VCD归档；归档错误保留原始波形并明确报错。

回归位于`test/toolchain_task_test.js`与`test/waveform_lifecycle_test.js`：显式子目录、重跑稳定、同名输出、动态目标屏障、归档失败保留、跨卷复制与FST边界。
`scripts/verify-toolchains.js --iverilog <路径> --vvp <路径> --cygwin <路径>`实际编译运行默认VCD、RTL字面路径和simArgs路径三种场景，逐项验证归档、未改写RTL及相对readmem数据。
2026-10-29上述三项真实Icarus验收通过；尚未提交。
