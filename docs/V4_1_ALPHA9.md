# 4.1.0-alpha9：单比特与多比特总线

2026-10-16。独立`codex/feat-circuit-viewer`分支，继续[草稿PR11](https://github.com/JayceVane/SV-Tools/pull/11)；原工程保持4.0 preview，不自动合并或发布Release。

## 显示与交互

单比特线1.3px、多比特线2.8px，选中/悬停/搜索时分别2.7px和4.2px。线宽使用non-scaling-stroke，多比特端点同步加粗。顶层I/O双行显示名称与实际位数；不根据名称里的方括号猜测向量，也不伪造声明范围。

总线在可读长段显示斜杠和位宽数字，点击数字或斜杠可选中对应网络。文字使用轻轮廓衬底，没有方形背景。标记位置避让单元/标题与其他标签，紧凑视图隐藏数字，总览隐藏装饰并保留粗细差异。短线或空间不足时仍保留粗线、悬停提示和详情位宽。

位宽来自当前路由或端口自身bits。真实32位端口可有8/24两组分支，不能把32写到每条切片上；重复常量也可能以单比特源驱动多比特端口。本层不修改连线、位序、分组或工具数据。

## 几何与性能

ELK有浮点近似正交段和冗余共线折点。纯几何层以1e-6容差处理，在原路由上选择长段中点/四分点，以稀疏网格避让。renderer和视口索引共用同一Map，避免高倍率只剩标记可见时被中心线裁剪移除。平移、缩放和选择不重新布局标记。

同机Edge155、相同脚本、32位数据、2000节点/5994连线、75%起始倍率：

| 指标 | alpha8 | alpha9 |
|---|---:|---:|
| 首次绘制 | 129.7ms | 252.9ms |
| 活动DOM | 1539 | 1743 |
| 可见总线标记 | 0 | 68 |
| 拖拽帧中位/P95 | 16.7/16.8ms | 16.7/16.8ms |
| 缩放帧中位/P95 | 16.7/16.8ms | 16.7/16.8ms |
| 选择处理中位 | 0.3ms | 0.3ms |

新增装饰有初始化成本。以上为本机合成事件基准，不承诺任意图或宿主60fps。取消拖动、屏外搜索、网络点击、深色主题也通过。证据位于bin/circuit-interaction/alpha8-bus32-2000.json和alpha9-bus32-2000-final.json。

复验：`node scripts/benchmark-circuit-interaction.js --nodes 2000 --bus-width 32 --label bus32 --acceptance`。`--bus-width`范围1..64，默认仍为1，可用`--extension-root`加载其他已解包版本进行对照。

## 验证与交付

| 检查 | 结果 / bin本地证据 |
|---|---|
| JS语法 | 152文件；circuit-alpha9-package.log |
| Golden | 40/40，20用例，含generate后例化对齐 |
| 既有Node | 516项：515通过、1可选目录重建跳过 |
| 电路Node | 154/154，新增7项 |
| Rust | 125/125；circuit-alpha9-rust.log |
| Node22.20相关回归 | 46/46；circuit-alpha9-node22.log |
| 真实工具数据 | 内置Slang/Yosys→Worker/ELK，10节点/12连线，1/8/24/32位组 |
| 解包后Qoder | Node24.15.0/Electron42.2.0实际运行时编译/布局并加载native ABI；circuit-alpha9-qoder.log、qoder-native.log |
| 正式页面浏览器 | Edge155，浅深主题、普通/选中线宽、标签点击、无文字遮挡、紧凑/总览、适配恢复；circuit-alpha9-packaged-browser.log |
| 依赖与质量 | 无循环依赖；viewport最大CC11、renderer最大CC18。既有目录仍有复杂度热点，未宣称整体质量门槛全部通过 |
| VSIX | 442文件、18,526,011字节，426运行文件逐字节一致；circuit-alpha9-package-report.json |
| 远程CI | Node22/24矩阵，最终状态见草稿PR11 |

Qoder使用Electron的Node运行时模式，浏览器加载包内正式页面；这些不等于完整IDE Webview宿主验收。截图为bin/circuit-interaction/alpha9-packaged-bus.png及alpha9-packaged-bus-dark.png。原用户RTL与原工程没有写入。

安装包：`bin/svtools-4.1.0-alpha9-win32-x64.vsix`。安装后重载窗口，重新生成电路。

SHA256：`9b82152a56ac8ebab43b96fcb7d18b9a64caf71b9392cfdf71fa05c115dd09b3`。

## 完整文件清单（相对alpha8）

| 文件 | 修改 |
|---|---|
| `ARCHITECTURE.md` | 标记纯几何、共享Map与裁剪职责 |
| `CHANGELOG.md` | alpha9行为、原因与影响面 |
| `CONTEXT.md` | 本轮实测及后续交接 |
| `README.md` | 版本和总线查看能力 |
| `docs/CIRCUIT.md` | 线型、位宽、切片和缩放操作说明 |
| `docs/ROADMAP.md` | 同步alpha9进展 |
| `docs/V4_1_ALPHA9.md` | 交付数据、边界与完整清单 |
| `docs/bugs/logic-circuit-bus-labels.md` | 浮点段、重合标签与裁剪根因 |
| `package.json` | 扩展版本alpha9 |
| `package-lock.json` | 扩展锁版本同步 |
| `src/native/Cargo.toml` | 原生crate版本alpha9 |
| `src/native/Cargo.lock` | Rust锁版本同步 |
| `src/native/package.json` | 原生npm版本alpha9 |
| `src/native/package-lock.json` | 原生npm锁版本同步 |
| `scripts/benchmark-circuit-interaction.js` | 新增可选1..64位总线场景及标记计数 |
| `src/circuit/projection.js` | 多比特I/O双行空间，保持位元数据 |
| `src/circuit/renderer.js` | 粗端点、I/O位宽、总线斜杠与数字，复用标记Map |
| `src/circuit/viewport.js` | 容差/共线几何、标记网格避让与共享裁剪边界 |
| `src/circuit/view.css` | 普通/选中/搜索线宽、文字轮廓、图例和缩放细节 |
| `src/circuit/view.js` | 增加单比特和总线图例 |
| `test/circuit_layout_test.js` | 多比特端口空间及名称误判回归 |
| `test/circuit_view_test.js` | 位宽、点击、虚拟化、浮点、避让及高倍率裁剪回归 |

安装包、原生模块、生成电路、截图和基准证据均位于已忽略的bin/，不提交。
