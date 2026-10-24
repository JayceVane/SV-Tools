# compat-vsce-msal-auth-dependency

> **发现方式**：4.0.0正式发布前重新执行npm audit，根目录2项high，native为0。
> **修复位置**：`package.json` overrides、`package-lock.json`。

## 症状与排查

依赖路径为`@vscode/vsce@4.0.0 -> @azure/identity@4.14.0 -> @azure/msal-node@6.0.1`。
[GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5)影响MSAL5/6的授权码流程，7.1.0及以后修复。
现有Azure Identity仍声明MSAL6，`npm audit fix --dry-run`没有可直接应用的变更。
没有强行替换MSAL7，以免绕过SDK主版本兼容边界。

## 修复与取舍

固定Identity4.13.0，回到未受此通告影响的MSAL3。首次审计仍出现uuid旧版本的边界检查通告，
于是仅在该MSAL子树中使用修复后的CommonJS版本uuid11.1.1，避免全工程覆盖。
两个override都明确记录在锁文件。Identity版本低于vsce声明范围，不能把API形状相同解释为所有认证功能都已验证。

确认vsce实际使用的6个Credential接口存在，认证模块可加载；MSAL本地构造和缓存、uuid v4工作。
全过程不获取云token、不执行Marketplace发布。本轮实际使用路径为VSIX打包及GitHub Release，真实打包继续复验。
根目录与native的npm审计均为0；VSIX通过排除node_modules保持这些依赖仅用于开发构建。

## 教训

依赖审计必须与具体时间和锁文件绑定。修复一个主通告后仍需检查旧兼容分支的传递依赖，
也要说明override越过的上游范围及尚未测试的认证路径。上游修复发布后应移除临时约束并重验。
