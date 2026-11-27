import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildThreadProgress, unwrapStructuredReply } from './progress-summary.mjs';

function stateDir(configured, defaultDir) {
  const value = configured || defaultDir;
  return value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function withReadOnlyDb(dbFile, fn, fallback) {
  if (!dbFile || !fs.existsSync(dbFile)) return fallback;
  let db = null;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 2000;');
    return fn(db);
  } catch {
    return fallback;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
}

function readDispatchState(statePath) {
  if (!fs.existsSync(statePath)) return { tasks: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return raw && typeof raw === 'object' ? raw : { tasks: {} };
  } catch {
    return { tasks: {} };
  }
}

function dispatchRunDirs(runDir) {
  if (!runDir) return [];
  try {
    const turns = fs.readdirSync(runDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('turn-'))
      .map(entry => path.join(runDir, entry.name))
      .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
    return [runDir, ...turns];
  } catch {
    return [];
  }
}

function readRunResult(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')); }
  catch { return null; }
}

function readDispatchRunResult(runDir) {
  for (const dir of dispatchRunDirs(runDir).reverse()) {
    const result = readRunResult(dir);
    if (result) return result;
  }
  return null;
}

function dispatchMessages(record, task) {
  const messages = [];
  function append(turnId, type, text, createdAtMs) {
    if (typeof text === 'string' && text.trim()) messages.push({
      id: `${turnId}-${type}`, turnId, ordinal: messages.length + 1, type, createdAtMs, text: text.slice(0, 4000),
    });
  }
  for (const dir of dispatchRunDirs(record?.run_dir).slice(-20)) {
    const turnId = path.basename(dir);
    let prompt;
    try { prompt = fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8'); } catch { /* Older runs may lack a prompt. */ }
    const result = readRunResult(dir);
    append(turnId, 'userMessage', prompt || result?.prompt || (dir === record.run_dir && record.prompt), task.createdAtMs);
    append(turnId, 'agentMessage', result?.report?.summary || result?.summary, task.updatedAtMs);
  }
  if (!messages.length) append(task.id, 'userMessage', record?.prompt, task.createdAtMs);
  if (!messages.some(m => m.type === 'agentMessage')) append(task.id, 'agentMessage', task.summary, task.updatedAtMs);
  return messages;
}

function parseWorktreeLabel(cwd) {
  if (!cwd) return null;
  let m = cwd.match(/\/worktrees\/([^/]+)\/([^/]+)$/);
  if (m) return `${m[1]}/${m[2]}`;
  m = cwd.match(/\.codex\/worktrees\/([^/]+)/);
  if (m) return m[1];
  m = cwd.match(/\/worktrees\/([^/]+)/);
  if (m) return m[1];
  return null;
}

function parseSubagentMeta(row) {
  const isSub =
    row.thread_source === 'subagent' ||
    (typeof row.source === 'string' && row.source.startsWith('{"subagent"'));
  if (!isSub) return { isSubagent: false, parentThreadId: null, agentPath: row.agent_path || null };
  let parentThreadId = null;
  let agentPath = row.agent_path || null;
  let nickname = row.agent_nickname || null;
  try {
    if (typeof row.source === 'string' && row.source.startsWith('{')) {
      const parsed = JSON.parse(row.source);
      const spawn = parsed?.subagent?.thread_spawn;
      if (spawn) {
        parentThreadId = spawn.parent_thread_id || null;
        agentPath = spawn.agent_path || agentPath;
        nickname = spawn.agent_nickname || nickname;
      }
    }
  } catch {
    // ignore
  }
  return { isSubagent: true, parentThreadId, agentPath, nickname };
}

function cleanDisplayTitle({ customTitle, threadName, dispatchTask, rawTitle, preview, agentNickname, agentPath, id }) {
  if (customTitle && customTitle.trim()) return customTitle.trim();
  if (threadName && threadName.trim()) return threadName.trim();
  if (dispatchTask?.task_id && (!rawTitle || rawTitle.startsWith('Read docs/BLACKBOARD.md'))) {
    const repo = dispatchTask.repo_root ? path.basename(dispatchTask.repo_root) : '';
    return repo ? `${repo} · ${dispatchTask.task_id}` : dispatchTask.task_id;
  }
  if (agentNickname || agentPath) {
    const roleTag = agentPath ? agentPath.replace(/^\/root\//, '') : '';
    if (agentNickname && roleTag) return `${agentNickname} (${roleTag})`;
  }
  const candidate = (rawTitle || preview || '').replace(/\s+/g, ' ').trim();
  if (!candidate) {
    if (dispatchTask?.task_id) return dispatchTask.task_id;
    return `Thread ${id.slice(0, 8)}`;
  }
  const stripped = candidate
    .replace(/^Read\s+docs\/BLACKBOARD\.md\s+thoroughly\s+first\s*(and|\.)?\s*/i, '')
    .trim();
  const base = stripped || candidate;
  return base.length > 72 ? `${base.slice(0, 70)}…` : base;
}

function deriveProjectName(row, projectsById, projectRoots, dispatchTask) {
  if (row.project_id && projectsById.has(row.project_id)) {
    return projectsById.get(row.project_id);
  }
  if (dispatchTask?.repo_root) {
    return path.basename(dispatchTask.repo_root);
  }
  const cwd = row.cwd || '';
  for (const pr of projectRoots) {
    if (cwd === pr.path || cwd.startsWith(pr.path + '/')) {
      return pr.projectName;
    }
  }
  if (cwd.includes('/worktrees/')) {
    const m = cwd.match(/\/worktrees\/([^/]+)/);
    if (m) return m[1];
  }
  if (cwd && cwd !== '/' && cwd !== '/private/tmp' && cwd !== '/tmp') {
    return path.basename(cwd);
  }
  return cwd || '未分类项目';
}

function parseItemJson(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function formatToolCall(obj) {
  const args = parseItemJson(obj.arguments) ?? obj.arguments;
  const preview = args?.url || args?.path || args?.file_path || args?.query || args?.target?.url || args?.target?.path;
  const name = [obj.server, obj.tool].filter(Boolean).join('.') || '工具调用';
  const first = name + (typeof preview === 'string' ? ' ' + preview.replace(/\s+/g, ' ').slice(0, 100) : '') +
    (obj.status ? ` [${obj.status}]` : '');
  const lines = [first];
  if (args != null) lines.push('参数 ' + (typeof args === 'string' ? args : JSON.stringify(args)).slice(0, 800));
  const result = obj.result;
  const resultText = typeof result === 'string' ? result : result?.text ||
    (Array.isArray(result?.content) && result.content.map(part => part?.text).filter(Boolean).join('\n'));
  if (typeof resultText === 'string' && resultText.trim()) lines.push('结果 ' + resultText.trim().slice(0, 1200));
  if (obj.error?.message) lines.push('错误 ' + String(obj.error.message).slice(0, 400));
  return lines.join('\n');
}

function formatWebSearch(obj) {
  const query = obj.query || obj.action?.query || obj.action?.queries?.[0];
  const results = obj.results ?? obj.action?.results;
  const count = obj.resultCount ?? (Array.isArray(results) ? results.length : null);
  const lines = [((typeof query === 'string' ? query.trim() : query?.query) || '网页搜索') +
    (Number.isInteger(count) ? ` · ${count} 条结果` : '')];
  for (const result of (Array.isArray(results) ? results : []).slice(0, 3)) {
    if (!result) continue;
    let domain = result.domain;
    try { domain ||= new URL(result.url).hostname; } catch { /* Some results only have a title. */ }
    const line = [result.title, domain].filter(Boolean).join(' · ');
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

function extractTextFromItem(itemType, itemJson) {
  const obj = parseItemJson(itemJson);
  if (!obj) return '';
  if (itemType === 'mcpToolCall') return formatToolCall(obj);
  if (itemType === 'webSearch') return formatWebSearch(obj);
  if (itemType === 'agentMessage' || itemType === 'plan') {
    return typeof obj.text === 'string' ? obj.text : '';
  }
  if (itemType === 'userMessage') {
    if (Array.isArray(obj.content)) {
      return obj.content
        .filter((c) => c && (c.type === 'text' || typeof c.text === 'string'))
        .map((c) => c.text || '')
        .join('\n');
    }
    return typeof obj.text === 'string' ? obj.text : '';
  }
  if (itemType === 'commandExecution') {
    return `$ ${obj.command || ''}${obj.status ? ` [${obj.status}]` : ''}`;
  }
  if (itemType === 'fileChange') {
    const files = Array.isArray(obj.changes)
      ? obj.changes.filter(c => c?.path).map(c => `${c.kind?.type || (typeof c.kind === 'string' ? c.kind : 'edit')}: ${c.path}`)
      : [];
    return files.join('\n');
  }
  if (itemType === 'reasoning') {
    if (Array.isArray(obj.summary) && obj.summary.length) {
      return obj.summary.map(part => typeof part === 'string' ? part : part?.text).filter(Boolean).join(' / ');
    }
    return '';
  }
  return '';
}

function historyMessage(row) {
  const obj = parseItemJson(row.item_json);
  const text = extractTextFromItem(row.item_type, obj);
  const message = { id: row.item_id, turnId: row.turn_id, ordinal: row.rollout_ordinal,
    type: row.item_type, createdAtMs: row.created_at_ms, text };
  if (row.item_type === 'agentMessage') {
    message.text = unwrapStructuredReply(text);
    message.phase = obj?.phase ?? null;
  }
  return message;
}

function readSubAgentItems(db, threadId) {
  return db.prepare(`
    SELECT item_json, rollout_ordinal, created_at_ms FROM thread_items
    WHERE thread_id = ? AND item_type = 'subAgentActivity'
    ORDER BY rollout_ordinal DESC LIMIT 40
  `).all(threadId).map(row => ({
    ...parseItemJson(row.item_json), ordinal: row.rollout_ordinal, createdAtMs: row.created_at_ms,
  }));
}

function computeEffectiveStatus({ thread, goal, latestTurn, dispatchTask }) {
  const dispatchTerminal =
    dispatchTask &&
    ['completed', 'failed', 'cleaned', 'cancelled', 'timed_out', 'stopped', 'partial', 'blocked'].includes(
      dispatchTask.status
    );

  if (!dispatchTerminal && (latestTurn?.status === 'inProgress' || dispatchTask?.status === 'running')) {
    return { code: 'running', label: '运行中', tone: 'info' };
  }
  if (goal?.status === 'blocked') {
    return { code: 'blocked', label: 'Goal 阻塞', tone: 'warning' };
  }
  if (goal?.status === 'usage_limited' || goal?.status === 'budget_limited') {
    return { code: 'limited', label: '额度受限', tone: 'danger' };
  }
  if (goal?.status === 'active') {
    return { code: 'goal_active', label: 'Goal 进行中', tone: 'info' };
  }
  if (goal?.status === 'paused') {
    return { code: 'paused', label: 'Goal 暂停', tone: 'muted' };
  }
  if (goal?.status === 'complete') {
    return { code: 'complete', label: 'Goal 完成', tone: 'success' };
  }
  if (
    (!dispatchTerminal && latestTurn?.status === 'failed') ||
    dispatchTask?.status === 'failed' ||
    dispatchTask?.status === 'timed_out'
  ) {
    return { code: 'failed', label: '执行异常', tone: 'danger' };
  }
  if (dispatchTask?.status === 'cleaned') {
    return {
      code: 'exec_done',
      label: dispatchTask.exit_code === 124 ? '已清理(曾超时)' : 'CLI 已清理',
      tone: 'muted',
    };
  }
  if (dispatchTask?.status === 'blocked' || dispatchTask?.status === 'partial') {
    return { code: 'blocked', label: dispatchTask.status === 'partial' ? '部分完成' : '任务阻塞', tone: 'warning' };
  }
  if (['stopped', 'cancelled'].includes(dispatchTask?.status)) {
    return { code: 'stopped', label: '已停止', tone: 'muted' };
  }
  if (thread.archived) {
    return { code: 'archived', label: '已归档', tone: 'muted' };
  }
  if (thread.source === 'exec' || dispatchTask?.status === 'completed') {
    return { code: 'exec_done', label: 'CLI 已完成', tone: 'success' };
  }
  return { code: 'idle', label: '就绪', tone: 'muted' };
}

export class CodexStore {
  constructor(consoleDb) {
    this.consoleDb = consoleDb;
    this.codexHome = stateDir(process.env.CODEX_HOME, '~/.codex');
    this.dispatchFile = path.join(stateDir(process.env.AGY_DISPATCH_STATE_DIR, '~/.local/state/multi-agent-dispatch'), 'state.json');
    this.stateDbPath = path.join(this.codexHome, 'state_5.sqlite');
    this.goalsDbPath = path.join(this.codexHome, 'goals_1.sqlite');
    this.queueDbPath = path.join(this.codexHome, 'queue_1.sqlite');
    this.historyDbPath = path.join(this.codexHome, 'thread_history_1.sqlite');
  }

  getHealth() {
    return {
      codexHome: this.codexHome,
      stateDbExists: fs.existsSync(this.stateDbPath),
      goalsDbExists: fs.existsSync(this.goalsDbPath),
      queueDbExists: fs.existsSync(this.queueDbPath),
      historyDbExists: fs.existsSync(this.historyDbPath),
      dispatchStateExists: fs.existsSync(this.dispatchFile),
    };
  }

  getSnapshot({ limit = 160, threadId = null } = {}) {
    const prefsMap = this.consoleDb.getAllPrefs();
    const dispatchState = readDispatchState(this.dispatchFile);
    const dispatchTasksList = Object.entries(dispatchState.tasks || {})
      .filter(([, task]) => task && typeof task === 'object' && (
        task.backend ? ['codex', 'auto'].includes(task.backend) : !String(task.session_id || '').startsWith('sess_')
      ))
      .map(([id, task]) => ({ ...task, task_id: task.task_id || id }));
    const dispatchBySession = new Map(dispatchTasksList.filter(t => t.session_id).map(t => [t.session_id, t]));
    const includedIds = [...dispatchBySession.keys()];
    if (threadId) includedIds.push(threadId);

    // 1. Read state_5.sqlite
    const stateData = withReadOnlyDb(
      this.stateDbPath,
      (db) => {
        // The desktop client adds project metadata and spawn edges to the
        // state database. CLI-only installations may have just the threads.
        const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name));
        const projects = tables.has('projects') ? db.prepare('SELECT id, name FROM projects').all() : [];
        const roots = tables.has('project_roots') && tables.has('projects') ? db.prepare(`
          SELECT pr.project_id, pr.path, p.name AS project_name
          FROM project_roots pr
          JOIN projects p ON p.id = pr.project_id
        `).all() : [];
        const threads = db.prepare(`
          SELECT * FROM threads
          WHERE id IN (SELECT id FROM threads ORDER BY updated_at DESC LIMIT ?)
             OR id IN (SELECT value FROM json_each(?))
          ORDER BY updated_at DESC
        `).all(limit, JSON.stringify(includedIds));
        const totalRow = db.prepare('SELECT COUNT(*) AS c FROM threads').get();
        const spawnEdges = tables.has('thread_spawn_edges') ? db.prepare(
          'SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges'
        ).all() : [];
        return { projects, roots, threads, totalThreads: totalRow?.c || threads.length, spawnEdges };
      },
      { projects: [], roots: [], threads: [], totalThreads: 0, spawnEdges: [] }
    );

    const projectsById = new Map(stateData.projects.map((p) => [p.id, p.name]));
    const projectRoots = stateData.roots
      .map((r) => ({ path: r.path, projectName: r.project_name }))
      .sort((a, b) => b.path.length - a.path.length);

    const spawnByChild = new Map();
    const childrenByParent = new Map();
    for (const edge of stateData.spawnEdges) {
      spawnByChild.set(edge.child_thread_id, edge);
      const list = childrenByParent.get(edge.parent_thread_id) || [];
      list.push(edge);
      childrenByParent.set(edge.parent_thread_id, list);
    }

    // 2. Read goals_1.sqlite
    const goalsMap = withReadOnlyDb(
      this.goalsDbPath,
      (db) => {
        const rows = db.prepare('SELECT * FROM thread_goals').all();
        return new Map(rows.map((r) => [r.thread_id, r]));
      },
      new Map()
    );

    // 3. Read queue_1.sqlite
    const queueCountMap = withReadOnlyDb(
      this.queueDbPath,
      (db) => {
        const rows = db.prepare(
          'SELECT thread_id, COUNT(*) AS cnt FROM queued_items GROUP BY thread_id'
        ).all();
        return new Map(rows.map((r) => [r.thread_id, r.cnt]));
      },
      new Map()
    );

    // 4. Read latest turn + latest agent reply in thread_history_1.sqlite for loaded threads
    const threadIds = stateData.threads.map((t) => t.id);
    const { latestTurnMap, durationMap, latestReplyMap } = this._fetchThreadActivityBatch(threadIds);

    // 5. Read console ops & collab bindings
    const recentOps = this.consoleDb.listOps({ limit: 80 });
    const opsByThread = new Map();
    for (const op of recentOps) {
      if (!op.threadId) continue;
      const arr = opsByThread.get(op.threadId) || [];
      arr.push(op);
      opsByThread.set(op.threadId, arr);
    }

    const bindings = this.consoleDb.listBindings({ limit: 200 });
    const bindingsByThread = new Map();
    for (const b of bindings) {
      if (!b.threadId) continue;
      const arr = bindingsByThread.get(b.threadId) || [];
      arr.push(b);
      bindingsByThread.set(b.threadId, arr);
    }

    // 6. Assemble Codex task cards
    const tasks = stateData.threads.map((row) => {
      const pref = prefsMap.get(row.id) || null;
      const goal = goalsMap.get(row.id) || null;
      const dispatchTask = dispatchBySession.get(row.id) || null;
      const latestTurn = latestTurnMap.get(row.id) || null;
      const subMeta = parseSubagentMeta(row);
      const spawnEdge = spawnByChild.get(row.id) || null;
      const isSubagent = subMeta.isSubagent || Boolean(spawnEdge);
      const childEdges = childrenByParent.get(row.id) || [];

      const projectName = deriveProjectName(row, projectsById, projectRoots, dispatchTask);
      const worktreeLabel = parseWorktreeLabel(row.cwd || dispatchTask?.worktree_path);
      const status = computeEffectiveStatus({ thread: row, goal, latestTurn, dispatchTask });
      const updatedMs = row.updated_at_ms || (row.updated_at ? row.updated_at * 1000 : Date.now());
      const createdMs = row.created_at_ms || (row.created_at ? row.created_at * 1000 : updatedMs);
      const durationSec = goal?.time_used_seconds
        ? Number(goal.time_used_seconds)
        : Math.round((durationMap.get(row.id) || Math.max(0, updatedMs - createdMs)) / 1000);

      const pinned = pref ? pref.pinned : Boolean(row.is_pinned);
      const title = cleanDisplayTitle({
        customTitle: pref?.customTitle,
        threadName: row.name,
        dispatchTask,
        rawTitle: row.title,
        preview: row.preview,
        agentNickname: subMeta.nickname || row.agent_nickname,
        agentPath: subMeta.agentPath,
        id: row.id,
      });

      const latestReplyRaw = unwrapStructuredReply(latestReplyMap.get(row.id) || row.preview || '');
      const latestReply = latestReplyRaw.replace(/\s+/g, ' ').trim().slice(0, 220);
      const threadBindings = bindingsByThread.get(row.id) || [];
      const threadOps = opsByThread.get(row.id) || [];

      const isManagedDispatch =
        Boolean(dispatchTask) ||
        (row.git_branch || '').startsWith('agy-worker/') ||
        (row.cwd || '').includes('multi-agent-dispatch');
      const isExec = row.source === 'exec' || row.originator === 'codex_exec' || isManagedDispatch;

      return {
        id: row.id,
        shortId: row.id.slice(0, 8),
        title,
        customTitle: pref?.customTitle || null,
        rawTitle: (row.title || '').slice(0, 400),
        projectName,
        worktreeLabel,
        cwd: row.cwd || '',
        branch: row.git_branch || dispatchTask?.branch || '',
        model: row.model || dispatchTask?.model || '',
        reasoningEffort: row.reasoning_effort || dispatchTask?.effort || '',
        source: row.source || '',
        originator: row.originator || '',
        isExec,
        isManagedDispatch,
        isAgyDispatched: isExec,
        isSubagent,
        parentThreadId: subMeta.parentThreadId || spawnEdge?.parent_thread_id || null,
        childCount: childEdges.length,
        agentNickname: subMeta.nickname || row.agent_nickname || null,
        agentRole: row.agent_role || null,
        pinned,
        pinnedAt: pref?.pinnedAt || null,
        hidden: Boolean(pref?.hidden),
        archived: Boolean(row.archived),
        tokensUsed: Number(goal?.tokens_used || row.tokens_used || 0),
        durationSec,
        createdAtMs: createdMs,
        updatedAtMs: updatedMs,
        status,
        goal: goal
          ? {
              goalId: goal.goal_id,
              objective: goal.objective,
              status: goal.status,
              tokenBudget: goal.token_budget,
              tokensUsed: goal.tokens_used,
              timeUsedSeconds: goal.time_used_seconds,
              updatedAtMs: goal.updated_at_ms,
            }
          : null,
        queuedCount: queueCountMap.get(row.id) || 0,
        latestReply,
        latestTurnStatus: latestTurn?.status || null,
        dispatchTask: dispatchTask
          ? {
              taskId: dispatchTask.task_id,
              status: dispatchTask.status,
              difficulty: dispatchTask.difficulty,
              branch: dispatchTask.branch,
              worktreePath: dispatchTask.worktree_path,
              repoRoot: dispatchTask.repo_root,
              isolation: dispatchTask.isolation,
              sandbox: dispatchTask.sandbox,
              exitCode: dispatchTask.exit_code,
            }
          : null,
        bindingCount: threadBindings.length,
        changeKeys: threadBindings.map((b) => b.changeKey),
        runningOpsCount: threadOps.filter((o) => o.status === 'running').length,
      };
    });

    // A newly dispatched task may not yet have a row in the Codex state database.
    const byId = new Map(tasks.map(task => [task.id, task]));
    const results = new Map();
    for (const record of dispatchTasksList) {
      const result = readDispatchRunResult(record.run_dir);
      results.set(record.task_id, result);
      const id = record.session_id || record.task_id;
      if (byId.has(id)) continue;
      const cwd = record.workdir || record.worktree_path || record.original_cwd || record.repo_root || '';
      const pref = prefsMap.get(id);
      const summary = result?.report?.summary || result?.summary || record.report?.summary || record.summary || '';
      const model = record.model || result?.model_used || '';
      const updatedAtMs = Date.parse(record.updated_at || record.created_at) || 0;
      const createdAtMs = Date.parse(record.created_at) || updatedAtMs;
      const title = cleanDisplayTitle({ customTitle: pref?.customTitle, dispatchTask: record, rawTitle: record.title || record.prompt, id });
      const status = computeEffectiveStatus({ thread: {}, dispatchTask: record });
      const bindings = bindingsByThread.get(id) || [];
      const card = {
        id, shortId: id.slice(0, 8), sessionId: record.session_id || null,
        title, customTitle: pref?.customTitle || null, rawTitle: record.title || title,
        projectName: deriveProjectName({ cwd }, projectsById, projectRoots, record), cwd, branch: record.branch || '',
        worktreeLabel: parseWorktreeLabel(record.worktree_path || cwd), model,
        reasoningEffort: record.effort || '', source: 'dispatch', originator: 'codex_exec',
        isExec: true, isManagedDispatch: true, isAgyDispatched: true, isSubagent: false, childCount: 0, parentThreadId: null,
        pinned: Boolean(pref?.pinned), hidden: Boolean(pref?.hidden), pinnedAt: pref?.pinnedAt || null, archived: false,
        tokensUsed: Number(result?.usage?.total_tokens || 0), durationSec: Math.max(0, Math.round((updatedAtMs - createdAtMs) / 1000)),
        createdAtMs, updatedAtMs, status, goal: null, queuedCount: 0, summary, latestReply: summary.slice(0, 220),
        latestTurnStatus: record.status, dispatchTask: { taskId: record.task_id, status: record.status, difficulty: record.difficulty,
          branch: record.branch, worktreePath: record.worktree_path, repoRoot: record.repo_root, isolation: record.isolation,
          sandbox: record.sandbox, exitCode: record.exit_code },
        bindingCount: bindings.length, changeKeys: bindings.map(b => b.changeKey),
        runningOpsCount: (opsByThread.get(id) || []).filter(op => op.status === 'running').length,
      };
      byId.set(id, card);
      tasks.push(card);
    }
    tasks.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    const managedAgents = dispatchTasksList
      .map((t) => {
        const result = results.get(t.task_id);
        const linkedThread = byId.get(t.session_id || t.task_id);
        return {
          kind: 'dispatch',
          id: t.task_id,
          taskId: t.task_id,
          threadId: linkedThread?.id || t.session_id || null,
          title:
            linkedThread?.title ||
            `${path.basename(t.repo_root || t.original_cwd || '')} · ${t.task_id}`,
          projectName: t.repo_root
            ? path.basename(t.repo_root)
            : path.basename(t.original_cwd || ''),
          status: t.status || linkedThread?.status?.code || 'unknown',
          model: t.model || linkedThread?.model || '',
          effort: t.effort || '',
          difficulty: t.difficulty || '',
          branch: t.branch || '',
          worktreePath: t.worktree_path || t.workdir || '',
          repoRoot: t.repo_root || t.original_cwd || '',
          isolation: t.isolation || '',
          sandbox: t.sandbox || '',
          exitCode: t.exit_code ?? null,
          createdAt: t.created_at,
          updatedAt: t.updated_at,
          tokensUsed: linkedThread?.tokensUsed || 0,
          summary:
            result?.report?.summary ||
            result?.summary ||
            linkedThread?.latestReply ||
            '',
          changedFiles: result?.report?.files_modified || result?.changed_files || [],
          verificationPassed: Boolean(result?.report?.verification_passed),
          risks: result?.report?.risks_or_followups || [],
          worktreeExists: t.worktree_path ? fs.existsSync(t.worktree_path) : false,
        };
      })
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

    const nonSubagentTasks = tasks.filter((t) => !t.isSubagent);
    const health = this.getHealth();
    const stats = {
      totalThreads: stateData.totalThreads + tasks.length - stateData.threads.length,
      loadedThreads: tasks.length,
      visibleThreads: nonSubagentTasks.filter(t => !t.hidden).length,
      agyCount: nonSubagentTasks.filter((t) => t.isAgyDispatched).length,
      execCount: tasks.filter((t) => t.isExec).length,
      runningCount: tasks.filter((t) => t.status.code === 'running').length,
      goalBlockedCount: tasks.filter((t) => t.status.code === 'blocked').length,
      goalActiveCount: tasks.filter((t) => t.status.code === 'goal_active').length,
      pinnedCount: tasks.filter((t) => t.pinned).length,
      managedCount: managedAgents.length,
      subagentThreadCount: tasks.filter((t) => t.isSubagent).length,
      collabCount: bindings.length,
      runningOpsCount: recentOps.filter((o) => o.status === 'running').length,
    };

    const projects = [...new Set(tasks.map((t) => t.projectName).filter(Boolean))].sort();
    const worktrees = [...new Set(tasks.map((t) => t.worktreeLabel).filter(Boolean))].sort();

    return {
      connected: health.stateDbExists,
      health,
      stats,
      filters: { projects, worktrees },
      tasks,
      managedAgents,
      bindings,
      recentOps: recentOps.slice(0, 25),
      fetchedAt: Date.now(),
    };
  }

  _fetchThreadActivityBatch(threadIds) {
    const latestTurnMap = new Map();
    const durationMap = new Map();
    const latestReplyMap = new Map();
    if (!threadIds.length) return { latestTurnMap, durationMap, latestReplyMap };

    withReadOnlyDb(
      this.historyDbPath,
      (db) => {
        const placeholders = threadIds.map(() => '?').join(',');
        const turnRows = db.prepare(`
          SELECT thread_id, turn_id, status, started_at, completed_at, duration_ms, rollout_ordinal
          FROM thread_turns
          WHERE thread_id IN (${placeholders})
          ORDER BY thread_id, rollout_ordinal DESC
        `).all(...threadIds);

        for (const row of turnRows) {
          if (!latestTurnMap.has(row.thread_id)) {
            latestTurnMap.set(row.thread_id, row);
          }
          if (row.duration_ms) {
            durationMap.set(row.thread_id, (durationMap.get(row.thread_id) || 0) + Number(row.duration_ms));
          }
        }

        const replyRows = db.prepare(`
          SELECT ti.thread_id, ti.item_json
          FROM thread_items ti
          INNER JOIN (
            SELECT thread_id, MAX(rollout_ordinal) AS max_ord
            FROM thread_items
            WHERE thread_id IN (${placeholders}) AND item_type = 'agentMessage'
            GROUP BY thread_id
          ) latest
            ON ti.thread_id = latest.thread_id AND ti.rollout_ordinal = latest.max_ord
          WHERE ti.item_type = 'agentMessage'
        `).all(...threadIds);

        for (const r of replyRows) {
          const text = extractTextFromItem('agentMessage', r.item_json);
          if (text) latestReplyMap.set(r.thread_id, text);
        }
      },
      null
    );

    return { latestTurnMap, durationMap, latestReplyMap };
  }

  getThreadDetail(threadId) {
    const snapshot = this.getSnapshot({ limit: 200, threadId });
    const task = snapshot.tasks.find(t => t.id === threadId || t.dispatchTask?.taskId === threadId) || null;
    if (!task) return { task: null, turns: [], messages: [], queuedItems: [], childThreads: [], ops: [], bindings: [] };
    threadId = task.id;
    if (task.source === 'dispatch') {
      const record = readDispatchState(this.dispatchFile).tasks?.[task.dispatchTask.taskId];
      const messages = dispatchMessages(record, task);
      const subAgentItems = task.sessionId ? withReadOnlyDb(this.historyDbPath, db => readSubAgentItems(db, threadId), []) : [];
      return { task, turns: [], messages, progress: buildThreadProgress({ task, items: messages, subAgentItems }), queuedItems: [], childThreads: [],
        ops: this.consoleDb.listOps({ threadId, limit: 25 }), bindings: this.consoleDb.listBindings({ threadId, limit: 20 }) };
    }

    const history = withReadOnlyDb(
      this.historyDbPath,
      (db) => {
        const turns = db.prepare(`
          SELECT turn_id, rollout_ordinal, status, started_at, completed_at, duration_ms, error_json
          FROM thread_turns
          WHERE thread_id = ?
          ORDER BY rollout_ordinal DESC
          LIMIT 20
        `).all(threadId);

        const items = db.prepare(`
          SELECT turn_id, item_id, rollout_ordinal, created_at_ms, item_type, item_json
          FROM (
            SELECT turn_id, item_id, rollout_ordinal, created_at_ms, item_type, item_json
            FROM thread_items
            WHERE thread_id = ?
              AND item_type IN ('userMessage', 'agentMessage', 'plan')
            UNION ALL
            SELECT turn_id, item_id, rollout_ordinal, created_at_ms, item_type, item_json
            FROM (
              SELECT turn_id, item_id, rollout_ordinal, created_at_ms, item_type, item_json
              FROM thread_items
              WHERE thread_id = ?
                AND item_type IN ('fileChange', 'commandExecution', 'reasoning', 'mcpToolCall', 'webSearch')
              ORDER BY rollout_ordinal DESC
              LIMIT 120
            )
          )
          ORDER BY rollout_ordinal DESC
          LIMIT 160
        `).all(threadId, threadId);

        const messages = items.reverse().map(historyMessage).filter(m => m.text.trim());
        let progressItems = messages;
        // Keep the latest explicit plan authoritative even after it scrolls
        // out of the bounded feed. Long plan bodies are parsed before clipping.
        if (items.length === 160 && !messages.some(m => m.type === 'plan')) {
          const plan = db.prepare(`
            SELECT turn_id, item_id, rollout_ordinal, created_at_ms, item_type, item_json
            FROM thread_items WHERE thread_id = ? AND item_type = 'plan'
            ORDER BY rollout_ordinal DESC LIMIT 1
          `).get(threadId);
          if (plan) progressItems = [historyMessage(plan), ...messages];
        }

        return { turns, messages, progressItems, subAgentItems: readSubAgentItems(db, threadId) };
      },
      { turns: [], messages: [], progressItems: [], subAgentItems: [] }
    );

    const queuedItems = withReadOnlyDb(
      this.queueDbPath,
      (db) => {
        return db.prepare(`
          SELECT id, payload_json, queue_order, created_at_ms
          FROM queued_items
          WHERE thread_id = ?
          ORDER BY queue_order ASC
        `).all(threadId);
      },
      []
    );

    const childThreads = snapshot.tasks
      .filter((t) => t.parentThreadId === threadId)
      .map((t) => ({
        id: t.id,
        shortId: t.shortId,
        title: t.title,
        status: t.status,
        updatedAtMs: t.updatedAtMs,
      }));

    const ops = this.consoleDb.listOps({ threadId, limit: 25 });
    const bindings = this.consoleDb.listBindings({ threadId, limit: 20 });

    return {
      task,
      turns: history.turns,
      messages: history.messages.map(m => m.text.length > 4000 ? { ...m, text: m.text.slice(0, 4000) + '\n…(已截断)' } : m),
      progress: buildThreadProgress({ task, items: history.progressItems, subAgentItems: history.subAgentItems, turns: history.turns }),
      queuedItems,
      childThreads,
      ops,
      bindings,
    };
  }
}
