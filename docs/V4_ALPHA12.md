# 4.0.0-alpha12 交付记录

## 规则与行为

按用户要求建立不可配置的字符保全条件：仅普通空格U+0020、Tab U+0009、CR U+000D、
LF U+000A可以变化。忽略这四种字符后，输出必须与原文完全相同；不得删除、添加、
替换或重排其余字符，重复次数也不能改变。全部乱码、未知语法、不完整字符串/注释/
宏、加密片段同样适用。NBSP、全角空格、VT/FF、BOM、零宽、NUL和组合字符属于正文。

布局候选不安全或抛出Rust布局异常时返回对应入口原文并记录诊断。所有配置服从保全，
`oneDeclPerLine`等选项若重复类型或改写标点，候选会被拒绝；安全优先于布局效果。
常规缩进、always触发条件紧凑和正常声明对齐继续有效，原golden全部保持。

## 技术方向

- `format_guard.rs`以UTF-8字节迭代比较，无过滤后字符串副本；共享全文、普通段、兼容beautifier和选区对齐入口，捕获布局panic后保留原文。
- NAPI用原始`JsString`严格读取UTF-16，无法转换的孤立代理项直接返回原句柄，避免普通String入参在Rust校验前替换成U+FFFD。两种布局导出的JS/TS签名仍为string→string。
- 编辑器`format-safety.js`以UTF-16码元再次比较，全文/选区和对齐替换前拒绝旧或错误native的损坏候选；生成实例、Testbench、头部与重复代码仍按用途新增代码。
- CLI沿用严格UTF-8读取；无效编码拒绝输入，不覆盖原文件或既有输出，不进行有损转码。规则详见`docs/FORMAT_SPEC.md`。

## 验证

- 104个JS语法检查、golden36/36、Node503/503、Rust117/117通过，native/CLI同步重建到alpha12。
- 新增Rust守卫5项：精确四字符白名单、删除/添加/替换/乱序/Unicode归一拒绝、保留原始行尾、注入panic、公开入口与声明拆分配置。
- 新增20项真实native/CLI合同：14个固定语料×6配置、64个确定性变异输入×6配置，两轮逐个保全且幂等；另验孤立代理项、正常格式化仍生效、选区对齐守恒及正常logic对齐。
- CLI覆盖stdin、原位、独立输出、检查模式；无效UTF-8输入、原文件和预先存在的输出均做字节比对，确认拒绝后未写入。
- 编辑器新增7项：故障native删除、添加、替换、乱序、非字符串返回、UTF-16/Unicode白名单边界及选区对齐替换，全文与范围读取均覆盖。原有6项继续通过，共13项。
- 全文与范围复核采用原始序列；没有用`\s`过滤Unicode空白，也没有用集合或排序后字符比较代替顺序检查。

日志：`bin/alpha12-test.log`、`bin/alpha12-rust-test.log`、`bin/alpha12-conservation.log`、
`bin/alpha12-editor-before.log`、`bin/alpha12-native-build.log`。Rust测试进程没有Node宿主时
原有NAPI动态符号诊断仍会出现，不影响117项测试。两个新增安全模块静态健康分100，
MI为54.51（JS）/34.34（Rust，包含同文件单测）；原始报告在`bin/alpha12-*-quality.json`。

旧选区赋值对齐分支使用Rust regex不支持的lookahead；未知内容进入该分支会触发panic。
本轮真实验收确认被捕获后返回原文，宿主正常退出；保留原panic hook诊断，未将该算法
扩展为本轮重构。根因、排除的错误猜测与维护边界见
`docs/bugs/logic-formatter-character-preservation.md`。

## 安装包

Windows x64：`bin/svtools-4.0.0-alpha12.vsix`，2315194字节、83个ZIP条目。
SHA-256：`173ee028e246d98fdd710fdadd5ea262ced89906dbc531fe69cc02b0c22fa82f`。
79项逐字节一致，其中61个src运行JS/CSS；中英文106个配置引用及公共JS/TS签名核对
通过。报告为`bin/alpha12-package-report.json`。打包再次执行503项回归全部通过，
README/CHANGELOG由VSCE处理链接与换行，未混入Rust源、测试或日志。

开发仅在4.0独立worktree完成，3.x原目录未修改；未安装到用户IDE、推送、合并或发布。

## 修改清单

| 文件 | 变更 |
|---|---|
| `src/native/src/format_guard.rs` | 新增共享字符保全、异常回退与5项Rust合同。 |
| `src/native/src/lib.rs` | 全文和普通段入口在归一/拼接之后校验原始输入序列。 |
| `src/native/src/formatter/mod.rs` | 兼容beautifier入口同样受到保护。 |
| `src/native/src/codegen/align_code.rs` | 选区对齐复用守卫，异常保守回退。 |
| `src/native/src/bindings.rs` | 两种布局导出共用严格UTF-16原文适配。 |
| `src/editor/format-safety.js` | 新增无中间副本的UTF-16提交检查。 |
| `src/editor/formatting.js` | 全文/选区格式化拒绝损坏的native候选。 |
| `src/editor/commands.js` | 对齐选区在创建替换之前检查原文序列。 |
| `test/formatter_conservation_test.js` | 新增20项真实native/CLI保全合同。 |
| `test/editor_test.js` | 正常排版替身与7项故障native边界回归。 |
| `docs/FORMAT_SPEC.md` | 固化最高优先级规则、配置冲突和编码边界。 |
| `ARCHITECTURE.md` | 记录Rust提交条件、NAPI编码和JS复核的分工。 |
| `docs/bugs/logic-formatter-character-preservation.md` | 记录复现、根因、实际修复与已有赋值对齐维护项。 |
| `docs/V4_ALPHA12.md` | 本轮验收、包核验和完整修改清单。 |
| `CHANGELOG.md` | 记录硬性保全与影响。 |
| `CONTEXT.md` | 更新里程碑、验证和下一步。 |
| `README.md` | 同步alpha12并说明保全规则。 |
| `package.json` | 同步版本并注册专项测试。 |
| `package-lock.json` | 同步根锁版本。 |
| `src/native/Cargo.toml` | 同步crate版本。 |
| `src/native/Cargo.lock` | 同步crate锁版本。 |
| `src/native/package.json` | 同步native包版本。 |
| `src/native/package-lock.json` | 同步native锁版本。 |
