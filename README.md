# Amazon Sheet Rank

> 在腾讯文档（Tencent Docs Sheet）里维护的 Amazon US 关键词自然排名，按 SPU/Sheet 定向采集并回写——
> 一条命令、一个常驻本地 runner、一个 browser Context 一个 Sheet。

[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/playwright-1.6x-2EAD33?logo=playwright&logoColor=white)](https://playwright.dev)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4)](#环境要求)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## 这是什么

电商运营每天要看一堆关键词在 Amazon 搜索结果里的**自然排名**（organic rank）。人工做法是：打开 Excel → 找到今天要查的关键词 → 在 Amazon 上搜 → 翻页数位置 → 手填回来。关键词一多就变成纯体力活。

这个项目把它做成了自动化闭环：

```
腾讯文档 Sheet（关键词 + 日期列）
        │  读取待采集的关键词
        ▼
   本地 runner（常驻进程，并发 = 1）
        │  派发单个关键词任务
        ▼
 Playwright + 本地 Chrome（--incognito）
        │  搜索 → 翻页 → 排除 Sponsored → 定位目标 ASIN
        ▼
   写回腾讯文档 + 重新读取校验
```

**核心特征：**

- **定向而非全量**：一次调用只处理明确指定的 Sheet（SPU），不推断、不扩大、不默认跑整个文档。
- **可断点续跑**：每个关键词都有 checkpoint，中途被风控打断后只重跑未完成的尾部，已完成的结果不会被清空。
- **区分"真的没排到"和"被拦了"**：WAF / HTTP 202 / CAPTCHA / `_sec/verify` 属于技术故障，绝不会被误写成 `NOT_FOUND`。
- **写回强校验**：写完立即重读比对，不一致就报 `RESULT_WRITE_VERIFY_FAILED`，不留下"以为写成功了"的脏数据。
- **凭据零入库**：token 与文档链接只存在于本机（详见 [SECURITY.md](SECURITY.md)）。

---

## 环境要求

| 依赖 | 说明 |
| --- | --- |
| Windows 10 / 11 | 安装脚本、runner 守护均基于 PowerShell |
| Node.js LTS（≥ 18） | 含 npm |
| Google Chrome | 使用本机 Chrome + 独立 `--incognito` 临时 profile，不碰你日常的浏览器会话 |
| 腾讯文档授权 | 一个有权访问目标 Sheet 的授权 token |
| 目标 Sheet | 形如 `https://docs.qq.com/sheet/<fileId>` |

> 需要能接受 Amazon 的美国区结果，采集时使用 **ZIP 10001（纽约）** 作为定位。

---

## 安装

1. 解压发行包，双击 `安装-Amazon单Sheet排名.cmd`（或直接跑 PowerShell）：

   ```powershell
   .\install-amazon-sheet-rank.ps1
   ```

   安装脚本会：
   - 把项目复制到 `%LOCALAPPDATA%\AmazonSheetRank`（可用 `-InstallRoot` 覆盖）
   - 把 Skill 复制到 `<CODEX_HOME>\skills\amazon-sheet-rank`（可用 `-CodexRoot` 覆盖）
   - `npm ci --omit=dev` 安装依赖
   - 注册用户级环境变量 `AMAZON_RANK_PROJECT`
   - 启动本地 runner 并**校验心跳与版本号一致**后才算安装完成

2. 一次性授权（两个脚本都是交互式提问，输入内容不会被回显/落盘到日志）：

   ```powershell
   cd $env:LOCALAPPDATA\AmazonSheetRank
   .\setup-token.ps1     # 腾讯文档授权 token
   .\setup-doc.ps1       # 该机器负责的 Sheet URL
   ```

3. 安装脚本最后会提示**重启 Codex**，让新的 Skill 被发现。

**常用参数：** `-TencentDocUrl <url>` 一步配置文档 ·`-SkipDependencyInstall`（依赖已就绪）·`-SkipDocumentSetup`（测试用）·`-SkipUserEnvironment`（不改环境变量）。

---

## 使用

Skill 入口（在 Codex 对话里）：

```
Use $amazon-sheet-rank to run Amazon natural ranking for these assigned SPU/Sheets only: 918, B06
```

或者直接调脚本：

```powershell
# 运行指定 Sheet（多个则顺序执行，每个 Sheet 写完并校验后才进入下一个）
.\skill\scripts\invoke.ps1 -Action run -Sheets 918,B06

# 查看状态 / 暂停 / 从断点续跑
.\skill\scripts\invoke.ps1 -Action status -Sheets 918
.\skill\scripts\invoke.ps1 -Action pause  -Sheets 918
.\skill\scripts\invoke.ps1 -Action resume -Sheets 918

# 仅在修复了排名判定逻辑后，才去重查之前被标成 NOT_FOUND / "-" 的单元格
.\skill\scripts\invoke.ps1 -Action run -Sheets 918 -RecheckNotFound
```

`invoke.ps1` 会在派发前检查 runner 心跳（≤ 45 秒）与版本号；runner 空闲且过期就自动重启，**正在跑 Sheet 的 runner 绝不重启**。

### 关键词是怎么定位的

1. Sheet 名 = SPU。
2. 在该 Sheet 的 【asin尺寸颜色对应表】 里，只取 SPU 等于当前 Sheet 名的那些 ASIN。
3. Amazon 结果按「该 SPU 的 ASIN 集合 + 已验证的变体家族」匹配；**不会**拿当前 Sheet 顶部可见的子 ASIN 当目标，也不会把全量 ASIN 映射套到每个 Sheet。

### 业务日期

统一使用 **Los Angeles 业务日期**。已存在的同日日期单元格是权威值；新建行时写入不补零的 `YYYY/M/D`（如 `2026/9/15`），对外汇报用 `YYYY-MM-DD (America/Los_Angeles)`。

---

## 目录结构

```
amazon-rank-automation/
├─ install-amazon-sheet-rank.ps1   # 安装器（复制 + 装依赖 + 配置 + 启动校验）
├─ 安装-Amazon单Sheet排名.cmd        # 双击入口
├─ 故障诊断-让对方发这个.txt         # 给非技术同事的一页说明
├─ skill/                          # Codex Skill 包装
│  ├─ SKILL.md                     #   触发条件、执行流程、不变式
│  ├─ agents/openai.yaml           #   展示名与默认 prompt
│  ├─ references/operations.md     #   完成证据、恢复策略、分发规则
│  └─ scripts/invoke.ps1           #   run / resume / status / pause 统一入口
└─ project/
   ├─ run_owned_sheets.cjs         # 定向协调器：只跑传入的 Sheet 列表
   ├─ run_tencent_multi_sheet_cycle.cjs  # 全量协调器（含通知，定向运行不使用）
   ├─ local_runner.cjs             # 常驻 runner：并发 1，只吃 bridge/requests 的预定义任务
   ├─ run_single_test.cjs          # 单关键词浏览器采集（Playwright）
   ├─ amazon_health_check.cjs      # Amazon 可达性 / 风控页检测
   ├─ tencent_token.cjs            # 凭据加载（从不打印值）
   ├─ tencent_doc_config.cjs       # Sheet URL 解析与持久化
   ├─ configure_tencent_doc.cjs    # 原子写入文档配置
   ├─ run_owned_sheet.cjs          # 单 Sheet 隔离执行（独立 lock）
   ├─ test_workflow.cjs            # 离线回归测试（不联网、不写文档）
   ├─ collect-diagnostics.ps1      # 打包诊断 zip
   ├─ setup-token.ps1 / setup-doc.ps1 / start_local_runner.ps1
   ├─ version.json                 # 版本号 + 浏览器生命周期策略
   ├─ config/project-config.json   # 站点、ZIP、品牌、配色映射、写回样式
   └─ core/
      ├─ rank_parser.cjs           # 搜索结果卡片分类（Sponsored / 自然位）
      ├─ product_match.cjs         # ASIN 判定 + 变体家族证据
      ├─ writeback_guard.cjs       # 写回后重读校验
      ├─ sheet_grid.cjs            # 列号编码 / CSV grid 解析
      └─ date_format.cjs           # 业务日期格式化
```

---

## 设计说明（为什么这么写）

**为什么要一个常驻 runner 而不是每次拉起进程。**
Chrome 冷启动 + 登录态建立很贵，而且频繁创建会显著提高被风控盯上的概率。改为常驻进程后，浏览器生命周期由 `version.json` 的 `browserLifecycle` 策略统一管理，且天然把并发压到 1。

**为什么 runner 只接受"预定义任务"。**
`local_runner.cjs` 从 `bridge/requests/*.json` 读取任务，**不会执行请求文件里传来的任意命令**。请求文件只是一个数据载荷，动作类型必须命中预定义集合。这样即使 bridge 目录被污染，也无法升级成本机任意代码执行。

**为什么状态是 per-Sheet 的。**
每个 Sheet 有独立的 state / lock / pause 文件，所以不同机器可以并行处理不同 Sheet；同一台机器上唯一共享的 runner 仍然串行，浏览器操作是安全的。

**为什么心跳和版本号要一起校验。**
只校验存活会漏掉"跑着旧代码的僵尸 runner"；只校验版本会漏掉"进程已经死了"。两个一起看，才能安全地决定"该不该重启"。

**风控与节奏。**
关键词之间保留 20–60 秒间隔；遇到阻断时有限次重建 Context 并只重试未完成的部分，恢复预算耗尽就暂停（保留 state），而不是继续消耗额度、也不是把结果写成 `-`。

---

## 故障排查

先跑离线回归（不联网、不写文档），确认是代码问题还是环境问题：

```powershell
cd $env:LOCALAPPDATA\AmazonSheetRank
node test_workflow.cjs
```

判断结果异常时，在出问题的机器上生成诊断包：

```powershell
.\collect-diagnostics.ps1 -Sheets "32582","B06"
```

它只打包版本号、运行状态、采集日志、执行结果和对应 Sheet 状态——**不含 token，也不含文档链接配置**。非技术同事的操作步骤见 `故障诊断-让对方发这个.txt`。

| 现象 | 优先排查 |
| --- | --- |
| `TENCENT_DOCS_TOKEN_MISSING` | 跑一次 `setup-token.ps1` |
| runner 心跳过期 | `start_local_runner.ps1`；确认 `AMAZON_RANK_NODE` 或 PATH 里有 node.exe |
| 关键词大片变成 `-` | 是否被风控拦了；用 `-RecheckNotFound` 修复判定逻辑后重查，不要手改单元格 |
| 安装时报 runner busy | 有 Sheet 正在跑，等它跑完再装 |
| 需要换文档 | 显式传新的 `-TencentDocUrl`；默认保留本机已有配置 |

---

## 合规与免责声明

- 本项目通过 Playwright 驱动**你本机的浏览器**访问公开搜索结果页，不调用任何未公开接口、不绕过登录。
- 请遵守 Amazon 的服务条款、robots 规则以及你所在地区的法律法规，自行承担使用风险。
- 采集节奏、并发与重试策略**刻意保守**。请勿调高频率用于批量抓取，那既违背本项目的设计初衷，也会让你的账号陷入风险。
- 作者不对因使用本项目导致的账号限制、数据错误或商业损失负责。

---

## Roadmap

- [ ] 把 Windows-only 的 PowerShell 编排层抽象成跨平台 CLI
- [ ] 采集结果的结构化 export（CSV / JSON），便于接 BI
- [ ] 把 `core/` 的无副作用模块抽成独立包并补齐单测

---

## 同类项目（Prior art）

Amazon 自然排名采集这个细分并不拥挤。公开仓库里大多是单人脚本，通用 SEO 排名工具则解决的是另一个问题。以下按相关性列出，供对比选型：

| 项目 | ★ | 技术栈 | 数据落地 | 与本研究的关系 |
| --- | --- | --- | --- | --- |
| [allenhxd/amazon-organic-rank-monitor](https://github.com/allenhxd/amazon-organic-rank-monitor) | 0 | TypeScript / Next.js + Postgres + Redis + BullMQ | 自有数据库 + Web UI | **设计理念最接近**：同样把 Sponsored 设为排除项、同样区分"确实没有"与"采集未完成"、同样要求变体证据才允许家族匹配、同样拒绝绕过 CAPTCHA。差别在于它是重基础设施的自托管服务，本项目是嵌入既有表格工作流的轻量本地 runner。 |
| [pangolinfoapi/amazon-keyword-rank-tracker](https://github.com/pangolinfoapi/amazon-keyword-rank-tracker) | 1 | Python + GitHub Actions | 仓库文件 / 数据库 | 同样是每日关键词排名追踪，但采集依赖其商业数据 API，本质是 SDK 示范仓库。本项目不依赖任何付费接口。 |
| [saiyancode/Basic-Amazon-Rank-Tracker](https://github.com/saiyancode/Basic-Amazon-Rank-Tracker) | 16 | Python + Selenium | MongoDB / SQLite | 该细分里星数最高的一个，2017 年后未再更新，无 License、无恢复策略、无写回校验。 |
| [cmod/amazon_ranking](https://github.com/cmod/amazon_ranking) | 3 | Python | JSON + HTML 图表 | 追踪单本书的 BSR 与评论数，带可视化面板。面向选品监控，不面向关键词自然位。 |
| [the-gigi/book-tracker](https://github.com/the-gigi/book-tracker) | 3 | Python | 本地文件 | 同类思路，聚焦图书销售排名。 |
| [towfiqi/serpbear](https://github.com/towfiqi/serpbear) | 2078 | TypeScript | 自有数据库 | 成熟的自托管 SEO 排名追踪器。解决的是 Google/Bing 等搜索引擎的排名，不涉及 Amazon 搜索结果页的 Sponsored 与变体判定。 |

**本项目的差异化：**

1. **腾讯文档是唯一信源**。上述项目的落点都是自有数据库或本地文件，运营需要在"工具"和"表格"之间手动同步。本项目直接读写团队已经在用的那张 Sheet，没有第二份真相。
2. **写回后强制重读校验**（`core/writeback_guard.cjs`）。其余项目只负责采集，不校验写入结果。
3. **面向多人协作分发**。安装器 + 每台机器独立的文档配置 + per-Sheet 锁，让不同同事并行处理不同 Sheet；其余项目都是单人自用脚本。
4. **零依赖离线回归测试**（`test_workflow.cjs`）。不需要 `npm install`、不联网、不碰文档，就能验证恢复逻辑与节奏控制。

如果你要的是"开箱即用的 Web 面板 + 历史趋势图"，`serpbear` 或 `allenhxd/amazon-organic-rank-monitor` 更合适；如果你要的是"接进团队现有的表格流转、不引入新系统"，这个项目才对。

---

## License

[MIT](LICENSE)
