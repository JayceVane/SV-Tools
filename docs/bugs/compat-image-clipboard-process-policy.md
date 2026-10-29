# compat-image-clipboard-process-policy

> **发现方式**：用户新增图片复制后报告PowerShell调用失败，并反馈安全软件拦截。
> **定位耗时**：本轮通过原生解码、像素及Win32读回分层验证。
> **修复位置**：`src/graphics/image-files.js`、`clipboard.js`、`src/native/src/clipboard/`。
> **修复提交**：未提交。

## 症状

`电路复制失败：写入系统剪贴板失败：Command failed: ...powershell.exe -NoProfile -NonInteractive -STA -WindowStyle Hidden -Command Add-Type ... Clipboard]::SetImage(...)`

## 排查过程

1. 原实现先写临时PNG，再启动PowerShell加载Windows.Forms/System.Drawing，失败只返回子进程错误。
2. VS Code公开Clipboard接口仅提供文本读写；不把它当成图片API，也不假设扩展宿主能访问Electron内部模块。
3. 复用已有Rust/NAPI模块，在工作线程解码PNG和调用Win32，移除脚本进程及临时文件。
4. 核验Win32所有权规则：OpenClipboard必须提供有效owner窗口，提交内存必须为可移动HGLOBAL；
   SetClipboardData成功后内存归系统所有，不能由调用方释放。
5. 验证像素通道／上下方向／透明合成、截断PNG，以及真正的PNG/CF_DIB读回和占用重试。

## 根因与边界

图片复制依赖脚本宿主启动权限，扩大了一个简单剪贴板操作所需的运行条件。
用户给出的Command failed不能单独证明唯一失败原因；本次修复移除了这条外部进程依赖。
系统剪贴板权限或其它程序占用仍可能让原生API失败，不能承诺规避所有安全策略。

## 修复

JavaScript只校验载荷并调用异步NAPI接口；PNG解码成功、尺寸通过预算且内存准备完成后才打开剪贴板。
同时提交原始PNG和CF_DIB：PNG保留透明信息，传统位图将透明像素合成白底，以兼容常见图片粘贴目标。
打开重试10次、间隔20ms；工作线程执行，页面保持响应。不回退PowerShell或临时脚本。

## 教训

- 尽量复用项目已有原生边界来完成平台操作，避免以脚本进程充当系统API适配器。
- 剪贴板不是文件路径：必须验证格式、数据生命周期及目标程序可识别的位图表示。
