---
name: amazon-sheet-rank
description: Run, resume, pause, or inspect Amazon organic-ranking collection for explicitly assigned SPU/Sheets in a user-configured Tencent spreadsheet, without starting an all-Sheet cycle.
---

# Amazon Single-Sheet Ranking

Run only the user-supplied SPU/Sheets through the verified local Amazon runner. Multiple named Sheets run sequentially. Never infer extra Sheets, expand to the whole document, or invoke the all-Sheet daily entrypoint.

## Required input

Obtain one or more exact Sheet names/SPUs from the request. If none are supplied, ask for them. Reject wildcards, “all”, or implicit expansion.

## Execution

1. Work in `%LOCALAPPDATA%\AmazonSheetRank` unless `AMAZON_RANK_PROJECT` points to another installed copy.
2. Confirm `tencent-doc-config.json` identifies the Tencent Sheet URL supplied by the current owner. If it is missing, obtain that owner's exact `https://docs.qq.com/sheet/...` link and run `setup-doc.ps1`. Never reuse another person's or another machine's document URL.
3. Confirm `bridge/runner-status.json` has a fresh heartbeat (45 seconds or less) and its `version` matches `version.json`. The invocation script safely restarts an idle stale/mismatched runner; never replace or restart a runner with an active Sheet.
4. Use [scripts/invoke.ps1](scripts/invoke.ps1): `run`, `resume`, `status`, or `pause`, followed by the exact Sheet list. Add `-RecheckNotFound` only when intentionally rerunning previous `NOT_FOUND`/`-` cells after a ranking-logic fix. The coordinator checks Amazon health before dispatching pending browser work; recovered or writeback-only work needs no Amazon health check. Do not run an additional standalone check beforehand. `run` processes each Sheet sequentially and writes/verifies that Sheet before starting the next.
5. Watch each scoped state under `state/tencent-sheet-<sheet>-state.json`, the runner heartbeat, and result logs until all requested Sheets complete or reach a real manual-intervention boundary.

Each Sheet has its own state, lock, and pause file. Different machines can therefore process different Sheets in parallel. On one machine the shared local runner remains concurrency 1 and serializes browser work safely.

## Invariants

- One invocation owns only the explicitly named Sheet list; the list is printed before dispatch.
- Preserve valid existing values and completed `SUCCESS`/`NOT_FOUND` results; resume only unfinished or technical failures.
- Use the Los Angeles business date. Existing same-day date cells are authoritative; when creating a new row, write the date as full-year, non-padded `YYYY/M/D` such as `2026/9/15`. Conversation summaries use unambiguous `YYYY-MM-DD (America/Los_Angeles)`.
- Keep one fresh `--incognito` temporary Chrome profile for each explicitly owned Sheet. Reuse its single Context and page for that Sheet's keywords, then close it before the next Sheet. ZIP 10001, Sponsored exclusion, MUSSHOE and organic position counting remain unchanged. For ASIN matching, the current Sheet name is the SPU: read 【asin尺寸颜色对应表】, collect only the ASINs under the header whose SPU equals the current Sheet name, and match Amazon MUSSHOE results against that SPU-scoped ASIN set and its proven variation family. Do not use the current Sheet's visible/top-row child ASINs as target ASINs, and never use all mapped ASINs for every Sheet.
- Keep 20–60 seconds between valid keyword completions.
- WAF, HTTP 202, `_sec/verify`, CAPTCHA, missing search/location controls, or a stale runner are technical blocks, never `NOT_FOUND`. Rebuild the current Sheet Context a bounded number of times and resume only unfinished keywords; pause without consuming more work when recovery is exhausted.
- Handle bounded technical recovery autonomously. Do not ask the triggering user to choose between retry strategies; request intervention only for a real CAPTCHA/verification, login/authorization, administrator permission, or another genuinely manual boundary.
- Write only the owned Sheets in the locally configured Tencent document. Never change the configured document unless the triggering owner explicitly supplies a replacement URL. Do not send DingTalk, start `run_daily_cycle_and_notify.cjs`, or call the unfiltered coordinator.
- Report results in the triggering conversation, separately for every Sheet.

For troubleshooting and handoff rules, read [references/operations.md](references/operations.md).
