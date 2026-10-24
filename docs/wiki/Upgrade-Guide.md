# 从 3.x / preview / beta 升级

## 升级步骤

1. 记录工作区与用户级的 `svtools.*` 自定义设置。
2. 从[GitHub Releases](https://github.com/JayceVane/SV-Tools/releases)安装4.0.0的Windows x64 VSIX并重载窗口。
3. 在扩展详情确认版本，检查Verilog/SystemVerilog默认格式化器。
4. 重新打开VCD、重新生成电路。需要跨仿真复用显示状态时保存`.svwave.json`。
5. 检查工具路径，完成一次小文件格式化/仿真/电路生成后，再使用大工程。

3.x的常用快捷键和设置继续使用。4.0加入更严格的字符及词法保全：不能安全格式化时保留原文；部分不能忠实生成的复杂接口会明确报错，而不是输出缺端口的成功模板。

4.0.0高于4.0.0-preview/beta版本。曾装4.1.0-alpha的用户可能需要手动确认版本回退；4.0.0包含此前纳入本轮的电路开发成果。

## 需要注意的变化

- VS Code最低版本为1.106.0；离线Yosys的WASM需要相应的新宿主，旧版兼容IDE可能不满足。
- 默认生成VCD测试台；FSDB/VPD/SHM依赖外部兼容仿真器，不代表内置查看器支持这些格式。
- 直接点击VCD默认打开波形；已有显式编辑器关联继续按用户设置。
- 仿真前自动关闭相关旧VCD标签，避免Windows写入被读取worker阻塞。
- 文件头新增UTF-8文件模板和多行控件；旧版已丢失的换行需重新粘贴。
- task/function默认值等号与标量/向量名称列统一；默认`portNameGap`为2。
- 总线收起保留子位局部配置，重新展开恢复；可用布局文件跨仿真复用。

## 当前范围

官方本轮交付为GitHub Release的Windows x64 VSIX和CLI。其他系统需自行构建匹配原生模块，并单独验证宿主和外部工具；不把Windows验收解释为跨平台保证。

内置波形只支持VCD；二维mem要求文件保留索引。补全不是完整编译器语义实现。Vivado电路当前是平坦RTL，专门的IP新增/定制面板仍在计划中。超大电路建议按模块查看。

[4.0发布说明](https://github.com/JayceVane/SV-Tools/releases/tag/v4.0.0) · [变更日志](https://github.com/JayceVane/SV-Tools/blob/v4.0.0/CHANGELOG.md)
