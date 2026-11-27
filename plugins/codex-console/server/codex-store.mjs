import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { loadEngineConfig, discoverZcodeEnvironment, dispatchStateDir, expandPath } from './engine-config.mjs';

const ZCODE_PROVIDER_SHORT = {
  'qwen-alibaba-model-studio-cn': '百炼',
  'e2a41300-b652-45ec-9f78-ebd2ec7889be': 'TokenHub',
};

function formatZcodeModelDisplay(rawModel, providerLabels) {
  if (!rawModel) return 'zcode';
  const s = String(rawModel).trim();
  if (!s.includes('/')) return s;
  const [prov, mod] = s.split('/', 2);
  const shortProv = ZCODE_PROVIDER_SHORT[prov] || providerLabels?.[prov];
  return shortProv ? `${shortProv}/${mod}` : mod || s;
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

function readDispatchState() {
  const statePath = path.join(dispatchStateDir(), 'state.json');
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

function dispatchBackend(task) {
  return task.backend || (task.session_id?.startsWith('sess_') ? 'zcode' : 'codex');
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

function unwrapStructuredReply(rawText) {
  const trimmed = (rawText || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.summary === 'string' && obj.summary.trim()) {
        return obj.summary.trim();
      }
    } catch {
      // fall through
    }
  }
  return trimmed;
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

function extractTextFromItem(itemType, itemJson) {
  if (!itemJson) return '';
  try {
    const obj = JSON.parse(itemJson);
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
        ? obj.changes.map((c) => `${c.kind?.type || 'edit'}: ${c.path || ''}`)
        : [];
      return files.join('\n');
    }
    if (itemType === 'reasoning') {
      if (Array.isArray(obj.summary) && obj.summary.length) {
        return obj.summary.join(' / ');
      }
      return '';
    }
  } catch {
    return '';
  }
  return '';
}

function computeEffectiveStatus({ thread, goal, latestTurn, dispatchTask }) {
  const dispatchTerminal =
    dispatchTask &&
    ['completed', 'failed', 'cleaned', 'cancelled', 'timed_out', 'stopped'].includes(
      dispatchTask.status
    );

  if (latestTurn?.status === 'inProgress' && !dispatchTerminal) {
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
  if (thread.task_status === 'completed' || thread.last_outcome === 'completed') {
    return { code: 'complete', label: '已完成', tone: 'success' };
  }
  if (thread.task_status === 'running') {
    return { code: 'running', label: '运行中', tone: 'info' };
  }
  if (thread.task_status === 'failed' || thread.last_outcome === 'failed') {
    return { code: 'failed', label: '执行异常', tone: 'danger' };
  }
  return { code: 'idle', label: '就绪', tone: 'muted' };
}

export class CodexStore {
  constructor(consoleDb) {
    this.consoleDb = consoleDb;
    this.codexHome = expandPath(process.env.CODEX_HOME || '~/.codex');
    this.zcodeHome = expandPath(process.env.ZCODE_HOME || '~/.zcode');
    this.stateDbPath = path.join(this.codexHome, 'state_5.sqlite');
    this.goalsDbPath = path.join(this.codexHome, 'goals_1.sqlite');
    this.queueDbPath = path.join(this.codexHome, 'queue_1.sqlite');
    this.historyDbPath = path.join(this.codexHome, 'thread_history_1.sqlite');
    this.zcodeCliDbPath = path.join(this.zcodeHome, 'cli', 'db', 'db.sqlite');
    this.zcodeTasksIndexDbPath = path.join(this.zcodeHome, 'v2', 'tasks-index.sqlite');
  }

  getHealth() {
    return {
      codexHome: this.codexHome,
      zcodeHome: this.zcodeHome,
      stateDbExists: fs.existsSync(this.stateDbPath),
      goalsDbExists: fs.existsSync(this.goalsDbPath),
      queueDbExists: fs.existsSync(this.queueDbPath),
      historyDbExists: fs.existsSync(this.historyDbPath),
      zcodeCliDbExists: fs.existsSync(this.zcodeCliDbPath),
      zcodeTasksIndexDbExists: fs.existsSync(this.zcodeTasksIndexDbPath),
      dispatchStateExists: fs.existsSync(path.join(dispatchStateDir(), 'state.json')),
    };
  }

  _loadZcodeTasks({ limit = 100, prefsMap, dispatchBySession, opsByThread, bindingsByThread, engine, providerLabels }) {
    const idxData = withReadOnlyDb(
      this.zcodeTasksIndexDbPath,
      (db) => {
        const projects = db
          .prepare('SELECT project_id, name FROM projects WHERE deleted = 0')
          .all();
        const roots = db
          .prepare('SELECT project_id, root_path FROM project_roots')
          .all();
        const indexedTasks = db
          .prepare(
            `SELECT workspace_path, task_id, title, cli_title, task_status, mode, model,
                    created_at, updated_at, pinned, archived, deleted, cli_deleted,
                    searchable_text, project_id, root_path, worktree_root
             FROM tasks
             WHERE deleted = 0 AND COALESCE(cli_deleted, 0) = 0 AND task_id LIKE 'sess_%'
             ORDER BY updated_at DESC
             LIMIT ?`
          )
          .all(limit);
        return { projects, roots, indexedTasks };
      },
      { projects: [], roots: [], indexedTasks: [] }
    );

    const zProjectsById = new Map(idxData.projects.map((p) => [p.project_id, p.name]));
    const zProjectRoots = idxData.roots
      .map((r) => ({
        path: r.root_path,
        projectName: zProjectsById.get(r.project_id) || path.basename(r.root_path || ''),
      }))
      .sort((a, b) => b.path.length - a.path.length);

    const indexedById = new Map();
    for (const row of idxData.indexedTasks) {
      if (row.task_id) indexedById.set(row.task_id, row);
    }

    // Collect candidate ZCode session IDs: all indexed Desktop tasks + all dispatch-tracked ZCode sessions
    const targetSessionIds = new Set(indexedById.keys());
    for (const [sid, dt] of dispatchBySession.entries()) {
      if (dispatchBackend(dt) === 'zcode') {
        targetSessionIds.add(sid);
      }
    }

    const cliSessionsMap = new Map();
    const cliUsageMap = new Map();
    const cliReplyMap = new Map();
    const cliRunningSet = new Set();

    withReadOnlyDb(
      this.zcodeCliDbPath,
      (db) => {
        // Also check active runtime presence (only if the OS process is actually alive)
        try {
          const pres = db.prepare('SELECT session_id, process_id FROM session_runtime_presence').all();
          for (const p of pres) {
            if (!p.session_id) continue;
            let alive = false;
            if (p.process_id && Number(p.process_id) > 0) {
              try {
                process.kill(Number(p.process_id), 0);
                alive = true;
              } catch {
                alive = false;
              }
            }
            if (alive) {
              cliRunningSet.add(p.session_id);
              targetSessionIds.add(p.session_id);
            }
          }
        } catch {
          // ignore if table absent
        }

        // If tasks-index.sqlite didn't exist, fall back to recent sessions from cli/db/db.sqlite
        if (targetSessionIds.size === 0) {
          const recentRows = db
            .prepare(
              `SELECT id FROM session WHERE time_deleted IS NULL ORDER BY time_updated DESC LIMIT ?`
            )
            .all(Math.min(40, limit));
          for (const r of recentRows) {
            if (r.id) targetSessionIds.add(r.id);
          }
        }

        const sids = [...targetSessionIds];
        if (!sids.length) return;
        const ph = sids.map(() => '?').join(',');

        const srows = db
          .prepare(
            `SELECT id, directory, path, title, time_created, time_updated, time_archived, time_deleted, last_outcome
             FROM session
             WHERE id IN (${ph})`
          )
          .all(...sids);
        for (const r of srows) {
          cliSessionsMap.set(r.id, r);
        }

        const urows = db
          .prepare(
            `SELECT session_id, provider_id, model_id, variant,
                    SUM(COALESCE(computed_total_tokens, provider_total_tokens, input_tokens + output_tokens, 0)) AS total_tok,
                    SUM(COALESCE(duration_ms, 0)) AS total_dur_ms,
                    MAX(started_at) AS last_started
             FROM model_usage
             WHERE session_id IN (${ph})
             GROUP BY session_id`
          )
          .all(...sids);
        for (const u of urows) {
          cliUsageMap.set(u.session_id, u);
        }

        // Fetch latest model per session
        const latestModelRows = db
          .prepare(
            `SELECT mu.session_id, mu.provider_id, mu.model_id, mu.variant
             FROM model_usage mu
             INNER JOIN (
               SELECT session_id, MAX(started_at) AS max_st
               FROM model_usage
               WHERE session_id IN (${ph})
               GROUP BY session_id
             ) latest ON mu.session_id = latest.session_id AND mu.started_at = latest.max_st`
          )
          .all(...sids);
        for (const lm of latestModelRows) {
          const cur = cliUsageMap.get(lm.session_id) || {};
          cliUsageMap.set(lm.session_id, {
            ...cur,
            provider_id: lm.provider_id,
            model_id: lm.model_id,
            variant: lm.variant,
          });
        }
      },
      null
    );

    const zcodeTasks = [];
    for (const sid of targetSessionIds) {
      const idxRow = indexedById.get(sid) || null;
      const cliRow = cliSessionsMap.get(sid) || null;
      const dispatchTask = dispatchBySession.get(sid) || null;
      if (!idxRow && !cliRow) continue;
      if (cliRow?.time_deleted) continue;

      const pref = prefsMap.get(sid) || null;
      const usage = cliUsageMap.get(sid) || null;
      const cwd =
        dispatchTask?.workdir ||
        idxRow?.workspace_path ||
        cliRow?.directory ||
        cliRow?.path ||
        '';
      const rawModel =
        (usage?.provider_id && usage?.model_id ? `${usage.provider_id}/${usage.model_id}` : '') ||
        idxRow?.model ||
        dispatchTask?.model ||
        'zcode';
      const displayModel = formatZcodeModelDisplay(rawModel, providerLabels);

      const parsedUpdated = dispatchTask?.updated_at ? Date.parse(dispatchTask.updated_at) : NaN;
      const updatedMs = Number(
        idxRow?.updated_at ||
          cliRow?.time_updated ||
          (Number.isFinite(parsedUpdated) ? parsedUpdated : Date.now())
      );
      const parsedCreated = dispatchTask?.created_at ? Date.parse(dispatchTask.created_at) : NaN;
      const createdMs = Number(
        idxRow?.created_at ||
          cliRow?.time_created ||
          (Number.isFinite(parsedCreated) ? parsedCreated : updatedMs)
      );

      const isManagedDispatch = Boolean(dispatchTask);
      const isRunning = cliRunningSet.has(sid) || dispatchTask?.status === 'running';
      const status = computeEffectiveStatus({
        thread: {
          archived: Boolean(idxRow?.archived || cliRow?.time_archived),
          source: isManagedDispatch ? 'exec' : 'zcode_desktop',
          task_status: isRunning ? 'running' : idxRow?.task_status || cliRow?.last_outcome,
          last_outcome: cliRow?.last_outcome || idxRow?.task_status,
        },
        goal: null,
        latestTurn: isRunning ? { status: 'inProgress' } : null,
        dispatchTask,
      });

      const projectName = deriveProjectName(
        { project_id: idxRow?.project_id, cwd },
        zProjectsById,
        zProjectRoots,
        dispatchTask
      );
      const worktreeLabel = parseWorktreeLabel(cwd || dispatchTask?.worktree_path || idxRow?.worktree_root);

      const dispatchResult = dispatchTask ? readDispatchRunResult(dispatchTask.run_dir) : null;
      const searchLines = (idxRow?.searchable_text || '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const previewText =
        dispatchResult?.report?.summary ||
        (searchLines.length > 1 ? searchLines[searchLines.length - 1] : searchLines[0] || '');

      const title = cleanDisplayTitle({
        customTitle: pref?.customTitle,
        threadName: idxRow?.title || idxRow?.cli_title,
        dispatchTask,
        rawTitle: cliRow?.title || idxRow?.title,
        preview: previewText,
        agentNickname: null,
        agentPath: null,
        id: sid,
      });

      const threadBindings = bindingsByThread.get(sid) || [];
      const threadOps = opsByThread.get(sid) || [];
      const pinned = pref ? pref.pinned : Boolean(idxRow?.pinned);

      zcodeTasks.push({
        id: sid,
        shortId: sid.replace(/^sess_/, '').slice(0, 8),
        engine: 'zcode',
        engineLabel: engine.name,
        title,
        customTitle: pref?.customTitle || null,
        rawTitle: (cliRow?.title || idxRow?.title || title).slice(0, 400),
        projectName,
        worktreeLabel,
        cwd,
        branch: dispatchTask?.branch || '',
        model: displayModel,
        rawModel,
        reasoningEffort: usage?.variant || dispatchTask?.effort || 'max',
        source: isManagedDispatch ? 'exec' : 'zcode_desktop',
        originator: isManagedDispatch ? 'zcode_exec' : 'zcode_desktop',
        isExec: isManagedDispatch,
        isManagedDispatch,
        isAgyDispatched: isManagedDispatch,
        isSubagent: false,
        parentThreadId: null,
        childCount: 0,
        agentNickname: null,
        agentRole: null,
        pinned,
        pinnedAt: pref?.pinnedAt || null,
        hidden: Boolean(pref?.hidden),
        archived: Boolean(idxRow?.archived || cliRow?.time_archived),
        tokensUsed: Number(usage?.total_tok || 0),
        durationSec: Math.round(Number(usage?.total_dur_ms || Math.max(0, updatedMs - createdMs)) / 1000),
        createdAtMs: createdMs,
        updatedAtMs: updatedMs,
        status,
        goal: null,
        queuedCount: 0,
        latestReply: unwrapStructuredReply(previewText).replace(/\s+/g, ' ').trim().slice(0, 220),
        latestTurnStatus: isRunning ? 'inProgress' : 'completed',
        dispatchTask: dispatchTask
          ? {
              taskId: dispatchTask.task_id,
              backend: 'zcode',
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
      });
    }

    return zcodeTasks;
  }

  getSnapshot({ limit = 160 } = {}) {
    const prefsMap = this.consoleDb.getAllPrefs();
    const dispatchState = readDispatchState();
    const engineConfig = loadEngineConfig();
    const engineMap = new Map(engineConfig.engines.map(engine => [engine.id, engine]));
    const visible = id => !engineConfig.policy.hideDisabledEngineTasks || engineMap.get(id)?.enabled;
    const dispatchTasksList = Object.entries(dispatchState.tasks || {})
      .map(([id, task]) => ({ ...task, task_id: task.task_id || id }))
      .filter(task => visible(dispatchBackend(task)));
    const dispatchBySession = new Map();
    for (const t of dispatchTasksList) {
      const backend = dispatchBackend(t);
      if (!dispatchBySession.has(backend)) dispatchBySession.set(backend, new Map());
      if (t.session_id) dispatchBySession.get(backend).set(t.session_id, t);
    }
    const readCodexDb = (file, fn, fallback) => withReadOnlyDb(visible('codex') && file, fn, fallback);

    // 1. Read state_5.sqlite
    const stateData = readCodexDb(
      this.stateDbPath,
      (db) => {
        const projects = db.prepare('SELECT id, name FROM projects ORDER BY position ASC').all();
        const roots = db.prepare(`
          SELECT pr.project_id, pr.path, p.name AS project_name
          FROM project_roots pr
          JOIN projects p ON p.id = pr.project_id
        `).all();
        const threads = db.prepare(`
          SELECT id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
                 source, thread_source, originator, cwd, title, name, preview,
                 tokens_used, archived, is_pinned, git_branch, git_sha,
                 model, reasoning_effort, agent_nickname, agent_role, agent_path,
                 project_id, history_mode
          FROM threads
          WHERE id IN (SELECT id FROM threads ORDER BY updated_at DESC LIMIT ?)
             OR id IN (SELECT value FROM json_each(?))
          ORDER BY updated_at DESC
        `).all(limit, JSON.stringify([...(dispatchBySession.get('codex')?.keys() || [])]));
        const totalRow = db.prepare('SELECT COUNT(*) AS c FROM threads').get();
        const spawnEdges = db.prepare(
          'SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges'
        ).all();
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
    const goalsMap = readCodexDb(
      this.goalsDbPath,
      (db) => {
        const rows = db.prepare('SELECT * FROM thread_goals').all();
        return new Map(rows.map((r) => [r.thread_id, r]));
      },
      new Map()
    );

    // 3. Read queue_1.sqlite
    const queueCountMap = readCodexDb(
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
    const codexTasks = stateData.threads.map((row) => {
      const pref = prefsMap.get(row.id) || null;
      const goal = goalsMap.get(row.id) || null;
      const dispatchTask = dispatchBySession.get('codex')?.get(row.id) || null;
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
        engine: 'codex',
        engineLabel: engineMap.get('codex').name,
        title,
        customTitle: pref?.customTitle || null,
        rawTitle: (row.title || '').slice(0, 400),
        projectName,
        worktreeLabel,
        cwd: row.cwd || '',
        branch: row.git_branch || dispatchTask?.branch || '',
        model: row.model || dispatchTask?.model || '',
        rawModel: row.model || dispatchTask?.model || '',
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
              backend: dispatchTask.backend || 'codex',
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

    const zcode = engineMap.get('zcode');
    const providerLabels = visible('zcode') ? discoverZcodeEnvironment(zcode.binPath, zcode.configFilePath).providerLabels : {};
    const zcodeTasks = visible('zcode') ? this._loadZcodeTasks({
      limit: Math.max(60, Math.floor(limit / 2)), prefsMap, dispatchBySession: dispatchBySession.get('zcode') || new Map(),
      opsByThread, bindingsByThread, engine: zcode, providerLabels,
    }) : [];
    const tasks = [...codexTasks, ...zcodeTasks];
    const nativeIds = new Map(tasks.map(t => [t.id, t.engine]));
    const dispatchCards = new Map();
    const results = new Map();
    for (const record of dispatchTasksList) {
      const backend = dispatchBackend(record);
      const result = readDispatchRunResult(record.run_dir);
      results.set(record.task_id, result);
      if (record.session_id && nativeIds.get(record.session_id) === backend) continue;
      const id = !record.session_id || nativeIds.has(record.session_id) ? record.task_id : record.session_id;
      const cwd = record.workdir || record.worktree_path || record.original_cwd || record.repo_root || '';
      const pref = prefsMap.get(id);
      const summary = result?.report?.summary || result?.summary || record.report?.summary || record.summary || '';
      const rawModel = record.model || result?.model_used || '';
      const updatedAtMs = Date.parse(record.updated_at || record.created_at) || 0;
      const createdAtMs = Date.parse(record.created_at) || updatedAtMs;
      const title = cleanDisplayTitle({ customTitle: pref?.customTitle, dispatchTask: record, rawTitle: record.title || record.prompt, id });
      const status = computeEffectiveStatus({ thread: { task_status: record.status }, dispatchTask: record });
      const bindings = bindingsByThread.get(id) || [];
      const card = {
        id, shortId: id.slice(0, 8), sessionId: record.session_id || null, engine: backend, engineLabel: engineMap.get(backend)?.name || backend,
        title, customTitle: pref?.customTitle || null, rawTitle: record.title || title,
        projectName: deriveProjectName({ cwd }, projectsById, projectRoots, record), cwd, branch: record.branch || '',
        worktreeLabel: parseWorktreeLabel(record.worktree_path || cwd), model: backend === 'zcode' ? formatZcodeModelDisplay(rawModel, providerLabels) : rawModel,
        rawModel, reasoningEffort: record.effort || '', source: 'dispatch', originator: backend,
        isExec: true, isManagedDispatch: true, isAgyDispatched: true, isSubagent: false, childCount: 0, parentThreadId: null,
        pinned: Boolean(pref?.pinned), hidden: Boolean(pref?.hidden), pinnedAt: pref?.pinnedAt || null, archived: false,
        tokensUsed: Number(result?.usage?.total_tokens || 0), durationSec: Math.max(0, Math.round((updatedAtMs - createdAtMs) / 1000)),
        createdAtMs, updatedAtMs, status, goal: null, queuedCount: 0, summary, latestReply: summary.slice(0, 220),
        latestTurnStatus: record.status, dispatchTask: { taskId: record.task_id, backend, status: record.status, difficulty: record.difficulty,
          branch: record.branch, worktreePath: record.worktree_path, repoRoot: record.repo_root, isolation: record.isolation,
          sandbox: record.sandbox, exitCode: record.exit_code },
        bindingCount: bindings.length, changeKeys: bindings.map(b => b.changeKey),
        runningOpsCount: (opsByThread.get(id) || []).filter(op => op.status === 'running').length,
      };
      dispatchCards.set(record.task_id, card);
      nativeIds.set(id, backend);
      tasks.push(card);
    }
    tasks.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    const byId = new Map(tasks.map(task => [task.id, task]));
    const managedAgents = dispatchTasksList
      .map((t) => {
        const backend = dispatchBackend(t);
        const result = results.get(t.task_id);
        const linkedThread = dispatchCards.get(t.task_id) || byId.get(t.session_id);
        const rawMod = t.model || linkedThread?.rawModel || linkedThread?.model || '';
        const displayMod = backend === 'zcode' ? formatZcodeModelDisplay(rawMod, providerLabels) : rawMod;
        return {
          kind: 'dispatch',
          id: t.task_id,
          taskId: t.task_id,
          backend,
          engine: backend,
          engineLabel: engineMap.get(backend)?.name || backend,
          threadId: linkedThread?.id || t.session_id || null,
          title:
            linkedThread?.title ||
            `${path.basename(t.repo_root || t.original_cwd || '')} · ${t.task_id}`,
          projectName: t.repo_root
            ? path.basename(t.repo_root)
            : path.basename(t.original_cwd || ''),
          status: linkedThread?.status?.code === 'running' ? 'running' : t.status || 'unknown',
          model: displayMod,
          rawModel: rawMod,
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
    const engineCounts = Object.fromEntries(engineConfig.engines.map(e => [e.id, 0]));
    for (const task of nonSubagentTasks) {
      if (!task.hidden) engineCounts[task.engine] = (engineCounts[task.engine] || 0) + 1;
    }
    const health = this.getHealth();
    const stats = {
      totalThreads: stateData.totalThreads + zcodeTasks.length + dispatchCards.size,
      loadedThreads: tasks.length,
      visibleThreads: nonSubagentTasks.length,
      engineCounts,
      codexCount: engineCounts.codex,
      zcodeCount: engineCounts.zcode,
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
      connected: health.stateDbExists || health.zcodeCliDbExists || health.dispatchStateExists,
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

  _getZcodeThreadDetail(sessionId, task) {
    const history = withReadOnlyDb(
      this.zcodeCliDbPath,
      (db) => {
        const rows = db
          .prepare(
            `SELECT p.id AS part_id, p.message_id, p.time_created, p.data AS part_json, p.sequence AS part_seq,
                    m.data AS msg_json, m.sequence AS msg_seq
             FROM part p
             JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
             WHERE p.session_id = ?
             ORDER BY m.sequence ASC, p.sequence ASC
             LIMIT 220`
          )
          .all(sessionId);

        const messages = [];
        let ord = 1;
        for (const r of rows) {
          try {
            const mObj = JSON.parse(r.msg_json || '{}');
            const pObj = JSON.parse(r.part_json || '{}');
            if (
              mObj.synthetic === true ||
              mObj.visibility === 'model-only' ||
              pObj.synthetic === true ||
              pObj.visibility === 'model-only'
            ) {
              continue;
            }
            const role = mObj.role || 'assistant';
            const pType = pObj.type || '';
            if (pType === 'text' && typeof pObj.text === 'string' && pObj.text.trim()) {
              const txt = pObj.text.trim();
              messages.push({
                id: r.part_id,
                turnId: mObj.anchor?.turnId || r.message_id,
                ordinal: ord++,
                type: role === 'user' ? 'userMessage' : 'agentMessage',
                createdAtMs: r.time_created,
                text: txt.length > 4000 ? `${txt.slice(0, 4000)}\n…(已截断)` : txt,
              });
            } else if (pType === 'reasoning' && typeof pObj.text === 'string' && pObj.text.trim()) {
              messages.push({
                id: r.part_id,
                turnId: r.message_id,
                ordinal: ord++,
                type: 'reasoning',
                createdAtMs: r.time_created,
                text: pObj.text.trim().slice(0, 1200),
              });
            } else if (pType === 'tool' || pObj.tool) {
              const toolName = pObj.tool || pObj.name || 'Tool';
              const stateStatus = pObj.state?.status || '';
              const inputPreview = pObj.state?.input
                ? JSON.stringify(pObj.state.input).slice(0, 260)
                : '';
              messages.push({
                id: r.part_id,
                turnId: r.message_id,
                ordinal: ord++,
                type: 'commandExecution',
                createdAtMs: r.time_created,
                text: `[${toolName}] ${inputPreview}${stateStatus ? ` (${stateStatus})` : ''}`,
              });
            }
          } catch {
            // skip malformed row
          }
        }
        return { turns: [], messages };
      },
      { turns: [], messages: [] }
    );

    if (!history.messages.length && task?.latestReply) {
      history.messages.push({
        id: `${sessionId}-summary`,
        turnId: 'turn-1',
        ordinal: 1,
        type: 'agentMessage',
        createdAtMs: task.updatedAtMs,
        text: task.latestReply,
      });
    }

    const ops = this.consoleDb.listOps({ threadId: sessionId, limit: 25 });
    const bindings = this.consoleDb.listBindings({ threadId: sessionId, limit: 20 });

    return {
      task,
      turns: history.turns,
      messages: history.messages,
      queuedItems: [],
      childThreads: [],
      ops,
      bindings,
    };
  }

  getThreadDetail(threadId) {
    const snapshot = this.getSnapshot({ limit: 200 });
    const task = snapshot.tasks.find(t => t.id === threadId || t.dispatchTask?.taskId === threadId) || null;
    if (!task) return { task: null, turns: [], messages: [], queuedItems: [], childThreads: [], ops: [], bindings: [] };
    threadId = task.id;
    if (task.source === 'dispatch') {
      const record = readDispatchState().tasks?.[task.dispatchTask.taskId];
      return { task, turns: [], messages: dispatchMessages(record, task), queuedItems: [], childThreads: [],
        ops: this.consoleDb.listOps({ threadId, limit: 25 }), bindings: this.consoleDb.listBindings({ threadId, limit: 20 }) };
    }
    if (task.engine === 'zcode') {
      return this._getZcodeThreadDetail(threadId, task);
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
            UNION
            SELECT turn_id, item_id, rollout_ordinal, created_at_ms, item_type, item_json
            FROM (
              SELECT turn_id, item_id, rollout_ordinal, created_at_ms, item_type, item_json
              FROM thread_items
              WHERE thread_id = ?
                AND item_type IN ('fileChange', 'commandExecution', 'reasoning')
              ORDER BY rollout_ordinal DESC
              LIMIT 80
            )
          )
          ORDER BY rollout_ordinal DESC
          LIMIT 110
        `).all(threadId, threadId);

        const messages = items
          .reverse()
          .map((it) => {
            const rawText = extractTextFromItem(it.item_type, it.item_json);
            const text = it.item_type === 'agentMessage' ? unwrapStructuredReply(rawText) : rawText;
            return {
              id: it.item_id,
              turnId: it.turn_id,
              ordinal: it.rollout_ordinal,
              type: it.item_type,
              createdAtMs: it.created_at_ms,
              text: text.length > 4000 ? `${text.slice(0, 4000)}\n…(已截断)` : text,
            };
          })
          .filter((m) => m.text && m.text.trim());

        return { turns, messages };
      },
      { turns: [], messages: [] }
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
      messages: history.messages,
      queuedItems,
      childThreads,
      ops,
      bindings,
    };
  }
}
