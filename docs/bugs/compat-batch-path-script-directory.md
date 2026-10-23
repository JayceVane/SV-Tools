# compat-batch-path-script-directory

> **发现方式**：正式发布前远程CI，Windows Node22/24均在原生构建入口失败。
> **修复位置**：toolchains/process的batchInvocation与resolveBatchCommand。

## 症状

npm.cmd报告 `Cannot find module`，路径却是工程的 `src/native/node_modules/npm/bin/npm-cli.js`，而非Node安装目录。
本地从npm父进程启动可能成功，不能据此判断干净构建环境无问题。

## 排查

构造只在PATH中的sibling-probe.cmd，脚本用 `%~dp0` 查找兄弟文件，cwd设为另一目录。
原入口可以命中并执行脚本，但 `%~f0` 和 `%~dp0` 都错误地按cwd展开，退出37；绝对路径和显式相对入口则成功。
这与CI中的npm.cmd错误路径一致，排除了Rust编译器、源码语法、npm安装失败及依赖更新本身。

## 根因与修复

安全参数中转把命令作为引号内环境变量引用交给cmd。只有名称的BAT仍由PATH定位，但cmd保留的脚本名不能正确为 `%~dp0` 提供其实际目录。
现在先按调用cwd和实际环境的PATH顺序解析普通文件，固定绝对BAT入口，再进行同样的参数中转。
相对PATH项以调用cwd为基准，Windows Path键不区分大小写，目录不能伪装成可执行普通文件；缺工具明确ENOENT。
不修改npm构建脚本来掩盖通用启动器问题，也不移除百分号/感叹号参数保护。

## 验证

新增两项真实Windows回归在原实现均失败；修复后完整toolchain_test 25/25。
覆盖PATH-only、绝对/相对入口、兄弟文件、空格和%/!目录、Path大小写、引号及相对PATH项、搜索顺序、空参数和缺工具。
继续使用清理npm父环境变量的`node scripts/build-native.js`和远程Windows Node22/24构建验证。

教训：验证批处理边界时，应检查脚本自身定位与兄弟资源；只检查echo参数或已知绝对路径不够。
