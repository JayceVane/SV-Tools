# perf-circuit-svg-interaction

> **发现方式**：用户反馈“拖拽、缩放或选择时卡顿”。
> **定位范围**：2026-10-16本轮浏览器基准与三次实现对照。
> **修复位置**：`src/circuit/client.js`、`renderer.js`、`graph-index.js`、`viewport.js`。

## 症状

2000节点、5994连接、每节点2引脚的已布局图，在本机Edge155隐藏页面中连续输入：

```text
before.zoom.frame.medianMs = 250.29999999999927
before.zoom.handler.medianMs = 150.69999998807907
before.domElements = 54646
```

## 排查过程

- 用户明确慢在拖拽、缩放和选择，因此先固定布局结果，排除Yosys和ELK对测量的干扰。
- 旧代码每次滚轮调用`getBoundingClientRect()`，随后直接写`transform`；同一帧多次输入交替读写，引发同步布局成本。
- 首次改为rAF合并与`display:none`裁剪，缩放帧中位数降到约62.5ms，但输入处理仍约35.4ms。缓存视口几何后，输入处理降到约0.1ms，帧耗时仍约62.4ms，说明还有浏览器渲染成本。
- 将屏外对象移出活动SVG后，相同图只挂载1558个SVG元素；缩放帧中位数约31.2ms。对象及拓扑索引仍完整保存。
- 旧选择循环扫描所有边、引脚和节点；改用网络/端口邻接索引与差集高亮，并复用详情索引，选择处理中位数从2ms降到约0.3ms。

## 根因

输入事件频率超过帧提交频率，重复变换和同步几何读取放大开销；大量屏外SVG仍留在活动DOM。选择的工作量又随整张图而非实际关联对象增长。透明命中线、非缩放描边和文字使缩放比单纯平移更敏感。

## 修复与边界

相机在rAF提交，几何只在布局变化时读取。静态包围盒树先筛选视口候选，再以折线段排除空包围盒；端点均在屏外但穿过视口的连线必须保留。保留100px过扫描与节点标签边界，避免边缘跳出。屏外DOM移出后仍保留身份、选择和原始绘制顺序。

低倍率简化不可读细节，正常倍率恢复。拓扑/搜索/别名索引每模块只建一次，选择仅更新变化对象。回归覆盖取消、换图、销毁、缩放锚点、手动相机resize及屏外搜索。

完整网表和屏外DOM仍在内存，未实现领域数据分页或逻辑锥。全图适配时可能挂载大部分对象，不能从局部视口基准推导任意图的性能；预算仍为2000节点/6000连接。本机rAF采样约31ms，不能据此宣称60fps。浏览器替代桥不能计作真实IDE宿主验收。

## 复验

```powershell
node scripts/benchmark-circuit-interaction.js --label current --nodes 2000 --acceptance
node scripts/benchmark-circuit-interaction.js --label old --extension-root <旧VSIX解包目录>
node --test test/circuit_view_test.js test/circuit_viewport_test.js
```

原始记录位于`bin/circuit-interaction/`；汇总与版本边界见`docs/V4_1_ALPHA5.md`。
