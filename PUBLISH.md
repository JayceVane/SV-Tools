# 4.0 GitHub 发布

当前发布候选为 `4.0.0-beta.14`，仍使用独立预览号。完成源码修复、完整 Node/Rust 回归、真实工具与宿主验收、依赖审计和解包核对后，才评估正式 `4.0.0`。本轮审查不自动创建正式 tag 或公开 Release。

预览使用 `npm run package:preview`，要求干净源码提交、六处版本一致、原生 CLI 版本匹配；输出 VSIX 和包含 sourceCommit、大小、SHA256 的 manifest。同一版本不覆盖。构建机使用 Node 22 或更新版本，打包工具固定为 vsce 4.0.0；它不改变扩展宿主的 Node 要求。

正式发布时，在 PR 完成且使用者确认后，将六处版本统一为 `4.0.0`，更新发布说明、重建原生模块、重新跑验收并生成新的稳定安装包。不要将 beta 文件简单重命名为正式版。tag 必须指向已审查的源码；原生模块、CLI 和 VSIX 不进入 Git 历史。

`.github/workflows/release.yml` 校验 tag 与 package.json，构建 Windows x64 原生模块及 VSIX，执行 Node/Rust 回归并上传 SHA256 清单。含 `-` 的 tag 使用 GitHub prerelease，不改变稳定版 Latest。已有同名附件时上传失败，禁止 clobber。发布说明取 `docs/releases/<tag>.md`。

打包前执行根目录与 `src/native` 的 npm audit。netlistsvg 仅用于开发验证，其 JSON5/yargs 安全版本 override 需通过真实 `scripts/verify-circuit.js` 验证；生产视图使用独立模型与 ELK。不要用 `npm audit fix --force` 替代兼容性审查。

3.5.0 历史和稳定版附件继续保留。下文 Marketplace 为独立渠道的旧操作指南，本轮不执行。

---

# VSCode 插件发布指南

本文档说明如何将 SystemVerilog Tools（扩展 ID `svtools`）发布到 VSCode 应用市场。

---

## 前置准备

### 1. 准备 GitHub 仓库

**重要**：发布到 VSCode Marketplace 需要**公开的 GitHub 仓库**。

1. 在 GitHub 创建新仓库（如果还没有）
2. 将代码推送到 GitHub
3. 更新 `package.json` 中的仓库地址：

```json
"repository": {
  "type": "git",
  "url": "https://github.com/你的用户名/你的仓库名"
},
"bugs": {
  "url": "https://github.com/你的用户名/你的仓库名/issues"
},
"homepage": "https://github.com/你的用户名/你的仓库名#readme"
```

---

### 2. 注册 Publisher 账号

1. 访问 [VSCode Marketplace Publisher 管理](https://marketplace.visualstudio.com/manage)
2. 使用 GitHub 或 Microsoft 账号登录
3. 创建 Publisher（发布者）：
   - **Name**: `JayceVane`（或你喜欢的名称，一旦创建不能修改）
   - **Display Name**: JayceVane
   - **Description**: SystemVerilog 插件开发者
   - **Email**: JayceVane@163.com
   - **Website**: 你的 GitHub 个人主页或博客

4. 记录你的 Publisher 名称，发布时需要用到

---

### 3. 创建 Personal Access Token

1. 访问 [Azure DevOps](https://dev.azure.com/)
2. 登录后点击右上角头像 → User settings → Personal access tokens
3. 点击 "New Token"
4. 填写信息：
   - **Name**: VSCode Marketplace Publishing
   - **Organization**: (选择你的组织或所有可访问组织)
   - **Scopes**: 选择 "Marketplace" → "Manage"
5. 创建后**立即复制并保存** Token（只显示一次！）

---

## 安装 vsce 工具

vsce (Visual Studio Code Extensions) 是官方的打包和发布工具。

```bash
# 使用 npm 安装
npm install -g @vscode/vsce

# 验证安装
vsce --version
```

---

## 打包插件

在仓库根目录运行：

```bash
npm install          # 只装 vsce 等打包依赖
npm run build:native # 构建当前平台 .node 与 CLI 到 bin/
npm run package      # vsce package，打包前自动跑 npm test
```

VSIX 运行时包含 `src/` JavaScript 与 `bin/*.node`，`.vscodeignore` 排除 Rust 源码和中间产物；Release 单独附加 `bin/svtools.exe`。

成功后生成 `svtools-<version>.vsix`（完整测试未通过时打包会中止）。

---

## 本地测试

在发布前，建议先本地测试 .vsix 文件：

1. 打开 VSCode
2. 按 `Ctrl+Shift+P` 打开命令面板
3. 输入 "Install from VSIX..."
4. 选择生成的 `svtools-<version>.vsix` 文件
5. 重新加载窗口
6. 测试插件功能是否正常
7. 检查图标是否正确显示

---

## 发布到 Marketplace

### 方法一：命令行发布（推荐）

```bash
# 打包前会自动执行 npm test（golden、格式化和工具链合同），失败即中止
vsce publish

# 或指定版本递增（当前版本见 package.json）
vsce publish patch   # 3.4.6 -> 3.4.7
vsce publish minor   # 3.4.6 -> 3.5.0
vsce publish major   # 3.4.6 -> 4.0.0
```

根据提示输入：
- **Publisher Name**: 你创建的 Publisher 名称（如 `JayceVane`）
- **Personal Access Token**: 上一步创建的 Token

### 方法二：手动发布

1. 访问 [VSCode Marketplace Publisher](https://marketplace.visualstudio.com/manage)
2. 选择你的 Publisher
3. 点击 "Publish Extension"
4. 上传 `svtools-<version>.vsix` 文件
5. 填写扩展信息（会从 package.json 自动读取）
6. 点击 "Upload" 发布

---

## 发布后验证

1. 访问 [VSCode Marketplace](https://marketplace.visualstudio.com/)
2. 搜索 "SystemVerilog Tools"
3. 检查插件页面显示是否正确：
   - ✓ 图标显示正确
   - ✓ 名称和描述正确
   - ✓ README.md 内容显示
   - ✓ 版本号正确
4. 在 VSCode 中搜索并安装测试
5. 检查统计信息（下载量、评分）

---

## 发布到 Open VSX（可选）

Open VSX 是 Eclipse Foundation 维护的开源替代市场，兼容 VSCode。

```bash
# 安装 ovsx 工具
npm install -g ovsx

# 发布到 Open VSX
ovsx publish
```

访问 [Open VSX Gallery](https://open-vsx.org/) 查看你的插件。

---

## 更新插件

### 修改代码后更新

1. 修改 `package.json` 中的版本号（并同步 `src/native/Cargo.toml`、`src/native/package.json` 与 CHANGELOG.md）：
   ```json
   "version": "2.0.1"  // 根据修改类型递增
   ```

2. 重新打包：
   ```bash
   vsce package
   ```

3. 发布新版本：
   ```bash
   vsce publish
   ```

### 版本号规则（语义化版本）

- `2.0.0` → `2.0.1`: **Patch** - 修复 Bug，向后兼容
- `2.0.0` → `2.1.0`: **Minor** - 新增功能，向后兼容
- `2.0.0` → `3.0.0`: **Major** - 破坏性变更

---

## 常见问题

### Q: 发布失败提示权限错误
**A**: 检查 Token 是否正确，确保 Token 有 "Marketplace" 权限。

### Q: 图标不显示
**A**:
1. 确保 `icon.png` 在仓库根目录
2. 确保 `package.json` 中有 `"icon": "icon.png"`
3. 重新打包并发布

### Q: README 格式混乱
**A**: Marketplace 使用 GitHub 风格的 Markdown，检查格式是否正确。

### Q: 如何删除已发布的插件
**A**: 访问 [Publisher 管理](https://marketplace.visualstudio.com/manage)，找到插件后删除。

### Q: Publisher 名称选错了能改吗
**A**: Publisher 名称一旦创建不能修改。可以创建新的 Publisher，使用新名称发布。

---

## 资源链接

- [VSCode Extension API](https://code.visualstudio.com/api)
- [Publishing Extensions 官方文档](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [vsce 工具 GitHub](https://github.com/microsoft/vscode-vsce)
- [Open VSX](https://open-vsx.org/)

---

## 快速发布检查清单

发布前确认：

- [ ] GitHub 仓库已公开
- [ ] `package.json` 中的 repository URL 已更新
- [ ] 图标文件 `icon.png` 存在（256x256 PNG）
- [ ] README.md 内容完整
- [ ] CHANGELOG.md 已更新
- [ ] 版本号正确
- [ ] Publisher 已创建
- [ ] Personal Access Token 已获取
- [ ] 本地测试通过（`npm test`：golden 用例 + 幂等断言）
- [ ] .vsix 文件生成成功

准备就绪后，运行：

```bash
vsce publish
```

祝发布顺利！🎉
