# 开发环境与本地安装

本说明对应4.0.0源码开发与本地安装。用户安装包及图文操作见[GitHub Wiki](https://github.com/JayceVane/SV-Tools/wiki)；源码开发建议使用独立worktree、依赖与Rust构建缓存。

## 技术方向

扩展使用 CommonJS 连接 VS Code 与 Rust napi 核心。源码统一放在 src/，可发布的原生模块和 CLI 统一输出到 bin/。工具链各自构造参数和解析诊断，共享进程生命周期管理。

## 实现愿景

保留 3.x 的格式化、代码智能、代码生成、Icarus/Vivado 工具链和 VCD 界面；通过 golden、词法保真、配置和工具运行合同验证重构，在 VS Code 中按原快捷键和命令使用。

## 前置条件

- 开发构建使用Node.js 22.20.0+（CI覆盖22/24）、VS Code 1.106.0+；仅安装VSIX无需自行安装Node.js或Rust
- 修改或构建 Rust 核心需要 cargo
- Icarus 和 Vivado 为可选的外部工具，沿用 svtools.iverilog.* / svtools.vivado.* 设置

## 项目结构

```text
02_svtools/
├── extension.js                 # VS Code 公开入口
├── src/
│   ├── extension.js             # Provider、命令与工具链装配
│   ├── configuration.js         # VS Code → napi 配置适配
│   ├── native-loader.js         # bin/ 平台产物加载
│   ├── editor/                  # 格式化适配、命令、语言 Provider
│   ├── workspace/               # 共享设计单元索引
│   ├── toolchains/              # Icarus、xvlog 与共享进程执行器
│   ├── waveform/                # VCD parser、HTML view 与 VS Code 集成
│   ├── vivado/                  # TCL、工程树、器件与报告
│   └── native/                  # Rust 源码、napi 绑定与 CLI
├── bin/                         # svtools.<platform>.node 和 svtools(.exe)
├── scripts/                     # 构建、JS 语法检查
├── example/                     # golden 输入与 target 期望输出
├── test/                        # 格式化、工具进程和波形合同
└── docs/FORMAT_SPEC.md           # 格式化行为规范
```

## 构建与验证

```bash
npm install
npm run build:native
npm test
cargo test --manifest-path src/native/Cargo.toml
```

已有依赖时直接构建即可。构建脚本先执行 napi release 构建，再构建 CLI，将当前平台产物复制到 bin/；Rust 中间产物在 src/native/target/。无需 Rust 时可从对应版本 Releases 下载平台 .node 到 bin/；加载器会显示实际缺失或 ABI 错误和路径。

npm test 依次运行 JS 语法检查、golden 输出与幂等断言、完整格式化合同、工具链运行与 VCD 解析测试。

## VS Code 本地运行

按 F5 启动扩展开发宿主。在宿主打开 .sv/.v 文件，Shift+Alt+F 格式化，Ctrl+Shift+C 例化、Ctrl+Shift+T 生成测试台、Ctrl+Shift+X 对齐选区。开发宿主断点使用 src/**/*.js。

新增格式化样例时，把最小输入放在 example/，生成后人工检查期望输出，再运行完整测试：

```bash
bin/svtools.exe example/new_case.sv > example/target/new_case.sv
npm test
```

## 打包

```bash
npm run package
```

VSIX 包含根入口、src/ 的 JavaScript、语法/模板资源和 bin/*.node；Rust 源代码、中间构建产物、CLI、测试与开发脚本不会进入扩展包。安装产物后验证编辑器命令、工具链状态栏、Vivado 活动栏与波形查看器。发布流程见 PUBLISH.md。

## 常见问题

- 原生模块加载失败：检查报错中的 bin/ 文件名，执行 npm run build:native 后重新加载窗口。
- 格式化没有生效：确认语言模式为 Verilog/SystemVerilog，再检查扩展宿主日志。
- Icarus 秒退且无 stderr：Cygwin 构建需要 cygwin1.dll，用 svtools.iverilog.cygwinPath 指向其 bin 目录。
- 波形未打开：仿真需生成 .vcd，并启用 svtools.iverilog.autoOpenWaveform；设置 waveViewer 时走外部查看器。
