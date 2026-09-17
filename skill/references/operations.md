# Operations

## Completion evidence

Report each exact Sheet, business date as `YYYY-MM-DD (America/Los_Angeles)`, total keywords, `SUCCESS`, `NOT_FOUND`, technical failures, verified writes, pending writes, and wall-clock time. DingTalk is intentionally omitted for owner-scoped runs.

## Recovery

- A stale/missing runner heartbeat must be repaired before creating a request file.
- On an Amazon block, retain every per-keyword checkpoint. Rebuild the Sheet Context and retry only the current/unstarted suffix with a finite recovery limit; if exhausted, retain the scoped pause/state files for a later health-checked resume.
- Never delete or reset result history to make a retry possible.
- Do not move a result from one business date to another. A checkpoint retains its original date; a new date gets a new scoped cycle after the prior one finishes.

## Distribution

When tuning this workflow, run `node test_workflow.cjs` in the installed project. This offline regression checks recovery, browser dispatch, pacing, and completion reporting without searching Amazon or writing Tencent cells. Keep the 20-second default pacing and ranking/writeback checks intact; distinguish measured live timings from simulated recovery checks.

Keep reviewed code and skill changes synchronized with the distribution package when it is available. Copy only code/instructions, never local tokens, document configuration, browser profiles, logs, or state.

Each person's machine needs the project folder, Node dependencies, Chrome, Tencent authorization, its own Tencent Sheet URL, and a working local runner. The package contains no live Tencent document URL or authorization token. On first install, the owner supplies an `https://docs.qq.com/sheet/...` link; upgrades preserve that machine's existing link unless an explicit replacement is provided.

The installer places the project under `%LOCALAPPDATA%\AmazonSheetRank` and the Skill under the current user's Codex skills directory. `AMAZON_RANK_PROJECT` overrides the project location.
