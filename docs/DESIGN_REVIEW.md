# 设计讲解

在工程根目录放置 `svtools.review.json`，从命令面板执行「SV Tools: 打开设计讲解」。已选择工程时，也可以从「设计进展」打开。

先选要判断的行为，再按事件查看涉及的结构、前提和检查方法。「查看实际结果」展开当前事件的候选对照。波形取值使用完整实例路径，点击波形链接可定位到采样点。每个事件可为不同候选指定各自的时刻，因此比较的是同一个事务位置。

工程可按功能组织规则。选中跨模块事务的某一步时，页面并列显示关联接口的上游保证、下游前提和源码位置。读者可先核对两侧条件，再展开讲解者的判断。

规则记录候选变更时，可展开两版约定、实现或检查逻辑的差异，跳到受影响的事件，或直接在 VS Code 中打开两份经校验的 RTL。

在设计笔记中执行「SV Tools: 核对笔记定版」，打开与该 Note 关联的规则。规则标题下可打开当时保存的只读 Note 版本。展开实际结果时会核对定版 Note、锚点和该次运行的输入及产物。文件变更后重新展开实际结果可看到具体受影响的材料。

## 从编辑器创建定版

保存 Note 和相关文件后，在 `.svnote.md` 中执行「SV Tools: 创建笔记评审定版」。扩展会列出与当前锚点匹配的近期 Icarus 运行，也支持选择工程内已有的运行 JSON。确认测试检查行。如果同一运行有多个匹配，可以选择具体锚点。

命令核对运行输入和所选产物的内容哈希，然后保存 Note 的只读版本，在 `svtools.review.json` 中追加复核条目并打开它。新条目标记为「待审阅」，可直接打开运行日志和波形。

运行记录可填写 `entry`（测试台相对路径）、`case.id` 和 `case.line`（测试检查行）。波形产物可附 `sample: { at, signals }`，并使用完整层级信号路径。有采样信息时，点击波形链接会定位到该时刻。

## 侧车锚点和富文本

选中一段 HDL 后运行「将设计笔记绑定到选区」，或在 `begin : name` 内运行「将设计笔记绑定到具名块」。笔记正文和锚点元数据保存在 `docs/design-notes/`，HDL 中会出现 Note 徽章。悬停可预览正文。改行和移动文件时尝试重新定位，多个候选需要人工重锚。原有 `//:` 和 `//<` 标记仍可使用。

在笔记中运行「用富文本编辑设计笔记」。可切换到 Markdown 源码。扩展在加载时检查 Markdown 往返保真度，出现语义变化会进入源码模式。富文本使用 Tiptap 的 Markdown 编辑器。 [Tiptap Markdown 文档](https://tiptap.dev/docs/editor/markdown/getting-started/basic-usage)

## 导出与设计提交

「导出设计笔记」选择当前笔记、一个主题或全部笔记，并生成 Markdown、HTML 或 PDF。PDF 使用本机 Edge，也可由 CLI `--browser` 指定 Chromium 浏览器路径。定版清单保留正文、版本、源码和关联运行材料的文件身份。草稿导出可用于预览。

```powershell
node src/cli/main.js note get --note nt_reset
node src/cli/main.js note update --note nt_reset --expect <etag> --topic "FIFO 复位" --body notes.md
node src/cli/main.js note export --topic "FIFO 复位" --format html --out docs/fifo-design --module afifo --final
node src/cli/main.js design submit --module afifo --actor designer --revision 1 --token <claim-token> --evidence docs/fifo-design/manifest.json
```

`etag` 同时保护正文、主题和锚点。`note check` 查找失效或歧义锚点，`note reanchor` 用新的选区更新锚点。导出清单用于设计角色提交，验证角色仍提交包含编译、仿真和 ΔCycle 检查的运行证据。

「固定笔记版本」对应 CLI 的 `--final`。导出内容逐篇显示笔记的复核状态。清单中 `notes[].verification.status` 为 `unbound`、`pending_review` 或 `review_recorded`。`outcomes` 保留原始观察状态，包括失败和未触发。已经关联的运行证据仍需通过输入与产物哈希校验。

## 复跑 FIFO 复位试点

`node scripts/verify-fifo-workflow.cjs --review` 生成保留两次 VCD 的试点工程、回归日志、主题导出和审阅题面。试点验证短复位后的幻影读和修复结果。题面可配合 `conv3x3` 做两轮人工对照。

## 复跑背压保持试点

执行 `node scripts/verify-backpressure-review.cjs`。如需指定 Icarus，追加 `--iverilog <bin>`。打开终端输出的工程目录，阅读 `TASK.md` 后进入设计讲解。两次运行均检查两个接收字节，一次执行 0 次保持检查，另一次执行 3 次。`verification.json` 记录了日志计数及 VCD 独立读取结果。

## 清单格式（4.3 原型）

| 字段 | 内容 |
| --- | --- |
| `schemaVersion` | `1` |
| `title` | 页面标题 |
| `files[]` | `id`、工程根目录相对 `path`、内容 `sha256`、可选的显示名称 `label` |
| `rules[]` | `id`、`title`、`module`、`contract`、`mechanism`、`stimulus`、`checker` |
| `rules[].note` | 可选的定版笔记，含 `id`、文档历史的 `version` 和正文 `sha256`，以及 `anchor: { file, line }`。其中 `file` 是承载笔记标记的 RTL 文件 ID，`line` 是标记所在的 1 基行号 |
| `rules[].group` | 可选的功能分组名称 |
| `rules[].interfaces[]` | 可选接口约定，包含 `id`、`title`、`from`、`to`、`status`、`rationale`。两端各填 `module`、`expectation` 和可选 `refs[]` |
| `rules[].variants[]` | `id`、`label`、候选源文件、规格及测试台的 `inputs[]` 文件 ID。可通过 `run` 指定仿真运行 JSON 的文件 ID |
| `rules[].changes[]` | 可选候选变更，包含 `id`、`title`、`kind`（`contract`、`implementation` 或 `verification`）、候选 ID `from` 和 `to`、说明 `before` 和 `after`、受影响事件 `impacts[]`（`event`、`note`），以及可选的 `sourceDiffs[]`（`before` 和 `after` 为对应候选中的文件 ID，另含 `label` 和可选的 `afterLine`） |
| `rules[].events[]` | `id`、`title`、`expected`、可读的结构步骤 `flow[]`、`refs[]`、`observations[]` |
| `rules[].events[].interfaces[]` | 可选，填本事件涉及的接口约定 ID，顺序按阅读路径排列 |
| `rules[].events[].architecture` | 可选，含顶层 `top`、架构章节对应的 RTL 文件 ID `file`、从顶层向下的实例路径 `path[]`、本章高亮的 `instances[]` 和 `links[]`。后三项省略时为空。使用 RTL 里的实例名与连接名或网络名 |
| `rules[].events[].expectedValues[]` | 可选的共用预期值，填 `id`、`label`、`encoding` 和字符串 `value` |
| `flow[]` | `label`、`detail`，可用 `active: true` 标记当前环节 |
| `observations[]` | `variant` 候选 ID、`status`、运行摘要 `text`、提供依据的 `refs[]` |
| `refs[]` | `file` 文件 ID、`label`。源码和日志可附 1 基 `line`；VCD/FST 可附 `sample: { at, signals }`。时间可写成整数 tick 字符串或带单位的字符串，信号使用完整路径 |
| `observations[].refs[].sample.expect[]` | 可选。用 `{ signal, id }` 将本采样的完整信号路径绑定到事件中的预期值。一个信号最多绑定一次 |

`status` 可填 `passed`、`failed`、`not_triggered`、`inconclusive` 或 `pending_review`。`pending_review` 表示已经绑定运行材料，尚待复核。审阅后应以场景中的实际检查结果为准。例如最后一次寄存器读回可通过，与此同时相邻事务的覆盖属性可能从未触发。分别记录两个结果。

事件定义 `architecture` 后，可点击「在架构图定位」，后续切换事件会更新高亮。在架构图实例或连接详情中可点「查看相关讲解」，回到绑定的事件。跳转会核对 RTL 文件哈希和架构中的实际实例及连接。

接口约定的 `status` 可填 `compatible`（相容）、`mismatch`（不一致）或 `unresolved`（待确认）。用 `rationale` 写明适用的配置、条件或候选，界面将其作为讲解者判断呈现。运行观察继续按事件和候选记录。

候选与相应证据文件经内容校验后显示导入的运行摘要。波形采样由扩展从原始文件读取；其值为该时刻的记录值。若要解释同步采样条件，清单应给出所需的沿前时刻。文件身份校验确认内容与清单一致。需求、设计推导和运行摘要由清单编写者负责核对。

使用 `run` 时，运行记录需含 `schemaVersion: 1`、`inputs[]` 和 `artifacts[]`，每项记录工程根目录相对 `path` 与文件 `sha256`。候选输入须与该次运行的输入一致，波形须出现在运行产物中。复核时可以区分当前文件变更和文件与指定运行不匹配。修改清单中的测试台哈希后，旧运行仍会报告输入不符。

预期支持 `bits`（与声明等宽的 0/1 位串）、`signed`（按声明位宽解释二补码）及 `unsigned`（无符号十进制）。两份候选可绑定同一预期 ID，并使用各自的采样时刻与信号路径。结果分别标出一致、不一致、含 X/Z、无记录、预期不符合位宽及不可比较。采样点对照仅判断绑定的值。场景是否触发、用例结果及覆盖范围继续在运行摘要中单列。

## 最小清单示例

```json
{
  "schemaVersion": 1,
  "title": "stream_pipe 设计讲解",
  "files": [
    { "id": "rtl", "path": "src/stream_pipe.sv", "sha256": "<填入文件的 SHA-256>" },
    { "id": "tb", "path": "sim/tb_stream_pipe.sv", "sha256": "<填入文件的 SHA-256>" },
    { "id": "vcd", "path": "runs/stream_pipe.vcd", "sha256": "<填入文件的 SHA-256>" }
  ],
  "rules": [
    {
      "id": "stall-stability",
      "title": "背压期间待接收的数据保持稳定",
      "module": "stream_pipe",
      "contract": "o_valid=1 且 i_ready=0 时保持输出。",
      "mechanism": "输出寄存器仅在输出空闲或下游允许推进时更新。",
      "stimulus": "发出一个事务后，拉低下游 ready 并继续提供新输入。",
      "checker": "在相邻时钟沿比较已在等待的输出数据。",
      "variants": [{ "id": "current", "label": "候选 A", "inputs": ["rtl", "tb"] }],
      "events": [
        {
          "id": "hold",
          "title": "第一个等待周期",
          "flow": [{ "label": "输出寄存器", "detail": "写入使能关闭", "active": true }],
          "expected": "输出仍然保存上一个周期的待接收值。",
          "expectedValues": [
            { "id": "data", "label": "本用例发送的第一个数据", "encoding": "unsigned", "value": "42" }
          ],
          "refs": [{ "file": "rtl", "label": "检查更新条件", "line": 14 }],
          "observations": [
            {
              "variant": "current",
              "status": "passed",
              "text": "该次运行中，等待周期的输出值符合独立检查的预期。",
              "refs": [{ "file": "vcd", "label": "打开采样位置", "sample": {
                "at": "75 ns", "signals": ["tb.dut.o_data", "tb.dut.o_valid", "tb.dut.i_ready"],
                "expect": [{ "signal": "tb.dut.o_data", "id": "data" }]
              } }]
            }
          ]
        }
      ]
    }
  ]
}
```
