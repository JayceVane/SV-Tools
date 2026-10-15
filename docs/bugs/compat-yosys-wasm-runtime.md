# compat-yosys-wasm-runtime

> **发现方式**：GitHub Actions真实Node20的内置编译回归失败。
> **定位耗时**：跨两次验收。
> **修复位置**：`src/circuit/yosys-wasi.js`、`package.json`、`.github/workflows/ci.yml`。

## 症状

```text
WebAssembly.compile(): invalid value type 'noexternref', enable with --experimental-wasm-gc @+84
```

本地Node24通过，CI只有两条真实内置Yosys测试失败，其余电路合同通过。

## 排查过程

- 原先使用`npx --package=node@20 node`，误以为已切换运行时。打印`process.execPath`和`process.versions`才发现仍调用系统Node24；之前Node16/20的通过记录无效，已撤回。
- 在被忽略的`bin/runtime-compat`下载明确版本的`node-win-x64`二进制，直接执行，无安装脚本、无系统环境修改。Node20.20.0稳定复现CI错误。
- Node22.21.1真实编译通过，但22.15.1继续失败，错误变为`invalid value type 'exn', enable with --experimental-wasm-exnref @+84`。两者虽然同为V8 12.4，回移特性开关不同，不能只比较Node主版本或V8主版本。
- Node22.20.0与24.17.0通过两个前端的真实流程，包含宏、相对readmem、中文/空格路径和源位置回映射。

## 根因

固定YoWASP0.68.1207原始WASM使用异常引用类型。旧V8无法识别该类型，较早Node22虽识别但默认关闭。Electron自带的V8又与同名Node版本不同，桌面测试不能直接证明远程扩展宿主兼容。

## 修复

- 保留固定工具与原始二进制，不切换实验性V8开关，不跳过编译用例。
- 最低VS Code从1.74提高至1.106；其[源码Node基线](https://github.com/microsoft/vscode/blob/1.106.0/.nvmrc)为22.20.0。开发基线使用实测22.20.0，CI同时覆盖22/24，发布构建采用22。
- 捕获`WebAssembly.CompileError`，保留Node/V8身份和原始错误，并提示升级或配置外部Yosys。完整日志仍由任务管理器落盘。
- 电路测试脚本每次记录实际可执行文件与Node/V8版本。旧VS Code可继续安装4.0 preview。

## 教训

运行时兼容必须直接执行目标二进制并记录身份；npx包参数不等于实际已切换。最低宿主版本必须同时考虑Electron与远程Node，且用真实编译验证，不能只测试模块导入。
