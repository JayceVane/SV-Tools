# logic-instance-clock-reset-alias

> **发现方式**：用户报告cdc_hs_bits的例化模板，时钟和复位端口连接不匹配。
> **定位耗时**：约十分钟。
> **修复位置**：`src/native/src/codegen/module_inst.rs` / `build_instance`；`testbench.rs`声明边界。

## 症状

对用户模块调用实际NAPI `generateModuleInst` 得到：

```systemverilog
.i_clk_a   (i_clk_a  ), // input i_clk_a
.i_rst_n_a (i_rst_n_a), // input i_rst_n_a
.i_clk_b   (i_clk_a  ), // input i_clk_b
.i_rst_n_b (i_rst_n_a), // input i_rst_n_b
```

声明段生成了i_clk_b和i_rst_n_b，但端口连接没有使用它们。

## 排查过程

1. 只读用户真实文件，直接调用原生生成入口复现，排除剪贴板或编辑器复制问题。
2. 查看解析结果：两个时钟和两个复位均被识别，未丢失端口、方向或参数。
3. 定位到私有get_port_mapping：如果端口属于clocks或resets，就返回对应列表的first。
   生成声明使用原名，生成连接却走此替换，两个阶段产生不同信号。
4. 同一实例构造器也用于Testbench；旧声明逻辑跳过全部识别出的控制信号，但只生成主控制信号的声明与激励。
   因此修正连接时，必须同时保留额外域的信号声明。

## 根因

时钟/复位列表是角色分类结果，不是信号别名表。把同类信号替换为第一个成员，
会把CDC两侧连接到同一时钟或复位；列表排序改变还可能改变被选中的主信号。

## 修复

删除私有别名替换路径，端口名和信号名均来自同一Port.name，按同一列宽生成模板。
Testbench声明只排除其实际生成声明及激励的主信号，其余域保持独立声明。
本轮不推断跨域频率/相位或补齐多时钟激励；用户真实RTL保持只读。

回归覆盖CDC完整端口表、声明开关、配置列表顺序、非ANSI端口、普通输入输出与双向端口，
并检查Testbench复用路径。真实Icarus在default_nettype none下编译生成模板，
A/B时钟与复位分别设置不同电平，逐个检查DUT端口值。

## 教训

- 角色分类不应改变连接身份，尤其不能默认合并同类时钟域。
- 修改共享生成器时，应同步验证声明和引用，避免产生未声明信号。
