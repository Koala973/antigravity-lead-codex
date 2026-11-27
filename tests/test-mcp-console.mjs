import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const LAUNCHER = path.join(ROOT, 'plugins', 'codex-console', 'bin', 'run-server.sh');

function createSyntheticCodexHome(codexHome, zcodeHome, dispatchDir) {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(path.join(zcodeHome, 'cli', 'db'), { recursive: true });
  fs.mkdirSync(path.join(zcodeHome, 'v2'), { recursive: true });
  fs.mkdirSync(path.join(dispatchDir, 'runs', 'demo-task-1', 'turn-20261124-010000-abc123'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(dispatchDir, 'runs', 'demo-zcode-1'), {
    recursive: true,
  });

  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();

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
        '/tmp/worktrees/acme-api/demo-task-1', 'Implement JWT auth and unit tests', NULL,
        'Preview text', 1250000, 0, 0, 'agy-worker/demo-task-1', 'deadbeef', 'gpt-6.2-astra',
        'high', NULL, NULL, NULL, NULL, 'paginated'
      )`
    )
    .run(nowSec - 300, nowSec, nowMs - 300000, nowMs);
  stateDb
    .prepare(
      `INSERT INTO threads VALUES (
        '01a90000-0000-7000-8000-000000000002', '', ?, ?, ?, ?, 'vscode', 'user', 'codex_work_desktop',
        '/tmp/acme-api', 'Desktop chat thread', 'Desktop Refactor', 'Desktop preview',
        42000, 0, 0, 'main', 'cafebabe', 'gpt-6.2-sol', 'medium', NULL, NULL, NULL, 'proj-1', 'paginated'
      )`
    )
    .run(nowSec - 900, nowSec - 600, nowMs - 900000, nowMs - 600000);
  stateDb
    .prepare(
      `INSERT INTO threads VALUES (
        '01a90000-0000-7000-8000-000000000003', '', ?, ?, ?, ?, 'exec', 'user', 'codex_exec',
        '/tmp/worktrees/acme-api/demo-task-cleaned', 'Timed-out and cleaned task', NULL,
        'Cleaned preview', 512000, 0, 0, 'agy-worker/demo-task-cleaned', 'bead1234', 'gpt-6.2-astra',
        'xhigh', NULL, NULL, NULL, NULL, 'paginated'
      )`
    )
    .run(nowSec - 1200, nowSec - 600, nowMs - 1200000, nowMs - 600000);
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
          repo_root: '/tmp/acme-api',
          worktree_path: '/tmp/worktrees/acme-api/demo-task-1',
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
        'demo-claude': {
          task_id: 'demo-claude', session_id: 'sess_fixture_claude', backend: 'claude',
          model: 'claude-fixture-model', status: 'completed', exit_code: 0, workdir: dispatchDir,
          created_at: '2026-11-24T00:05:00Z', updated_at: '2026-11-24T00:10:00Z',
          run_dir: path.join(dispatchDir, 'runs', 'demo-claude'),
        },
        'demo-task-cleaned': {
          task_id: 'demo-task-cleaned',
          backend: 'codex',
          model: 'gpt-6.2-astra',
          effort: 'xhigh',
          difficulty: 'hard',
          repo_root: '/tmp/acme-api',
          worktree_path: '/tmp/worktrees/acme-api/demo-task-cleaned',
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

  const cliRun = path.join(dispatchDir, 'runs', 'demo-claude');
  fs.mkdirSync(cliRun, { recursive: true });
  fs.writeFileSync(path.join(cliRun, 'prompt.txt'), 'Describe the fixture.');
  fs.writeFileSync(path.join(cliRun, 'result.json'), JSON.stringify({ report: { summary: 'Fixture ready.' } }));

  // 7. Synthetic ZCode tasks-index.sqlite + cli/db/db.sqlite
  const zIdxDb = new DatabaseSync(path.join(zcodeHome, 'v2', 'tasks-index.sqlite'));
  zIdxDb.exec(`
    CREATE TABLE projects (project_id TEXT PRIMARY KEY, name TEXT, deleted INTEGER);
    CREATE TABLE project_roots (project_id TEXT, root_path TEXT);
    CREATE TABLE tasks (
      workspace_path TEXT, task_id TEXT, title TEXT, cli_title TEXT,
      task_status TEXT, mode TEXT, model TEXT, created_at INTEGER, updated_at INTEGER,
      pinned INTEGER, archived INTEGER, deleted INTEGER, cli_deleted INTEGER,
      searchable_text TEXT, project_id TEXT, root_path TEXT, worktree_root TEXT
    );
  `);
  zIdxDb.prepare(`INSERT INTO projects VALUES ('zproj-1', 'Security Audit Demo', 0)`).run();
  zIdxDb.prepare(`INSERT INTO project_roots VALUES ('zproj-1', '/tmp/sec-audit')`).run();
  zIdxDb
    .prepare(
      `INSERT INTO tasks VALUES (
        '/tmp/sec-audit', 'sess_zcode_demo_001', '提取图片中的问题描述', '提取图片中的问题描述',
        'completed', 'build', 'qwen-alibaba-model-studio-cn/kimi-k3', ?, ?,
        0, 0, 0, 0, '提取下群的内容\n操作日志接口越权读取仍存在', 'zproj-1', '/tmp/sec-audit', NULL
      )`
    )
    .run(nowMs - 400000, nowMs - 100000);
  zIdxDb.close();

  const zCliDb = new DatabaseSync(path.join(zcodeHome, 'cli', 'db', 'db.sqlite'));
  zCliDb.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, directory TEXT, path TEXT, title TEXT,
      time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
      time_deleted INTEGER, last_outcome TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
      time_updated INTEGER, data TEXT, sequence INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT, sequence INTEGER
    );
    CREATE TABLE model_usage (
      id TEXT PRIMARY KEY, session_id TEXT, provider_id TEXT, model_id TEXT,
      variant TEXT, computed_total_tokens INTEGER, provider_total_tokens INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, duration_ms INTEGER, started_at INTEGER
    );
    CREATE TABLE session_runtime_presence (session_id TEXT, owner_id TEXT, process_id INTEGER);
  `);
  zCliDb
    .prepare(
      `INSERT INTO session VALUES (
        'sess_zcode_demo_001', '/tmp/sec-audit', '/tmp/sec-audit', '提取图片中的问题描述',
        ?, ?, NULL, NULL, 'completed'
      )`
    )
    .run(nowMs - 400000, nowMs - 100000);
  zCliDb
    .prepare(
      `INSERT INTO message VALUES ('m-1', 'sess_zcode_demo_001', ?, ?, ?, 1)`
    )
    .run(nowMs - 390000, nowMs - 390000, JSON.stringify({ role: 'user' }));
  zCliDb
    .prepare(
      `INSERT INTO part VALUES ('p-1', 'm-1', 'sess_zcode_demo_001', ?, ?, ?, 0)`
    )
    .run(
      nowMs - 390000,
      nowMs - 390000,
      JSON.stringify({ type: 'text', text: '直接描述这个图的问题' })
    );
  zCliDb
    .prepare(
      `INSERT INTO message VALUES ('m-2', 'sess_zcode_demo_001', ?, ?, ?, 2)`
    )
    .run(nowMs - 380000, nowMs - 380000, JSON.stringify({ role: 'assistant' }));
  zCliDb
    .prepare(
      `INSERT INTO part VALUES ('p-2', 'm-2', 'sess_zcode_demo_001', ?, ?, ?, 0)`
    )
    .run(
      nowMs - 380000,
      nowMs - 380000,
      JSON.stringify({ type: 'text', text: '问题描述：test-pms.shands.cn 操作日志接口越权读取仍存在' })
    );
  zCliDb
    .prepare(
      `INSERT INTO model_usage VALUES (
        'mu-1', 'sess_zcode_demo_001', 'qwen-alibaba-model-studio-cn', 'kimi-k3',
        'max', 18500, 18500, 18000, 500, 6100, ?
      )`
    )
    .run(nowMs - 380000);
  zCliDb.close();
}

async function runTests() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alc-test-'));
  const codexHome = path.join(tmpRoot, 'codex-home');
  const zcodeHome = path.join(tmpRoot, 'zcode-home');
  const dispatchDir = path.join(tmpRoot, 'dispatch-state');
  const pluginData = path.join(tmpRoot, 'plugin-data');

  let child;
  try {
    createSyntheticCodexHome(codexHome, zcodeHome, dispatchDir);

    const configFile = path.join(dispatchDir, 'engine_config.json');
    const claudeCfg = path.join(tmpRoot, 'claude.json');
    const geminiCfg = path.join(tmpRoot, 'gemini.json');
    const codexBin = path.join(tmpRoot, 'fixture-codex');
    fs.writeFileSync(codexBin, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('-o')) require('node:fs').writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({env: process.env.AGY_MODELS_CACHE_FILE, args}));
`, { mode: 0o755 });
    const zcodeBin = path.join(tmpRoot, 'zcode.cjs');
    fs.writeFileSync(zcodeBin, 'console.log(JSON.stringify({result: process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE}));');
    const providerConfig = path.join(zcodeHome, 'v2', 'provider_config.json');
    fs.writeFileSync(providerConfig, JSON.stringify({ config: { providerConfigRules: { providerRules: [
      { providerId: 'demo', providerName: 'Fixture', config: { modelOrder: ['main', 'backup'] } },
    ] } } }));
    fs.writeFileSync(claudeCfg, JSON.stringify({ model: 'claude-fixture-model' }));
    fs.writeFileSync(geminiCfg, JSON.stringify({ model: { name: 'gemini-fixture-model' } }));
    const desktopCache = path.join(codexHome, 'models_cache.codex_work_desktop.json');
    fs.writeFileSync(desktopCache, JSON.stringify({ models: [
      { slug: 'fixture-codex', visibility: 'list', description: 'Demo', context_window: 1234 },
      { slug: 'hidden-codex', visibility: 'hide' },
    ] }));
    fs.writeFileSync(configFile, JSON.stringify({
      version: 1, updatedAtMs: 42, codex: { enabled: true, binPath: codexBin, flagshipModel: 'fixture-codex', fastModel: 'auto', defaultIsolation: 'inplace' },
      zcode: { enabled: true, scriptPath: zcodeBin, syncDesktopIndex: false, routes: {
        wide_1m_context: { primary: 'demo/wide', fallback1: 'demo/backup' },
        code_and_audit: { primary: 'demo/audit', fallback1: 'demo/audit-backup' },
        reasoning_and_business: { primary: 'demo/business', effort: 'high' },
      } },
      customAgents: [{ id: 'legacy-cli', enabled: false, name: 'Legacy CLI', binPath: 'legacy-tool',
        defaultModel: 'legacy-main', effort: 'low', argsTemplate: '--query {prompt}' }, { id: 'claude', enabled: true, configFilePath: claudeCfg, binPath: process.execPath },
        { id: 'gemini', configFilePath: geminiCfg }],
      policy: { reviewPolicy: 'codex_only' },
    }));
    const testEnv = {
        ...process.env,
        CODEX_HOME: codexHome,
        ZCODE_HOME: zcodeHome,
        AGY_DISPATCH_STATE_DIR: dispatchDir,
        AGY_ENGINE_CONFIG_FILE: configFile,
        AGY_DISPATCH_SCRIPT: path.join(ROOT, 'skills', 'multi-agent-dispatch', 'scripts', 'dispatch.py'),
        AGY_MODELS_CACHE_FILE: '', ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: '',
    };
    child = spawn('bash', [LAUNCHER, '--data-dir', pluginData], {
      env: testEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buf = '';
    const pending = new Map();
    let nextId = 1;
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      }
    });

    const rpc = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method} (stderr: ${stderr})`)), 10000);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });

    // 1. Initialize
    const init = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'ci-test', version: '1.0.0' },
    });
    assert.ok(init.result?.capabilities?.tools, 'tools capability advertised');
    assert.ok(init.result?.capabilities?.resources, 'resources capability advertised');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    // 2. Verify tools & UI entrypoints metadata
    const toolsRes = await rpc('tools/list');
    const openTool = toolsRes.result.tools.find((t) => t.name === 'open_codex_console');
    assert.equal(openTool?._meta?.ui?.resourceUri, 'ui://codex-console/app.html');
    assert.equal(openTool?._meta?.['com.google.antigravity/ui']?.entrypoints?.length, 2);
    assert.equal(
      openTool?._meta?.['com.google.antigravity/ui']?.entrypoints?.[0]?.title,
      'Antigravity Lead Codex'
    );

    // 3. Verify bundled single-file HTML resource
    const resRead = await rpc('resources/read', { uri: 'ui://codex-console/app.html' });
    assert.equal(resRead.result.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.ok(resRead.result.contents[0].text.length > 10000, 'bundled app.html is non-empty');

    // 4. Verify console_snapshot merges Codex DBs + ZCode DBs + dispatch turn result & unwraps JSON reply
    const snapRes = await rpc('tools/call', { name: 'console_snapshot', arguments: { limit: 50 } });
    const snap = snapRes.result.structuredContent;
    assert.equal(snap.connected, true);
    assert.equal(snap.stats.runningCount, 1);
    assert.equal(snap.stats.goalBlockedCount, 1);
    assert.equal(snap.stats.codexCount, 3);
    assert.equal(snap.stats.zcodeCount, 1);
    assert.equal(snap.stats.agyCount, 3);
    assert.equal(snap.stats.managedCount, 3);
    const zcodeTask = snap.tasks.find((t) => t.id === 'sess_zcode_demo_001');
    assert.ok(zcodeTask, 'ZCode task loaded into unified console snapshot');
    assert.equal(zcodeTask.engine, 'zcode');
    assert.equal(zcodeTask.model, '百炼/kimi-k3');
    assert.equal(zcodeTask.projectName, 'Security Audit Demo');

    const zDetailRes = await rpc('tools/call', {
      name: 'get_codex_task_detail',
      arguments: { threadId: 'sess_zcode_demo_001' },
    });
    const zDetail = zDetailRes.result.structuredContent;
    assert.equal(zDetail.messages.length, 2);
    assert.ok(zDetail.messages[1].text.includes('操作日志接口越权读取仍存在'));
    const agyTask = snap.tasks.find((t) => t.id === '01a90000-0000-7000-8000-000000000001');
    const cleanedTask = snap.tasks.find((t) => t.id === '01a90000-0000-7000-8000-000000000003');
    assert.equal(cleanedTask.status.code, 'exec_done');
    assert.equal(cleanedTask.status.label, '已清理(曾超时)');
    const cleanedAgent = snap.managedAgents.find((m) => m.id === 'demo-task-cleaned');
    assert.equal(cleanedAgent.status, 'cleaned');
    assert.equal(agyTask.isManagedDispatch, true);
    assert.equal(agyTask.latestReply, 'Implemented JWT auth with 18 passing tests.');
    const demoAgent = snap.managedAgents.find((m) => m.id === 'demo-task-1');
    assert.equal(demoAgent.summary, 'Resume turn verified all 18 tests cleanly.');
    assert.equal(demoAgent.changedFiles.length, 2);

    // 4b. Verify dual-window quota picks minimum remaining (5h 51% < weekly 88%)
    assert.equal(snap.quota?.available, true);
    assert.equal(snap.quota?.planType, 'plus');
    assert.equal(snap.quota?.windows?.length, 2);
    assert.equal(snap.quota?.bottleneck?.key, '5h');
    assert.equal(snap.quota?.bottleneck?.remainingPercent, 51);

    // 5. Verify local pin, custom title & soft-hide drawer persistence
    await rpc('tools/call', {
      name: 'console_toggle_pin',
      arguments: { threadId: agyTask.id, pinned: true, customTitle: 'Auth Service Worker' },
    });
    const snap2 = (await rpc('tools/call', { name: 'console_snapshot', arguments: {} })).result.structuredContent;
    const pinnedTask = snap2.tasks.find((t) => t.id === agyTask.id);
    assert.equal(pinnedTask.pinned, true);
    assert.equal(pinnedTask.hidden, false);
    assert.equal(pinnedTask.title, 'Auth Service Worker');

    await rpc('tools/call', {
      name: 'console_toggle_pin',
      arguments: { threadId: agyTask.id, hidden: true },
    });
    const snapHidden = (await rpc('tools/call', { name: 'console_snapshot', arguments: {} })).result.structuredContent;
    const hiddenTask = snapHidden.tasks.find((t) => t.id === agyTask.id);
    assert.equal(hiddenTask.hidden, true);
    assert.equal(hiddenTask.pinned, false);

    await rpc('tools/call', {
      name: 'console_toggle_pin',
      arguments: { threadId: agyTask.id, hidden: false },
    });

    // 6. Verify cross-session collaboration bindings CRUD
    const upsertRes = await rpc('tools/call', {
      name: 'manage_collab_binding',
      arguments: {
        action: 'upsert',
        changeKey: 'change-jwt-auth',
        goalTitle: 'Implement JWT Auth',
        threadId: agyTask.id,
        ownerRole: 'claude',
        status: 'active',
      },
    });
    const bindingId = upsertRes.result.structuredContent.binding.id;
    assert.ok(bindingId);
    const listBindings = (await rpc('tools/call', { name: 'manage_collab_binding', arguments: { action: 'list' } }))
      .result.structuredContent.bindings;
    assert.equal(listBindings[0].ownerRole, 'claude');
    assert.equal(listBindings.length, 1);
    await rpc('tools/call', { name: 'manage_collab_binding', arguments: { action: 'delete', id: bindingId } });

    const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
    const settings = async (action, config) => {
      const result = await call('console_engine_settings', { action, config });
      assert.ok(!result.isError, result.content?.[0]?.text);
      return result.structuredContent.engineSettings;
    };
    const snapshot = async () => (await call('console_snapshot')).structuredContent;
    const enginesById = cfg => Object.fromEntries(cfg.engines.map(e => [e.id, e]));
    const migrated = await settings('get');
    const pythonConfig = execFileSync('python3', ['-c',
      'import json, runpy, sys; print(json.dumps(runpy.run_path(sys.argv[1])["load_engine_config"]()))',
      testEnv.AGY_DISPATCH_SCRIPT], { encoding: 'utf8', env: testEnv });
    assert.deepEqual(migrated.config, JSON.parse(pythonConfig), 'both loaders migrate the same on-disk v1 fixture identically');
    assert.equal(migrated.configPath, configFile);
    assert.equal(migrated.config.version, 2);
    assert.deepEqual(Object.keys(migrated.config).sort(), ['engines', 'policy', 'updatedAtMs', 'version', 'workflowRoles']);
    assert.equal(migrated.config.policy.defaultIsolation, 'inplace');
    assert.equal(migrated.config.workflowRoles.reviewer.engineId, 'codex');
    assert.deepEqual(migrated.config.workflowRoles.scenarios.wide_context, {
      enabled: true, engineId: 'zcode', model: 'demo/wide', fallbackModel: 'demo/backup', effort: 'max',
    });
    assert.equal(enginesById(migrated.config).codex.models.fallbackModel, '');
    assert.equal(enginesById(migrated.config).zcode.adapter.syncDesktopIndex, false);
    const discovered = migrated.discovery.engines;
    assert.equal(discovered.codex.resolvedConfigPath, desktopCache);
    assert.deepEqual(discovered.codex.models, [{ id: 'fixture-codex', label: 'fixture-codex', description: 'Demo', contextWindow: 1234 }]);
    assert.equal(discovered.zcode.available, true);
    assert.equal(discovered.zcode.detectedBin, zcodeBin);
    assert.equal(discovered.zcode.providers[0].providerName, 'Fixture');
    assert.deepEqual(discovered.zcode.models[0], { id: 'demo/main', label: 'Fixture / main', providerName: 'Fixture', providerId: 'demo', modelId: 'main' });
    for (const [key, id] of [['claude', 'claude-fixture-model'], ['claude', 'claude-opus-4-6'], ['gemini', 'gemini-fixture-model'], ['gemini', 'gemini-2.5-flash']]) {
      assert.ok(discovered[key].models.some(m => m.id === id));
    }

    const task = snap.tasks.find(t => t.engine === 'claude');
    assert.equal(task.id, 'sess_fixture_claude');
    assert.equal(task.engineLabel, 'Claude Code');
    assert.deepEqual([task.model, task.summary, task.status.code], ['claude-fixture-model', 'Fixture ready.', 'exec_done']);
    assert.equal(snap.managedAgents.find(t => t.backend === 'claude').engineLabel, 'Claude Code');
    assert.deepEqual(snap.stats.engineCounts, { codex: 3, zcode: 1, claude: 1, gemini: 0, 'legacy-cli': 0 });
    const detail = (await call('get_codex_task_detail', { threadId: task.id })).structuredContent;
    assert.deepEqual(detail.messages.map(m => [m.type, m.text]), [['userMessage', 'Describe the fixture.'], ['agentMessage', 'Fixture ready.']]);
    const list = (await call('list_codex_tasks', { engine: 'claude' })).structuredContent;
    assert.deepEqual(list.tasks.map(t => t.id), [task.id]);

    await settings('save', { engines: [{ id: 'codex', configFilePath: desktopCache }] });
    const codexAsk = await finish(await call('ask_codex_readonly', { threadId: agyTask.id, prompt: 'Show the cache path' }));
    const nativeAsk = JSON.parse(codexAsk.outputText);
    assert.equal(nativeAsk.env, desktopCache);
    assert.ok(nativeAsk.args.includes('model_catalog_json=' + JSON.stringify(desktopCache)));
    const zcodeAsk = await finish(await call('ask_codex_readonly', { threadId: zcodeTask.id, prompt: 'Show provider config' }));
    assert.equal(zcodeAsk.outputText, providerConfig);

    const routed = await settings('save', { workflowRoles: {
      primaryBuilder: { engineId: 'zcode', model: 'demo/main' }, reviewer: { mode: 'explicit', engineId: 'codex' },
    }, policy: { hideDisabledEngineTasks: true } });
    assert.equal(routed.config.workflowRoles.primaryBuilder.engineId, 'zcode');
    assert.equal(routed.config.workflowRoles.reviewer.engineId, 'codex');
    const noCodex = await settings('save', { engines: [{ id: 'codex', enabled: false }] });
    assert.equal(enginesById(noCodex.config).codex.enabled, false);
    assert.equal(noCodex.config.workflowRoles.reviewer.mode, 'auto_heterogeneous');
    assert.equal(noCodex.config.workflowRoles.reviewer.engineId, '');
    const hiddenCodex = await snapshot();
    assert.equal(hiddenCodex.stats.codexCount, 0);
    assert.ok(hiddenCodex.tasks.every(t => t.engine !== 'codex'));
    assert.ok(hiddenCodex.managedAgents.every(t => t.engine !== 'codex'));
    assert.equal((await call('get_codex_task_detail', { threadId: agyTask.id })).isError, true);
    const onlyClaude = await settings('save', { engines: [{ id: 'zcode', enabled: false }] });
    assert.equal(onlyClaude.config.workflowRoles.primaryBuilder.engineId, 'claude');
    assert.equal(onlyClaude.config.workflowRoles.primaryBuilder.model, 'auto');
    assert.equal((await snapshot()).stats.zcodeCount, 0);

    const current = fs.readFileSync(configFile, 'utf8');
    const rejects = [
      [onlyClaude.config.engines.map(e => ({ id: e.id, enabled: false })), /至少需要启用 1 个 CLI 引擎，无法全部关闭/],
      ...['auto', 'all', '-bad', 'Bad', 'x'.repeat(33)].map(id => [[{ id }], /无效/]),
      [[{ id: 'foo' }, { id: 'foo' }], /重复/],
    ];
    for (const [engines, message] of rejects) {
      const result = await call('console_engine_settings', { action: 'save', config: { engines } });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, message);
      assert.equal(fs.readFileSync(configFile, 'utf8'), current);
    }

    const cli = path.join(tmpRoot, 'fixture-cli.cjs');
    fs.writeFileSync(cli, `console.log(JSON.stringify({session_id:'sess_managed_fixture', result:process.argv.slice(2).join('|')}));`);
    const modelsFile = path.join(tmpRoot, 'models.json');
    fs.writeFileSync(modelsFile, JSON.stringify({ models: [{ id: 'from-file' }] }));
    const argsTemplate = JSON.stringify(cli) + ' -p {prompt} --model {model}';
    const custom = {
      id: 'my-cli', name: 'Fixture CLI', enabled: true, kind: 'custom_cli', binPath: process.execPath,
      configFilePath: modelsFile, models: { primaryModel: 'fixture-main', fallbackModel: 'fixture-backup' },
      adapter: { execTemplate: '{bin} ' + argsTemplate, readonlyTemplate: '{bin} ' + argsTemplate + ' --mode plan',
        resumeTemplate: '{bin} ' + argsTemplate + ' --resume {session_id}' },
    };
    const added = await settings('save', { engines: [...onlyClaude.config.engines, custom],
      workflowRoles: { primaryBuilder: { engineId: 'my-cli', model: 'auto' } } });
    assert.equal(added.discovery.engines['my-cli'].available, true);
    assert.deepEqual(added.discovery.engines['my-cli'].models.map(m => m.id), ['from-file', 'fixture-main', 'fixture-backup']);
    assert.equal(enginesById(added.config)['my-cli'].builtin, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile)), added.config);

    async function finish(result) {
      assert.ok(!result.isError, result.content?.[0]?.text);
      const id = result.structuredContent.op.id;
      for (let i = 0; i < 120; i++) {
        const { op } = (await call('console_get_op', { opId: id })).structuredContent;
        if (op.status !== 'running') {
          assert.equal(op.status, 'succeeded', op.errorText);
          return op;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.fail('CLI operation did not complete');
    }
    const partial = await settings('save', { engines: [{ id: 'zcode', enabled: false }] });
    assert.deepEqual(partial.config.engines, added.config.engines, 'partial save retains registered custom engines and their order');
    assert.ok(enginesById(JSON.parse(fs.readFileSync(configFile)))['my-cli']);

    const beforeBadTemplates = fs.readFileSync(configFile, 'utf8');
    for (const field of ['execTemplate', 'readonlyTemplate', 'resumeTemplate']) {
      for (const openQuote of ["'", '"']) {
        const result = await call('console_engine_settings', { action: 'save', config: {
          engines: [{ id: 'my-cli', adapter: { [field]: '{bin} -p ' + openQuote + '{prompt}' } }],
        } });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /模板引号未闭合/);
        assert.equal(fs.readFileSync(configFile, 'utf8'), beforeBadTemplates);
      }
    }
    const validQuoted = String.raw`{bin} --note "it's a \"quoted\" value" -p {prompt}`;
    await settings('save', { engines: [{ id: 'legacy-cli', adapter: { execTemplate: validQuoted } }] });
    const noBuiltinRemoval = await call('console_engine_settings', { action: 'save', config: { removeEngineIds: ['codex'] } });
    assert.equal(noBuiltinRemoval.isError, true);
    assert.match(noBuiltinRemoval.content[0].text, /内置引擎/);
    const withoutLegacy = await settings('save', { removeEngineIds: ['legacy-cli'] });
    assert.ok(!enginesById(withoutLegacy.config)['legacy-cli']);
    assert.ok(enginesById(withoutLegacy.config)['my-cli']);

    const built = await finish(await call('spawn_codex_worker', {
      cwd: tmpRoot, isolation: 'inplace', prompt: 'Build the fixture', taskId: 'roundtrip',
    }));
    assert.equal(JSON.parse(built.outputText).backend, 'my-cli');
    assert.equal(built.meta.backend, 'my-cli');
    const copy = (await snapshot()).tasks.find(t => t.engine === 'my-cli');
    assert.equal(copy.engineLabel, 'Fixture CLI');
    const messageOp = await finish(await call('send_codex_message', { threadId: copy.id, message: 'continue' }));
    assert.ok(messageOp.outputText.includes('--resume|sess_managed_fixture'));
    const readonly = await finish(await call('ask_codex_readonly', { threadId: copy.id, prompt: 'Read only' }));
    assert.ok(readonly.outputText.includes('--mode|plan'));
    assert.ok(readonly.outputText.includes('--resume|sess_managed_fixture'));
    await settings('save', { engines: [{ id: 'my-cli', enabled: false }] });
    const hiddenCustom = await snapshot();
    assert.ok(hiddenCustom.tasks.every(t => t.engine !== 'my-cli'));
    assert.ok(hiddenCustom.managedAgents.every(t => t.engine !== 'my-cli'));
    const removed = await settings('save', { replaceEngines: true,
      engines: withoutLegacy.config.engines.filter(e => e.id !== 'my-cli' && e.id !== 'gemini') });
    assert.ok(enginesById(removed.config).gemini, 'replacement retains omitted builtins');
    assert.ok(!Object.hasOwn(removed.config, 'replaceEngines'));
    assert.equal(removed.config.engines.length, 4);
    assert.equal(removed.config.workflowRoles.primaryBuilder.engineId, 'claude');
    assert.ok(!(await snapshot()).tasks.some(t => t.engine === 'my-cli'));
    assert.ok(!JSON.parse(fs.readFileSync(configFile)).engines.some(e => e.id === 'my-cli'));
    const reset = await settings('reset');
    assert.equal(reset.config.workflowRoles.primaryBuilder.engineId, 'codex');
    assert.equal(reset.config.workflowRoles.reviewer.mode, 'auto_heterogeneous');
    assert.ok(reset.config.engines.filter(e => e.enabled).every(e => ['codex', 'zcode'].includes(e.id)));

    // Exercise the live MCP entry points against a hand-edited file, with a non-Codex first row.
    const corrupt = structuredClone(removed.config);
    corrupt.engines = [enginesById(corrupt).zcode, ...corrupt.engines.filter(e => e.id !== 'zcode')];
    corrupt.engines.forEach(e => { e.enabled = false; });
    fs.writeFileSync(configFile, JSON.stringify(corrupt));
    const healed = await settings('get');
    assert.deepEqual(healed.config.engines.filter(e => e.enabled).map(e => e.id), ['zcode']);
    assert.deepEqual(healed.config.workflowRoles.primaryBuilder, { engineId: 'zcode', model: 'auto', effort: 'xhigh' });
    const consoleCalls = [['open_codex_console', {}], ['list_codex_tasks', {}],
      ['get_codex_task_detail', { threadId: zcodeTask.id }], ['console_snapshot', {}]];
    for (const [name, args] of consoleCalls) assert.ok(!(await call(name, args)).isError, name);
    fs.writeFileSync(configFile, JSON.stringify({ ...corrupt, engines: [corrupt.engines[0], corrupt.engines[0]] }));
    for (const [name, args] of consoleCalls) {
      const error = await call(name, args);
      assert.equal(error.isError, true, name);
      assert.match(error.structuredContent.error, /重复的 CLI 引擎 ID/);
    }

    fs.unlinkSync(configFile);
    for (const [name, args] of [['ask_codex_readonly', { prompt: 'Read' }], ['send_codex_message', { message: 'Continue' }]]) {
      const disabled = await call(name, { threadId: task.id, ...args });
      assert.equal(disabled.isError, true);
      assert.match(disabled.content[0].text, /引擎未启用.*claude/);
    }
    console.log('[PASS] All MCP Codex Console integration tests passed.');
  } finally {
    child?.kill();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    } catch {
      // ignore late SQLite WAL cleanup race on exit
    }
  }
}

runTests().catch((err) => {
  console.error('[FAIL]', err);
  process.exit(1);
});
