# logic-export-target-alias

> **发现方式**：4.1严重缺陷排查；仅在隔离夹具写入。
> **修复位置**：`workspace/export-target.js`、`waveform/layout-files.js`、`graphics/image-files.js`。
> **修复提交**：待提交后回填。

## 症状

布局保存仅检查目标不是当前VCD，未限制扩展名。将目标设为`design.sv`时实际进入writeFile，保护回归得到：

```text
AssertionError [ERR_ASSERTION]: Missing expected rejection.
```

图片和布局另只比较路径文本。给原VCD建立`.svg`或`.json`硬链接后，导出可以通过两个不同路径覆盖同一原文件；两个真实硬链接回归同样未触发预期拒绝。

## 排查与修复

先使用内存写入边界确认非JSON目标确实被接受，再在本仓库临时目录建立真实硬链接，确认同一物理文件会被写入，未操作用户文件。

布局保存增加`.json`后缀检查，保留`.svwave.json`和普通`.json`的原有兼容。
共享导出目标检查在写入前拒绝符号链接、多重硬链接和非普通文件；已有目标再通过realpath核对受保护输入，阻止目录别名绕过路径比较。

## 边界和教训

这是保存前的目标检查，不是对恶意进程在检查与写入之间替换文件的系统级防护。正常新文件和独立同格式文件仍按用户选择保存。文件对话框过滤器不是扩展名校验，路径不同也不等于物理文件不同。
