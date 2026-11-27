import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const LAUNCHER = path.join(ROOT, 'plugins', 'codex-console', 'bin', 'run-server.sh');

function createSyntheticCodexHome(codexHome, dispatchDir) {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(dispatchDir, 'runs', 'demo-task-1', 'turn-20261124-010000-abc123'), {
    recursive: true,
  });

  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();

  const repo = path.join(path.dirname(codexHome), 'acme-api');
  const worktrees = path.join(path.dirname(codexHome), 'worktrees', 'acme-api');
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(worktrees, 'demo-task-1'), { recursive: true });

  // 1. state_5.sqlite
  const stateDb = new DatabaseSync(path.join(codexHome, 'state_5.sqlite'));
  stateDb.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, metadata TEXT, position INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER);
    CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER,
      created_at_ms INTEGER, updated_at_ms INTEGER, source TEXT, thread_source TEXT,
      originator TEXT, cwd TEXT, title TEXT, name TEXT, preview TEXT,
      tokens_used INTEGER, archived INTEGER, is_pinned INTEGER, git_branch TEXT,
      git_sha TEXT, model TEXT, reasoning_effort TEXT, agent_nickname TEXT,
      agent_role TEXT, agent_path TEXT, project_id TEXT, history_mode TEXT
    );
  `);
  stateDb.prepare(`INSERT INTO projects VALUES ('proj-1', 'acme-api', '{}', 1, ?, ?)`).run(nowMs, nowMs);
  stateDb
    .prepare(
      `INSERT INTO threads VALUES (
        '01a90000-0000-7000-8000-000000000001', '', ?, ?, ?, ?, 'exec', 'user', 'codex_exec',
        ?, 'Implement JWT auth and unit tests', NULL,
        'Preview text', 1250000, 0, 0, 'agy-worker/demo-task-1', 'deadbeef', 'gpt-6.2-astra',
        'high', NULL, NULL, NULL, NULL, 'paginated'
      )`
    )
    .run(nowSec - 300, nowSec, nowMs - 300000, nowMs, path.join(worktrees, 'demo-task-1'));
  stateDb
    .prepare(
      `INSERT INTO threads VALUES (
        '01a90000-0000-7000-8000-000000000002', '', ?, ?, ?, ?, 'vscode', 'user', 'codex_work_desktop',
        ?, 'Desktop chat thread', 'Desktop Refactor', 'Desktop preview',
        42000, 0, 0, 'main', 'cafebabe', 'gpt-6.2-sol', 'medium', NULL, NULL, NULL, 'proj-1', 'paginated'
      )`
    )
    .run(nowSec - 900, nowSec - 600, nowMs - 900000, nowMs - 600000, repo);
  stateDb
    .prepare(
      `INSERT INTO threads VALUES (
        '01a90000-0000-7000-8000-000000000003', '', ?, ?, ?, ?, 'exec', 'user', 'codex_exec',
        ?, 'Timed-out and cleaned task', NULL,
        'Cleaned preview', 512000, 0, 0, 'agy-worker/demo-task-cleaned', 'bead1234', 'gpt-6.2-astra',
        'xhigh', NULL, NULL, NULL, NULL, 'paginated'
      )`
    )
    .run(nowSec - 1200, nowSec - 600, nowMs - 1200000, nowMs - 600000, path.join(worktrees, 'demo-task-cleaned'));
  stateDb.close();

  // 2. goals_1.sqlite
  const goalsDb = new DatabaseSync(path.join(codexHome, 'goals_1.sqlite'));
  goalsDb.exec(`
    CREATE TABLE thread_goals (
      thread_id TEXT PRIMARY KEY, goal_id TEXT, objective TEXT, status TEXT,
      token_budget INTEGER, tokens_used INTEGER, time_used_seconds INTEGER,
      created_at_ms INTEGER, updated_at_ms INTEGER
    );
  `);
  goalsDb
    .prepare(
      `INSERT INTO thread_goals VALUES (
        '01a90000-0000-7000-8000-000000000002', 'goal-1', 'Refactor API router', 'blocked',
        2000000, 42000, 120, ?, ?
      )`
    )
    .run(nowMs - 900000, nowMs - 600000);
  goalsDb.close();

  // 3. queue_1.sqlite
  const queueDb = new DatabaseSync(path.join(codexHome, 'queue_1.sqlite'));
  queueDb.exec(`
    CREATE TABLE queued_items (
      id TEXT PRIMARY KEY, thread_id TEXT, payload_json TEXT, queue_order INTEGER,
      created_at_ms INTEGER, updated_at_ms INTEGER
    );
  `);
  queueDb.close();

  // 4. thread_history_1.sqlite
  const histDb = new DatabaseSync(path.join(codexHome, 'thread_history_1.sqlite'));
  histDb.exec(`
    CREATE TABLE thread_turns (
      thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT,
      error_json TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER
    );
    CREATE TABLE thread_items (
      thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER,
      created_at_ms INTEGER, item_type TEXT, item_json TEXT
    );
  `);
  histDb
    .prepare(
      `INSERT INTO thread_turns VALUES (
        '01a90000-0000-7000-8000-000000000001', 'turn-1', 1, 'inProgress', NULL, ?, NULL, NULL
      )`
    )
    .run(nowSec - 60);
  histDb
    .prepare(
      `INSERT INTO thread_turns VALUES (
        '01a90000-0000-7000-8000-000000000003', 'turn-1', 1, 'inProgress', NULL, ?, NULL, NULL
      )`
    )
    .run(nowSec - 1200);
  histDb
    .prepare(
      `INSERT INTO thread_items VALUES (
        '01a90000-0000-7000-8000-000000000001', 'turn-1', 'item-1', 1, ?, 'userMessage', ?
      )`
    )
    .run(nowMs - 55000, JSON.stringify({ content: [{ type: 'text', text: 'Build JWT auth' }] }));
  histDb
    .prepare(
      `INSERT INTO thread_items VALUES (
        '01a90000-0000-7000-8000-000000000001', 'turn-1', 'item-2', 2, ?, 'agentMessage', ?
      )`
    )
    .run(
      nowMs - 5000,
      JSON.stringify({
        text: JSON.stringify({ status: 'completed', summary: 'Implemented JWT auth with 18 passing tests.' }),
      })
    );
  histDb.close();

  // 5. Synthetic rollout JSONL with dual 5h (49% used -> 51% rem) + weekly (12% used -> 88% rem)
  const sessionsDir = path.join(codexHome, 'sessions', '2026', '11', '24');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, 'rollout-2026-11-24T17-00-00-01a90000.jsonl'),
    JSON.stringify({
      timestamp: new Date(nowMs).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          limit_id: 'codex',
          plan_type: 'plus',
          primary: { used_percent: 49.0, window_minutes: 300, resets_at: nowSec + 7200 },
          secondary: { used_percent: 12.0, window_minutes: 10080, resets_at: nowSec + 259200 },
          credits: { has_credits: false, unlimited: false, balance: '0' },
        },
      },
    }) + '\n'
  );

  // 6. multi-agent-dispatch state.json + nested turn result.json
  fs.writeFileSync(
    path.join(dispatchDir, 'state.json'),
    JSON.stringify({
      rr_counter: 1,
      tasks: {
        'demo-task-1': {
          task_id: 'demo-task-1',
          backend: 'codex',
          model: 'gpt-6.2-astra',
          effort: 'high',
          difficulty: 'hard',
          repo_root: repo,
          worktree_path: path.join(worktrees, 'demo-task-1'),
          branch: 'agy-worker/demo-task-1',
          isolation: 'worktree',
          sandbox: 'workspace-write',
          session_id: '01a90000-0000-7000-8000-000000000001',
          status: 'running',
          exit_code: null,
          created_at: '2026-11-24T00:00:00+00:00',
          updated_at: '2026-11-24T01:00:00+00:00',
          run_dir: path.join(dispatchDir, 'runs', 'demo-task-1'),
        },
        'demo-task-cleaned': {
          task_id: 'demo-task-cleaned',
          backend: 'codex',
          model: 'gpt-6.2-astra',
          effort: 'xhigh',
          difficulty: 'hard',
          repo_root: repo,
          worktree_path: path.join(worktrees, 'demo-task-cleaned'),
          branch: 'agy-worker/demo-task-cleaned',
          isolation: 'worktree',
          sandbox: 'workspace-write',
          session_id: '01a90000-0000-7000-8000-000000000003',
          status: 'cleaned',
          exit_code: 124,
          created_at: '2026-11-24T00:00:00+00:00',
          updated_at: '2026-11-24T00:15:00+00:00',
          run_dir: path.join(dispatchDir, 'runs', 'demo-task-cleaned'),
        },
      },
    })
  );
  fs.writeFileSync(
    path.join(dispatchDir, 'runs', 'demo-task-1', 'turn-20261124-010000-abc123', 'result.json'),
    JSON.stringify({
      report: {
        status: 'completed',
        summary: 'Resume turn verified all 18 tests cleanly.',
        files_modified: ['src/auth.py', 'tests/test_auth.py'],
        verification_passed: true,
        risks_or_followups: [],
      },
    })
  );
}

async function connect(env, pluginData) {
  const child = spawn('bash', [LAUNCHER, '--data-dir', pluginData], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 1;
  let buf = '';
  let stderr = '';
  const closed = once(child, 'close');

  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const { id, result, error } = JSON.parse(line);
      const waiter = pending.get(id);
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      pending.delete(id);
      if (error) waiter.reject(new Error(error.message));
      else waiter.resolve(result);
    }
  });
  child.on('close', code => {
    for (const { timer, reject } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(`Server exited (${code}) ${stderr}`));
    }
    pending.clear();
  });
  function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout calling ${method} ${stderr}`));
      }, 10_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  try {
    const init = await rpc('initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ci-test', version: '1.0.0' },
    });
    assert.ok(init.capabilities.tools);
    assert.ok(init.capabilities.resources);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  } catch (err) {
    child.kill();
    throw err;
  }
  const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });
  return {
    rpc, call,
    async data(name, args = {}) {
      const res = await call(name, args);
      assert.ok(!res.isError, res.content?.[0]?.text);
      return res.structuredContent;
    },
    async close() {
      child.kill();
      await closed;
    },
  };
}

async function runTests() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alc-test-'));
  const codexHome = path.join(tmp, 'codex-home');
  const dispatchDir = path.join(tmp, 'dispatch-state');
  const pluginData = path.join(tmp, 'plugin-data');
  const codexBin = path.join(tmp, 'fixture-codex');
  const cache = path.join(codexHome, 'models_cache.json');
  const script = path.join(tmp, 'dispatch fixture.py');
  const env = {
    ...process.env, CODEX_HOME: codexHome, CODEX_BIN: codexBin, AGY_MODELS_CACHE_FILE: '',
    AGY_DISPATCH_STATE_DIR: dispatchDir, AGY_DISPATCH_SCRIPT: script,
  };
  const defaults = { uiStyle: 'minimal', catEnabled: true, catLinkTaskStatus: false };
  let client;
  try {
    createSyntheticCodexHome(codexHome, dispatchDir);
    fs.writeFileSync(codexBin, `#!/usr/bin/env node
const args = process.argv.slice(2);
const i = args.indexOf('-o');
if (i >= 0) require('node:fs').writeFileSync(args[i + 1], JSON.stringify(args));
else console.log(JSON.stringify(args));
`, { mode: 0o755 });
    fs.writeFileSync(script, `import json, sys
print(json.dumps({"args": sys.argv[1:], "session_id": "fixture-session"}))
`);
    const models = [
      { slug: 'gpt-6.9-astra', priority: 0 },
      { slug: 'gpt-6.10-sol', context_window: 1_000_000 },
      { slug: 'gpt-6.10-astra', context_window: 400_000 },
      { slug: 'gpt-99-astra', visibility: 'hide' },
    ];
    fs.writeFileSync(cache, JSON.stringify({ models: models.map(m => ({ visibility: 'list', ...m })) }));
    client = await connect(env, pluginData);
    const data = (name, args) => client.data(name, args);
    const prefs = async (action, patch) => (await data('console_ui_prefs', { action, prefs: patch })).uiPrefs;
    const snapshot = () => data('console_snapshot');
    const toolList = (await client.rpc('tools/list')).tools;
    const openTool = toolList.find(t => t.name === 'open_codex_console');
    assert.equal(openTool._meta.ui.resourceUri, 'ui://codex-console/app.html');
    assert.equal(openTool._meta['com.google.antigravity/ui'].entrypoints.length, 2);
    assert.ok(toolList.some(t => t.name === 'console_ui_prefs'));
    assert.ok(!toolList.some(t => t.name === 'console_engine_settings'));
    assert.equal((await data('open_codex_console', { tab: 'settings' })).initialTab, 'settings');
    const resource = (await client.rpc('resources/read', { uri: openTool._meta.ui.resourceUri })).contents[0];
    assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
    assert.ok(resource.text.length > 10_000);

    const snap = await snapshot();
    assert.equal(snap.connected, true);
    assert.deepEqual(snap.uiPrefs, defaults);
    assert.deepEqual(await prefs(), defaults);
    assert.deepEqual(Object.keys(snap.stats).sort(), [
      'totalThreads', 'loadedThreads', 'visibleThreads', 'agyCount', 'execCount', 'runningCount',
      'goalBlockedCount', 'goalActiveCount', 'pinnedCount', 'managedCount', 'subagentThreadCount',
      'collabCount', 'runningOpsCount',
    ].sort());
    assert.equal(snap.stats.runningCount, 1);
    assert.equal(snap.stats.goalBlockedCount, 1);
    assert.equal(snap.stats.agyCount, 2);
    assert.equal(snap.stats.managedCount, 2);
    assert.equal(snap.codexEnv.binPath, codexBin);
    assert.equal(snap.codexEnv.available, true);
    assert.equal(snap.codexEnv.cacheExists, true);
    assert.equal(snap.codexEnv.cachePath, cache);
    assert.equal(snap.codexEnv.flagshipModel, 'gpt-6.10-astra');
    assert.equal(snap.codexEnv.wideFastModel, 'gpt-6.10-sol');
    assert.equal(snap.codexEnv.models.length, 3);
    assert.equal(snap.runtime.dispatchScript, script);
    assert.equal(snap.quota.planType, 'plus');
    assert.equal(snap.quota.windows.length, 2);
    assert.equal(snap.quota.bottleneck.key, '5h');
    assert.equal(snap.quota.bottleneck.remainingPercent, 51);

    const task = snap.tasks.find(t => t.id.endsWith('001'));
    const cleaned = snap.tasks.find(t => t.id.endsWith('003'));
    assert.equal(task.latestReply, 'Implemented JWT auth with 18 passing tests.');
    assert.equal(cleaned.status.code, 'exec_done');
    assert.equal(cleaned.status.label, '已清理(曾超时)');
    const agent = snap.managedAgents.find(m => m.id === 'demo-task-1');
    assert.equal(agent.summary, 'Resume turn verified all 18 tests cleanly.');
    assert.equal(agent.changedFiles.length, 2);
    assert.equal((await data('get_codex_task_detail', { threadId: task.id })).messages.length, 2);
    const ambiguous = await client.call('send_codex_message', { threadId: task.shortId, message: 'Continue' });
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.content[0].text, /完整会话 ID/);
    assert.equal((await data('list_codex_tasks', { status: 'blocked' })).totalMatched, 1);
    const stateFile = path.join(dispatchDir, 'state.json');
    const recorded = JSON.parse(fs.readFileSync(stateFile));
    for (const status of ['failed', 'completed']) {
      recorded.tasks['demo-task-cleaned'].status = status;
      fs.writeFileSync(stateFile, JSON.stringify(recorded));
      const latest = await snapshot();
      assert.equal(latest.stats.runningCount, 1);
      assert.notEqual(latest.tasks.find(t => t.id === cleaned.id).status.code, 'running');
    }

    await data('console_toggle_pin', { threadId: task.id, pinned: true, customTitle: 'Auth Worker' });
    let updated = (await snapshot()).tasks.find(t => t.id === task.id);
    assert.equal(updated.pinned, true);
    assert.equal(updated.title, 'Auth Worker');
    await data('console_toggle_pin', { threadId: task.id, hidden: true });
    updated = (await snapshot()).tasks.find(t => t.id === task.id);
    assert.equal(updated.hidden, true);
    assert.equal(updated.pinned, false);
    await data('console_toggle_pin', { threadId: task.id, hidden: false });

    const chosen = { uiStyle: 'glow', catEnabled: false, catLinkTaskStatus: true };
    await prefs('save', { uiStyle: 'glow', catLinkTaskStatus: true });
    assert.deepEqual(await prefs('save', { catEnabled: false }), chosen);
    for (const patch of [{ uiStyle: 'unknown' }, { uiStyle: 'minimal', catEnabled: 'true' }, { unknown: 'field' }]) {
      assert.equal((await client.call('console_ui_prefs', { action: 'save', prefs: patch })).isError, true);
    }
    await client.close();
    client = await connect(env, pluginData);
    assert.deepEqual((await snapshot()).uiPrefs, chosen);
    assert.deepEqual(await prefs('reset'), defaults);
    assert.deepEqual(await prefs('get'), defaults);
    const db = new DatabaseSync(path.join(pluginData, 'console.sqlite'));
    try {
      const insert = db.prepare('INSERT INTO ui_prefs VALUES (?, ?, ?)');
      insert.run('uiStyle', 'unknown', Date.now());
      insert.run('catEnabled', '0', Date.now());
      insert.run('obsolete', 'true', Date.now());
      assert.deepEqual(await prefs('get'), defaults);
      assert.deepEqual(await prefs('reset'), defaults);
    } finally {
      db.close();
    }

    const changeKey = 'change-auth';
    const { binding } = await data('manage_collab_binding', { action: 'upsert', changeKey, threadId: task.id });
    assert.equal(binding.ownerRole, 'codex');
    await data('manage_collab_binding', { action: 'log_message', id: binding.id, messageContent: 'Ready to review' });
    assert.equal((await data('manage_collab_binding', { action: 'list' })).bindings[0].messages[0].content, 'Ready to review');
    await data('manage_collab_binding', { action: 'delete', id: binding.id });
    assert.deepEqual((await data('manage_collab_binding', { action: 'list' })).bindings, []);

    async function finish(name, input) {
      let { op } = await data(name, input);
      for (let i = 0; i < 120 && op.status === 'running'; i++) {
        await new Promise(resolve => setTimeout(resolve, 30));
        ({ op } = await data('console_get_op', { opId: op.id }));
      }
      assert.equal(op.status, 'succeeded', op.errorText || op.status);
      return JSON.parse(op.outputText);
    }
    const ask = await finish('ask_codex_readonly', { threadId: task.id, prompt: 'Look at the tests' });
    assert.deepEqual(ask.slice(0, 2), ['exec', 'fork']);
    assert.ok(ask.includes('--ephemeral'));
    assert.ok(ask.includes('sandbox_mode="read-only"'));
    assert.deepEqual(ask.slice(-2), [task.id, 'Look at the tests']);
    const message = { threadId: task.id, message: 'Continue' };
    const queue = await finish('send_codex_message', message);
    assert.ok(queue.includes('queue') && queue.includes('--resume'));
    assert.equal(queue[queue.indexOf('--thread') + 1], task.id);
    assert.equal((await client.call('send_codex_message', message)).isError, true);
    const resume = await finish('send_codex_message', { ...message, mode: 'resume' });
    assert.deepEqual(resume.slice(0, 2), ['exec', 'resume']);
    assert.deepEqual(resume.slice(-2), [task.id, 'Continue']);
    const managed = await finish('send_codex_message', { ...message, mode: 'dispatch_resume' });
    assert.deepEqual(managed.args, ['resume', '--task-id', 'demo-task-1', '--prompt', 'Continue']);

    const prompt = 'Compile the project';
    const spawn = (options = {}) => finish('spawn_codex_worker', { cwd: tmp, prompt, ...options });
    const baseArgs = ['run', '--cwd', tmp, '--difficulty', 'auto', '--quality', 'smart', '--isolation', 'worktree', '--prompt', prompt];
    assert.deepEqual((await spawn()).args, baseArgs);
    const requested = await spawn({ model: 'gpt-6.10-sol', network: true, taskId: 'demo-worker', changeKey });
    assert.deepEqual(requested.args.slice(0, baseArgs.length), baseArgs);
    assert.equal(requested.args[requested.args.indexOf('--model') + 1], 'gpt-6.10-sol');
    assert.equal(requested.args[requested.args.indexOf('--task-id') + 1], 'demo-worker');
    assert.ok(requested.args.includes('--network'));
    assert.equal((await data('manage_collab_binding', { action: 'list' })).bindings[0].threadId, 'fixture-session');

    fs.unlinkSync(cache);
    const fallback = (await snapshot()).codexEnv;
    assert.equal(fallback.cacheExists, false);
    assert.equal(fallback.flagshipModel, 'gpt-6.2-astra');
    assert.equal(fallback.wideFastModel, 'gpt-6.2-sol');
    fs.renameSync(path.join(codexHome, 'state_5.sqlite'), path.join(codexHome, 'state-backup.sqlite'));
    recorded.tasks.pending = { task_id: 'pending', backend: 'codex', status: 'running' };
    recorded.tasks.foreign = { task_id: 'foreign', backend: 'other-cli', status: 'running' };
    fs.writeFileSync(stateFile, JSON.stringify(recorded));
    const dispatchOnly = await snapshot();
    assert.equal(dispatchOnly.connected, false);
    assert.ok(dispatchOnly.tasks.some(t => t.id === 'pending'));
    assert.ok(!dispatchOnly.tasks.some(t => t.id === 'foreign'));
    const pendingAsk = await client.call('ask_codex_readonly', { threadId: 'pending', prompt: 'Status?' });
    assert.equal(pendingAsk.isError, true);
    assert.match(pendingAsk.content[0].text, /尚未关联 Codex 会话/);
    console.log('[PASS] Codex MCP tools, model discovery, SQLite preferences, terminal states and execution arguments.');
  } finally {
    if (client) await client.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

runTests().catch(err => {
  console.error('[FAIL]', err);
  process.exitCode = 1;
});
