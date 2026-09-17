# Security

## 凭据处理原则

这个仓库**永远不包含**任何可用的凭据。具体来说：

| 数据 | 是否入库 | 存放位置 |
| --- | --- | --- |
| 腾讯文档授权 token | 否 | `project/.tencent-docs-token`（已 gitignore）+ `HKCU\Environment` |
| 腾讯文档 Sheet 链接 | 否 | `project/tencent-doc-config.json`（已 gitignore） |
| 运行状态 / 采集结果 | 否 | `project/bridge/`、`project/state/`（已 gitignore） |
| 诊断包 | 否 | 本地生成，手动发送 |

`install-amazon-sheet-rank.ps1` 与 `setup-doc.ps1` 都会明确拒绝把文档链接或 token 写进包内。

## 如果你准备 fork 后改代码

1. 提 PR 前先自查：`git diff --cached | grep -iE "token|secret|docs.qq.com/sheet"`。
2. 不要为了"方便别人测试"而提交一份真实的 `tencent-doc-config.json`。
3. 本机若曾误提交 token，请立刻在腾讯文档侧吊销该授权并重新授权，改历史记录并不能撤回已泄露的凭据。

## 报告问题

发现安全问题请开一个 Issue（不要附带真实 token 或 sheet 链接），或直接联系仓库作者。
