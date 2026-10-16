# 4.1.0-alpha7：正确表达触发器符号

2026-10-16。独立分支`codex/feat-circuit-viewer`，继续[草稿PR11](https://github.com/JayceVane/SV-Tools/pull/11)；原工程保持4.0 preview，不合并或发布Release。

## 用户问题与修正

用户sync_resetn的原网表连接正确。真实内置Slang/Yosys生成一个$aldff：D=1，AD=0，CLK接i_clk且上升沿触发，ALOAD接i_rst_n且低电平有效。此RTL为一级寄存器，复位低时异步清零，复位释放后下一上升沿输出1。

原绘图仅凭register类别，在左下角固定画时钟三角；既没有传递极性，又将所有端点画成空心圆。现在以原始类型/参数生成纯展示语义，时钟三角对齐真实CLK，下降沿和低有效控制使用空心气泡，普通端点采用连续直线。节点拓宽至至少196以完整容纳ALOAD且不与DFF符号重叠；原引脚名、工具类型和连接保持。

点击引脚可看触发沿、控制极性及装载数据，点击单元可看原工具参数。参数展示最多32项、值256字符，完整数据留在模型/网表。缺失或非法极性加问号并显示未知；不凭名称推断Vivado和未知门级单元。LATCH/SR/隐式全局时钟FF使用各自符号；$adlatch分类补齐。

[语义依据：Yosys寄存器内部单元](https://yosyshq.readthedocs.io/projects/yosys/en/latest/cell/word_reg.html)。$aldff即使AD为常量0，也保留异步装载原型，不冒充工具生成的$adff。

## 验证与边界

| 检查 | 结果 / 本地证据 |
|---|---|
| JS语法 | 152文件；bin/circuit-alpha7-package.log |
| Golden | 38/38，19用例 |
| 既有Node | 512项：511通过、1可选目录重建跳过 |
| 电路Node | 147/147，新增9项 |
| Rust | 121/121；bin/circuit-alpha7-rust.log |
| 用户实际RTL | 内置Slang→Yosys→Worker→ELK，6节点/5连线，原源码SHA256不变；bin/circuit-alpha7-user-register.log |
| 解包后Qoder | Node24.15.0/Electron42.2.0的实际运行时执行编译、Worker/ELK、符号元数据及formatText ABI；bin/circuit-alpha7-qoder-packaged-final.log、qoder-native.log |
| 正式页面浏览器 | Edge155隐藏独立profile，浅深主题、时钟几何、无标签重叠、气泡选择和空心状态通过；bin/circuit-alpha7-packaged-browser.log |
| 大图交互 | 2000节点/5994边，活动DOM1539；拖拽/缩放帧中位16.7ms、P95约16.7/16.8ms，选择处理0.3ms；取消拖动、屏外搜索、网络点击通过；bin/circuit-interaction/alpha7-2000.json |
| 依赖与质量 | 无循环依赖；新语义模块MI 36.08、最大CC5、无热点。renderer原有renderGraph的CC19与alpha6相同，未宣称整目录通过所有质量阈值 |
| 远程CI | Node22/24矩阵，最终状态见草稿PR11 |

浏览器基准是合成事件测量，本轮机器调度与旧基准不同，不作为新增性能提升承诺。Qoder使用Electron的Node运行时模式，浏览器使用正式页面内容；这些不等于完整IDE Webview宿主验收，本轮未运行完整IDE UI。

截图：bin/circuit-interaction/alpha7-packaged-register.png（浅色）、alpha7-packaged-register-dark.png（深色选中）。真实截图同时发现并修复ELK外边缘与端口中心混用造成的短线间隙。

## 安装包

`bin/svtools-4.1.0-alpha7-win32-x64.vsix`。442文件、18,521,693字节，426个运行文件逐字节一致，证据为bin/circuit-alpha7-package-report.json。

SHA256：`00737e7311cbc9ef9c754cef0c9176f4ef5e15644ddb8cb2e95ef8a86f4e132c`。

安装后重载窗口，重新生成电路即可使用新符号。完整模型保留所有真实位连接，未修改用户RTL、设置及XPR。

## 完整文件清单（相对alpha6）

| 文件 | 修改 |
|---|---|
| `ARCHITECTURE.md` | 新增时序展示语义模块的职责边界 |
| `CHANGELOG.md` | alpha7问题、修复与影响面 |
| `CONTEXT.md` | 本轮验证结果和后续交接 |
| `README.md` | 版本同步及寄存器符号能力说明 |
| `docs/CIRCUIT.md` | 时序符号、未知极性和工具边界 |
| `docs/ROADMAP.md` | 同步当前完成进度 |
| `docs/V4_1_ALPHA7.md` | 交付结果、证据和完整文件清单 |
| `docs/bugs/logic-circuit-register-symbol.md` | 记录错误时钟位置、空心端点和ELK锚点排查 |
| `package.json` | 扩展版本alpha7 |
| `package-lock.json` | 扩展锁版本同步 |
| `src/native/Cargo.toml` | 原生crate版本alpha7 |
| `src/native/Cargo.lock` | 原生锁版本同步 |
| `src/native/package.json` | 原生npm版本alpha7 |
| `src/native/package-lock.json` | 原生npm锁版本同步 |
| `src/circuit/adapters/yosys.js` | 将$adlatch正确归类为寄存器 |
| `src/circuit/register-symbol.js` | 按明确Yosys单元/参数解释时钟、控制、数据语义 |
| `src/circuit/projection.js` | 携带时序语义与原参数，预留控制标签空间 |
| `src/circuit/renderer.js` | 实际时钟位置、极性气泡与连续引脚线 |
| `src/circuit/client.js` | 有界参数展示及引脚语义详情 |
| `src/circuit/view.css` | 区分直线端点与气泡，选中仍保持空心 |
| `test/circuit_symbols_test.js` | 5项参数、类型、真实ELK及连接保真回归 |
| `test/circuit_view_test.js` | 4项绘图/选择/端点/参数截断回归及既有命中适配 |

安装包、原生二进制、真实编译日志、截图和基准数据均在已忽略的bin/中，不提交。没有新增依赖或修改打包资源白名单。
