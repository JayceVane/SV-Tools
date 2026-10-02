# 开发环境搭建与本地安装

面向使用者的一条命令是：在 VSCode 扩展市场搜索 **SystemVerilog Tools** 安装即可（详见 [README.md](README.md)）。
本文给需要跑源码、改格式化器或自己打包的人。

## 前置条件

- Node.js 18+（扩展宿主与打包脚本）
- VSCode 1.74 或更高
- 改 Rust 层时需要 Rust 工具链（`cargo`）；只改 JS 层不需要
- v3.0+ 不再需要 Python；仓库里的格式化/代码生成逻辑全部在 `src-rust/`

## 项目结构

```
02_svtools/
├── extension.js                    # 扩展入口：命令注册、DocumentFormattingProvider、Provider 装配
├── iverilog.js                     # Icarus Verilog lint / 仿真 / 波形联动
├── vcd.js                          # 内置 VCD 波形查看器（CustomTextEditorProvider + Canvas）
├── vivado/                         # Vivado TCL 执行、器件库、工程创建向导
├── syntaxes/systemverilog.tmLanguage.json
├── templates/header_template.txt   # 文件头模板
├── svtools.win32-x64-msvc.node     # Rust 原生模块（运行时加载；本地产物，不入库）
├── src-rust/                       # Rust 源码：格式化核心 + napi 绑定 + CLI
│   ├── src/{beautifier,preprocess,blank_rules,align,codegen,analyzer}/
│   └── package.json                # napi 构建脚本
├── example/                        # golden 输入
├── example/target/                 # golden 期望输出
├── docs/FORMAT_SPEC.md             # 格式化行为唯一权威规范
└── test/golden_test.js             # golden 比对 + 幂等断言
```

## 本地运行（F5）

原生模块 `svtools.win32-x64-msvc.node` 不再随仓库提交（23MB 的二进制每次发版都会留在历史里），
首次 clone 必须先自备：

```bash
npm install
npm run build:native   # napi release 构建，并把 .node 复制到仓库根目录
npm test               # golden 用例全部通过再进宿主
```

不想装 Rust 工具链的话，从 GitHub Releases 下载对应 tag 的 `.node` 放到仓库根目录即可，
效果与 `build:native` 相同。

然后按 `F5` 启动扩展开发宿主，在宿主窗口打开任意 `.sv`/`.v` 文件：

- `Shift+Alt+F` 格式化文档
- `Ctrl+Shift+C` 生成模块例化、`Ctrl+Shift+T` 生成 testbench、`Ctrl+Shift+X` 对齐选中文本

## 格式化改动的验证方式

`docs/FORMAT_SPEC.md` 是格式化行为的唯一定义，实现与它冲突时先修实现；规范本身有问题则先改规范、附 golden 用例，再改实现。

`npm test` 对 `example/*.sv` 逐个断言两件事：输出与 `example/target/` 一致；对 target 再格式化一次仍是 target（幂等）。

新增用例：把最小复现放进 `example/`，用 CLI 生成后再人工校对，最后固化到 `example/target/`：

```bash
src-rust/target/release/svtools.exe example/ex15_new_case.sv > example/target/ex15_new_case.sv
npm test
```

## 打包与发布

```bash
npm run package        # 生成 svtools-<version>.vsix（打包前自动跑 npm test）
```

安装产物验证：宿主窗口里 `Extensions → … → Install from VSIX`，或
`code --install-extension svtools-<version>.vsix`。

发布流程见 [PUBLISH.md](PUBLISH.md)。

## 排查

**"svtools native module not loaded" / Cannot find module**
根目录缺少与当前平台匹配的 `.node`。Windows x64 需要 `svtools.win32-x64-msvc.node`，
执行 `npm run build:native` 生成；`.vsix` 里已含该文件，说明安装本身没问题。

**格式化没有生效**
确认文件语言模式是 Verilog / SystemVerilog，再看输出面板的报错。

**仿真/lint 秒退且无 stderr（exit 0xC0000135）**
装的是 Cygwin 构建的 Icarus Verilog 且 `cygwin1.dll` 不在 PATH 上。用
`svtools.iverilog.cygwinPath` 指向 cygwin 的 bin 目录（例如 iverilog 装在非 Cygwin 根时，
指向其兄弟目录 `cygwin64/bin`）。

**波形没自动打开**
仿真需产出 `.vcd`；`svtools.iverilog.autoOpenWaveform` 默认开启，设置了
`svtools.iverilog.waveViewer` 时改走外部查看器（`.fst` 等格式也走外部）。
