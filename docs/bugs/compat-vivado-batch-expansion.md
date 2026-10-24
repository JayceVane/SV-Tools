# compat-vivado-batch-expansion

> **发现方式**：4.0发布审查，合法特殊路径实测。
> **定位耗时**：本轮集中排查。
> **修复位置**：toolchains/process、vivado/batch。

## 症状与排查

路径 `project%SVTOOLS_AUDIT_TOKEN%/run.tcl` 传给BAT后变为 `projectexpanded/run.tcl`。
最初只给参数加双引号，但cmd在引号内仍展开百分号变量。
改为固定随机变量名经环境传值后，简单echo BAT逐字保真；真实Vivado仍失败。
继续读取厂商脚本，发现vivado.bat内部CALL loader.bat，loader又启用delayed expansion，重新解释了 `%ENV%` 和 `!var!`。

## 修复

通用启动器使用固定变量引用、参数数组和 `/v:off`，拒绝无法安全传递的双引号及控制字符。
Vivado适配器在受控私有临时目录创建ASCII桥接Tcl，仅向厂商BAT传安全桥接路径。
真实source与cwd用环境变量传入，桥接在Tcl内执行 `cd` 和 `source -encoding utf-8`。
成功、失败、取消、启动异常均清理桥接目录，日志仍在原任务目录。
安装目录或额外BAT参数含无法保真的 `%/!` 时明确停止；不能保证任意第三方BAT内部不再次解析。

## 验证与教训

真实Vivado2022.1.2中，source和cwd同时含百分号变量形式、感叹号、空格、&和括号，Tcl收到原路径与原argv。
真实错误与取消都返回正确状态且删除私有桥接；Node回归覆盖启动异常清理。
不要仅凭echo脚本推断厂商包装脚本的端到端传参语义。
