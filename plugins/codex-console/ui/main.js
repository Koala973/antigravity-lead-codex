import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';
import { renderPixelCat } from './cat-pet.js';

const app = new App({ name: 'Antigravity Lead Codex', version: '2.0.0' }, {});
const SLEEP_IDLE_MS = 12 * 60 * 1000;

const MODE_TIPS = {
  queue: '排队唤醒 (codex queue --resume)',
  resume: '同步续跑 (按当前会话引擎继续执行)',
  dispatch_resume: '隔离 Worktree 续跑 (dispatch.py resume)',
  readonly: '只读查询 (不修改工作区文件)',
};

const SCENARIO_DEFS = [
  {
    key: 'wide_context',
    title: '超长上下文全库扫街（10+ 文件摸底）',
    hint: '适合大窗口模型，如 ZCode / glm-5.3 或 Gemini CLI 1M 窗口',
  },
  {
    key: 'architecture_concurrency',
    title: '核心架构重构与并发状态机排障',
    hint: '适合深度推理与硬沙箱引擎，如 OpenAI Codex / gpt-6.2-astra',
  },
  {
    key: 'chinese_business_security',
    title: '中文复杂业务逻辑与安全测试分析',
    hint: '适合中文推理与安全审计模型，如 ZCode / kimi-k3 或 deepseek-v4',
  },
  {
    key: 'unit_tests_and_tools',
    title: '批量单元测试补齐与插件/脚本工具调用',
    hint: '适合批量单测与工具调用模型，如 ZCode / deepseek-v4 或 qwen3.8-max',
  },
];

const EFFORT_OPTIONS = [
  { value: 'max', label: 'max（满血深度思考）' },
  { value: 'xhigh', label: 'xhigh（极高推理）' },
  { value: 'high', label: 'high（高推理）' },
  { value: 'medium', label: 'medium（均衡推理）' },
];

const ENGINE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const ICON_HIDE = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="3" rx="1"/><path d="M3.5 6v6.5A1.5 1.5 0 0 0 5 14h6a1.5 1.5 0 0 0 1.5-1.5V6"/><path d="M6.5 9.5h3"/></svg>`;
const ICON_RESTORE = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8a5 5 0 1 1 1.5 3.6"/><path d="M3 4.5V8h3.5"/></svg>`;

const state = {
  connected: false,
  capabilities: {},
  stats: {
    loadedThreads: 0,
    visibleThreads: 0,
    engineCounts: {},
    codexCount: 0,
    zcodeCount: 0,
    agyCount: 0,
    runningCount: 0,
    goalBlockedCount: 0,
    managedCount: 0,
    collabCount: 0,
    runningOpsCount: 0,
  },
  tasks: [],
  managedAgents: [],
  bindings: [],
  quota: null,
  refreshingQuota: false,
  engineSettings: null,
  settingsDraft: null,
  settingsDirty: false,
  savingSettings: false,
  settingsUi: {
    expandedEngineId: null,
    showAddEngineForm: false,
    newEngine: {
      id: '',
      name: '',
      binPath: '',
      configFilePath: '',
      primaryModel: '',
      fallbackModel: '',
      defaultEffort: 'high',
    },
    showScenarios: false,
    showAdapterDetails: false,
  },

  activeTab: 'tasks',          // tasks | subagents | collab | settings
  narrowView: 'list',          // list | detail (used when container < 640px)
  engineFilter: 'all',         // all | <engineId>
  detailSubTab: 'history',     // history | ops | git
  showDesktopTasks: false,
  showHiddenDrawer: false,

  spawnDraft: {
    backend: '',
    model: 'auto',
    quality: 'max',
    difficulty: 'auto',
    isolation: 'worktree',
    cwd: '',
    prompt: '',
    taskId: '',
    changeKey: '',
    showOptional: false,
  },

  selectedThreadId: null,
  selectedAgentId: null,
  selectedBindingId: null,
  selectedDetail: null,
  selectedGit: null,

  loadingSnapshot: false,
  sendingMessage: false,
  searchQuery: '',
  composerText: '',
  composerMode: 'queue',
  allowDuplicate: false,

  catMeowing: false,
  catMeowTimer: null,
  catFreezeLeft: null,
  catFreezeFlip: 1,
  lastCatWakeMs: 0,

  modal: null,                 // null | spawn | readonly | binding | rename
  toast: null,
  toastTimer: null,
  autoRefreshTimer: null,
  lastPollMs: 12_000,
};

// ---------------- Formatters ----------------

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relTime(ms) {
  if (!ms) return '';
  const sec = Math.max(0, Math.floor((Date.now() - Number(ms)) / 1000));
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function clockTime(ms) {
  if (!ms) return '';
  return new Date(Number(ms)).toTimeString().slice(0, 5);
}

function fmtTokens(n) {
  const num = Number(n || 0);
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M tok`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k tok`;
  return num > 0 ? `${num} tok` : '';
}

function fmtDuration(sec) {
  const s = Number(sec || 0);
  if (s <= 0) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function dotClass(code) {
  if (code === 'running' || code === 'goal_active') return 'running';
  if (code === 'blocked' || code === 'limited') return 'blocked';
  if (code === 'failed') return 'failed';
  if (code === 'exec_done' || code === 'complete' || code === 'completed') return 'done';
  return '';
}

function quotaTone(rem) {
  if (typeof rem !== 'number') return 'muted';
  if (rem <= 20) return 'danger';
  if (rem <= 50) return 'warn';
  return 'healthy';
}

function fmtReset(ms) {
  if (!ms) return '';
  const diff = Math.floor((Number(ms) - Date.now()) / 1000);
  const d = new Date(Number(ms));
  const clk = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (diff <= 0) return clk;
  const days = Math.floor(diff / 86400);
  const hrs = Math.floor((diff % 86400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  if (days > 0) return `${days}d ${hrs}h · ${clk}`;
  if (hrs > 0) return `${hrs}h ${mins}m · ${clk}`;
  return `${Math.max(1, mins)}m · ${clk}`;
}

function renderMd(text) {
  if (!text) return '';
  const lines = String(text).split('\n');
  let html = '';
  let inList = false;
  let inCode = false;
  let codeBuf = [];
  const flush = () => {
    if (inList) {
      html += '</ul>';
      inList = false;
    }
  };
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      flush();
      if (!inCode) {
        inCode = true;
        codeBuf = [];
      } else {
        inCode = false;
        html += `<pre>${esc(codeBuf.join('\n'))}</pre>`;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    const t = line.trim();
    if (!t) {
      flush();
      continue;
    }
    const lm = t.match(/^[-*•]\s+(.*)$/) || t.match(/^\d+[.)]\s+(.*)$/);
    if (lm) {
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      html += `<li>${inline(lm[1])}</li>`;
      continue;
    }
    flush();
    if (t.startsWith('### ')) html += `<p><strong>${inline(t.slice(4))}</strong></p>`;
    else if (t.startsWith('## ')) html += `<p><strong>${inline(t.slice(3))}</strong></p>`;
    else html += `<p>${inline(t)}</p>`;
  }
  flush();
  if (inCode && codeBuf.length) html += `<pre>${esc(codeBuf.join('\n'))}</pre>`;
  return html;
}

function oneLineClean(text) {
  return String(text || '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanCommandPreview(rawCmd) {
  let s = oneLineClean(rawCmd);
  s = s.replace(/^\$\s*\/bin\/(?:z|ba)?sh\s+-lc\s+["'](.+)["']\s*(\[[^\]]+\])?$/, '$ $1 $2');
  s = s.replace(/^\$\s*\/bin\/(?:z|ba)?sh\s+-lc\s+["']/, '$ ');
  return s.trim();
}

function stripExecutionContract(text) {
  const raw = String(text || '').trim();
  const marker = '[Execution Contract]';
  const idx = raw.indexOf(marker);
  return idx < 0 ? raw : raw.slice(0, idx).trim();
}

function showToast(text, kind = 'ok') {
  state.toast = { text, kind };
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    state.toast = null;
    render();
  }, 2400);
  render();
}

// ---------------- Server RPC ----------------

async function callTool(name, args = {}) {
  const res = await app.callServerTool({ name, arguments: args });
  if (res?.isError) {
    throw new Error(res?.structuredContent?.error || res?.content?.[0]?.text || name);
  }
  return res?.structuredContent ?? {};
}

async function refreshSnapshot({ silent = false } = {}) {
  if (state.loadingSnapshot) return;
  state.loadingSnapshot = true;
  if (!silent) render();
  try {
    const data = await callTool('console_snapshot', { limit: 180 });
    state.connected = Boolean(data.connected);
    state.stats = data.stats || state.stats;
    state.tasks = data.tasks || [];
    state.managedAgents = data.managedAgents || [];
    state.bindings = data.bindings || [];
    if (data.quota) state.quota = data.quota;
    if (data.engineSettings) {
      state.engineSettings = data.engineSettings;
      if (!state.settingsDraft || !state.settingsDirty) {
        state.settingsDraft = cloneConfig(data.engineSettings.config);
      }
      const validIds = new Set(getEngineList().map((e) => e.id));
      if (state.engineFilter !== 'all' && !validIds.has(state.engineFilter)) {
        state.engineFilter = 'all';
      }
    }

    if (!state.selectedThreadId && state.tasks.length) {
      const visible = state.tasks.filter((t) => !t.isSubagent && !t.hidden);
      const pick =
        visible.find((t) => t.isAgyDispatched && t.status.code === 'running') ||
        visible.find((t) => t.pinned) ||
        visible.find((t) => t.isAgyDispatched) ||
        visible[0] ||
        state.tasks[0];
      state.selectedThreadId = pick?.id || null;
    }
    if (!state.selectedAgentId && state.managedAgents.length) {
      state.selectedAgentId = state.managedAgents[0].id;
    }
    if (!state.selectedBindingId && state.bindings.length) {
      state.selectedBindingId = state.bindings[0].id;
    }
    if (state.selectedThreadId) {
      await loadThreadDetail(state.selectedThreadId, { silent: true });
    }
    scheduleAutoRefresh();
  } catch (err) {
    if (!silent) showToast(err.message, 'error');
  } finally {
    state.loadingSnapshot = false;
    render();
  }
}

async function refreshQuotaLive({ silent = false } = {}) {
  if (state.refreshingQuota) return;
  state.refreshingQuota = true;
  if (!silent) render();
  try {
    const res = await callTool('console_refresh_quota', {});
    if (res?.quota) state.quota = res.quota;
    if (!silent && state.quota?.available) {
      showToast(`额度已同步 · ${Math.round(state.quota.bottleneck.remainingPercent)}%`);
    }
  } catch (err) {
    if (!silent) showToast(err.message, 'error');
  } finally {
    state.refreshingQuota = false;
    render();
  }
}

async function loadThreadDetail(threadId, { silent = false, drill = false } = {}) {
  if (!threadId) return;
  state.selectedThreadId = threadId;
  if (drill) state.narrowView = 'detail';
  try {
    const detail = await callTool('get_codex_task_detail', { threadId });
    state.selectedDetail = detail;
    state.selectedGit = detail.git || null;
  } catch (err) {
    if (!silent) showToast(err.message, 'error');
  } finally {
    render();
  }
}

async function updateThreadPref(threadId, patch, toastMsg = '') {
  try {
    await callTool('console_toggle_pin', { threadId, ...patch });
    if (patch.hidden === true && state.selectedThreadId === threadId) {
      const next = state.tasks.find((t) => !t.isSubagent && !t.hidden && t.id !== threadId);
      if (next) state.selectedThreadId = next.id;
    }
    await refreshSnapshot({ silent: true });
    if (toastMsg) showToast(toastMsg);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function triggerReadonly(threadId, prompt = '', preset = 'diagnose_blocker') {
  try {
    const res = await callTool('ask_codex_readonly', { threadId, prompt, preset });
    state.detailSubTab = 'ops';
    showToast(preset === 'diagnose_blocker' ? '已发起诊断' : '已发起提问');
    await loadThreadDetail(threadId, { silent: true });
    if (res?.op?.id) pollOp(res.op.id, threadId);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function pollOp(opId, threadId) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const { op } = await callTool('console_get_op', { opId });
      if (!op || op.status !== 'running') {
        await refreshSnapshot({ silent: true });
        if (threadId && state.selectedThreadId === threadId) {
          await loadThreadDetail(threadId, { silent: true });
        }
        return;
      }
    } catch {
      return;
    }
  }
}

async function sendComposer() {
  const task = selectedTask();
  const msg = state.composerText.trim();
  if (!task || !msg || state.sendingMessage) return;
  const effectiveMode =
    task.engine !== 'codex' && state.composerMode === 'queue'
      ? 'resume'
      : state.composerMode === 'dispatch_resume' && !task.dispatchTask
        ? 'resume'
        : state.composerMode;
  state.sendingMessage = true;
  render();
  try {
    const res = await callTool('send_codex_message', {
      threadId: task.id,
      message: msg,
      mode: effectiveMode,
      allowDuplicate: state.allowDuplicate,
    });
    state.composerText = '';
    if (effectiveMode === 'readonly') state.detailSubTab = 'ops';
    const op = res?.op;
    if (op?.status === 'failed') showToast(op.errorText || '发送失败', 'error');
    else if (op?.status === 'running') {
      showToast('后台执行中');
      pollOp(op.id, task.id);
    } else showToast('已发送');
    await loadThreadDetail(task.id, { silent: true });
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    state.sendingMessage = false;
    render();
  }
}

async function sendBack(text) {
  if (!state.capabilities?.message) return;
  try {
    await app.sendMessage({ role: 'user', content: [{ type: 'text', text }] });
    showToast('已发回对话');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function openFile(absPath) {
  if (!absPath) return;
  const uri = absPath.startsWith('file://') ? absPath : `file://${encodeURI(absPath)}`;
  try {
    await app.request(
      { method: 'com.google.antigravity/toggle-aux-pane', params: { tabType: 'fileView', uri } },
      z.object({ isError: z.boolean().optional() }).passthrough()
    );
  } catch {
    showToast('无法打开文件', 'error');
  }
}

function copyText(str) {
  navigator.clipboard?.writeText(str).then(() => showToast('已复制'), () => showToast(str));
}

// ---------------- Engine Registry & Workflow Helpers ----------------

function cloneConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  try {
    return JSON.parse(JSON.stringify(cfg));
  } catch {
    return null;
  }
}

function getFallbackConfig() {
  return {
    version: 2,
    updatedAtMs: 0,
    engines: [
      {
        id: 'codex',
        name: 'OpenAI Codex',
        builtin: true,
        kind: 'codex',
        enabled: true,
        binPath: '',
        configFilePath: '~/.codex/models_cache.json',
        models: { primaryModel: 'auto', fallbackModel: '', defaultEffort: 'xhigh' },
        adapter: {
          execTemplate: 'codex exec -C {cwd} -m {model} -c model_reasoning_effort="{effort}" -s {sandbox} --json -',
          readonlyTemplate: 'codex exec review -m {model} -c model_reasoning_effort="{effort}" -c sandbox_mode="read-only" --json',
          resumeTemplate: 'codex exec resume -m {model} -c model_reasoning_effort="{effort}" {session_id} -',
          syncDesktopIndex: false,
        },
      },
      {
        id: 'zcode',
        name: 'ZCode CLI',
        builtin: true,
        kind: 'zcode',
        enabled: false,
        binPath: '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
        configFilePath: '~/.zcode/v2/provider_config.json',
        models: {
          primaryModel: 'qwen-alibaba-model-studio-cn/kimi-k3',
          fallbackModel: 'qwen-alibaba-model-studio-cn/deepseek-v4-pro-0813',
          defaultEffort: 'max',
        },
        adapter: {
          execTemplate: 'node {bin} -p {prompt} --cwd {cwd} --mode build --json --no-color',
          readonlyTemplate: 'node {bin} -p {prompt} --cwd {cwd} --mode plan --json --no-color',
          resumeTemplate: 'node {bin} --resume {session_id} -p {prompt} --cwd {cwd} --mode build --json --no-color',
          syncDesktopIndex: true,
        },
      },
      {
        id: 'claude',
        name: 'Claude Code',
        builtin: true,
        kind: 'custom_cli',
        enabled: false,
        binPath: 'claude',
        configFilePath: '~/.claude.json',
        models: { primaryModel: 'claude-sonnet-4-6', fallbackModel: '', defaultEffort: 'high' },
        adapter: {
          execTemplate: '{bin} -p {prompt} --model {model} --output-format json',
          readonlyTemplate: '{bin} -p {prompt} --model {model} --permission-mode plan --output-format json',
          resumeTemplate: '{bin} --resume {session_id} -p {prompt} --model {model} --output-format json',
          syncDesktopIndex: false,
        },
      },
      {
        id: 'gemini',
        name: 'Gemini CLI',
        builtin: true,
        kind: 'custom_cli',
        enabled: false,
        binPath: 'gemini',
        configFilePath: '~/.gemini/settings.json',
        models: { primaryModel: 'gemini-2.5-pro', fallbackModel: '', defaultEffort: 'high' },
        adapter: {
          execTemplate: '{bin} -p {prompt} -m {model} --output-format json',
          readonlyTemplate: '{bin} -p {prompt} -m {model} --output-format json',
          resumeTemplate: '{bin} --resume {session_id} -p {prompt} -m {model} --output-format json',
          syncDesktopIndex: false,
        },
      },
    ],
    workflowRoles: {
      primaryBuilder: { engineId: 'codex', model: 'auto', effort: 'xhigh' },
      reviewer: { mode: 'auto_heterogeneous', engineId: '', model: 'auto', effort: 'max' },
      scenarios: {
        wide_context: { enabled: false, engineId: '', model: '', fallbackModel: '', effort: 'max' },
        architecture_concurrency: { enabled: false, engineId: '', model: '', fallbackModel: '', effort: 'xhigh' },
        chinese_business_security: { enabled: false, engineId: '', model: '', fallbackModel: '', effort: 'max' },
        unit_tests_and_tools: { enabled: false, engineId: '', model: '', fallbackModel: '', effort: 'max' },
      },
    },
    policy: {
      costStrategy: 'effect_first',
      defaultIsolation: 'worktree',
      hideDisabledEngineTasks: false,
    },
  };
}

function getActiveConfig() {
  if (!state.settingsDraft) {
    state.settingsDraft = cloneConfig(state.engineSettings?.config) || getFallbackConfig();
  }
  return state.settingsDraft;
}

function getEngineList(cfg = null) {
  const c = cfg || state.engineSettings?.config || state.settingsDraft || getFallbackConfig();
  return Array.isArray(c?.engines) ? c.engines : [];
}

function getEnabledEngines(cfg = null) {
  return getEngineList(cfg).filter((e) => e.enabled);
}

function getEngineById(id, cfg = null) {
  return getEngineList(cfg).find((e) => e.id === id) || null;
}

function getEngineDiscovery(id) {
  return (
    state.engineSettings?.discovery?.engines?.[id] || {
      id,
      available: false,
      detectedBin: null,
      configExists: false,
      resolvedConfigPath: '',
      providers: [],
      models: [],
    }
  );
}

function getEngineShortName(id, fallbackLabel = '') {
  if (id === 'codex') return 'Codex';
  if (id === 'zcode') return 'ZCode';
  if (id === 'claude') return 'Claude';
  if (id === 'gemini') return 'Gemini';
  const entry = getEngineById(id);
  return fallbackLabel || entry?.name || id || 'CLI';
}

function formatModelDisplay(modelId, engineId) {
  const val = String(modelId || '').trim();
  if (!val || val === 'auto') return 'auto';
  if (engineId === 'zcode' && val.includes('/')) {
    const disc = getEngineDiscovery('zcode');
    const matched = (disc.models || []).find((m) => m.id === val);
    if (matched?.label) return matched.label;
    const [, shortMod] = val.split('/', 2);
    return shortMod || val;
  }
  return val;
}

function ensureDraftConsistency(cfg) {
  const active = (cfg.engines || []).filter((e) => e.enabled);
  if (!active.length && cfg.engines?.length) {
    cfg.engines[0].enabled = true;
    active.push(cfg.engines[0]);
  }
  const activeIds = new Set(active.map((e) => e.id));
  if (!activeIds.has(cfg.workflowRoles.primaryBuilder.engineId)) {
    cfg.workflowRoles.primaryBuilder.engineId = active[0]?.id || 'codex';
    cfg.workflowRoles.primaryBuilder.model = 'auto';
  }
  if (
    cfg.workflowRoles.reviewer.mode === 'explicit' &&
    !activeIds.has(cfg.workflowRoles.reviewer.engineId)
  ) {
    cfg.workflowRoles.reviewer.mode = 'auto_heterogeneous';
    cfg.workflowRoles.reviewer.engineId = '';
  }
  return cfg;
}

function resolveAutoReviewerPreview(cfg) {
  const active = (cfg.engines || []).filter((e) => e.enabled);
  const builderId = cfg.workflowRoles?.primaryBuilder?.engineId || active[0]?.id || '';
  const builder = active.find((e) => e.id === builderId) || active[0] || null;
  const others = active.filter((e) => e.id !== builder?.id);
  const preferredOther =
    others.find((e) => getEngineDiscovery(e.id).available) || others[0] || null;

  if (preferredOther && builder) {
    return {
      isHeterogeneous: true,
      builderName: builder.name,
      reviewerName: preferredOther.name,
      reviewerId: preferredOther.id,
      text: `${builder.name} 施工 ⇄ ${preferredOther.name} 交叉审计`,
      sub: '按当前已启用引擎自动异构互审；切换主力施工引擎后审查方自动对调',
    };
  }
  return {
    isHeterogeneous: false,
    builderName: builder?.name || '当前引擎',
    reviewerName: builder?.name || '当前引擎',
    reviewerId: builder?.id || '',
    text: `${builder?.name || '当前引擎'} 独立只读沙箱自审`,
    sub: '当前仅启用 1 个引擎；启用第 2 个引擎后将自动升级为异构交叉互审',
  };
}

// ---------------- Selectors ----------------

function selectedTask() {
  return state.selectedDetail?.task || state.tasks.find((t) => t.id === state.selectedThreadId) || null;
}

function selectedAgent() {
  return state.managedAgents.find((a) => a.id === state.selectedAgentId) || state.managedAgents[0] || null;
}

function selectedBinding() {
  return state.bindings.find((b) => b.id === state.selectedBindingId) || state.bindings[0] || null;
}

function sortPriority(a, b) {
  const rank = (t) =>
    t.status.code === 'running' ? 0 : t.status.code === 'blocked' ? 1 : t.isManagedDispatch ? 2 : 3;
  const d = rank(a) - rank(b);
  return d !== 0 ? d : (b.updatedAtMs || 0) - (a.updatedAtMs || 0);
}

function filteredTasks() {
  const q = state.searchQuery.trim().toLowerCase();
  return state.tasks.filter((t) => {
    if (t.isSubagent) return false;
    if (state.engineFilter !== 'all' && t.engine !== state.engineFilter) return false;
    if (!q) return true;
    return `${t.title} ${t.projectName} ${t.branch} ${t.cwd} ${t.id} ${t.engineLabel || ''} ${t.model || ''} ${t.changeKeys.join(' ')}`
      .toLowerCase()
      .includes(q);
  });
}

function getCatState() {
  const running = state.stats.runningCount + state.stats.runningOpsCount;
  const blocked = state.stats.goalBlockedCount;
  if (running > 0) {
    return { mode: 'working', label: `工作中（${running} 个进行中）· 点击喵一声并定位` };
  }
  if (blocked > 0) {
    return { mode: 'blocked', label: `有 ${blocked} 个任务阻塞 · 点击喵一声并查看` };
  }

  // Determine recent activity within 12 minutes -> strolling; >= 12 min idle -> zZz sleeping
  const agyTasks = state.tasks.filter((t) => !t.isSubagent && t.isAgyDispatched);
  const latestTaskMs = agyTasks.reduce((m, t) => Math.max(m, Number(t.updatedAtMs || 0)), 0);
  const latestActivity = Math.max(latestTaskMs, state.lastCatWakeMs);
  const idleMs = latestActivity ? Date.now() - latestActivity : SLEEP_IDLE_MS + 1;

  if (idleMs < SLEEP_IDLE_MS) {
    const leftMin = Math.max(1, Math.ceil((SLEEP_IDLE_MS - idleMs) / 60_000));
    return { mode: 'strolling', label: `散步中（约 ${leftMin} 分钟无任务后休眠）· 点击喵一声` };
  }
  return { mode: 'sleeping', label: '已休眠 ZZZ · 点击叫醒喵一声' };
}

// ---------------- Topbar Widgets ----------------

function renderQuotaWidget() {
  const q = state.quota;
  const r = 4.6;
  const circ = 2 * Math.PI * r;
  const has = Boolean(q?.available && q?.bottleneck);
  const rem = has ? Math.round(q.bottleneck.remainingPercent) : null;
  const tone = quotaTone(rem);
  const offset = has ? circ * (1 - Math.max(0, Math.min(100, q.bottleneck.remainingPercent)) / 100) : circ;

  const rows = has
    ? q.windows
        .map(
          (w) => `
          <div class="quota-row">
            <div class="quota-row-top">
              <span>${esc(w.label)}</span>
              <strong>剩余 ${Math.round(w.remainingPercent)}%</strong>
            </div>
            <div class="quota-bar-track">
              <div class="quota-bar-fill ${quotaTone(w.remainingPercent)}" style="width:${Math.max(0, Math.min(100, w.remainingPercent))}%"></div>
            </div>
            <div class="quota-row-sub">
              <span>已用 ${w.usedPercent}%</span>
              <span>${esc(fmtReset(w.resetsAtMs))}</span>
            </div>
          </div>`
        )
        .join('')
    : `<div style="font-size:11px;color:var(--fg-muted)">暂未读取到额度</div>`;

  return `
    <div class="quota-wrap">
      <button class="tactile-btn" id="btnQuotaRing" aria-label="Codex 额度">
        <svg class="quota-ring" viewBox="0 0 12 12" aria-hidden="true">
          <circle class="quota-track" cx="6" cy="6" r="${r}"></circle>
          <circle class="quota-arc ${tone}" cx="6" cy="6" r="${r}" stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"></circle>
        </svg>
        <span class="quota-num">${state.refreshingQuota ? '…' : has ? `${rem}%` : '--'}</span>
      </button>
      <div class="quota-popover" role="tooltip">
        <div class="quota-pop-head">
          <span>Codex 额度监控</span>
          <button class="tactile-btn" id="btnQuotaRefresh" style="height:22px;padding:0 8px">${state.refreshingQuota ? '…' : '刷新'}</button>
        </div>
        ${rows}
        <div class="quota-pop-foot">
          ${q?.resetCreditsAvailable > 0 ? `<span>免费重置券: ${q.resetCreditsAvailable}</span>` : ''}
          <span>${q?.source === 'live' ? '官方实时' : '本地缓存'} · ${esc(relTime(q?.updatedAtMs))}</span>
        </div>
      </div>
    </div>
  `;
}

// ---------------- Left Rail: 12px Rounded Organic List Rows ----------------

function renderTaskRow(t, inHiddenDrawer = false) {
  const sel = t.id === state.selectedThreadId;
  const engineName = getEngineShortName(t.engine, t.engineLabel);
  const metaParts = [t.projectName, t.branch].filter(Boolean).join(' · ');
  const modelLabel = t.model || 'auto';
  const effortLabel = (t.reasoningEffort || 'high').toUpperCase();
  return `
    <div class="task-row ${sel ? 'selected' : ''}" data-select-thread="${esc(t.id)}">
      <div class="task-row-line1">
        <span class="status-dot ${dotClass(t.status.code)}"></span>
        <span class="task-row-title" title="${esc(t.title)}">${esc(t.title)}</span>
        <span class="task-row-time">${esc(relTime(t.updatedAtMs))}</span>
      </div>
      <div class="task-row-line2">
        <div style="display:flex;align-items:center;gap:6px;min-width:0;flex:1">
          <span class="argon-box">${esc(engineName)}</span>
          <span class="task-row-meta"><strong>${esc(modelLabel)}</strong> <span class="argon-tier">${esc(effortLabel)}</span>${metaParts ? ` · ${esc(metaParts)}` : ''}</span>
        </div>
        <span class="row-actions">
          ${!inHiddenDrawer ? `
            <button
              class="row-micro-btn ${t.pinned ? 'pinned' : ''}"
              data-pin-thread="${esc(t.id)}"
              data-pinned="${t.pinned ? '1' : '0'}"
              title="${t.pinned ? '取消置顶' : '置顶'}"
            >${t.pinned ? '★' : '☆'}</button>
          ` : ''}
          <button
            class="row-micro-btn"
            data-hide-thread="${esc(t.id)}"
            data-hidden="${inHiddenDrawer ? '1' : '0'}"
            title="${inHiddenDrawer ? '还原' : '隐藏'}"
          >${inHiddenDrawer ? ICON_RESTORE : ICON_HIDE}</button>
        </span>
      </div>
    </div>
  `;
}

function renderTasksLeftRail() {
  const all = filteredTasks();
  const visible = all.filter((t) => !t.hidden);
  const hidden = all.filter((t) => t.hidden);

  const pinned = visible.filter((t) => t.pinned).sort(sortPriority);
  const unpinned = visible.filter((t) => !t.pinned);
  const agy = unpinned.filter((t) => t.isAgyDispatched).sort(sortPriority);
  const desktop = unpinned.filter((t) => !t.isAgyDispatched);
  const desktopOpen =
    state.showDesktopTasks ||
    Boolean(state.searchQuery.trim()) ||
    state.engineFilter !== 'all' ||
    agy.length === 0;

  let itemsHtml = '';
  if (!visible.length && !hidden.length) {
    itemsHtml = `<div class="detail-empty">无匹配任务</div>`;
  } else {
    if (pinned.length) {
      itemsHtml += `<div class="list-group-label"><span>已置顶</span><span>${pinned.length}</span></div>`;
      itemsHtml += pinned.map((t) => renderTaskRow(t, false)).join('');
    }
    if (agy.length) {
      itemsHtml += `<div class="list-group-label"><span>Antigravity</span><span>${agy.length}</span></div>`;
      itemsHtml += agy.map((t) => renderTaskRow(t, false)).join('');
    }
    if (desktop.length) {
      itemsHtml += `<div class="list-group-label toggle" id="btnToggleDesktop"><span>${desktopOpen ? '▾' : '▸'} 桌面历史</span><span>${desktop.length}</span></div>`;
      if (desktopOpen) itemsHtml += desktop.map((t) => renderTaskRow(t, false)).join('');
    }
  }

  const hiddenDrawerHtml = hidden.length
    ? `
      <div class="hidden-drawer">
        <button class="hidden-drawer-toggle" id="btnToggleHidden">
          <span>${state.showHiddenDrawer ? '▾' : '▸'} 已隐藏</span>
          <span>${hidden.length}</span>
        </button>
        ${state.showHiddenDrawer ? `<div class="hidden-drawer-body">${hidden.map((t) => renderTaskRow(t, true)).join('')}</div>` : ''}
      </div>`
    : '';

  const filterEngines = getEngineList().filter(
    (e) => e.enabled || (state.stats?.engineCounts?.[e.id] || 0) > 0
  );

  return `
    <aside class="left-rail">
      <div class="rail-toolbar">
        <input id="searchInput" class="search-input" type="text" placeholder="搜索任务…" value="${esc(state.searchQuery)}" />
        <div class="filter-seg">
          <button class="tactile-btn" data-active="${state.engineFilter === 'all'}" data-engine-filter="all">全部</button>
          ${filterEngines
            .map(
              (e) =>
                `<button class="tactile-btn" data-active="${state.engineFilter === e.id}" data-engine-filter="${esc(e.id)}">${esc(getEngineShortName(e.id, e.name))}</button>`
            )
            .join('')}
        </div>
      </div>
      <div class="task-list">${itemsHtml}</div>
      ${hiddenDrawerHtml}
    </aside>
  `;
}

function renderSubagentsLeftRail() {
  const q = state.searchQuery.trim().toLowerCase();
  const list = state.managedAgents.filter((a) =>
    !q ? true : `${a.title} ${a.taskId} ${a.branch} ${a.projectName} ${a.summary} ${a.engineLabel || ''} ${a.model || ''}`.toLowerCase().includes(q)
  );
  const cur = selectedAgent();

  const itemsHtml = !list.length
    ? `<div class="detail-empty">无受管子代理</div>`
    : list
        .map((a) => {
          const sel = cur && a.id === cur.id;
          const engineName = getEngineShortName(a.backend, a.engineLabel);
          return `
            <div class="task-row ${sel ? 'selected' : ''}" data-select-agent="${esc(a.id)}">
              <div class="task-row-line1">
                <span class="status-dot ${dotClass(a.status)}"></span>
                <span class="task-row-title" title="${esc(a.title)}">${esc(a.title)}</span>
              </div>
              <div class="task-row-line2">
                <div style="display:flex;align-items:center;gap:5px;min-width:0;flex:1">
                  <span class="argon-box">${esc(engineName)}</span>
                  <span class="task-row-meta">${esc([a.model, a.branch].filter(Boolean).join(' · '))}</span>
                </div>
              </div>
            </div>`;
        })
        .join('');

  return `
    <aside class="left-rail">
      <div class="rail-toolbar">
        <input id="searchInput" class="search-input" type="text" placeholder="搜索子代理…" value="${esc(state.searchQuery)}" />
        <button class="tactile-btn icon-only cta" id="btnSpawnFromTab" title="新建">+</button>
      </div>
      <div class="task-list">${itemsHtml}</div>
    </aside>
  `;
}

function renderCollabLeftRail() {
  const q = state.searchQuery.trim().toLowerCase();
  const list = state.bindings.filter((b) =>
    !q ? true : `${b.changeKey} ${b.goalTitle} ${b.ownerRole} ${b.threadId || ''}`.toLowerCase().includes(q)
  );
  const cur = selectedBinding();

  const itemsHtml = !list.length
    ? `<div class="detail-empty">无跨会话绑定</div>`
    : list
        .map((b) => {
          const sel = cur && b.id === cur.id;
          return `
            <div class="task-row ${sel ? 'selected' : ''}" data-select-binding="${esc(b.id)}">
              <div class="task-row-line1">
                <span class="status-dot ${dotClass(b.status)}"></span>
                <span class="task-row-title" title="${esc(b.changeKey)}">${esc(b.changeKey)}</span>
                <span class="pill-badge">${esc(b.ownerRole)}</span>
              </div>
              <div class="task-row-line2">
                <span class="task-row-meta">${esc(b.goalTitle)}</span>
              </div>
            </div>`;
        })
        .join('');

  return `
    <aside class="left-rail">
      <div class="rail-toolbar">
        <input id="searchInput" class="search-input" type="text" placeholder="搜索绑定…" value="${esc(state.searchQuery)}" />
        <button class="tactile-btn icon-only cta" id="btnNewBinding" title="新建">+</button>
      </div>
      <div class="task-list">${itemsHtml}</div>
    </aside>
  `;
}

// ---------------- Detail Stream: Flowing Lavender Glow Progress Card + 12px Trace Pill ----------------

function groupMessagesIntoBlocks(messages) {
  const blocks = [];
  let traceBuf = [];

  const flushTrace = () => {
    if (!traceBuf.length) return;
    blocks.push({ kind: 'trace_group', steps: traceBuf });
    traceBuf = [];
  };

  for (const m of messages) {
    if (m.type === 'reasoning' || m.type === 'commandExecution' || m.type === 'fileChange') {
      traceBuf.push(m);
    } else {
      flushTrace();
      blocks.push({ kind: m.type === 'userMessage' ? 'user' : 'outcome', msg: m });
    }
  }
  flushTrace();
  return blocks;
}

function renderAmbientProgressCard(detail, task) {
  const msgs = detail?.messages || [];
  const canSend = Boolean(state.capabilities?.message);
  const thoughts = msgs.filter((m) => m.type === 'reasoning');
  const tools = msgs.filter((m) => m.type === 'commandExecution');
  const files = msgs.filter((m) => m.type === 'fileChange');
  const agentMsgs = msgs.filter((m) => m.type === 'agentMessage' || m.type === 'plan');
  const userMsgs = msgs.filter((m) => m.type === 'userMessage');

  const latestAgentText = agentMsgs.length ? agentMsgs[agentMsgs.length - 1].text : '';
  const latestUserText = userMsgs.length ? stripExecutionContract(userMsgs[userMsgs.length - 1].text) : '';

  let effectiveSummary = latestAgentText;
  if (!effectiveSummary && task?.latestReply) {
    const cleanReply = oneLineClean(task.latestReply);
    const cleanUser = oneLineClean(latestUserText);
    if (!cleanUser || !cleanUser.startsWith(cleanReply.slice(0, 40))) {
      effectiveSummary = task.latestReply;
    }
  }

  const recentThoughts = [];
  for (let i = thoughts.length - 1; i >= 0 && recentThoughts.length < 3; i--) {
    const t = oneLineClean(thoughts[i].text);
    if (t && !recentThoughts.includes(t)) recentThoughts.push(t);
  }
  const latestTool = tools.length ? cleanCommandPreview(tools[tools.length - 1].text) : '';

  const statParts = [
    thoughts.length ? `${thoughts.length} 次思考` : '',
    tools.length ? `${tools.length} 次工具` : '',
    files.length ? `${files.length} 文件` : '',
  ].filter(Boolean);

  const isRunning = task?.status?.code === 'running' || task?.status?.code === 'goal_active';

  const summaryTextForSend =
    effectiveSummary ||
    [
      latestUserText ? `目标：${oneLineClean(latestUserText).slice(0, 150)}` : '',
      recentThoughts.length ? `最新思考：${recentThoughts.join(' → ')}` : '',
      latestTool ? `最新工具：${latestTool.slice(0, 140)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

  let innerHtml = '';
  if (effectiveSummary) {
    innerHtml = `<div class="msg-body">${renderMd(effectiveSummary)}</div>`;
  } else if (recentThoughts.length || latestTool) {
    innerHtml = `
      <div class="msg-body">
        ${recentThoughts.length ? `<p><strong>当前进展：</strong>${esc(recentThoughts.join(' → '))}</p>` : ''}
        ${latestTool ? `<p><code>${esc(latestTool.slice(0, 140))}</code></p>` : ''}
      </div>
    `;
  } else {
    return '';
  }

  return `
    <section class="taper-card progress-taper-card">
      <div class="progress-card-head">
        <div class="progress-card-title">
          <span class="tactile-btn" style="height:24px;padding:0 9px 0 7px">
            <span class="argon-spark">✦</span>
            <span class="argon-box">${esc(task?.engineLabel || 'Codex')}</span>
            <span style="font-weight:650;color:var(--fg-primary)">${esc(task?.model || 'flagship')}</span>
            <span class="argon-tier">${esc((task?.reasoningEffort || 'high').toUpperCase())}</span>
          </span>
          <span>${effectiveSummary ? '有效概要与结论' : '实时进度概要'}</span>
        </div>
        <div class="telemetry-strip">
          ${thoughts.length ? `<span><strong>${thoughts.length}</strong> 思考</span>` : ''}
          ${thoughts.length && tools.length ? `<span>·</span>` : ''}
          ${tools.length ? `<span><strong>${tools.length}</strong> 工具</span>` : ''}
          ${
            canSend && summaryTextForSend
              ? `<button class="tactile-btn" style="height:23px;padding:0 9px" data-send-back="${esc(`【${task?.engineLabel || 'Codex'}｜${task?.title} (${task?.shortId})】\n${summaryTextForSend}`)}">发回对话</button>`
              : ''
          }
        </div>
      </div>
      ${innerHtml}
    </section>
  `;
}

function renderTraceGroup(steps, taskDurationSec) {
  const thoughts = steps.filter((s) => s.type === 'reasoning');
  const tools = steps.filter((s) => s.type === 'commandExecution');
  const files = steps.filter((s) => s.type === 'fileChange');

  const countParts = [];
  if (taskDurationSec > 0) countParts.push(`耗时 ${fmtDuration(taskDurationSec)}`);
  if (thoughts.length) countParts.push(`${thoughts.length} 次思考`);
  if (tools.length) countParts.push(`${tools.length} 次工具`);
  if (files.length) countParts.push(`${files.length} 文件`);

  const latestThought = thoughts.length ? oneLineClean(thoughts[thoughts.length - 1].text) : '';
  const latestTool = tools.length ? cleanCommandPreview(tools[tools.length - 1].text) : '';
  const latestLabel = latestThought || latestTool;

  const stepsHtml = steps
    .map((s) => {
      const k = s.type === 'reasoning' ? '思考' : s.type === 'commandExecution' ? '工具' : '文件';
      const rawLine = s.text.split('\n')[0];
      const line = (s.type === 'commandExecution' ? cleanCommandPreview(rawLine) : oneLineClean(rawLine)).slice(0, 220);
      return `
        <details class="trace-step">
          <summary>
            <span class="trace-step-kind">${k}</span>
            <span class="trace-step-line">${esc(line)}</span>
            <span class="trace-step-time">${esc(clockTime(s.createdAtMs))}</span>
          </summary>
          <div class="trace-step-body">${esc(s.text)}</div>
        </details>`;
    })
    .join('');

  return `
    <details class="trace-group">
      <summary>
        <div class="trace-group-summary-left">
          <span class="trace-chevron">▸</span>
          <span class="trace-group-counts">${esc(countParts.join(' · ') || `${steps.length} 步骤`)}</span>
          ${latestLabel ? `<span class="trace-group-latest">· ${esc(latestLabel)}</span>` : ''}
        </div>
      </summary>
      <div class="trace-group-list">${stepsHtml}</div>
    </details>
  `;
}

function renderHistory(detail, task) {
  const msgs = detail?.messages || [];
  if (!msgs.length) return `<div class="detail-empty">无记录</div>`;
  const canSend = Boolean(state.capabilities?.message);
  const assistantRoleName = getEngineShortName(task?.engine, task?.engineLabel);

  const blocks = groupMessagesIntoBlocks(msgs);

  const metaItems = [
    task.projectName,
    task.model,
    task.branch,
    fmtTokens(task.tokensUsed),
    fmtDuration(task.durationSec),
  ].filter(Boolean);

  const metaStripHtml = `
    <div class="doc-meta-strip">
      <span class="meta-id" id="btnCopyThreadId" title="点击复制完整会话 ID">${esc(task.shortId)}</span>
      ${metaItems.map((p) => `<span class="meta-sep">·</span><span>${esc(p)}</span>`).join('')}
      ${state.selectedGit?.hasBlackboard ? `<span class="meta-sep">·</span><button class="tactile-btn" style="height:20px;padding:0 8px" data-open-file="${esc(state.selectedGit.blackboardPath)}">BLACKBOARD</button>` : ''}
    </div>
  `;

  const ambientCardHtml = renderAmbientProgressCard(detail, task);

  const blocksHtml = blocks
    .map((b) => {
      if (b.kind === 'user') {
        const cleanPrompt = stripExecutionContract(b.msg.text);
        return `
          <section class="taper-card turn-user">
            <div class="turn-head">
              <span class="tactile-btn" style="height:22px;padding:0 8px">
                <span class="argon-spark">✦</span>
                <span class="argon-box">主控</span>
                <span class="argon-tier">指令</span>
              </span>
              <span>${esc(clockTime(b.msg.createdAtMs))}</span>
            </div>
            <div class="turn-user-body">${renderMd(cleanPrompt || b.msg.text)}</div>
          </section>`;
      }
      if (b.kind === 'trace_group') {
        return renderTraceGroup(b.steps, task.durationSec);
      }
      const m = b.msg;
      const role = m.type === 'plan' ? '计划' : assistantRoleName;
      return `
        <section class="turn-outcome">
          <div class="turn-head">
            <span class="turn-role">${esc(role)}</span>
            <div style="display:flex;align-items:center;gap:6px">
              <span>${esc(clockTime(m.createdAtMs))}</span>
              ${canSend ? `<button class="tactile-btn" style="height:22px;padding:0 8px" data-send-back="${esc(`【${task.engineLabel || 'Codex'}｜${task.title} (${task.shortId})】\n${m.text}`)}">发回对话</button>` : ''}
            </div>
          </div>
          <div class="msg-body">${renderMd(m.text)}</div>
        </section>`;
      })
    .join('');

  return `${metaStripHtml}<div class="feed-inner">${ambientCardHtml}${blocksHtml}</div>`;
}

function renderOps(detail, task) {
  const ops = detail?.ops || [];
  const canSend = Boolean(state.capabilities?.message);
  if (!ops.length) {
    return `<div class="detail-empty"><button class="tactile-btn" id="btnEmptyDiagnose">发起只读诊断</button></div>`;
  }
  const names = {
    diagnose_blocker: '卡点诊断',
    readonly_ask: '只读提问',
    queue_send: '排队唤醒',
    exec_resume: '同步续跑',
    dispatch_resume: 'Worktree 续跑',
    spawn_worker: '新建子代理',
  };
  return `<div class="feed-inner">${ops
    .map((op) => {
      const chatText = `【${task.engineLabel || 'Codex'}｜${task.title} (${task.shortId}) · ${names[op.opType] || op.opType}】\n${op.outputText || op.errorText || op.status}`;
      return `
        <section class="op-block">
          <div class="turn-head">
            <span class="turn-role">${esc(names[op.opType] || op.opType)} · ${esc(op.status)}</span>
            <div style="display:flex;align-items:center;gap:6px">
              <span>${esc(clockTime(op.startedAt))}</span>
              ${canSend && op.status !== 'running' ? `<button class="tactile-btn" style="height:22px;padding:0 8px" data-send-back="${esc(chatText)}">发回对话</button>` : ''}
            </div>
          </div>
          <div class="op-prompt">${esc(op.prompt)}</div>
          ${op.outputText ? `<div class="msg-body">${renderMd(op.outputText)}</div>` : ''}
          ${op.errorText ? `<div class="op-err">${esc(op.errorText)}</div>` : ''}
        </section>`;
    })
    .join('')}</div>`;
}

function renderGit(git) {
  if (!git) return `<div class="detail-empty">…</div>`;
  if (!git.isGit) return `<div class="detail-empty">${esc(git.error || '非 Git 目录')}</div>`;
  if (!git.files?.length) return `<div class="detail-empty">工作区干净</div>`;
  return `<div>${git.files
    .map(
      (f) => `
      <div class="git-row">
        <span><span class="git-xy">${esc(f.xy)}</span>${esc(f.file)}</span>
        <button class="tactile-btn" style="height:22px;padding:0 8px" data-open-file="${esc(f.absPath)}">打开</button>
      </div>`
    )
    .join('')}</div>`;
}

function renderTaskDetailPane() {
  const task = selectedTask();
  if (!task) return `<main class="detail-pane"><div class="detail-empty">选择一个任务</div></main>`;
  const detail = state.selectedDetail;
  const git = state.selectedGit;
  const isCodex = task.engine === 'codex';
  const engineName = getEngineShortName(task.engine, task.engineLabel);

  return `
    <main class="detail-pane">
      <div class="detail-toolbar">
        <div class="detail-toolbar-left">
          <button class="tactile-btn icon-only back-btn" id="btnBackToList" title="返回列表">←</button>
          <span class="status-dot ${dotClass(task.status.code)}"></span>
          <span class="argon-box">${esc(engineName)}</span>
          <span class="detail-title" id="btnRenameTask" title="点击重命名">${esc(task.title)}</span>
        </div>
        <div class="detail-toolbar-right">
          <div class="sub-seg">
            <button class="tactile-btn" data-active="${state.detailSubTab === 'history'}" data-subtab="history">动态</button>
            <button class="tactile-btn" data-active="${state.detailSubTab === 'ops'}" data-subtab="ops">诊断${detail?.ops?.length ? ` ${detail.ops.length}` : ''}</button>
            <button class="tactile-btn" data-active="${state.detailSubTab === 'git'}" data-subtab="git">变更${git?.files?.length ? ` ${git.files.length}` : ''}</button>
          </div>
          <button class="tactile-btn" id="btnDiagnoseBlocker" title="只读卡点诊断">诊断</button>
          <button class="tactile-btn" id="btnOpenReadonlyModal" title="自定义只读提问">只读</button>
          <button class="tactile-btn icon-only" id="btnDetailPin" data-active="${Boolean(task.pinned)}" title="${task.pinned ? '取消置顶' : '置顶'}">${task.pinned ? '★' : '☆'}</button>
        </div>
      </div>

      <div class="detail-scroll">
        ${state.detailSubTab === 'history' ? renderHistory(detail, task) : ''}
        ${state.detailSubTab === 'ops' ? renderOps(detail, task) : ''}
        ${state.detailSubTab === 'git' ? renderGit(git) : ''}
      </div>

      <div class="composer-zone">
        <div class="taper-card composer-card">
          <textarea id="composerInput" placeholder="发送给 ${esc(engineName)}…">${esc(state.composerText)}</textarea>
          <div class="composer-foot">
            <div class="composer-left">
              <button class="tactile-btn icon-only" id="btnComposerSpawn" title="新建受管子代理">+</button>
              <span class="tactile-btn">
                <span class="argon-spark">✦</span>
                <span class="argon-box">${esc(engineName)}</span>
                <span style="font-weight:650;color:var(--fg-primary)">${esc(task.model || 'auto')}</span>
                <span class="argon-tier">${esc((task.reasoningEffort || 'high').toUpperCase())}</span>
              </span>
            </div>
            <div class="composer-right">
              <div class="telemetry-strip">
                ${task.tokensUsed ? `<span><strong>${esc(fmtTokens(task.tokensUsed))}</strong></span><span>·</span>` : ''}
                ${task.durationSec ? `<span>耗时 <strong>${esc(fmtDuration(task.durationSec))}</strong></span><span>·</span>` : ''}
                ${state.quota?.bottleneck ? `<span class="telemetry-quota">◯ ${Math.round(state.quota.bottleneck.remainingPercent)}%</span><span>·</span>` : ''}
              </div>
              <select class="mode-select" id="composerMode" aria-label="模式" title="${esc(MODE_TIPS[state.composerMode] || '')}">
                ${isCodex ? `<option value="queue" ${state.composerMode === 'queue' ? 'selected' : ''}>排队唤醒</option>` : ''}
                <option value="resume" ${state.composerMode === 'resume' || (!isCodex && state.composerMode === 'queue') ? 'selected' : ''}>同步续跑</option>
                ${task.dispatchTask ? `<option value="dispatch_resume" ${state.composerMode === 'dispatch_resume' ? 'selected' : ''}>Worktree 续跑</option>` : ''}
                <option value="readonly" ${state.composerMode === 'readonly' ? 'selected' : ''}>只读提问</option>
              </select>
              <label class="dup-toggle">
                <input id="chkAllowDup" type="checkbox" ${state.allowDuplicate ? 'checked' : ''} />
                重发
              </label>
              <button class="send-btn" id="btnSendCodex" title="发送 (Cmd+Enter)" ${state.sendingMessage ? 'disabled' : ''}>↑</button>
            </div>
          </div>
        </div>
      </div>
    </main>
  `;
}

function renderSubagentDetailPane() {
  const a = selectedAgent();
  if (!a) {
    return `<main class="detail-pane"><div class="detail-empty"><button class="tactile-btn cta" id="btnSpawnEmpty">+ 新建受管子代理</button></div></main>`;
  }
  const canSend = Boolean(state.capabilities?.message);
  const engineName = getEngineShortName(a.backend, a.engineLabel);
  const metaParts = [a.status, a.model, a.branch, a.effort, fmtTokens(a.tokensUsed)].filter(Boolean);
  const sendText = `【受管子代理｜${engineName} · ${a.taskId}】\n状态: ${a.status} · 模型: ${a.model || '-'} · 分支: ${a.branch}\nWorktree: ${a.worktreePath}\n${a.summary || ''}`;

  return `
    <main class="detail-pane">
      <div class="detail-toolbar">
        <div class="detail-toolbar-left">
          <button class="tactile-btn icon-only back-btn" id="btnBackToList" title="返回列表">←</button>
          <span class="status-dot ${dotClass(a.status)}"></span>
          <span class="argon-box">${esc(engineName)}</span>
          <span class="detail-title">${esc(a.title)}</span>
        </div>
        <div class="detail-toolbar-right">
          ${a.threadId ? `<button class="tactile-btn" data-jump-thread="${esc(a.threadId)}">打开会话</button>` : ''}
          ${canSend ? `<button class="tactile-btn" data-send-back="${esc(sendText)}">发回对话</button>` : ''}
        </div>
      </div>
      <div class="detail-scroll">
        <div class="doc-meta-strip">
          <span>${esc(a.taskId)}</span>
          ${metaParts.map((p) => `<span class="meta-sep">·</span><span>${esc(p)}</span>`).join('')}
        </div>
        <div class="feed-inner">
          <section class="running-progress-card ${a.status === 'running' ? '' : 'idle-card'}">
            <div class="progress-card-head">
              <span class="progress-card-title">执行摘要</span>
              <span class="pill-badge">${a.verificationPassed ? '自测通过' : esc(a.status)}</span>
            </div>
            <div class="msg-body">${renderMd(a.summary || '暂无摘要')}</div>
            <div style="font-family:var(--font-mono);font-size:var(--fs-xxs);color:var(--fg-muted);margin-top:6px">${esc(a.worktreePath)}</div>
          </section>

          ${a.changedFiles?.length ? `
            <section class="turn-outcome">
              <div class="turn-head" style="margin-bottom:4px"><span class="turn-role">变更文件 (${a.changedFiles.length})</span></div>
              ${a.changedFiles
                .map((f) => {
                  const abs = a.worktreePath ? `${a.worktreePath.replace(/\/$/, '')}/${f}` : '';
                  return `
                    <div class="git-row">
                      <span>${esc(f)}</span>
                      ${abs && a.worktreeExists ? `<button class="tactile-btn" style="height:22px;padding:0 8px" data-open-file="${esc(abs)}">打开</button>` : ''}
                    </div>`;
                })
                .join('')}
            </section>
          ` : ''}
        </div>
      </div>
    </main>
  `;
}

function renderCollabDetailPane() {
  const b = selectedBinding();
  if (!b) {
    return `<main class="detail-pane"><div class="detail-empty"><button class="tactile-btn cta" id="btnNewBindingEmpty">+ 新建跨会话绑定</button></div></main>`;
  }
  const canSend = Boolean(state.capabilities?.message);
  const sendText = `【跨会话协作｜${b.changeKey}】\n目标: ${b.goalTitle}\n负责方: ${b.ownerRole} · 状态: ${b.status}\n会话: ${b.threadId || '-'}\n备注: ${b.notes || '-'}`;

  return `
    <main class="detail-pane">
      <div class="detail-toolbar">
        <div class="detail-toolbar-left">
          <button class="tactile-btn icon-only back-btn" id="btnBackToList" title="返回列表">←</button>
          <span class="status-dot ${dotClass(b.status)}"></span>
          <span class="pill-badge">${esc(b.ownerRole)}</span>
          <span class="detail-title">${esc(b.changeKey)}</span>
        </div>
        <div class="detail-toolbar-right">
          ${b.threadId ? `<button class="tactile-btn" data-jump-thread="${esc(b.threadId)}">打开会话</button>` : ''}
          ${canSend ? `<button class="tactile-btn" data-send-back="${esc(sendText)}">发回对话</button>` : ''}
          <button class="tactile-btn" data-del-binding="${esc(b.id)}">删除</button>
        </div>
      </div>
      <div class="detail-scroll">
        <div class="doc-meta-strip">
          <span>${esc(b.status)}</span>
          ${b.branch ? `<span class="meta-sep">·</span><span>${esc(b.branch)}</span>` : ''}
          ${b.threadId ? `<span class="meta-sep">·</span><span>${esc(b.threadId.slice(0, 12))}</span>` : ''}
        </div>
        <div class="feed-inner">
          <section class="turn-outcome">
            <div class="msg-body">${renderMd(b.goalTitle)}</div>
            ${b.notes ? `<div class="op-prompt" style="margin-top:6px">${esc(b.notes)}</div>` : ''}
          </section>
          ${b.messages?.length ? b.messages
            .map(
              (m) => `
              <section class="op-block">
                <div class="turn-head">
                  <span class="turn-role">${esc(m.author)}</span>
                  <span>${esc(clockTime(m.createdAt))}</span>
                </div>
                <div class="msg-body">${renderMd(m.content)}</div>
              </section>`
            )
            .join('') : ''}
        </div>
      </div>
    </main>
  `;
}

function buildEffortOptionsHtml(selectedVal) {
  const cur = selectedVal || 'high';
  return EFFORT_OPTIONS.map(
    (opt) => `<option value="${esc(opt.value)}" ${cur === opt.value ? 'selected' : ''}>${esc(opt.label)}</option>`
  ).join('');
}

function buildEngineModelChoices(engineId, { includeAuto = true, autoLabel = 'auto（跟随默认）' } = {}) {
  const disc = getEngineDiscovery(engineId);
  const eng = getEngineById(engineId, getActiveConfig());
  const seen = new Set();
  const list = [];
  const pushItem = (id, label) => {
    const clean = String(id || '').trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    list.push({ id: clean, label: label || clean });
  };
  if (includeAuto) pushItem('auto', autoLabel);
  for (const m of disc.models || []) {
    const suffix = m.contextWindow ? ` (${Math.round(m.contextWindow / 1000)}k)` : '';
    pushItem(m.id, `${m.label || m.id}${suffix}`);
  }
  if (eng?.models?.primaryModel && eng.models.primaryModel !== 'auto') {
    pushItem(eng.models.primaryModel, formatModelDisplay(eng.models.primaryModel, engineId));
  }
  if (eng?.models?.fallbackModel) {
    pushItem(eng.models.fallbackModel, formatModelDisplay(eng.models.fallbackModel, engineId));
  }
  return list;
}

function renderModelComboInput({
  inputAttrs,
  selectAttrs,
  value,
  placeholder,
  engineId,
  includeAuto = true,
  autoLabel = 'auto（自动）',
  includeEmptyOption = false,
  emptyLabel = '留空（不回退）',
}) {
  const choices = buildEngineModelChoices(engineId, { includeAuto, autoLabel });
  return `
    <div class="model-combo-row">
      <input
        type="text"
        class="field-mono"
        ${inputAttrs}
        value="${esc(value || '')}"
        placeholder="${esc(placeholder || '')}"
      />
      <select class="model-combo-pick" ${selectAttrs} aria-label="快捷选择探测模型">
        <option value="__pick__">快捷选模…</option>
        ${includeEmptyOption ? `<option value="">${esc(emptyLabel)}</option>` : ''}
        ${choices.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('')}
      </select>
    </div>
  `;
}

function renderExpandedEngineEditor(eng) {
  const disc = getEngineDiscovery(eng.id);
  const providersCount = disc.providers?.length || 0;
  const modelsCount = disc.models?.length || 0;
  const probeSummary = disc.available
    ? `已就绪 · ${disc.detectedBin}${providersCount ? ` · ${providersCount} 渠道` : ''}${modelsCount ? ` · ${modelsCount} 模型` : ''}`
    : `未探测到可执行文件${modelsCount ? ` · 已加载 ${modelsCount} 候选模型` : ''}`;

  return `
    <div class="engine-editor-drawer">
      <div class="engine-editor-head">
        <div class="settings-title-row">
          <span class="argon-box">${esc(eng.id)}</span>
          <strong>${esc(eng.name)}</strong>
          <span class="status-pill ${disc.available ? 'ok' : 'off'}">${disc.available ? '已就绪' : '未安装'}</span>
          <span class="settings-hint">${esc(probeSummary)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <button type="button" class="tactile-btn" data-probe-engine="${esc(eng.id)}" style="height:24px;padding:0 9px">↻ 探测本机</button>
          ${!eng.builtin ? `<button type="button" class="tactile-btn inline-danger-btn" data-delete-engine="${esc(eng.id)}" style="height:24px;padding:0 9px">删除引擎</button>` : ''}
          <button type="button" class="tactile-btn" id="btnCloseEngineEditor" style="height:24px;padding:0 9px">收起</button>
        </div>
      </div>

      <div class="settings-grid-2">
        <div class="field">
          <label>主选模型（支持选择或手输 provider/model）</label>
          ${renderModelComboInput({
            inputAttrs: `id="engPrimaryModel_${esc(eng.id)}" data-eng-id="${esc(eng.id)}" data-eng-field="models.primaryModel"`,
            selectAttrs: `data-eng-model-pick="${esc(eng.id)}" data-eng-target="models.primaryModel"`,
            value: eng.models?.primaryModel || '',
            placeholder: eng.kind === 'codex' ? 'auto 或 gpt-6.2-astra' : '输入模型名或 provider/model',
            engineId: eng.id,
            includeAuto: true,
            autoLabel: 'auto（按引擎智能自动选模）',
          })}
        </div>
        <div class="field">
          <label>默认推理强度</label>
          <select data-eng-id="${esc(eng.id)}" data-eng-field="models.defaultEffort">
            ${buildEffortOptionsHtml(eng.models?.defaultEffort)}
          </select>
        </div>
      </div>

      <div class="settings-grid-2">
        <div class="field">
          <label>CLI 命令或脚本路径</label>
          <input
            class="field-mono"
            data-eng-id="${esc(eng.id)}"
            data-eng-field="binPath"
            value="${esc(eng.binPath || '')}"
            placeholder="${esc(disc.detectedBin || `${eng.id}（留空自动探测）`)}"
          />
        </div>
        <div class="field">
          <label>本机配置文件路径 <span class="opt-pill">可选</span></label>
          <input
            class="field-mono"
            data-eng-id="${esc(eng.id)}"
            data-eng-field="configFilePath"
            value="${esc(eng.configFilePath || '')}"
            placeholder="如 ~/.codex/models_cache.json 或 ~/.claude.json"
          />
        </div>
      </div>

      <div class="settings-grid-2">
        <div class="field">
          <label>同引擎 / 跨渠道热备模型 <span class="opt-pill">可选 · 留空不回退</span></label>
          ${renderModelComboInput({
            inputAttrs: `id="engFallbackModel_${esc(eng.id)}" data-eng-id="${esc(eng.id)}" data-eng-field="models.fallbackModel"`,
            selectAttrs: `data-eng-model-pick="${esc(eng.id)}" data-eng-target="models.fallbackModel"`,
            value: eng.models?.fallbackModel || '',
            placeholder: '留空则不启用内部回退',
            engineId: eng.id,
            includeAuto: false,
            includeEmptyOption: true,
            emptyLabel: '清空（不启用回退）',
          })}
        </div>
        <div class="field" style="display:flex;flex-direction:column;justify-content:flex-end;gap:6px">
          ${!eng.builtin ? `
            <label>显示名称</label>
            <input data-eng-id="${esc(eng.id)}" data-eng-field="name" value="${esc(eng.name || '')}" placeholder="引擎显示名" />
          ` : ''}
          <label class="dup-toggle" style="margin-bottom:4px">
            <input type="checkbox" data-eng-id="${esc(eng.id)}" data-eng-field="adapter.syncDesktopIndex" ${eng.adapter?.syncDesktopIndex ? 'checked' : ''} />
            <span>同步任务记录至对应桌面端索引</span>
            <span class="opt-pill">可选</span>
          </label>
        </div>
      </div>
    </div>
  `;
}

function renderAddCustomEngineForm() {
  const ne = state.settingsUi.newEngine;
  return `
    <div class="engine-editor-drawer">
      <div class="engine-editor-head">
        <div class="settings-title-row">
          <span class="argon-box">+ 自定义</span>
          <strong>新增自定义 CLI 引擎</strong>
          <span class="settings-hint">添加后与内置引擎平权，可指派为主力施工或代码审查引擎</span>
        </div>
        <button type="button" class="tactile-btn" id="btnCancelAddEngine" style="height:24px;padding:0 9px">取消</button>
      </div>
      <div class="settings-grid-3">
        <div class="field">
          <label>引擎 ID（小写字母/数字/-/_）</label>
          <input id="newEngId" class="field-mono" value="${esc(ne.id)}" placeholder="如 aider / opencode" />
        </div>
        <div class="field">
          <label>显示名称</label>
          <input id="newEngName" value="${esc(ne.name)}" placeholder="如 Aider CLI" />
        </div>
        <div class="field">
          <label>CLI 命令或绝对路径</label>
          <input id="newEngBin" class="field-mono" value="${esc(ne.binPath)}" placeholder="如 aider 或 /usr/local/bin/aider" />
        </div>
      </div>
      <div class="settings-grid-3">
        <div class="field">
          <label>配置文件路径 <span class="opt-pill">可选</span></label>
          <input id="newEngConfig" class="field-mono" value="${esc(ne.configFilePath)}" placeholder="用于自动探测模型，可留空" />
        </div>
        <div class="field">
          <label>主选模型 <span class="opt-pill">可选</span></label>
          <input id="newEngModel" class="field-mono" value="${esc(ne.primaryModel)}" placeholder="如 claude-sonnet-4-6" />
        </div>
        <div class="field">
          <label>默认推理强度</label>
          <select id="newEngEffort">${buildEffortOptionsHtml(ne.defaultEffort)}</select>
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button type="button" class="tactile-btn" id="btnCancelAddEngineFoot">取消</button>
        <button type="button" class="tactile-btn cta" id="btnConfirmAddEngine">✦ 添加并启用</button>
      </div>
    </div>
  `;
}

function renderSettingsWorkspace() {
  const es = state.engineSettings || {};
  const cfg = ensureDraftConsistency(getActiveConfig());
  const engines = cfg.engines || [];
  const enabledEngines = engines.filter((e) => e.enabled);
  const roles = cfg.workflowRoles || {};
  const builder = roles.primaryBuilder || { engineId: enabledEngines[0]?.id || 'codex', model: 'auto', effort: 'xhigh' };
  const reviewer = roles.reviewer || { mode: 'auto_heterogeneous', engineId: '', model: 'auto', effort: 'max' };
  const scenarios = roles.scenarios || {};
  const policy = cfg.policy || { costStrategy: 'effect_first', defaultIsolation: 'worktree', hideDisabledEngineTasks: false };

  const expandedEngine = state.settingsUi.expandedEngineId
    ? engines.find((e) => e.id === state.settingsUi.expandedEngineId) || null
    : null;
  const autoRevPreview = resolveAutoReviewerPreview(cfg);
  const enabledScenarioCount = SCENARIO_DEFS.filter((s) => scenarios[s.key]?.enabled).length;

  return `
    <div class="settings-scroll">
      <div class="settings-container">
        <!-- Top Action Bar -->
        <div class="settings-topbar">
          <div>
            <div class="settings-title-row">
              <span class="tactile-btn" style="height:24px;padding:0 10px">
                <span class="argon-spark">✦</span>
                <span class="argon-box">引擎中心</span>
                <span class="argon-tier">WORKFLOW ROUTER</span>
              </span>
              <span class="settings-main-title">平权引擎池与研发流程分配</span>
            </div>
            <div class="settings-subtitle">
              任选本机已接入 CLI 引擎组合（至少启用 1 个），再按研发流程指定主力施工与代码审查角色。
            </div>
          </div>
          <div class="settings-hero-actions">
            <button type="button" class="tactile-btn" id="btnSettingsProbe" title="重新扫描本机 CLI 与模型配置">↻ 重新探测</button>
            <button type="button" class="tactile-btn" id="btnSettingsReset" title="恢复为推荐默认配置">恢复默认</button>
            <button type="button" class="tactile-btn cta" id="btnSettingsSave">
              ${state.settingsDirty ? '<span class="dirty-dot"></span>' : ''}
              <span>${state.savingSettings ? '保存中…' : '✦ 保存并同步'}</span>
            </button>
          </div>
        </div>

        <!-- LAYER 1 (P0 · Core · Directly Expanded V1 Tapered Card ①): Equal-Rights Engine Pool -->
        <section class="taper-card settings-card">
          <div class="settings-card-head">
            <div class="settings-title-row">
              <span class="priority-pill">① 核心 · 引擎池</span>
              <span class="settings-card-title">已接入 CLI 引擎开关栏</span>
              <span class="settings-hint">已启用 ${enabledEngines.length} / ${engines.length} · 点击任意卡片展开通用配置</span>
            </div>
          </div>

          <div class="engine-pool-grid">
            ${engines
              .map((eng) => {
                const disc = getEngineDiscovery(eng.id);
                const isExpanded = expandedEngine?.id === eng.id;
                const isBuilder = builder.engineId === eng.id;
                const isExplicitReviewer = reviewer.mode === 'explicit' && reviewer.engineId === eng.id;
                const modelText = formatModelDisplay(eng.models?.primaryModel || 'auto', eng.id);
                return `
                  <div
                    class="engine-tile ${eng.enabled ? 'is-enabled' : 'is-disabled'} ${isExpanded ? 'is-expanded' : ''}"
                    data-expand-engine="${esc(eng.id)}"
                  >
                    <div class="engine-tile-top">
                      <div class="engine-tile-name" title="${esc(eng.name)}">
                        <span class="status-dot ${eng.enabled ? (disc.available ? 'done' : 'blocked') : ''}"></span>
                        <span>${esc(eng.name)}</span>
                      </div>
                      <button
                        type="button"
                        class="mini-switch"
                        role="switch"
                        aria-checked="${eng.enabled ? 'true' : 'false'}"
                        aria-label="切换启用 ${esc(eng.name)}"
                        data-toggle-engine="${esc(eng.id)}"
                        title="${eng.enabled ? '点击停用' : '点击启用'}"
                        ${state.savingSettings ? 'disabled' : ''}
                      ></button>
                    </div>
                    <div class="engine-tile-mid">
                      <span class="status-pill ${disc.available ? 'ok' : 'off'}">${disc.available ? '已就绪' : '未安装'}</span>
                      ${isBuilder && eng.enabled ? '<span class="role-badge">主力施工</span>' : ''}
                      ${isExplicitReviewer && eng.enabled ? '<span class="role-badge review">指定审查</span>' : ''}
                    </div>
                    <div class="engine-tile-model" title="${esc(eng.models?.primaryModel || 'auto')}">
                      ${esc(modelText)} · ${esc((eng.models?.defaultEffort || 'high').toUpperCase())}
                    </div>
                    <div class="engine-tile-foot">
                      <span>${disc.models?.length ? `${disc.models.length} 模型` : '可手输模型'}</span>
                      <span>${isExpanded ? '收起配置 ▴' : '展开配置 ▾'}</span>
                    </div>
                  </div>
                `;
              })
              .join('')}

            <button type="button" class="engine-tile engine-tile-add" id="btnShowAddEngine">
              <span style="font-size:16px;line-height:1">＋</span>
              <span>新增自定义 CLI 引擎</span>
            </button>
          </div>

          ${state.settingsUi.showAddEngineForm ? renderAddCustomEngineForm() : ''}
          ${expandedEngine && !state.settingsUi.showAddEngineForm ? renderExpandedEngineEditor(expandedEngine) : ''}
        </section>

        <!-- LAYER 1 (P0 · Core · Directly Expanded V1 Tapered Card ②): Workflow-First Role Routing -->
        <section class="taper-card settings-card">
          <div class="settings-card-head">
            <div class="settings-title-row">
              <span class="priority-pill">② 核心 · 流程角色</span>
              <span class="settings-card-title">研发流程角色分配</span>
              <span class="settings-hint">按工作流指定主力施工与代码审查由谁负责</span>
            </div>
          </div>

          <div class="role-cards-grid">
            <!-- Role A: Primary Builder -->
            <div class="role-panel">
              <div class="role-panel-head">
                <span class="role-panel-title">主力施工引擎 (Primary Builder)</span>
                <span class="priority-pill">必选主流程</span>
              </div>
              <div class="role-panel-desc">
                决定新建任务与 <code>dispatch.py run</code> 未指定引擎时默认由谁主攻。
              </div>
              <div class="field" style="margin-bottom:2px">
                <label>指定主力引擎</label>
                <select id="cfgRoleBuilderEngine">
                  ${enabledEngines
                    .map(
                      (e) =>
                        `<option value="${esc(e.id)}" ${builder.engineId === e.id ? 'selected' : ''}>${esc(e.name)}${getEngineDiscovery(e.id).available ? '' : '（未检测到 CLI）'}</option>`
                    )
                    .join('')}
                </select>
              </div>
              <div class="settings-grid-2">
                <div class="field">
                  <label>主力模型</label>
                  ${renderModelComboInput({
                    inputAttrs: 'id="cfgRoleBuilderModel"',
                    selectAttrs: 'id="cfgRoleBuilderModelPick"',
                    value: builder.model || 'auto',
                    placeholder: 'auto（跟随引擎主选）',
                    engineId: builder.engineId,
                    includeAuto: true,
                    autoLabel: 'auto（跟随引擎主选）',
                  })}
                </div>
                <div class="field">
                  <label>主力推理挡位</label>
                  <select id="cfgRoleBuilderEffort">${buildEffortOptionsHtml(builder.effort)}</select>
                </div>
              </div>
            </div>

            <!-- Role B: Reviewer & Auditor -->
            <div class="role-panel">
              <div class="role-panel-head">
                <span class="role-panel-title">代码审查与审计引擎 (Reviewer)</span>
                <span class="priority-pill">必选主流程</span>
              </div>
              <div class="role-panel-desc">
                决定 <code>dispatch.py review --backend auto</code> 由谁执行独立只读交叉审计。
              </div>
              <div class="pill-seg-group">
                <button
                  type="button"
                  class="tactile-btn"
                  data-reviewer-mode="auto_heterogeneous"
                  data-active="${reviewer.mode !== 'explicit'}"
                >✦ 自动异构互审（推荐）</button>
                <button
                  type="button"
                  class="tactile-btn"
                  data-reviewer-mode="explicit"
                  data-active="${reviewer.mode === 'explicit'}"
                >指定审查引擎</button>
              </div>

              ${reviewer.mode !== 'explicit' ? `
                <div class="route-preview-banner">
                  <strong>${esc(autoRevPreview.text)}</strong>
                  <span class="route-preview-sub">${esc(autoRevPreview.sub)}</span>
                </div>
              ` : `
                <div class="field" style="margin-bottom:2px">
                  <label>指定审查引擎</label>
                  <select id="cfgRoleReviewerEngine">
                    ${enabledEngines
                      .map(
                        (e) =>
                          `<option value="${esc(e.id)}" ${reviewer.engineId === e.id ? 'selected' : ''}>${esc(e.name)}${e.id === builder.engineId ? '（与主力同引擎 · 只读自审）' : '（异构互审）'}</option>`
                      )
                      .join('')}
                  </select>
                </div>
                <div class="settings-grid-2">
                  <div class="field">
                    <label>审查模型</label>
                    ${renderModelComboInput({
                      inputAttrs: 'id="cfgRoleReviewerModel"',
                      selectAttrs: 'id="cfgRoleReviewerModelPick"',
                      value: reviewer.model || 'auto',
                      placeholder: 'auto（跟随引擎主选）',
                      engineId: reviewer.engineId || builder.engineId,
                      includeAuto: true,
                      autoLabel: 'auto（跟随引擎主选）',
                    })}
                  </div>
                  <div class="field">
                    <label>审查推理挡位</label>
                    <select id="cfgRoleReviewerEffort">${buildEffortOptionsHtml(reviewer.effort)}</select>
                  </div>
                </div>
              `}
            </div>
          </div>

          <!-- Global Effect Strategy & Isolation Strip -->
          <div class="policy-strip">
            <div class="policy-group">
              <span class="policy-label">全局效果策略</span>
              <button type="button" class="tactile-btn" data-cost-strategy="effect_first" data-active="${policy.costStrategy !== 'balanced'}">不计成本满血推理</button>
              <button type="button" class="tactile-btn" data-cost-strategy="balanced" data-active="${policy.costStrategy === 'balanced'}">按难度自适应</button>
            </div>
            <div class="policy-group">
              <span class="policy-label">默认隔离</span>
              <button type="button" class="tactile-btn" data-default-iso="worktree" data-active="${policy.defaultIsolation !== 'inplace'}">独立 Worktree</button>
              <button type="button" class="tactile-btn" data-default-iso="inplace" data-active="${policy.defaultIsolation === 'inplace'}">当前目录</button>
            </div>
            <label class="dup-toggle">
              <input type="checkbox" id="cfgHideDisabledTasks" ${policy.hideDisabledEngineTasks ? 'checked' : ''} />
              停用引擎时隐藏历史会话
            </label>
          </div>
        </section>

        <!-- LAYER 2 (P1 · Optional Collapsible): Scenario Overrides -->
        <section class="optional-section">
          <button type="button" class="optional-section-head" id="btnToggleScenarios">
            <div class="optional-section-left">
              <span>${state.settingsUi.showScenarios ? '▾' : '▸'} 专项任务场景分流</span>
              <span class="opt-pill">可选 · 4 项</span>
              ${enabledScenarioCount > 0 ? `<span class="role-badge">已自定义 ${enabledScenarioCount} 项</span>` : ''}
            </div>
            <span class="settings-hint">不配置时全部默认跟随主力施工引擎</span>
          </button>

          ${state.settingsUi.showScenarios ? `
            <div class="optional-section-body">
              <div class="scenario-list">
                ${SCENARIO_DEFS.map((def) => {
                  const sc = scenarios[def.key] || { enabled: false, engineId: '', model: '', fallbackModel: '', effort: 'max' };
                  const targetEngId = sc.engineId && enabledEngines.some((e) => e.id === sc.engineId)
                    ? sc.engineId
                    : enabledEngines[0]?.id || builder.engineId;
                  const targetEng = enabledEngines.find((e) => e.id === targetEngId);
                  return `
                    <div class="scenario-card ${sc.enabled ? 'active' : ''}">
                      <div class="scenario-card-head">
                        <div class="scenario-head-left">
                          <button
                            type="button"
                            class="mini-switch"
                            role="switch"
                            aria-checked="${sc.enabled ? 'true' : 'false'}"
                            aria-label="启用 ${esc(def.title)}"
                            data-toggle-scenario="${esc(def.key)}"
                          ></button>
                          <div>
                            <div class="scenario-title">${esc(def.title)}</div>
                            <div class="scenario-desc">${esc(def.hint)}</div>
                          </div>
                        </div>
                        <span class="opt-pill">
                          ${sc.enabled && targetEng ? `可选 · 已分流至 ${esc(targetEng.name)}` : '可选 · 默认跟随主力施工引擎'}
                        </span>
                      </div>
                      ${sc.enabled ? `
                        <div class="settings-grid-4">
                          <div class="field">
                            <label>指定引擎</label>
                            <select data-sc-key="${esc(def.key)}" data-sc-field="engineId">
                              ${enabledEngines
                                .map((e) => `<option value="${esc(e.id)}" ${targetEngId === e.id ? 'selected' : ''}>${esc(e.name)}</option>`)
                                .join('')}
                            </select>
                          </div>
                          <div class="field">
                            <label>指定模型</label>
                            ${renderModelComboInput({
                              inputAttrs: `data-sc-key="${esc(def.key)}" data-sc-field="model"`,
                              selectAttrs: `data-sc-model-pick="${esc(def.key)}" data-sc-target="model"`,
                              value: sc.model || '',
                              placeholder: '留空跟随引擎主选',
                              engineId: targetEngId,
                              includeAuto: true,
                              autoLabel: 'auto（跟随引擎主选）',
                            })}
                          </div>
                          <div class="field">
                            <label>热备模型 <span class="opt-pill">可选</span></label>
                            ${renderModelComboInput({
                              inputAttrs: `data-sc-key="${esc(def.key)}" data-sc-field="fallbackModel"`,
                              selectAttrs: `data-sc-model-pick="${esc(def.key)}" data-sc-target="fallbackModel"`,
                              value: sc.fallbackModel || '',
                              placeholder: '留空不回退',
                              engineId: targetEngId,
                              includeAuto: false,
                              includeEmptyOption: true,
                              emptyLabel: '清空（不回退）',
                            })}
                          </div>
                          <div class="field">
                            <label>推理挡位</label>
                            <select data-sc-key="${esc(def.key)}" data-sc-field="effort">
                              ${buildEffortOptionsHtml(sc.effort)}
                            </select>
                          </div>
                        </div>
                      ` : ''}
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          ` : ''}
        </section>

        <!-- LAYER 2 (P2 · Optional Collapsible): CLI Paths, Command Templates & Cross-Provider Backups -->
        <section class="optional-section">
          <button type="button" class="optional-section-head" id="btnToggleAdapterDetails">
            <div class="optional-section-left">
              <span>${state.settingsUi.showAdapterDetails ? '▾' : '▸'} 引擎 CLI 路径、命令模板与跨渠道热备详情</span>
              <span class="opt-pill">可选 · 已有默认预置</span>
            </div>
            <span class="settings-hint">无需手填即可使用，仅需自定义命令参数时展开</span>
          </button>

          ${state.settingsUi.showAdapterDetails ? `
            <div class="optional-section-body">
              ${engines
                .map((eng) => {
                  const disc = getEngineDiscovery(eng.id);
                  return `
                    <div class="adapter-detail-card">
                      <div class="scenario-card-head">
                        <div class="settings-title-row">
                          <span class="argon-box">${esc(eng.id)}</span>
                          <strong>${esc(eng.name)}</strong>
                          <span class="status-pill ${disc.available ? 'ok' : 'off'}">${disc.available ? '已就绪' : '未安装'}</span>
                          ${disc.providers?.length ? `<span class="settings-hint">渠道：${disc.providers.map((p) => `${esc(p.providerName)}(${p.models.length})`).join(' / ')}</span>` : ''}
                        </div>
                        <span class="opt-pill">${eng.enabled ? '已启用' : '已停用'}</span>
                      </div>
                      <div class="settings-grid-3">
                        <div class="field">
                          <label>CLI 路径</label>
                          <input class="field-mono" data-eng-id="${esc(eng.id)}" data-eng-field="binPath" value="${esc(eng.binPath || '')}" placeholder="${esc(disc.detectedBin || eng.id)}" />
                        </div>
                        <div class="field">
                          <label>配置文件路径 <span class="opt-pill">可选</span></label>
                          <input class="field-mono" data-eng-id="${esc(eng.id)}" data-eng-field="configFilePath" value="${esc(eng.configFilePath || '')}" />
                        </div>
                        <div class="field">
                          <label>热备模型 <span class="opt-pill">可选</span></label>
                          <input class="field-mono" data-eng-id="${esc(eng.id)}" data-eng-field="models.fallbackModel" value="${esc(eng.models?.fallbackModel || '')}" placeholder="留空不回退" />
                        </div>
                      </div>
                      <div class="settings-grid-3">
                        <div class="field">
                          <label>写模式命令模板 <span class="opt-pill">预置</span></label>
                          <input class="field-mono" data-eng-id="${esc(eng.id)}" data-eng-field="adapter.execTemplate" value="${esc(eng.adapter?.execTemplate || '')}" />
                        </div>
                        <div class="field">
                          <label>只读审查模板 <span class="opt-pill">预置</span></label>
                          <input class="field-mono" data-eng-id="${esc(eng.id)}" data-eng-field="adapter.readonlyTemplate" value="${esc(eng.adapter?.readonlyTemplate || '')}" />
                        </div>
                        <div class="field">
                          <label>会话续跑模板 <span class="opt-pill">预置</span></label>
                          <input class="field-mono" data-eng-id="${esc(eng.id)}" data-eng-field="adapter.resumeTemplate" value="${esc(eng.adapter?.resumeTemplate || '')}" />
                        </div>
                      </div>
                    </div>
                  `;
                })
                .join('')}
              <div class="settings-footnote">
                配置文件路径：<code>${esc(es.configPath || '~/.local/state/multi-agent-dispatch/engine_config.json')}</code>
              </div>
            </div>
          ` : ''}
        </section>
      </div>
    </div>
  `;
}

function renderModal() {
  if (!state.modal) return '';
  const task = selectedTask();

  if (state.modal === 'spawn') {
    const cfg = ensureDraftConsistency(cloneConfig(state.engineSettings?.config) || getActiveConfig());
    const enabledEngines = (cfg.engines || []).filter((e) => e.enabled);
    const builderId = cfg.workflowRoles?.primaryBuilder?.engineId || enabledEngines[0]?.id || 'codex';
    const d = state.spawnDraft;
    const effectiveBackend = enabledEngines.some((e) => e.id === d.backend) ? d.backend : builderId;
    const selectedEng = enabledEngines.find((e) => e.id === effectiveBackend) || enabledEngines[0];
    const cwd = d.cwd || task?.dispatchTask?.repoRoot || task?.cwd || '';

    const modelChoices = buildEngineModelChoices(effectiveBackend, {
      includeAuto: true,
      autoLabel: `✦ 自动跟随引擎与角色配置（${formatModelDisplay(selectedEng?.models?.primaryModel || 'auto', effectiveBackend)}）`,
    });
    const qualityLabels = { max: '满血效果', smart: '智能路由', balanced: '均衡' };
    const isoLabels = { worktree: '独立 Worktree', inplace: '当前目录' };
    const diffLabels = { auto: '难度自动', low: '轻量', medium: '常规', hard: '高难', extreme: '极限' };
    const optionalSummary = [
      qualityLabels[d.quality] || d.quality,
      isoLabels[d.isolation] || d.isolation,
      diffLabels[d.difficulty] || d.difficulty,
      d.taskId?.trim() ? `ID:${d.taskId.trim()}` : '',
      d.changeKey?.trim() ? `Change:${d.changeKey.trim()}` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    return `
      <div class="modal-backdrop" data-close-modal="1">
        <div class="taper-card modal modal-spawn">
          <div class="modal-head">
            <div class="modal-title-group">
              <span class="tactile-btn" style="height:24px;padding:0 9px">
                <span class="argon-spark">✦</span>
                <span class="argon-box">派单中心</span>
                <span class="argon-tier">WORKTREE</span>
              </span>
              <span class="modal-title-text">新建受管子代理</span>
            </div>
            <button class="tactile-btn icon-only" data-close-modal="1" title="关闭">✕</button>
          </div>

          <!-- High Priority P0 Fields -->
          <div class="field">
            <div class="field-label-row">
              <label>任务指令（Prompt）</label>
              <span class="priority-pill">核心必填</span>
            </div>
            <textarea id="mSpawnPrompt" rows="4" placeholder="说明目标、接口约定、验收标准及需要一并核实的内容…">${esc(d.prompt)}</textarea>
          </div>

          <div class="field">
            <div class="field-label-row">
              <label>选择执行引擎（已启用 ${enabledEngines.length} 个）</label>
              <button type="button" class="link-micro-btn" id="btnJumpSettingsFromSpawn">⚙ 引擎与流程设置</button>
            </div>
            <div class="engine-cards-row">
              ${enabledEngines
                .map((eng) => {
                  const disc = getEngineDiscovery(eng.id);
                  const isSel = effectiveBackend === eng.id;
                  const isBuilder = builderId === eng.id;
                  return `
                    <button
                      type="button"
                      class="engine-pick-card ${isSel ? 'selected' : ''}"
                      data-pick-backend="${esc(eng.id)}"
                    >
                      <div class="engine-pick-top">
                        <span class="argon-spark">✦</span>
                        <span class="argon-box">${esc(eng.builtin ? getEngineShortName(eng.id, eng.name) : eng.id)}</span>
                        <strong>${esc(eng.name)}</strong>
                        ${isBuilder ? '<span class="role-badge">主力</span>' : ''}
                      </div>
                      <div class="engine-pick-desc" title="${esc(eng.models?.primaryModel || 'auto')}">
                        ${esc(formatModelDisplay(eng.models?.primaryModel || 'auto', eng.id))} · ${esc((eng.models?.defaultEffort || 'high').toUpperCase())}${disc.available ? '' : ' · 未安装'}
                      </div>
                    </button>
                  `;
                })
                .join('')}
            </div>
          </div>

          <div class="settings-grid-2">
            <div class="field">
              <label>模型选择</label>
              <select id="mSpawnModel">
                ${modelChoices
                  .map(
                    (c) => `<option value="${esc(c.id)}" ${d.model === c.id ? 'selected' : ''}>${esc(c.label)}</option>`
                  )
                  .join('')}
              </select>
            </div>
            <div class="field">
              <label>目标仓库 / 工作目录</label>
              <input id="mSpawnCwd" class="field-mono" value="${esc(cwd)}" placeholder="/path/to/repo" />
            </div>
          </div>

          <!-- Low Priority Optional Fields (Collapsed with Defaults Preserved) -->
          <div class="spawn-optional-box">
            <button type="button" class="spawn-optional-head" id="btnToggleSpawnOpt">
              <span style="display:inline-flex;align-items:center;gap:6px">
                <span>${d.showOptional ? '▾' : '▸'} 执行策略、沙箱与绑定覆盖</span>
                <span class="opt-pill">可选 · 已选默认</span>
              </span>
              <span class="spawn-optional-summary">${esc(optionalSummary)}</span>
            </button>

            ${d.showOptional ? `
              <div class="spawn-optional-body">
                <div class="spawn-pills-grid">
                  <div class="field" style="margin-bottom:0">
                    <label>推理与质量策略 <span class="opt-pill">可选</span></label>
                    <div class="pill-seg-group">
                      <button type="button" class="tactile-btn" data-spawn-quality="max" data-active="${d.quality === 'max'}">满血 (Max)</button>
                      <button type="button" class="tactile-btn" data-spawn-quality="smart" data-active="${d.quality === 'smart'}">智能 (Smart)</button>
                      <button type="button" class="tactile-btn" data-spawn-quality="balanced" data-active="${d.quality === 'balanced'}">均衡</button>
                    </div>
                  </div>
                  <div class="field" style="margin-bottom:0">
                    <label>沙箱隔离 <span class="opt-pill">可选</span></label>
                    <div class="pill-seg-group">
                      <button type="button" class="tactile-btn" data-spawn-iso="worktree" data-active="${d.isolation === 'worktree'}">独立 Worktree</button>
                      <button type="button" class="tactile-btn" data-spawn-iso="inplace" data-active="${d.isolation === 'inplace'}">当前目录</button>
                    </div>
                  </div>
                </div>

                <div class="field" style="margin-bottom:0">
                  <label>任务难度覆盖 <span class="opt-pill">可选</span></label>
                  <div class="pill-seg-group">
                    <button type="button" class="tactile-btn" data-spawn-diff="auto" data-active="${d.difficulty === 'auto'}">✦ 自动</button>
                    <button type="button" class="tactile-btn" data-spawn-diff="low" data-active="${d.difficulty === 'low'}">轻量</button>
                    <button type="button" class="tactile-btn" data-spawn-diff="medium" data-active="${d.difficulty === 'medium'}">常规</button>
                    <button type="button" class="tactile-btn" data-spawn-diff="hard" data-active="${d.difficulty === 'hard'}">高难</button>
                    <button type="button" class="tactile-btn" data-spawn-diff="extreme" data-active="${d.difficulty === 'extreme'}">极限</button>
                  </div>
                </div>

                <div class="field-grid-2">
                  <div class="field" style="margin-bottom:0">
                    <label>自定义 Task ID <span class="opt-pill">可选</span></label>
                    <input id="mSpawnTaskId" class="field-mono" value="${esc(d.taskId)}" placeholder="留空自动生成" />
                  </div>
                  <div class="field" style="margin-bottom:0">
                    <label>跨会话 Change 标识 <span class="opt-pill">可选</span></label>
                    <input id="mSpawnChange" class="field-mono" value="${esc(d.changeKey)}" placeholder="如 feat-auth-flow" />
                  </div>
                </div>
              </div>
            ` : ''}
          </div>

          <div class="modal-foot">
            <button class="tactile-btn" data-close-modal="1">取消</button>
            <button class="tactile-btn cta" id="btnSubmitSpawn">
              <span>✦ 启动 ${esc(selectedEng?.name || effectiveBackend)} 子代理</span>
            </button>
          </div>
        </div>
      </div>`;
  }

  if (state.modal === 'readonly') {
    return `
      <div class="modal-backdrop" data-close-modal="1">
        <div class="taper-card modal">
          <div class="modal-head">
            <div class="modal-title-group">
              <span class="tactile-btn" style="height:24px;padding:0 9px">
                <span class="argon-spark">✦</span>
                <span class="argon-box">${esc(getEngineShortName(task?.engine, task?.engineLabel))}</span>
                <span class="argon-tier">READ-ONLY</span>
              </span>
              <span class="modal-title-text">非侵入式只读提问</span>
            </div>
            <button class="tactile-btn icon-only" data-close-modal="1">✕</button>
          </div>
          <div class="field">
            <label>提问内容（在只读沙箱中检视当前会话上下文，不修改任何工作区文件）</label>
            <textarea id="mReadonlyPrompt" rows="4" placeholder="请输入要向当前会话询问的问题…"></textarea>
          </div>
          <div class="modal-foot">
            <button class="tactile-btn" data-close-modal="1">取消</button>
            <button class="tactile-btn cta" id="btnSubmitReadonly">✦ 发起只读提问</button>
          </div>
        </div>
      </div>`;
  }

  if (state.modal === 'binding') {
    const engines = getEngineList();
    return `
      <div class="modal-backdrop" data-close-modal="1">
        <div class="taper-card modal">
          <div class="modal-head">
            <div class="modal-title-group">
              <span class="tactile-btn" style="height:24px;padding:0 9px">
                <span class="argon-spark">✦</span>
                <span class="argon-box">协作绑定</span>
                <span class="argon-tier">CHANGE</span>
              </span>
              <span class="modal-title-text">新建跨会话绑定</span>
            </div>
            <button class="tactile-btn icon-only" data-close-modal="1">✕</button>
          </div>
          <div class="field"><label>Change / 功能标识</label><input id="mBindKey" placeholder="例如 feat-multi-engine-router" /></div>
          <div class="field"><label>目标简述</label><input id="mBindGoal" placeholder="清晰描述该任务的目标与交付边界" /></div>
          <div class="field-grid-2">
            <div class="field">
              <label>当前责任方</label>
              <select id="mBindOwner">
                ${engines.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('')}
                <option value="antigravity">Antigravity (主控)</option>
                <option value="shared">Shared (多引擎协同)</option>
              </select>
            </div>
            <div class="field">
              <label>当前状态</label>
              <select id="mBindStatus">
                <option value="active">进行中 (active)</option>
                <option value="reviewing">审查中 (reviewing)</option>
                <option value="blocked">阻塞待决策 (blocked)</option>
                <option value="completed">已完成 (completed)</option>
              </select>
            </div>
          </div>
          <div class="field"><label>关联会话 ID</label><input id="mBindThread" value="${esc(task?.id || '')}" /></div>
          <div class="field"><label>交接备注</label><textarea id="mBindNotes" rows="2" placeholder="可选：记录接口约定或审查意见"></textarea></div>
          <div class="modal-foot">
            <button class="tactile-btn" data-close-modal="1">取消</button>
            <button class="tactile-btn cta" id="btnSubmitBinding">✦ 保存绑定</button>
          </div>
        </div>
      </div>`;
  }

  if (state.modal === 'rename') {
    return `
      <div class="modal-backdrop" data-close-modal="1">
        <div class="taper-card modal">
          <div class="modal-head">
            <div class="modal-title-group">
              <span class="tactile-btn" style="height:24px;padding:0 9px">
                <span class="argon-spark">✦</span>
                <span class="argon-box">会话别名</span>
              </span>
              <span class="modal-title-text">重命名任务</span>
            </div>
            <button class="tactile-btn icon-only" data-close-modal="1">✕</button>
          </div>
          <div class="field"><label>自定义显示名称（留空则恢复原始标题）</label><input id="mRenameInput" value="${esc(task?.customTitle || task?.title || '')}" /></div>
          <div class="modal-foot">
            <button class="tactile-btn" data-close-modal="1">取消</button>
            <button class="tactile-btn cta" id="btnSubmitRename">✦ 保存名称</button>
          </div>
        </div>
      </div>`;
  }
  return '';
}

// ---------------- Main Render & Event Binding ----------------

function render() {
  const root = document.getElementById('root');
  if (!root) return;

  const activeEl = document.activeElement;
  const activeId = activeEl?.id || null;
  const selStart = typeof activeEl?.selectionStart === 'number' ? activeEl.selectionStart : null;
  const selEnd = typeof activeEl?.selectionEnd === 'number' ? activeEl.selectionEnd : null;

  const scrollTask = root.querySelector('.task-list')?.scrollTop ?? 0;
  const scrollDetail = root.querySelector('.detail-scroll')?.scrollTop ?? 0;
  const scrollHidden = root.querySelector('.hidden-drawer-body')?.scrollTop ?? 0;
  const scrollSettings = root.querySelector('.settings-scroll')?.scrollTop ?? 0;

  const s = state.stats;
  const cat = getCatState();
  const visibleAgyCount = state.tasks.filter((t) => !t.isSubagent && !t.hidden && t.isAgyDispatched).length;

  let workspaceHtml = '';
  if (state.activeTab === 'tasks') {
    workspaceHtml = `${renderTasksLeftRail()}${renderTaskDetailPane()}`;
  } else if (state.activeTab === 'subagents') {
    workspaceHtml = `${renderSubagentsLeftRail()}${renderSubagentDetailPane()}`;
  } else if (state.activeTab === 'collab') {
    workspaceHtml = `${renderCollabLeftRail()}${renderCollabDetailPane()}`;
  } else if (state.activeTab === 'settings') {
    workspaceHtml = renderSettingsWorkspace();
  }

  const drillClass = state.narrowView === 'detail' ? 'drill-detail' : 'drill-list';

  root.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="topbar-left">
          <span class="brand-mark">Antig Lead Codex</span>
          <nav class="nav-seg">
            <button class="tactile-btn" data-active="${state.activeTab === 'tasks'}" data-tab="tasks">
              任务${visibleAgyCount ? `<span class="nav-num">${visibleAgyCount}</span>` : ''}
            </button>
            <button class="tactile-btn" data-active="${state.activeTab === 'subagents'}" data-tab="subagents">
              子代理${s.managedCount ? `<span class="nav-num">${s.managedCount}</span>` : ''}
            </button>
            <button class="tactile-btn" data-active="${state.activeTab === 'collab'}" data-tab="collab">
              协作${s.collabCount ? `<span class="nav-num">${s.collabCount}</span>` : ''}
            </button>
            <button class="tactile-btn" data-active="${state.activeTab === 'settings'}" data-tab="settings">
              设置
            </button>
          </nav>
        </div>
        <div class="topbar-right">
          ${renderPixelCat({
            mode: cat.mode,
            label: cat.label,
            meowing: state.catMeowing,
            freezeLeft: state.catFreezeLeft,
            freezeFlip: state.catFreezeFlip,
          })}
          ${renderQuotaWidget()}
          <button class="tactile-btn icon-only" id="btnOpenSettings" data-active="${state.activeTab === 'settings'}" title="引擎与路由设置">⚙</button>
          <button class="tactile-btn icon-only" id="btnRefresh" title="刷新">${state.loadingSnapshot ? '·' : '↻'}</button>
          <button class="tactile-btn icon-only cta" id="btnOpenSpawn" title="新建受管子代理">+</button>
        </div>
      </header>

      <div class="workspace ${drillClass}">${workspaceHtml}</div>

      ${renderModal()}
      ${state.toast ? `<div class="toast ${esc(state.toast.kind)}">${esc(state.toast.text)}</div>` : ''}
    </div>
  `;

  bindEvents();

  const nl = root.querySelector('.task-list');
  if (nl) nl.scrollTop = scrollTask;
  const nd = root.querySelector('.detail-scroll');
  if (nd) nd.scrollTop = scrollDetail;
  const nh = root.querySelector('.hidden-drawer-body');
  if (nh) nh.scrollTop = scrollHidden;
  const ns = root.querySelector('.settings-scroll');
  if (ns) ns.scrollTop = scrollSettings;

  if (activeId) {
    const el = document.getElementById(activeId);
    if (el && typeof el.focus === 'function') {
      el.focus();
      if (selStart !== null && typeof el.setSelectionRange === 'function') {
        try {
          el.setSelectionRange(selStart, selEnd ?? selStart);
        } catch {}
      }
    }
  }
}

function bindEvents() {
  document.getElementById('btnRefresh')?.addEventListener('click', () => {
    refreshSnapshot();
    refreshQuotaLive({ silent: true });
  });
  document.getElementById('btnQuotaRing')?.addEventListener('click', () => refreshQuotaLive());
  document.getElementById('btnQuotaRefresh')?.addEventListener('click', (e) => {
    e.stopPropagation();
    refreshQuotaLive();
  });

  document.getElementById('btnBackToList')?.addEventListener('click', () => {
    state.narrowView = 'list';
    render();
  });

  document.getElementById('btnCatPet')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const walker = btn?.querySelector('.cat-walker');
    const svg = btn?.querySelector('.cat-svg');
    if (walker) {
      const curLeft = parseFloat(window.getComputedStyle(walker).left);
      if (!Number.isNaN(curLeft)) state.catFreezeLeft = curLeft;
    }
    if (svg) {
      const tf = window.getComputedStyle(svg).transform;
      if (tf && tf.startsWith('matrix(')) {
        const a = parseFloat(tf.slice(7).split(',')[0]);
        if (!Number.isNaN(a)) state.catFreezeFlip = a < 0 ? -1 : 1;
      }
    }

    state.catMeowing = true;
    state.lastCatWakeMs = Date.now();
    if (state.catMeowTimer) clearTimeout(state.catMeowTimer);
    state.catMeowTimer = setTimeout(() => {
      state.catMeowing = false;
      state.catFreezeLeft = null;
      render();
    }, 2200);

    const active = state.tasks.find(
      (t) => !t.isSubagent && !t.hidden && (t.status.code === 'running' || t.status.code === 'blocked')
    );
    if (active && (state.activeTab !== 'tasks' || state.selectedThreadId !== active.id)) {
      state.activeTab = 'tasks';
      loadThreadDetail(active.id, { silent: true, drill: true });
    } else {
      render();
    }
  });

  const openSpawn = () => {
    const t = selectedTask();
    const cfg = ensureDraftConsistency(cloneConfig(state.engineSettings?.config) || getActiveConfig());
    const builderId = cfg.workflowRoles?.primaryBuilder?.engineId || getEnabledEngines(cfg)[0]?.id || 'codex';
    state.spawnDraft.cwd = state.spawnDraft.cwd || t?.dispatchTask?.repoRoot || t?.cwd || '';
    state.spawnDraft.backend = builderId;
    state.spawnDraft.model = 'auto';
    state.spawnDraft.isolation = cfg.policy?.defaultIsolation || 'worktree';
    state.spawnDraft.quality = cfg.policy?.costStrategy === 'balanced' ? 'smart' : 'max';
    state.modal = 'spawn';
    render();
  };
  document.getElementById('btnOpenSpawn')?.addEventListener('click', openSpawn);
  document.getElementById('btnComposerSpawn')?.addEventListener('click', openSpawn);
  document.getElementById('btnSpawnFromTab')?.addEventListener('click', openSpawn);
  document.getElementById('btnSpawnEmpty')?.addEventListener('click', openSpawn);
  document.getElementById('btnOpenSettings')?.addEventListener('click', () => {
    state.activeTab = 'settings';
    render();
  });

  const openBinding = () => {
    state.modal = 'binding';
    render();
  };
  document.getElementById('btnNewBinding')?.addEventListener('click', openBinding);
  document.getElementById('btnNewBindingEmpty')?.addEventListener('click', openBinding);

  document.querySelectorAll('[data-tab]').forEach((el) =>
    el.addEventListener('click', () => {
      state.activeTab = el.dataset.tab;
      state.narrowView = 'list';
      render();
    })
  );
  document.querySelectorAll('[data-engine-filter]').forEach((el) =>
    el.addEventListener('click', () => {
      state.engineFilter = el.dataset.engineFilter;
      render();
    })
  );
  document.querySelectorAll('[data-subtab]').forEach((el) =>
    el.addEventListener('click', () => {
      state.detailSubTab = el.dataset.subtab;
      render();
    })
  );

  document.getElementById('searchInput')?.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    render();
  });
  document.getElementById('btnToggleDesktop')?.addEventListener('click', () => {
    state.showDesktopTasks = !state.showDesktopTasks;
    render();
  });
  document.getElementById('btnToggleHidden')?.addEventListener('click', () => {
    state.showHiddenDrawer = !state.showHiddenDrawer;
    render();
  });

  document.querySelectorAll('[data-select-thread]').forEach((el) =>
    el.addEventListener('click', () => loadThreadDetail(el.dataset.selectThread, { drill: true }))
  );
  document.querySelectorAll('[data-select-agent]').forEach((el) =>
    el.addEventListener('click', () => {
      state.selectedAgentId = el.dataset.selectAgent;
      state.narrowView = 'detail';
      render();
    })
  );
  document.querySelectorAll('[data-select-binding]').forEach((el) =>
    el.addEventListener('click', () => {
      state.selectedBindingId = el.dataset.selectBinding;
      state.narrowView = 'detail';
      render();
    })
  );

  document.querySelectorAll('[data-pin-thread]').forEach((el) =>
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const pinned = el.dataset.pinned === '1';
      updateThreadPref(el.dataset.pinThread, { pinned: !pinned }, !pinned ? '已置顶' : '已取消置顶');
    })
  );
  document.querySelectorAll('[data-hide-thread]').forEach((el) =>
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = el.dataset.hidden === '1';
      updateThreadPref(
        el.dataset.hideThread,
        { hidden: !isHidden },
        isHidden ? '已还原' : '已隐藏'
      );
    })
  );

  const task = selectedTask();
  document.getElementById('btnDetailPin')?.addEventListener('click', () => {
    if (task) updateThreadPref(task.id, { pinned: !task.pinned }, !task.pinned ? '已置顶' : '已取消置顶');
  });
  document.getElementById('btnCopyThreadId')?.addEventListener('click', () => task && copyText(task.id));
  document.getElementById('btnRenameTask')?.addEventListener('click', () => {
    state.modal = 'rename';
    render();
  });
  document.getElementById('btnOpenReadonlyModal')?.addEventListener('click', () => {
    state.modal = 'readonly';
    render();
  });
  const doDiag = () => task && triggerReadonly(task.id, '', 'diagnose_blocker');
  document.getElementById('btnDiagnoseBlocker')?.addEventListener('click', doDiag);
  document.getElementById('btnEmptyDiagnose')?.addEventListener('click', doDiag);

  const inp = document.getElementById('composerInput');
  inp?.addEventListener('input', (e) => {
    state.composerText = e.target.value;
  });
  inp?.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      sendComposer();
    }
  });
  document.getElementById('composerMode')?.addEventListener('change', (e) => {
    state.composerMode = e.target.value;
    render();
  });
  document.getElementById('chkAllowDup')?.addEventListener('change', (e) => {
    state.allowDuplicate = e.target.checked;
  });
  document.getElementById('btnSendCodex')?.addEventListener('click', sendComposer);

  document.querySelectorAll('[data-send-back]').forEach((el) =>
    el.addEventListener('click', () => sendBack(el.dataset.sendBack))
  );
  document.querySelectorAll('[data-open-file]').forEach((el) =>
    el.addEventListener('click', () => openFile(el.dataset.openFile))
  );
  document.querySelectorAll('[data-jump-thread]').forEach((el) =>
    el.addEventListener('click', () => {
      state.activeTab = 'tasks';
      loadThreadDetail(el.dataset.jumpThread, { drill: true });
    })
  );
  document.querySelectorAll('[data-del-binding]').forEach((el) =>
    el.addEventListener('click', async () => {
      try {
        await callTool('manage_collab_binding', { action: 'delete', id: el.dataset.delBinding });
        if (state.selectedBindingId === el.dataset.delBinding) state.selectedBindingId = null;
        state.narrowView = 'list';
        await refreshSnapshot({ silent: true });
        showToast('已删除');
      } catch (err) {
        showToast(err.message, 'error');
      }
    })
  );

  // Modals
  document.querySelectorAll('.modal').forEach((el) =>
    el.addEventListener('click', (e) => e.stopPropagation())
  );
  document.querySelectorAll('[data-close-modal]').forEach((el) =>
    el.addEventListener('click', (e) => {
      if (el.classList.contains('modal-backdrop') && e.target !== el) return;
      state.modal = null;
      render();
    })
  );

  // Spawn Modal Interactive Pill & Engine Card Controls
  const syncSpawnTextFields = () => {
    const cwdEl = document.getElementById('mSpawnCwd');
    const promptEl = document.getElementById('mSpawnPrompt');
    const modEl = document.getElementById('mSpawnModel');
    const tidEl = document.getElementById('mSpawnTaskId');
    const chgEl = document.getElementById('mSpawnChange');
    if (cwdEl) state.spawnDraft.cwd = cwdEl.value;
    if (promptEl) state.spawnDraft.prompt = promptEl.value;
    if (modEl) state.spawnDraft.model = modEl.value;
    if (tidEl) state.spawnDraft.taskId = tidEl.value;
    if (chgEl) state.spawnDraft.changeKey = chgEl.value;
  };

  document.getElementById('mSpawnCwd')?.addEventListener('input', (e) => {
    state.spawnDraft.cwd = e.target.value;
  });
  document.getElementById('mSpawnPrompt')?.addEventListener('input', (e) => {
    state.spawnDraft.prompt = e.target.value;
  });
  document.getElementById('mSpawnModel')?.addEventListener('change', (e) => {
    state.spawnDraft.model = e.target.value;
  });
  document.getElementById('mSpawnTaskId')?.addEventListener('input', (e) => {
    state.spawnDraft.taskId = e.target.value;
  });
  document.getElementById('mSpawnChange')?.addEventListener('input', (e) => {
    state.spawnDraft.changeKey = e.target.value;
  });

  document.querySelectorAll('[data-pick-backend]').forEach((el) =>
    el.addEventListener('click', () => {
      syncSpawnTextFields();
      state.spawnDraft.backend = el.dataset.pickBackend;
      state.spawnDraft.model = 'auto';
      render();
    })
  );

  document.querySelectorAll('[data-spawn-quality]').forEach((el) =>
    el.addEventListener('click', () => {
      syncSpawnTextFields();
      state.spawnDraft.quality = el.dataset.spawnQuality;
      render();
    })
  );

  document.querySelectorAll('[data-spawn-diff]').forEach((el) =>
    el.addEventListener('click', () => {
      syncSpawnTextFields();
      state.spawnDraft.difficulty = el.dataset.spawnDiff;
      render();
    })
  );

  document.querySelectorAll('[data-spawn-iso]').forEach((el) =>
    el.addEventListener('click', () => {
      syncSpawnTextFields();
      state.spawnDraft.isolation = el.dataset.spawnIso;
      render();
    })
  );

  document.getElementById('btnToggleSpawnOpt')?.addEventListener('click', () => {
    syncSpawnTextFields();
    state.spawnDraft.showOptional = !state.spawnDraft.showOptional;
    render();
  });

  document.getElementById('btnJumpSettingsFromSpawn')?.addEventListener('click', () => {
    syncSpawnTextFields();
    state.modal = null;
    state.activeTab = 'settings';
    render();
  });

  document.getElementById('btnSubmitSpawn')?.addEventListener('click', async () => {
    try {
      syncSpawnTextFields();
      const cfg = ensureDraftConsistency(cloneConfig(state.engineSettings?.config) || getActiveConfig());
      const enabledEngines = (cfg.engines || []).filter((e) => e.enabled);
      const fallbackId = cfg.workflowRoles?.primaryBuilder?.engineId || enabledEngines[0]?.id || 'codex';
      const backend = enabledEngines.some((e) => e.id === state.spawnDraft.backend)
        ? state.spawnDraft.backend
        : fallbackId;
      const eng = enabledEngines.find((e) => e.id === backend);
      const modelVal = state.spawnDraft.model?.trim();
      const promptVal = state.spawnDraft.prompt?.trim();
      const cwdVal = state.spawnDraft.cwd?.trim();
      if (!promptVal) return showToast('请填写任务指令', 'error');
      if (!cwdVal) return showToast('请填写目标工作目录', 'error');

      const res = await callTool('spawn_codex_worker', {
        cwd: cwdVal,
        prompt: promptVal,
        backend,
        model: modelVal && modelVal !== 'auto' ? modelVal : undefined,
        quality: state.spawnDraft.quality,
        difficulty: state.spawnDraft.difficulty,
        isolation: state.spawnDraft.isolation,
        taskId: state.spawnDraft.taskId?.trim() || undefined,
        changeKey: state.spawnDraft.changeKey?.trim() || undefined,
      });
      state.modal = null;
      state.spawnDraft.prompt = '';
      state.spawnDraft.taskId = '';
      state.activeTab = 'subagents';
      state.narrowView = 'list';
      showToast(`已启动 ${eng?.name || backend} 子代理`);
      await refreshSnapshot({ silent: true });
      if (res?.op?.id) pollOp(res.op.id, null);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // ---------------- Settings Workspace Events ----------------
  const setNestedField = (obj, pathStr, val) => {
    const parts = pathStr.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = val;
  };

  const persistSettingsDraft = async ({ toastText = '配置已保存并同步', extraPatch = {} } = {}) => {
    if (state.savingSettings) return false;
    const cfg = ensureDraftConsistency(getActiveConfig());
    state.savingSettings = true;
    render();
    try {
      const payload = {
        ...cloneConfig(cfg),
        replaceEngines: true,
        ...extraPatch,
      };
      const res = await callTool('console_engine_settings', { action: 'save', config: payload });
      if (res?.engineSettings) {
        state.engineSettings = res.engineSettings;
        state.settingsDraft = cloneConfig(res.engineSettings.config);
      }
      state.settingsDirty = false;
      const validIds = new Set(getEngineList().map((e) => e.id));
      if (state.engineFilter !== 'all' && !validIds.has(state.engineFilter)) {
        state.engineFilter = 'all';
      }
      await refreshSnapshot({ silent: true });
      if (toastText) showToast(toastText);
      return true;
    } catch (err) {
      showToast(err.message, 'error');
      return false;
    } finally {
      state.savingSettings = false;
      render();
    }
  };

  const markDirty = () => {
    state.settingsDirty = true;
  };

  // Expand / collapse universal engine card
  document.querySelectorAll('[data-expand-engine]').forEach((el) =>
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-toggle-engine]')) return;
      const id = el.dataset.expandEngine;
      state.settingsUi.showAddEngineForm = false;
      state.settingsUi.expandedEngineId = state.settingsUi.expandedEngineId === id ? null : id;
      render();
    })
  );

  document.getElementById('btnCloseEngineEditor')?.addEventListener('click', () => {
    state.settingsUi.expandedEngineId = null;
    render();
  });

  // Equal-rights engine enable/disable switch (requires at least 1 engine enabled)
  document.querySelectorAll('[data-toggle-engine]').forEach((el) =>
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (state.savingSettings) return;
      const id = el.dataset.toggleEngine;
      const cfg = getActiveConfig();
      const target = cfg.engines.find((item) => item.id === id);
      if (!target) return;
      const enabledCount = cfg.engines.filter((item) => item.enabled).length;
      if (target.enabled && enabledCount <= 1) {
        showToast('至少需要启用 1 个 CLI 引擎，无法全部关闭', 'error');
        return;
      }
      target.enabled = !target.enabled;
      ensureDraftConsistency(cfg);
      markDirty();
      await persistSettingsDraft({
        toastText: target.enabled ? `已启用 ${target.name}` : `已停用 ${target.name}`,
      });
    })
  );

  // Add Custom CLI Engine Form
  document.getElementById('btnShowAddEngine')?.addEventListener('click', () => {
    state.settingsUi.expandedEngineId = null;
    state.settingsUi.showAddEngineForm = !state.settingsUi.showAddEngineForm;
    render();
  });

  const cancelAddForm = () => {
    state.settingsUi.showAddEngineForm = false;
    render();
  };
  document.getElementById('btnCancelAddEngine')?.addEventListener('click', cancelAddForm);
  document.getElementById('btnCancelAddEngineFoot')?.addEventListener('click', cancelAddForm);

  document.getElementById('newEngId')?.addEventListener('input', (e) => { state.settingsUi.newEngine.id = e.target.value; });
  document.getElementById('newEngName')?.addEventListener('input', (e) => { state.settingsUi.newEngine.name = e.target.value; });
  document.getElementById('newEngBin')?.addEventListener('input', (e) => { state.settingsUi.newEngine.binPath = e.target.value; });
  document.getElementById('newEngConfig')?.addEventListener('input', (e) => { state.settingsUi.newEngine.configFilePath = e.target.value; });
  document.getElementById('newEngModel')?.addEventListener('input', (e) => { state.settingsUi.newEngine.primaryModel = e.target.value; });
  document.getElementById('newEngEffort')?.addEventListener('change', (e) => { state.settingsUi.newEngine.defaultEffort = e.target.value; });

  document.getElementById('btnConfirmAddEngine')?.addEventListener('click', async () => {
    if (state.savingSettings) return;
    const ne = state.settingsUi.newEngine;
    const cleanId = (ne.id || '').trim().toLowerCase();
    if (!cleanId || !ENGINE_ID_RE.test(cleanId) || cleanId === 'auto' || cleanId === 'all') {
      return showToast('引擎 ID 需为小写字母/数字/-/_，且不可为 auto/all', 'error');
    }
    const cfg = getActiveConfig();
    if (cfg.engines.some((e) => e.id === cleanId)) {
      return showToast(`引擎 ID「${cleanId}」已存在`, 'error');
    }
    const cleanName = (ne.name || '').trim() || cleanId;
    const cleanBin = (ne.binPath || '').trim() || cleanId;
    const execTpl = '{bin} -p {prompt} --model {model}';
    cfg.engines.push({
      id: cleanId,
      name: cleanName,
      builtin: false,
      kind: 'custom_cli',
      enabled: true,
      binPath: cleanBin,
      configFilePath: (ne.configFilePath || '').trim(),
      models: {
        primaryModel: (ne.primaryModel || '').trim() || 'auto',
        fallbackModel: '',
        defaultEffort: ne.defaultEffort || 'high',
      },
      adapter: {
        execTemplate: execTpl,
        readonlyTemplate: execTpl,
        resumeTemplate: '{bin} --resume {session_id} -p {prompt} --model {model}',
        syncDesktopIndex: false,
      },
    });
    state.settingsUi.showAddEngineForm = false;
    state.settingsUi.expandedEngineId = cleanId;
    state.settingsUi.newEngine = { id: '', name: '', binPath: '', configFilePath: '', primaryModel: '', fallbackModel: '', defaultEffort: 'high' };
    markDirty();
    await persistSettingsDraft({ toastText: `已新增并启用 ${cleanName}` });
  });

  // Delete Custom CLI Engine
  document.querySelectorAll('[data-delete-engine]').forEach((el) =>
    el.addEventListener('click', async () => {
      if (state.savingSettings) return;
      const id = el.dataset.deleteEngine;
      const cfg = getActiveConfig();
      const target = cfg.engines.find((e) => e.id === id);
      if (!target || target.builtin) return;
      const remainingEnabled = cfg.engines.filter((e) => e.id !== id && e.enabled);
      if (!remainingEnabled.length) {
        return showToast('至少需要保留 1 个已启用引擎，请先启用其他引擎后再删除', 'error');
      }
      cfg.engines = cfg.engines.filter((e) => e.id !== id);
      ensureDraftConsistency(cfg);
      if (state.settingsUi.expandedEngineId === id) state.settingsUi.expandedEngineId = null;
      markDirty();
      await persistSettingsDraft({ toastText: `已删除自定义引擎 ${target.name}` });
    })
  );

  // Per-engine generic field edits (both expanded card & P2 adapter details)
  document.querySelectorAll('[data-eng-id][data-eng-field]').forEach((el) => {
    const evt = el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(evt, (e) => {
      const id = el.dataset.engId;
      const field = el.dataset.engField;
      const cfg = getActiveConfig();
      const eng = cfg.engines.find((item) => item.id === id);
      if (!eng) return;
      const val = el.type === 'checkbox' ? e.target.checked : e.target.value;
      setNestedField(eng, field, typeof val === 'string' && field !== 'name' ? val.trim() : val);
      markDirty();
      if (evt === 'change') render();
    });
  });

  document.querySelectorAll('[data-eng-model-pick]').forEach((el) =>
    el.addEventListener('change', (e) => {
      const picked = e.target.value;
      if (picked === '__pick__') return;
      const id = el.dataset.engModelPick;
      const targetPath = el.dataset.engTarget;
      const cfg = getActiveConfig();
      const eng = cfg.engines.find((item) => item.id === id);
      if (!eng) return;
      setNestedField(eng, targetPath, picked);
      markDirty();
      render();
    })
  );

  // Probe single engine or full environment
  const runProbe = async (focusEngineId = null) => {
    try {
      const res = await callTool('console_engine_settings', { action: 'probe' });
      if (res?.engineSettings) {
        state.engineSettings = res.engineSettings;
        if (!state.settingsDirty) {
          state.settingsDraft = cloneConfig(res.engineSettings.config);
        }
      }
      render();
      if (focusEngineId) {
        const d = getEngineDiscovery(focusEngineId);
        showToast(
          d.available
            ? `${getEngineShortName(focusEngineId)} 已就绪（${d.models?.length || 0} 模型）`
            : `未在本机探测到 ${getEngineShortName(focusEngineId)} 可执行文件`
        );
      } else {
        const readyCount = Object.values(state.engineSettings?.discovery?.engines || {}).filter((x) => x.available).length;
        showToast(`探测完成：本机已就绪 ${readyCount} 个 CLI 引擎`);
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  };
  document.getElementById('btnSettingsProbe')?.addEventListener('click', () => runProbe());
  document.querySelectorAll('[data-probe-engine]').forEach((el) =>
    el.addEventListener('click', () => runProbe(el.dataset.probeEngine))
  );

  // Workflow Role A: Primary Builder
  document.getElementById('cfgRoleBuilderEngine')?.addEventListener('change', (e) => {
    const cfg = getActiveConfig();
    const engId = e.target.value;
    const eng = cfg.engines.find((item) => item.id === engId);
    cfg.workflowRoles.primaryBuilder.engineId = engId;
    cfg.workflowRoles.primaryBuilder.model = 'auto';
    if (eng?.models?.defaultEffort) {
      cfg.workflowRoles.primaryBuilder.effort = eng.models.defaultEffort;
    }
    markDirty();
    render();
  });
  document.getElementById('cfgRoleBuilderModel')?.addEventListener('input', (e) => {
    getActiveConfig().workflowRoles.primaryBuilder.model = e.target.value.trim() || 'auto';
    markDirty();
  });
  document.getElementById('cfgRoleBuilderModelPick')?.addEventListener('change', (e) => {
    if (e.target.value === '__pick__') return;
    getActiveConfig().workflowRoles.primaryBuilder.model = e.target.value || 'auto';
    markDirty();
    render();
  });
  document.getElementById('cfgRoleBuilderEffort')?.addEventListener('change', (e) => {
    getActiveConfig().workflowRoles.primaryBuilder.effort = e.target.value;
    markDirty();
    render();
  });

  // Workflow Role B: Reviewer & Auditor
  document.querySelectorAll('[data-reviewer-mode]').forEach((el) =>
    el.addEventListener('click', () => {
      const cfg = getActiveConfig();
      const mode = el.dataset.reviewerMode;
      cfg.workflowRoles.reviewer.mode = mode;
      if (mode === 'explicit') {
        const active = cfg.engines.filter((e) => e.enabled);
        const builderId = cfg.workflowRoles.primaryBuilder.engineId;
        const other = active.find((e) => e.id !== builderId) || active[0];
        if (!active.some((e) => e.id === cfg.workflowRoles.reviewer.engineId)) {
          cfg.workflowRoles.reviewer.engineId = other?.id || builderId;
        }
      } else {
        cfg.workflowRoles.reviewer.engineId = '';
      }
      markDirty();
      render();
    })
  );
  document.getElementById('cfgRoleReviewerEngine')?.addEventListener('change', (e) => {
    const cfg = getActiveConfig();
    cfg.workflowRoles.reviewer.engineId = e.target.value;
    cfg.workflowRoles.reviewer.model = 'auto';
    markDirty();
    render();
  });
  document.getElementById('cfgRoleReviewerModel')?.addEventListener('input', (e) => {
    getActiveConfig().workflowRoles.reviewer.model = e.target.value.trim() || 'auto';
    markDirty();
  });
  document.getElementById('cfgRoleReviewerModelPick')?.addEventListener('change', (e) => {
    if (e.target.value === '__pick__') return;
    getActiveConfig().workflowRoles.reviewer.model = e.target.value || 'auto';
    markDirty();
    render();
  });
  document.getElementById('cfgRoleReviewerEffort')?.addEventListener('change', (e) => {
    getActiveConfig().workflowRoles.reviewer.effort = e.target.value;
    markDirty();
    render();
  });

  // Global Policy Controls
  document.querySelectorAll('[data-cost-strategy]').forEach((el) =>
    el.addEventListener('click', () => {
      getActiveConfig().policy.costStrategy = el.dataset.costStrategy;
      markDirty();
      render();
    })
  );
  document.querySelectorAll('[data-default-iso]').forEach((el) =>
    el.addEventListener('click', () => {
      getActiveConfig().policy.defaultIsolation = el.dataset.defaultIso;
      markDirty();
      render();
    })
  );
  document.getElementById('cfgHideDisabledTasks')?.addEventListener('change', (e) => {
    getActiveConfig().policy.hideDisabledEngineTasks = e.target.checked;
    markDirty();
    render();
  });

  // Layer 2 Collapsible Optional Sections
  document.getElementById('btnToggleScenarios')?.addEventListener('click', () => {
    state.settingsUi.showScenarios = !state.settingsUi.showScenarios;
    render();
  });
  document.getElementById('btnToggleAdapterDetails')?.addEventListener('click', () => {
    state.settingsUi.showAdapterDetails = !state.settingsUi.showAdapterDetails;
    render();
  });

  // Optional Scenario Overrides
  document.querySelectorAll('[data-toggle-scenario]').forEach((el) =>
    el.addEventListener('click', () => {
      const key = el.dataset.toggleScenario;
      const cfg = getActiveConfig();
      const sc = cfg.workflowRoles.scenarios[key];
      if (!sc) return;
      sc.enabled = !sc.enabled;
      if (sc.enabled && !sc.engineId) {
        sc.engineId = cfg.workflowRoles.primaryBuilder.engineId || getEnabledEngines(cfg)[0]?.id || 'codex';
      }
      markDirty();
      render();
    })
  );
  document.querySelectorAll('[data-sc-key][data-sc-field]').forEach((el) => {
    const evt = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evt, (e) => {
      const key = el.dataset.scKey;
      const field = el.dataset.scField;
      const sc = getActiveConfig().workflowRoles.scenarios[key];
      if (!sc) return;
      sc[field] = e.target.value.trim();
      if (field === 'engineId') {
        sc.model = '';
        sc.fallbackModel = '';
      }
      markDirty();
      if (evt === 'change') render();
    });
  });
  document.querySelectorAll('[data-sc-model-pick]').forEach((el) =>
    el.addEventListener('change', (e) => {
      if (e.target.value === '__pick__') return;
      const key = el.dataset.scModelPick;
      const targetField = el.dataset.scTarget;
      const sc = getActiveConfig().workflowRoles.scenarios[key];
      if (!sc) return;
      sc[targetField] = e.target.value;
      markDirty();
      render();
    })
  );

  // Save & Reset Actions
  document.getElementById('btnSettingsSave')?.addEventListener('click', () => {
    persistSettingsDraft({ toastText: '引擎池与流程配置已保存并同步' });
  });

  document.getElementById('btnSettingsReset')?.addEventListener('click', async () => {
    try {
      const res = await callTool('console_engine_settings', { action: 'reset' });
      if (res?.engineSettings) {
        state.engineSettings = res.engineSettings;
        state.settingsDraft = cloneConfig(res.engineSettings.config);
      }
      state.settingsDirty = false;
      state.settingsUi.expandedEngineId = null;
      state.settingsUi.showAddEngineForm = false;
      await refreshSnapshot({ silent: true });
      showToast('已恢复默认推荐配置');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btnSubmitReadonly')?.addEventListener('click', async () => {
    const p = document.getElementById('mReadonlyPrompt')?.value?.trim();
    if (!p || !task) return;
    state.modal = null;
    render();
    await triggerReadonly(task.id, p, 'custom');
  });

  document.getElementById('btnSubmitBinding')?.addEventListener('click', async () => {
    const changeKey = document.getElementById('mBindKey')?.value?.trim();
    if (!changeKey) return showToast('需填标识', 'error');
    try {
      const res = await callTool('manage_collab_binding', {
        action: 'upsert',
        changeKey,
        goalTitle: document.getElementById('mBindGoal')?.value?.trim() || changeKey,
        ownerRole: document.getElementById('mBindOwner')?.value,
        status: document.getElementById('mBindStatus')?.value,
        threadId: document.getElementById('mBindThread')?.value?.trim() || undefined,
        notes: document.getElementById('mBindNotes')?.value?.trim() || '',
        repoPath: task?.cwd || undefined,
        branch: task?.branch || undefined,
      });
      if (res?.binding?.id) state.selectedBindingId = res.binding.id;
      state.modal = null;
      await refreshSnapshot({ silent: true });
      showToast('已保存');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btnSubmitRename')?.addEventListener('click', async () => {
    if (!task) return;
    await updateThreadPref(task.id, { customTitle: document.getElementById('mRenameInput')?.value ?? '' }, '已重命名');
    state.modal = null;
    render();
  });
}

// ---------------- Host Lifecycle ----------------

function scheduleAutoRefresh() {
  const active = selectedTask();
  const hot =
    state.stats.runningCount > 0 ||
    state.stats.runningOpsCount > 0 ||
    active?.status?.code === 'running';
  const ms = hot ? 4_000 : 12_000;
  if (state.autoRefreshTimer && state.lastPollMs === ms) return;
  if (state.autoRefreshTimer) clearInterval(state.autoRefreshTimer);
  state.lastPollMs = ms;
  state.autoRefreshTimer = setInterval(() => {
    if (!state.modal && !state.sendingMessage) refreshSnapshot({ silent: true });
  }, ms);
}

app.ontoolinput = () => {};

app.ontoolresult = (result) => {
  const sc = result?.structuredContent;
  if (sc) {
    if (sc.initialTab) state.activeTab = sc.initialTab;
    if (sc.initialThreadId) {
      state.selectedThreadId = sc.initialThreadId;
      state.narrowView = 'detail';
    } else {
      state.narrowView = 'list';
    }
    if (sc.initialQuery) state.searchQuery = sc.initialQuery;
    if (sc.stats) state.stats = sc.stats;
    if (sc.connected !== undefined) state.connected = sc.connected;
  }
  refreshSnapshot();
};

app.onhostcontextchanged = (ctx) => {
  if (ctx?.theme) {
    applyDocumentTheme(ctx.theme);
    document.documentElement.setAttribute('data-theme', ctx.theme);
  }
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

async function boot() {
  await app.connect();
  state.capabilities = app.getHostCapabilities() || {};
  const ctx = app.getHostContext();
  if (ctx?.theme) {
    applyDocumentTheme(ctx.theme);
    document.documentElement.setAttribute('data-theme', ctx.theme);
  }
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  render();
  await refreshSnapshot();
  scheduleAutoRefresh();
}

boot().catch((err) => {
  const root = document.getElementById('root');
  if (root) root.innerHTML = `<div class="boot-loading">${esc(err.message)}</div>`;
});
