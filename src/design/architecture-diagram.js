'use strict';

// 架构图按阶段拆分：版式常量 → 拓扑 → 卡片度量 → 两遍排布 → ELK → 主布局 → SVG 渲染。
// 本文件只保留出口，调用方与测试仍从 architecture-diagram 取三个入口。
const { diagramTopology } = require('./architecture-topology');
const { layoutDiagram } = require('./architecture-layout');
const { renderDiagram } = require('./architecture-render');

module.exports = { diagramTopology, layoutDiagram, renderDiagram };
