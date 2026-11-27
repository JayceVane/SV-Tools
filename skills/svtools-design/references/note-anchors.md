# 富文本 Note 与源码锚点

## 源码注释

| 格式 | 用途 |
| --- | --- |
| `//: 标题 [note:nt_reset]` | 悬停在标记行预览绑定的笔记。 |
| `//< 标题 [note:nt_write]` 与 `//>` | 绑定折叠区，在起始行预览笔记。折叠区可以嵌套。 |
| `/** Markdown 内容 */` | 直接预览注释里的 Markdown 正文。这里的 `[note:ID]` 只是正文。 |

`//:`、`//<` 和 `//>` 各占一行，允许前导缩进。`//:` 和 `//<` 后留空格再写标题，`[note:ID]` 前留空格并放在行尾。结束行只写 `//>`。

`[note:nt_reset]` 对应工作区中的 `docs/design-notes/nt_reset.svnote.md`，正文可在编辑器中通过「用富文本编辑设计笔记」编辑。ID 匹配 `[a-z0-9][a-z0-9_-]{0,79}`。复用已有笔记时沿用其 ID。

新建时可以先写标题，在标记行运行「打开或创建设计笔记」让编辑器生成并写回短 ID。编辑器的注释创建命令生成 `nt_` 加 10 位十六进制字符，CLI 和侧车创建生成 `nt_` 加 12 位。

## 选区与具名块

要保持 HDL 原文，保存源码后选中代码并运行「将设计笔记绑定到选区」，或将光标放在 `begin : reset_path … end` 内运行「将设计笔记绑定到具名块」。`reset_path` 是 SystemVerilog 块名，笔记有独立的 ID。正文和定位信息分别存入 `docs/design-notes/<id>.svnote.md` 和 `docs/design-notes/<id>.svnote.anchor.json`。锚点定位成功后，编辑器显示 Note 徽章，可悬停预览。

Agent 可以用 CLI 创建侧车锚点。`--offset` 是文件内从 0 开始的 UTF-16 偏移，`--symbol` 在该位置查找具名块。绑定选区时，用 `--end` 提供结束偏移并省略 `--symbol`。`--file` 和 `--body` 都使用工作区相对路径，`--body` 指向 UTF-8 Markdown 文件。

```powershell
svtools-agent.cmd note add --workspace <工作区> --file rtl/fifo.sv --offset <块内偏移> --symbol --body docs/reset.md
svtools-agent.cmd note get --workspace <工作区> --note <返回的ID>
svtools-agent.cmd note check --workspace <工作区> --note <返回的ID>
```

移动或改名后用 `note check` 核验侧车锚点是否仍唯一定位。出现 `stale` 或 `ambiguous` 时，先确认源码位置，再用 `note get` 返回的 `etag` 作为 `--expect` 调用 `note reanchor`。更新笔记正文时，同样用 `etag` 调用 `note update`。只有源码注释绑定的笔记在 `note check` 中显示为 `unbound`，可在标记行悬停确认正文。`note check` 只要有一篇 `stale` 或 `ambiguous` 就以 `failed` 结束，逐条 `status` 才是定位依据。

## 检索与导出

```powershell
svtools-agent.cmd note list --workspace <工作区> [--topic <主题>]
svtools-agent.cmd note search --workspace <工作区> --query "<关键词>"
svtools-agent.cmd note export --workspace <工作区> --topic <主题> --format pdf --out docs/notes-export
```

- `note list` 返回 `notes[]{id,path,title,topic,sha256,etag,anchor}`，按 ID 排序；`--topic` 精确过滤。
- `note search` 与 `list` 是同一份清单：`--query` 按空白分词，每个词都要在 ID、主题、锚点路径或正文中命中（全部命中才算）。
- `note export` 用 `--note` 或 `--topic` 选中（省略时导出全部，最多 64 篇）；`--format md|html|pdf`（默认 html），`--out` 默认 `docs/design-note-export`，目录必须不存在（已有目录返回 `EXPORT_EXISTS`）。正文合计超过 8 MiB 返回 `SOURCE_LIMIT`。
- 定版导出加 `--final`：先把每篇笔记的版本固定到历史，再要求所有锚点已 `resolved`（否则 `EVIDENCE_STALE`），并核对评审证据；产物 `notes.md`、`notes.html`/`notes.pdf` 与 `manifest.json`（`notes[].sha256/revision/verification`、`artifacts[].sha256`、`evidence[].sha256`）。普通导出只是快照，不能当作评审证据。

## 架构报告

模块章正文通过 `svtools.architecture.json` 的 `designDocs` 按模块类型名绑定。需要在报告中包含某篇 Note 时，可显式引用该 Note 的 Markdown 文件，文件须位于伪 SV 工作区内。源码注释或侧车锚点由编辑器使用，架构导出按 `designDocs` 取章内正文。见[报告展示配置](architecture.md#报告展示配置)。
