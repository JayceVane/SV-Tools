# 4.1 使用指南与 GitHub Wiki

线上入口：[SV Tools Wiki](https://github.com/JayceVane/SV-Tools/wiki)。

`docs/wiki/` 保存4.1.0指南源文件，含首页、安装、升级、格式化、生成、补全、工具链、波形、电路、配置/命令参考和排错，以及GitHub的侧栏与页脚。页面名采用稳定英文标识，正文为中文。

维护时先按package.json、实际命令和行为更新对应源文件，检查页面链接、JSON配置与关键操作，再同步到独立的SV-Tools.wiki.git仓库。不要删除Wiki中无关页面。发布版本的源码链接固定到对应tag；需要新增版本指南时同步更新页面适用版本和链接。

发布顺序：先同步并核对Wiki，再发布对应GitHub Release，验证下载附件、SHA256和版本。指南不宣称FSDB查看、完整标准语义或尚未交付的Vivado IP管理。
