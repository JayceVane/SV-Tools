'use strict';

// 工具快照和依赖目录不能进入设计单元或补全索引。
const SOURCE_EXCLUDE_GLOB = '**/{.git,node_modules,.svtools,.Xil}/**';
module.exports = { SOURCE_EXCLUDE_GLOB };
