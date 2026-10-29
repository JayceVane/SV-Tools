# 工程菜单重复点击后仍保持打开

2026-10-29，用户反馈工程“…”和Vivado“查看报告”菜单再次点击入口后无法收起。
两个入口共用`src/project/client.js`的菜单：document的`pointerdown`先把入口视为外部区域而关闭，随后按钮的`click`又无条件打开。仅在click里添加开关判断仍会被这一顺序干扰。原页面测试只调用click，document事件未参与，因而漏掉真实鼠标链路。

现在按钮click按当前入口切换状态；外部pointerdown排除当前菜单按钮及其子元素，节点右键菜单仍按原规则处理。关闭统一清理入口和aria-expanded，Escape及执行动作按需恢复焦点；菜单已关闭时Escape不再聚焦旧入口，刷新或重绘清理失效菜单。节点右键重复打开不按按钮开关处理。

`test/project_client_test.js`补充pointerdown→click、子元素点击、键盘激活、入口切换、外部关闭、焦点和快照刷新；`test/project_view_test.js`检查菜单按钮ARIA合同。真实浏览器替换旧client确定性复现两个入口二次点击仍打开，修复后亮色320px、暗色320px和亮色240px三场景各7组行为检查通过、页面错误为零（`bin/project-menu-browser.json`）。完整npm test通过：公共783项、12可选跳过，电路247项；尚未提交。
