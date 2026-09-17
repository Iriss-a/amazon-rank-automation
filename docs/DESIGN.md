# 设计说明

这份文档记录本项目**为什么这么实现**，以及每条设计约束背后的代价。README 讲怎么用，这里讲取舍。

---

## 1. 问题的真实形状

表面上这是个"抓 Amazon 排名"的工具，实际上真正难的部分不是抓，而是：

> 往一张**正在被别人编辑的表格**里，写入**别人会直接拿去做决策的数字**。

这决定了三条不可协商的要求：

1. 写入的值必须**语义正确**——不能把"没采到"写成"没排名"。
2. 写入必须**可验证**——不能出现"以为写成功了"。
3. 失败必须**可恢复且可解释**——不能靠人肉回忆跑到哪了。

下面所有设计都是为这三条服务的。

---

## 2. 核心：排名是三值语义，不是二值

`project/core/product_match.cjs` 里一个产品判定只有三种终态：

| status | 含义 | 典型 reason |
| --- | --- | --- |
| `FOUND` | 确认命中 | `EXACT_ASIN` / `VARIATION_FAMILY` |
| `NOT_FOUND` | 全量跑完，确实没排到 | `NO_EXACT_OR_PROVEN_VARIATION_FAMILY` |
| `FAILED` | **采集本身没成功，结果未知** | `ACTUAL_ASIN_UNAVAILABLE` / `TARGET_ASIN_SET_EMPTY` |

**为什么这条是整个项目最重要的设计。**

如果 WAF 拦截或页面结构变化导致取不到 ASIN，而代码把这种情况降级成 `NOT_FOUND`，运营第二天看到的是"排名掉了"——实际是"没采到"。**这个错误会以业务结论的形式被消费掉**：可能会去调整广告预算、可能会去改 listing、可能会被写进汇报。

技术故障和业务事实混淆，是这类自动化里最贵的一类 bug，而且它不会报错、不会崩溃、看起来一切正常。所以 `FAILED` 是独立终态，绝不与 `NOT_FOUND` 合并；`FOUND` 的判断同样只接受可复现的证据（见第 4 节）。

---

## 3. 自然位次：Sponsored 完全挤出计数序列

`project/core/rank_parser.cjs` 的 `classifySearchCards` 逐卡片处理：

```js
if (!validAsin(card.asin)) continue;              // 不是 B0XXXXXXXX 的卡片直接丢弃，不计数
if (isSponsored(card.text)) { sponsoredCount++; continue; }   // 广告：计数但不占自然位次
naturalCount += 1;                                // 只有非广告卡片才推进自然位次
```

`isSponsored` 的判定是 `/\bsponsored\b|广告|赞助/i`。

关键点：**Sponsored 的 `continue` 发生在 `naturalCount += 1` 之前**。所以排在搜索结果第 1 位的是广告时，第一个自然结果拿到的是 `pageNaturalPosition = 1`，而不是 2。

这正是"自然排名"的定义——如果广告也占位次，同一个产品在不同时间跑出的数字会因为当天投放策略变化而漂移，数字就失去了可比性。

卡片成为候选还需要「文本包含品牌词」**或**「ASIN 在目标集合内」；两者都不满足的卡片会被计数但不成为候选。

---

## 4. 变体家族匹配：四个条件必须同时成立

同一个 SPU 下的兄弟变体经常出现在搜索结果里。把兄弟变体的位置算成自己的，是一种**静默的错误**：数字看起来合理，但是别人的排名。

`project/core/product_match.cjs` 的 `productMatch` 只在**全部四个条件同时为真**时才返回 `VARIATION_FAMILY`：

```js
if (parentAsins.length              // 1. 页面脚本里确实解析出了 parentAsin
    && actualInFamily               // 2. 实际命中的 ASIN 在家族集合内
    && sibling                      // 3. 目标集合里也有 ASIN 在家族集合内
    && evidence.hasDimensionMap === true)  // 4. 找到了变体维度映射脚本
```

第 4 条的 `hasDimensionMap` 由 `collectVariationEvidence` 判定：页面 `<script>` 文本里必须**同时**出现实际 ASIN 和目标 ASIN，**且**含有 `dimensionToAsinMap` / `asinVariationValues` / `variationValues` / `twister` 之一。只在"包含实际 ASIN"的脚本里找还不够——必须同时能证明目标 ASIN 也在同一张映射表里。

条件不满足时返回 `NOT_FOUND` + `NO_EXACT_OR_PROVEN_VARIATION_FAMILY`，并把 `evidence`（`parentAsins` / `actualInFamily` / `targetFamilyMembers` / `hasDimensionMap`）一起带出来，方便事后判断到底是"真的没排到"还是"证据没解析出来"。

**设计立场：宁可漏判，不可错判。** 漏判是可见的（运营会问"这个怎么是 `-`"），错判是不可见的。

---

## 5. 写回契约：读-写-重读

`project/core/writeback_guard.cjs` 全文只有 9 行，但它是整套流程的信任锚点：

```js
async function writeAndVerify({ read, write, expected }) {
  const before = await read();
  await write(expected);
  const after = await read();
  if (after !== expected) throw new Error(`RESULT_WRITE_VERIFY_FAILED:${after}`);
  return { before, after, verified: true };
}
```

三个细节：

- **写前先读**（`before`）。返回值里保留 `before` 是为了让调用方知道**自己覆盖了什么**——表格是多人编辑的，被覆盖的值可能是同事刚填的。
- **写完必须重读**。接口返回 200 不等于单元格内容变成了你要的值（可能被并发编辑、可能被格式规则改写、可能静默失败）。
- **不一致就抛错，不吞**。`RESULT_WRITE_VERIFY_FAILED` 会带上实际读到的值，让问题可定位。

---

## 6. 常驻 runner 与信任边界

### 为什么是常驻进程

Chrome 冷启动 + 建立会话的成本很高，而且频繁创建进程会显著提高被风控注意的概率。改为常驻后，浏览器生命周期由 `project/version.json` 的 `browserLifecycle` 统一管理（当前策略 `ONE_CONTEXT_PER_SHEET`），并且天然把并发压到 1。

### 为什么 runner 只吃"预定义任务"

`project/local_runner.cjs` 从 `bridge/requests/*.json` 读取任务。关键约束：

> **请求文件只是数据载荷，不是指令。动作类型必须命中预定义集合。**

这样即使 `bridge/` 目录被污染（被别的进程写入、被误拷贝了别人的文件），也无法把本机升级成"任意代码执行"。如果 runner 直接 eval 或 shell 执行请求内容，这个目录就变成了一个本地 RCE 入口。

### 为什么心跳和版本号要一起校验

`invoke.ps1` 在派发任务前检查 runner 心跳（≤ 45 秒）**和**版本号：

- 只校验存活 → 漏掉"跑着旧代码的僵尸 runner"，会用过期契约处理新任务
- 只校验版本 → 漏掉"进程已经死了"，会派发到无人接收的地方

两者一起看，才能安全地得出"该不该重启"。补充规则：**正在跑 Sheet 的 runner 绝不重启**——重启会丢掉进行中的采集。

---

## 7. 状态按 Sheet 隔离

每个 Sheet 有独立的 state / lock / pause 文件，互不影响。这带来两个性质：

- **跨机器并行**：不同同事负责不同 Sheet，同时对各自的 Sheet 写入，不会互相阻塞
- **单机器串行**：同一台机器上只有一个常驻 runner，浏览器操作永远串行，不会出现两个 Context 争抢

这也是"面向多人协作分发"的实现基础——安装器 + 每台机器独立的文档配置 + per-Sheet 锁，让分工不需要中心调度。

---

## 8. 恢复策略：有界、可解释、不撒谎

被 Amazon 风控拦截后的处理顺序：

1. **保留每个关键词的 checkpoint**（已完成的绝不清空）
2. 重建该 Sheet 的 Context
3. **只重试当前及未开始的尾部**，不从头重跑
4. 恢复预算有限；耗尽则暂停，**保留 scoped pause / state 文件**，等待人工介入后的健康检查再续跑

两条红线，写在 `skill/references/operations.md` 里：

> **绝不为了"让重试能跑"而删除或重置结果历史。**
> **绝不把一个结果从业务日期 A 搬到日期 B。**

第二条容易被忽略：如果因为"今天没跑完"就把结果挪到明天，历史数据会出现一个不存在的采集日。正确做法是——新日期等前一轮跑完之后，开一个新的 scoped cycle；每个 checkpoint 保留它自己的原始日期。

### 恢复预算耗尽后为什么不写 `-`

因为"跑不动了"和"跑完了没有"是两件事（第 2 节）。预算耗尽时暂停并保留状态，是唯一诚实的选择：既没有虚构业务事实，也没有丢弃已完成的进度。

---

## 9. 节奏与限流

关键词之间保留 **20–60 秒**间隔（默认 20 秒）。这个值**故意保守**。

它不是为了"看起来礼貌"，而是三个成本之间的平衡：太密会被风控打断（一次打断的恢复成本远高于省下的时间）、太疏则单次运行时间不可接受、而只靠重试兜底是不成立的（见第 8 节，重试次数有界且不保证成功）。

`test_workflow.cjs` 里的 `interruptible pacing` 场景会在**不真正等待**的前提下验证节奏逻辑——否则回归测试要跑几分钟。

---

## 10. 业务日期：America/Los_Angeles

统一使用 **Los Angeles 业务日期**，因为 Amazon 美国站的自然排名按美西时间滚动。

- 已存在的同日日期单元格是**权威值**（不覆盖）
- 新建行写入不补零的 `YYYY/M/D`（如 `2026/9/15`）——匹配表格里既有的书写习惯，避免同一列出现两种格式
- 对外汇报统一用 `YYYY-MM-DD (America/Los_Angeles)`

`project/core/date_format.cjs` 单独承担这个转换，并在离线回归里有对应用例（`date format`）。

---

## 11. 非目标（Non-goals）

明确**不做**的事，和做什么一样重要：

| 非目标 | 原因 |
| --- | --- |
| Web 面板 / 历史趋势图 | 腾讯文档就是界面。多一个 UI 就多一份需要同步的真相 |
| 代理轮换、指纹伪装、CAPTCHA 绕过 | **CAPTCHA / WAF 视为硬阻断**：不重试、不代理、不绕过。绕过风控会让账号陷入风险，且违背项目初衷 |
| 分布式调度 / 消息队列 / 数据库 | 规模是"几个人、几十个 Sheet"，引入这些的成本远大于收益 |
| 全文档批量采集 | 定向运行只处理显式指定的 Sheet；不推断、不扩大。全量入口 `run_tencent_multi_sheet_cycle.cjs` 保留但定向运行不使用 |
| 跨平台 CLI | 编排层目前是 PowerShell（Windows-only）。列在 Roadmap 里，但不在当前范围 |

---

## 12. 已知局限

- **Windows-only 编排层**：`install-amazon-sheet-rank.ps1` / `invoke.ps1` / 守护逻辑均基于 PowerShell。
- **依赖本机 Chrome 与常驻 runner**：机器休眠、重启后需要确认心跳（`invoke.ps1` 会检查，但需要人触发）。
- **腾讯文档侧的限流与权限模型未做压力验证**：当前使用规模下未暴露问题，但不代表在更大并发下成立。
- **`-RecheckNotFound` 是人工兜底**：判定逻辑修复后需要显式重查历史 `-` 单元格，不会自动回填——因为无法自动区分"当时的正确判定"和"当时的误判"。
- **离线回归不覆盖真实页面**：`test_workflow.cjs` 验证的是恢复、节奏、写回校验等**逻辑**，不验证 Amazon 的 DOM。页面结构变化只能靠真实运行发现，这也是为什么 `FAILED` 终态必须存在（第 2 节）。

---

## 13. 测试策略

`project/test_workflow.cjs` 的设计目标：**零依赖、不联网、不碰表格**。这样任何人都能在自己的机器上一条命令验证核心逻辑：

```powershell
node test_workflow.cjs
```

覆盖的场景（来自实际输出）：

```
date format · expanded candidate ASINs · completed/recovered skip browser ·
health gate · startup retry · bounded exhaustion ·
pending writes preserved · interruptible pacing
```

选择"零依赖"是有意的：一旦测试需要 `npm install` 或真实网络，它在隔离环境、CI、以及同事出问题时都会失效——而这些恰恰是最需要它能跑起来的时候。

`.github/workflows/ci.yml` 在每次 push 和 PR 上跑三件事：这个离线回归、全部 `.cjs` 的 `node --check` 语法检查、以及一个 secret-scan（防止把腾讯文档链接或本机凭据文件提交进仓库）。

---

## 附：进一步阅读

- 使用方式与故障排查 → [README.md](../README.md)
- 凭据处理原则 → [SECURITY.md](../SECURITY.md)
- 运维不变式（完成证据、恢复规则、分发规则） → [skill/references/operations.md](../skill/references/operations.md)
- 同类项目对比 → README 的「同类项目（Prior art）」一节
