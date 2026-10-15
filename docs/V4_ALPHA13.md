# 4.0.0-alpha13 交付记录

## 修复结果

用户的task条件现在输出：

```systemverilog
if (grant != ({{(WIDTH-1){1'b0}}, 1'b1} << i)) begin
```

逗号前的多余空格删除，逗号后和移位运算符前的多余空格折叠；重复拼接、位宽、字面量
和运算符原字符不变。关闭`inlineCompact`保留条件空白，alpha12字符保全继续优先。

## 根因与技术方向

旧单行紧凑入口要求语句以分号结束，`if (...) begin`被排除。既有always事件头已有
平衡括号和词法保护能力，因此把私有入口统一为`normalize_control_headers`，在代码
掩码上定位if/always，跳过重叠区间，复用`find_matching`和`compact_inline_whitespace`。
没有复制一套条件正则重排，也没有修改解析、缩进、赋值对齐或字符保全策略。

范围止于条件/事件列表闭括号，支持嵌套函数、括号/方括号/花括号、拼接/重复拼接、
`else if`、限定词和同一行多个条件。保留用户换行、字符串、注释、宏正文、转义标识符
及其终止空白；未闭合或括号类型不匹配时保持该条件原文。

## 验证

- 104个JS语法检查、Node510/510、Rust121/121通过，native/CLI同步重建到alpha13。
- 新增用户片段golden：19个样例、38个断言全部通过，原18个样例的目标文件未改。
- 新增Rust4项：嵌套拼接与块体边界、同行/else/限定条件、保护区与宏、换行及不平衡条件。
- 新增Node7项：两种风格×开关4项、保护区1项、多行1项、同行与else if 1项；均走真实native管线、验证正文保全和幂等。
- 既有always事件头、多配置乱码/控制字符、故障native与CLI字符保全回归继续通过。
- 针对性if测试11/11，用户样例原文/结果/报告分别为`bin/alpha13-if-before.sv`、`bin/alpha13-if-after.sv`、`bin/alpha13-if-report.json`。

日志：`bin/alpha13-rust-test.log`、`bin/alpha13-if-before.log`、`bin/alpha13-if-test.log`、
`bin/alpha13-golden.log`、`bin/alpha13-native-build.log`、`bin/alpha13-package.log`。
GNU配置的条件回归直接提供GNU块布局。本轮另发现旧GNU+inlineCompact=false从同行
begin转换时有首轮/二轮缩进差异；它不影响默认1tbs修复，未将块风格转换扩入本轮修改。
该既有问题保留为后续维护项，不能据条件测试声称GNU样式转换全覆盖。

## 安装包

Windows x64：`bin/svtools-4.0.0-alpha13.vsix`，2315409字节、83个ZIP条目。
SHA-256：`f144d66cdaa5f9ef9c508735c3a7441bb627ec8bea795efc04201adb6a0b7008`。
79项逐字节一致，其中61个src运行JS/CSS；106个中英文配置引用和公共JS/TS签名通过。
README/CHANGELOG由VSCE处理链接与换行，未混入Rust源、样例、测试或日志。
核验报告为`bin/alpha13-package-report.json`。

4.0工作树独立开发，3.x原目录未修改；未安装到用户IDE、推送、合并或发布。

## 修改清单

| 文件 | 变更 |
|---|---|
| `src/native/src/preprocess.rs` | if/always共享条件头定位、平衡括号和紧凑规则，新增4项Rust合同。 |
| `test/formatter_contract_test.js` | 新增7项真实管线的if条件、开关、保护区和换行合同。 |
| `example/ex17_if_condition_compact.sv` | 固化用户task、重复拼接与移位条件的原始输入。 |
| `example/target/ex17_if_condition_compact.sv` | 对应默认格式化目标。 |
| `docs/FORMAT_SPEC.md` | 更新if条件头紧凑的范围与保护约束。 |
| `docs/V4_ALPHA13.md` | 本轮根因、效果、验证、维护边界和完整清单。 |
| `CHANGELOG.md` | 记录修复及影响。 |
| `CONTEXT.md` | 更新里程碑、验证和后续维护项。 |
| `README.md` | 同步开发版本。 |
| `package.json` | 同步扩展版本。 |
| `package-lock.json` | 同步根锁版本。 |
| `src/native/Cargo.toml` | 同步crate版本。 |
| `src/native/Cargo.lock` | 同步crate锁版本。 |
| `src/native/package.json` | 同步native包版本。 |
| `src/native/package-lock.json` | 同步native锁版本。 |
