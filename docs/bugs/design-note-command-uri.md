# 设计笔记的悬停命令未打开

4.3.0-local.1 能识别合法的折叠标记并显示「打开或创建笔记」，点击后可能没有反应。用用户提供的 RTL 副本在隔离 VS Code 宿主复现。

悬停命令将已经转义过的文件 URI 放入 JSON 参数。VS Code 解析命令 URI 后，命令打开器还会尝试解码查询串。Windows 盘符等转义字符发生变化，扩展的文档身份校验因此提前返回。编辑器右键还可能传入一个资源 URI，需要按编辑器光标所在行处理。

悬停链接现在传递可安全重复解码的文档标识，并继续校验文档版本和行号。右键携带的资源 URI 由独立分支处理。宿主回归使用含空格、中文、百分号和井号的文件名，按实际查询解码流程调用悬停命令，并验证右键命令的资源参数。见 [宿主测试](../../test/vscode_design_notes_host.js) 和 [VS Code 命令打开器](https://github.com/microsoft/vscode/blob/main/src/vs/editor/browser/services/openerService.ts)。
