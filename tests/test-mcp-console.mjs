import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { buildThreadProgress, summarizeEnglishToChinese } from '../plugins/codex-console/server/progress-summary.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const LAUNCHER = path.join(ROOT, 'plugins', 'codex-console', 'bin', 'run-server.sh');

function testProgressRules() {
  const progress = (code, items = [], extra = {}) => buildThreadProgress({ task: { status: { code } }, items, ...extra });
  for (const [code, label] of Object.entries({
    running: '执行中', goal_active: '执行中', blocked: '已阻塞', limited: '额度受限', failed: '执行异常',
    paused: '已暂停', exec_done: '已完成', complete: '已完成', completed: '已完成', archived: '已归档', idle: '已就绪',
  })) assert.equal(progress(code).statusLabel, label);

  const plan = { type: 'plan', turnId: 'plan-turn', ordinal: 2, text: '## 1. 核对记录\n说明\n### Step 2: 调整界面\n3. 验证结果' };
  const updates = ['已核对记录。', '正在调整界面。'].map((text, i) => ({
    type: 'agentMessage', phase: 'commentary', text, ordinal: i + 3,
  }));
  const statuses = p => p.steps.map(step => step.status);
  assert.deepEqual(statuses(progress('complete', [plan])), ['done', 'done', 'done']);
  assert.deepEqual(statuses(progress('running', [plan])), ['in_progress', 'pending', 'pending']);
  assert.deepEqual(statuses(progress('failed', [...updates, plan])), ['done', 'failed', 'pending']);
  const turns = [{ turn_id: 'plan-turn', status: 'completed' }, { turn_id: 'earlier-turn', status: 'completed' }];
  assert.deepEqual(statuses(progress('blocked', [plan], { turns })), ['done', 'pending', 'pending']);
  assert.deepEqual(statuses(progress('goal_active', [plan, ...updates], { turns })), ['done', 'in_progress', 'pending']);
  const earlier = { ...plan, ordinal: 1, text: '- [x] 旧步骤\n- [x] 第二项' };
  assert.deepEqual(progress('running', [plan, earlier, ...updates]).steps.map(s => s.title), ['核对记录', '调整界面', '验证结果']);
  const list = progress('running', [{ type: 'userMessage', text: '请按以下步骤执行\n1. 读取记录\n2. 核对差异' }]);
  assert.equal(list.source, 'plan');
  assert.deepEqual(statuses(list), ['in_progress', 'pending']);
  const boxed = { type: 'plan', text: '- [ ] 先核对\n- [x] 已记录\n- [ ] 后验证' };
  assert.deepEqual(statuses(progress('running', [boxed])), ['in_progress', 'done', 'pending']);
  assert.deepEqual(statuses(progress('completed', [boxed])), ['pending', 'done', 'pending']);
  assert.equal(progress('running', [{ type: 'plan', text: Array.from({ length: 12 }, (_, i) => `${i + 1}. 步骤 ${i + 1}`).join('\n') }]).totalSteps, 8);
  const codeExample = { type: 'userMessage', text: '示例\n```md\n1. 样例甲\n2. 样例乙\n```' };
  assert.deepEqual(progress('running', [codeExample]).steps, []);
  const ordinaryList = { type: 'agentMessage', text: '常见水果有\n1. 苹果\n2. 香蕉\n3. 橙子' };
  assert.deepEqual(progress('idle', [ordinaryList]).steps, []);

  assert.deepEqual(statuses(progress('failed', updates)), ['done', 'failed']);
  assert.deepEqual(statuses(progress('exec_done', updates)), ['done', 'done']);
  assert.deepEqual(progress('running', [updates[0], updates[0], { type: 'agentMessage', text: 'OK' }]).steps, []);
  const many = Array.from({ length: 9 }, (_, i) => ({ type: 'agentMessage', text: `核对第 ${i} 项记录。` }));
  assert.deepEqual(progress('running', many).steps.map(s => s.title), many.slice(-6).map(m => m.text.slice(0, -1)));

  for (const [raw, expected] of [
    ['**Rerunning updated build tests**', '正在重新运行构建与测试'],
    ['Now read runner.mjs and index.mjs', '正在查看 runner.mjs 和 index.mjs'],
    ['**Checking fallback and UI prefs**', '正在检查回退逻辑与界面偏好'],
    ['Code review completed. Updated main.js and styles.css. 18 tests passed.', '已完成代码审查，涉及 main.js 和 styles.css，18 项测试已通过'],
    ['Failed to update preferences.', '修改界面偏好失败'],
    ['No tests passed.', '没有测试通过'],
  ]) assert.equal(summarizeEnglishToChinese(raw), expected);
  assert.doesNotMatch(summarizeEnglishToChinese('Checking whether the tests passed.'), /已通过/);
  const cn = { type: 'agentMessage', text: JSON.stringify({ summary: '**已核对** [记录](local.md) 与 `main.js`。继续处理下一项。' }) };
  assert.equal(progress('running', [cn]).summary, '已核对 记录 与 main.js。');
  const trace = { type: 'reasoning', text: '**Checking fallback and UI prefs**', ordinal: 5, createdAtMs: 100 };
  const live = progress('running', [trace]);
  assert.equal(live.currentAction, '正在检查回退逻辑与界面偏好');
  assert.equal(live.summary, live.currentAction);
  assert.equal(live.updatedAtMs, 100);
  assert.equal(progress('paused', [trace]).currentAction, null);
  assert.equal(progress('running', [trace, { ...cn, ordinal: 6 }]).currentAction, null);
  assert.equal(progress('running', [trace, { type: 'userMessage', ordinal: 6, text: '继续' }]).currentAction, null);
  assert.equal(progress('running', [{ type: 'commandExecution', text: '$ npm run build && npm test [completed]' }]).currentAction, '正在运行构建与测试');
  const long = progress('running', [{ type: 'agentMessage', text: '正在核对记录'.repeat(50) }, ...updates]);
  assert.ok(long.steps.every(s => s.title.length <= 34));
  assert.ok(progress('running', [{ ...cn, text: '正在核对记录'.repeat(50) }]).summary.length <= 96);
}

function insertHistory(db, threadId, ordinal, type, payload, createdAtMs = Date.now()) {
  db.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    threadId, 'turn-1', `item-${ordinal}`, ordinal, createdAtMs, type, JSON.stringify(payload),
  );
}

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
        phase: 'final',
        text: JSON.stringify({ status: 'completed', summary: 'Implemented JWT auth with 18 passing tests.' }),
      })
    );
  const english = '01a90000-0000-7000-8000-000000000001';
  const chinese = '01a90000-0000-7000-8000-000000000002';
  const simple = '01a90000-0000-7000-8000-000000000003';
  const traces = [
    ['reasoning', { summary: ['**Checking fallback and UI prefs**'] }],
    ['commandExecution', { command: 'npm test', status: 'completed' }],
    ['mcpToolCall', { server: 'codex', tool: 'open_in_codex', arguments: { path: 'ui/main.js' },
      status: 'completed', result: { content: [{ type: 'text', text: 'Opened file' }] } }],
    ['webSearch', { action: { queries: ['UI preferences', 'unused query'] },
      results: ['First', 'Second', 'Third', 'Fourth'].map(title => ({ title, url: `https://example.org/${title}` })) }],
    ['fileChange', { changes: [{ path: 'ui/main.js', kind: { type: 'update' } }, { path: 'ui/styles.css' }] }],
  ];
  traces.forEach(([type, payload], i) => insertHistory(histDb, english, 3 + i, type, payload, nowMs - 4000 + i));
  ['**已读完现有记录**。', '已接入进度摘要。', '已核对动态页的设置。等待确认。'].forEach((text, i) =>
    insertHistory(histDb, chinese, i + 1, 'agentMessage', { text, phase: 'commentary' }, nowMs - 3000 + i));
  insertHistory(histDb, simple, 1, 'userMessage', { text: '你好，今天的安排是什么？' });
  insertHistory(histDb, simple, 2, 'agentMessage', { text: '今天安排了例会。' });
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
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'codex-console', 'package.json'), 'utf8'));
    const init = await rpc('initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ci-test', version: pkg.version },
    });
    assert.ok(init.capabilities.tools);
    assert.ok(init.capabilities.resources);
    assert.equal(init.serverInfo?.name, 'codex-console');
    assert.equal(init.serverInfo?.version, pkg.version);
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
  testProgressRules();
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
  const defaults = { uiStyle: 'minimal', catEnabled: true, catLinkTaskStatus: false, progressCardEnabled: true, traceDisplayMode: 'grouped' };
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
    const detail = threadId => data('get_codex_task_detail', { threadId });
    assert.deepEqual(toolList.find(t => t.name === 'get_codex_task_detail')._meta.ui.visibility, ['model', 'app']);
    const english = await detail(task.id);
    assert.ok(english.git);
    assert.deepEqual(english.messages.map(m => m.type), ['userMessage', 'agentMessage', 'reasoning', 'commandExecution', 'mcpToolCall', 'webSearch', 'fileChange']);
    assert.equal(english.messages[1].phase, 'final');
    assert.equal(english.messages[4].text, 'codex.open_in_codex ui/main.js [completed]\n参数 {"path":"ui/main.js"}\n结果 Opened file');
    assert.equal(english.messages[5].text, 'UI preferences · 4 条结果\nFirst · example.org\nSecond · example.org\nThird · example.org');
    assert.equal(english.progress.statusLabel, '执行中');
    assert.deepEqual(english.progress.steps, []);
    assert.equal(english.progress.summary, '已实现 JWT 认证，18 项测试已通过');
    assert.equal(english.progress.currentAction, '正在修改 main.js 等 2 个文件');
    const chinese = await detail(snap.tasks.find(t => t.status.code === 'blocked').id);
    assert.ok(chinese.messages.every(m => m.phase === 'commentary'));
    assert.equal(chinese.progress.source, 'commentary');
    assert.equal(chinese.progress.statusLabel, '已阻塞');
    assert.equal(chinese.progress.summary, '已核对动态页的设置。');
    assert.deepEqual(chinese.progress.steps, [
      { title: '已读完现有记录', status: 'done' }, { title: '已接入进度摘要', status: 'done' },
      { title: '已核对动态页的设置', status: 'pending' },
    ]);
    assert.equal(chinese.progress.completedSteps, 2);
    assert.equal(chinese.progress.totalSteps, 3);
    const simple = await detail(cleaned.id);
    assert.equal(simple.messages[1].phase, null);
    assert.equal(simple.progress.source, 'summary');
    assert.equal(simple.progress.summary, '今天安排了例会。');
    assert.deepEqual(simple.progress.steps, []);

    const history = new DatabaseSync(path.join(codexHome, 'thread_history_1.sqlite'));
    try {
      insertHistory(history, task.id, 8, 'plan', { text: '- [x] 核对现有实现\n- [ ] 接入进度摘要\n- [ ] 验证显示偏好' });
      insertHistory(history, task.id, 9, 'agentMessage', { phase: 'commentary', text: '已经核对本地记录。' });
      const planned = (await detail(task.id)).progress;
      assert.equal(planned.source, 'plan');
      assert.deepEqual(planned.steps, [
        { title: '核对现有实现', status: 'done' }, { title: '接入进度摘要', status: 'in_progress' },
        { title: '验证显示偏好', status: 'pending' },
      ]);
      assert.equal(planned.completedSteps, 1);
      assert.equal(planned.currentAction, null);
      const agents = [
        { agentThreadId: 'agent-a', agentPath: '/root/a', kind: 'started' },
        { agentPath: '/root/b', kind: 'started' },
        { agentThreadId: 'agent-a', agentPath: '/root/a', kind: 'completed' },
        { agentPath: '/root/b', kind: 'failed' },
      ];
      agents.forEach((payload, i) => insertHistory(history, cleaned.id, 3 + i, 'subAgentActivity', payload));
      const subagents = (await detail(cleaned.id)).progress;
      assert.equal(subagents.source, 'subagents');
      assert.deepEqual(subagents.steps, [{ title: '/root/a', status: 'done' }, { title: '/root/b', status: 'failed' }]);
      assert.equal(subagents.completedSteps, 1);
      for (let i = 0; i < 45; i++) insertHistory(history, task.id, 10 + i, 'userMessage', { text: '继续' });
      for (let i = 0; i < 125; i++) insertHistory(history, task.id, 55 + i, 'reasoning', { summary: ['Reading main.js'] });
      const busy = await detail(task.id);
      assert.equal(busy.messages.length, 160);
      assert.equal(busy.messages.filter(m => m.type === 'reasoning').length, 120);
      assert.ok(!busy.messages.some(m => m.type === 'plan'));
      assert.deepEqual(busy.progress.steps, planned.steps);
    } finally {
      history.close();
    }
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

    const chosen = { uiStyle: 'glow', catEnabled: false, catLinkTaskStatus: true, progressCardEnabled: false, traceDisplayMode: 'expanded' };
    await prefs('save', { uiStyle: 'glow', catLinkTaskStatus: true, progressCardEnabled: false, traceDisplayMode: 'expanded' });
    assert.deepEqual(await prefs('save', { catEnabled: false }), chosen);
    for (const patch of [{ uiStyle: 'unknown' }, { uiStyle: 'minimal', catEnabled: 'true' }, { unknown: 'field' },
      { traceDisplayMode: 'invalid', progressCardEnabled: true }, { progressCardEnabled: 'yes' }]) {
      assert.equal((await client.call('console_ui_prefs', { action: 'save', prefs: patch })).isError, true);
    }
    assert.deepEqual(await prefs('get'), chosen);
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
      insert.run('traceDisplayMode', 'invalid', Date.now());
      insert.run('progressCardEnabled', 'yes', Date.now());
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
    const synthetic = await detail(task.id);
    assert.equal(synthetic.task.source, 'dispatch');
    assert.deepEqual(synthetic.progress.steps, []);
    assert.match(synthetic.progress.summary, /检查.*测试/);
    assert.equal((await detail('pending')).progress.source, 'summary');
    assert.equal((await detail(cleaned.id)).progress.source, 'subagents');
    const pendingAsk = await client.call('ask_codex_readonly', { threadId: 'pending', prompt: 'Status?' });
    assert.equal(pendingAsk.isError, true);
    assert.match(pendingAsk.content[0].text, /尚未关联 Codex 会话/);
    console.log('[PASS] Codex MCP tools, progress and traces, model discovery, SQLite preferences, terminal states and execution arguments.');
  } finally {
    if (client) await client.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

runTests().catch(err => {
  console.error('[FAIL]', err);
  process.exitCode = 1;
});
