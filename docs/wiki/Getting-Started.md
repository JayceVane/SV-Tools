# 安装与第一次运行

## 安装 4.1.0

先确认系统为 **Windows x64**，使用 VS Code 1.106.0 或更新版本；兼容 IDE 也需满足相同扩展宿主要求。当前正式维护这一平台。

| 安装渠道 | 操作 |
|---|---|
| [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=JayceVane.svtools) | 在 VS Code 扩展市场搜索 **SystemVerilog Tools**，确认发布者 **JayceVane** 后安装 |
| [Open VSX](https://open-vsx.org/extension/JayceVane/svtools) | 在使用 Open VSX 的兼容 IDE 中搜索同一扩展 ID 并安装 |
| [GitHub Releases](https://github.com/JayceVane/SV-Tools/releases/tag/v4.1.0) | 下载 `svtools-v4.1.0-win32-x64.vsix`，执行 **Extensions: Install from VSIX… / 扩展：从 VSIX 安装** |

市场版本以各详情页为准。本指南按 4.1.0 的界面说明；安装后执行 **Developer: Reload Window / 开发人员：重新加载窗口**，在扩展详情中核对版本和扩展 ID **`JayceVane.svtools`**。

只安装扩展不需要 Node.js、Rust、Python 或系统 PATH 中的 Yosys。发布附件中的 `svtools.exe` 是独立 CLI，使用编辑器扩展时不必单独安装。

需要核对下载完整性时，用 PowerShell 对附件求哈希，与同一 Release 的 `SHA256SUMS.txt` 比较：

```powershell
Get-FileHash .\svtools-v4.1.0-win32-x64.vsix -Algorithm SHA256
```

## 先完成一次格式化

打开项目文件夹，新建并保存 `demo.sv`：

```systemverilog
module demo(input logic a,b,output logic y);
assign y=a&b;
endmodule
```

确认右下角语言模式为 **SystemVerilog**，按 `Shift+Alt+F`。如安装了多个格式化器，在“使用…格式化文档”中选择 SV Tools。也可以显式设置：

```json
{
  "[systemverilog]": {
    "editor.defaultFormatter": "JayceVane.svtools",
    "editor.formatOnSave": true
  },
  "[verilog]": {
    "editor.defaultFormatter": "JayceVane.svtools",
    "editor.formatOnSave": true
  }
}
```

## 可选：完成一次仿真与波形查看

安装 Icarus Verilog 后，在设置中配置其 bin 目录，例如：

```json
{
  "svtools.iverilog.path": "C:/EDA/iverilog/bin"
}
```

保存下列文件为 `tb_smoke.sv`，保持它为当前文件，从命令面板执行 **Icarus Verilog: 运行仿真**：

```systemverilog
`timescale 1ns/1ps
module tb_smoke;
    reg clk = 0;
    always #5 clk = ~clk;
    initial begin
        $dumpfile("smoke.vcd");
        $dumpvars(0, tb_smoke);
        #100;
        $finish;
    end
endmodule
```

成功后默认打开新生成的 VCD。添加 `clk`，点击波形放置 A，按住 Shift 点击放置 B，再用“A ↔ B”适配区间。工具找不到或 Cygwin DLL 缺失时见[故障排查](https://github.com/JayceVane/SV-Tools/wiki/Troubleshooting)。

下面用包含更多信号的公开示例解释同一波形界面；数字依次标出信号搜索、A/B 读值、栏宽边界、时间导航和图片导出。

[![第一次观察波形时要找的五个入口](https://raw.githubusercontent.com/wiki/JayceVane/SV-Tools/images/waveform-workspace-4.1-light.png)](https://github.com/JayceVane/SV-Tools/wiki/Waveforms)

跟随 [波形图解](https://github.com/JayceVane/SV-Tools/wiki/Waveforms)尝试添加信号、展开总线、移动游标和导出，再处理自己的测试台。

## 查看一次电路

打开 `demo.sv`，点击编辑器右上角“查看 RTL 电路（Yosys）”。默认使用离线内置引擎；多模块文件按提示选择 Top。查看单元、端口和连线，并尝试工具栏“导出图片”。

从更大项目生成时，先阅读[依赖、包和 Top 配置](https://github.com/JayceVane/SV-Tools/wiki/Circuits)，避免把缺失模块误当作绘图错误。
