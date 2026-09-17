// Runs in the interactive admin session.  It accepts only predefined jobs from
// bridge/requests; it never evaluates a command supplied by a request file.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = __dirname;
const bridge = path.join(root, 'bridge');
const requestsDir = path.join(bridge, 'requests');
const resultsDir = path.join(bridge, 'results');
const logsDir = path.join(bridge, 'logs');
const tasksDir = path.join(bridge, 'tasks');
const executionsDir = path.join(bridge, 'executions');
const statePath = path.join(bridge, 'runner-status.json');
const buildInfo = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8')); } catch { return { version: 'unknown' }; } })();
const businessScript = path.join(root, 'run_single_test.cjs');
const nodePath = process.execPath;
const maxConcurrency = Math.max(1, Math.min(8, Number(process.env.AMAZON_RUNNER_CONCURRENCY || 1)));
const launchIntervalMs = Math.max(0, Number(process.env.AMAZON_LAUNCH_INTERVAL_MS || 10000));
const jobTimeoutMs = Math.max(5 * 60 * 1000, Number(process.env.AMAZON_JOB_TIMEOUT_MS || 15 * 60 * 1000));
const activeJobs = new Map();
let lastLaunchAt = 0;

for (const dir of [requestsDir, resultsDir, logsDir, tasksDir, executionsDir]) fs.mkdirSync(dir, { recursive: true });

const now = () => new Date().toISOString();
function atomicJson(target, value) {
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}
function runnerState(state, extra = {}) {
  atomicJson(statePath, {
    runner: 'CodexAmazonLocalRunner', pid: process.pid, state, updatedAt: now(),
    version: buildInfo.version, browserLifecycle: buildInfo.browserLifecycle || null,
    maxConcurrency, launchIntervalMs, activeCount: activeJobs.size,
    activeJobs: [...activeJobs.values()].map(item => ({ id: item.id, sheet: item.sheet, startedAt: item.startedAt })),
    ...extra,
  });
}
function jobId(job) {
  return typeof job.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(job.id) ? job.id : null;
}
function resultPath(id) { return path.join(resultsDir, `${id}.json`); }
function writeResult(id, body) { atomicJson(resultPath(id), { id, updatedAt: now(), ...body }); }
function parseExecutionLog(logPath) {
  try { return JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch { return null; }
}

async function runJob(job) {
  const id = jobId(job);
  if (!id) throw new Error('Invalid job id. Use letters, numbers, _ or - only.');
  // run_single_amazon_test: one keyword, one fresh Chrome (historical path).
  // run_batch_amazon_tests: several keywords of one Sheet share one Chrome
  // session inside run_single_test.cjs (AMAZON_TASKS_FILE); per-keyword
  // outcomes still land in the same execution log envelope, incrementally.
  const isBatch = job.action === 'run_batch_amazon_tests';
  if (!isBatch && job.action !== 'run_single_amazon_test') throw new Error(`Unsupported action: ${job.action}`);
  if (isBatch) {
    if (!Array.isArray(job.tasks) || !job.tasks.length) throw new Error('Missing batch task list.');
    if (job.tasks.some(task => !task || typeof task !== 'object')) throw new Error('Invalid batch task payload.');
  } else if (!job.task || typeof job.task !== 'object') {
    throw new Error('Missing isolated Amazon task payload.');
  }
  const sheet = String((isBatch ? job.tasks[0] : job.task).sheet || job.sheet || '').trim();
  if (!sheet) throw new Error('Missing Sheet identity.');
  const logPath = path.join(logsDir, `${id}.log`);
  const taskPath = path.join(tasksDir, `${id}.json`);
  const executionPath = path.join(executionsDir, `${id}.json`);
  atomicJson(taskPath, isBatch ? job.tasks : job.task);
  // A Sheet-sized batch may contain dozens of paginated keywords. Keep a
  // finite watchdog, but do not cut a healthy Sheet at the former 90-minute
  // five-keyword-chunk boundary.
  const effectiveTimeoutMs = Math.max(5 * 60 * 1000, Math.min(Number(job.timeoutMs) || jobTimeoutMs, 8 * 60 * 60 * 1000));
  const startedAt = now();
  activeJobs.set(id, { id, sheet, startedAt });
  writeResult(id, { state: 'RUNNING', startedAt, action: job.action, sheet, logPath, taskPath, executionPath });
  runnerState('BUSY');

  const batchEnv = isBatch ? { AMAZON_TASKS_FILE: taskPath, ...(typeof job.batchPauseFile === 'string' && job.batchPauseFile ? { AMAZON_BATCH_PAUSE_FILE: job.batchPauseFile } : {}) } : { AMAZON_TASK_FILE: taskPath };
  const child = spawn(nodePath, [businessScript], {
    cwd: root,
    env: { ...process.env, NO_PAUSE: '1', AMAZON_EXECUTION_LOG: executionPath, ...batchEnv },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);
  const outcome = await new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => {
      writeResult(id, { state: 'RUNNING', startedAt, action: job.action, sheet, logPath, taskPath, executionPath, watchdog: `TIMEOUT_${effectiveTimeoutMs}` });
      try { child.kill('SIGTERM'); } catch { /* process may already be gone */ }
      setTimeout(() => { try { if (!child.killed) child.kill('SIGKILL'); } catch { /* ignore */ } }, 10000);
      finish({ code: null, signal: 'WATCHDOG_TIMEOUT' });
    }, effectiveTimeoutMs);
    child.on('close', (code, signal) => finish({ code, signal }));
  });
  await new Promise(resolve => stream.end(resolve));
  const execution = parseExecutionLog(executionPath);
  const state = outcome.code === 0 && execution?.status !== 'FAILED' ? 'COMPLETED' : 'FAILED';
  writeResult(id, { state, startedAt, finishedAt: now(), action: job.action, sheet, logPath, taskPath, executionPath, exitCode: outcome.code, signal: outcome.signal, execution });
  activeJobs.delete(id);
  runnerState(activeJobs.size ? 'BUSY' : 'IDLE', { lastJobId: id, lastJobState: state });
}

async function scan() {
  if (activeJobs.size >= maxConcurrency) return;
  if (Date.now() - lastLaunchAt < launchIntervalMs) return;
  const filenames = fs.readdirSync(requestsDir).filter(name => name.endsWith('.json')).sort();
  for (const filename of filenames) {
    if (activeJobs.size >= maxConcurrency) break;
    const source = path.join(requestsDir, filename);
    let job;
    try { job = JSON.parse(fs.readFileSync(source, 'utf8')); } catch { continue; }
    const sheet = String(job.task?.sheet || job.sheet || '').trim();
    if (sheet && [...activeJobs.values()].some(item => item.sheet === sheet)) continue;
    const claimed = `${source}.processing`;
    try { fs.renameSync(source, claimed); } catch { continue; }
    lastLaunchAt = Date.now();
    let id = path.basename(source, '.json');
    void (async () => {
      try {
        id = jobId(job) || id;
        await runJob(job);
      } catch (error) {
        activeJobs.delete(id);
        writeResult(id, { state: 'FAILED', finishedAt: now(), error: error.message });
        runnerState(activeJobs.size ? 'BUSY' : 'IDLE', { lastJobId: id, lastJobState: 'FAILED' });
      } finally {
        try { fs.renameSync(claimed, `${claimed}.done`); } catch { /* already moved or removed */ }
        setImmediate(() => scan().catch(error => runnerState('ERROR', { error: error.message })));
      }
    })();
    // New browser contexts are deliberately staggered at the shared public IP.
    // They still overlap for the full Amazon workflow after launch.
    break;
  }
}

runnerState('IDLE', { startedAt: now(), requestsDir, resultsDir, jobTimeoutMs });
console.log(`[RUNNER] Ready. Watching ${requestsDir}`);
setInterval(() => scan().catch(error => runnerState('ERROR', { error: error.message })), 800);
setInterval(() => runnerState(activeJobs.size ? 'BUSY' : 'IDLE'), 10000);
scan().catch(error => runnerState('ERROR', { error: error.message }));
