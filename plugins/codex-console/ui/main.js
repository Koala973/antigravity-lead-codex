import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';
import { renderPixelCat } from './cat-pet.js';

const app = new App({ name: 'Antigravity Lead Codex', version: '1.5.0' }, {});
const SLEEP_IDLE_MS = 12 * 60 * 1000;

const MODE_TIPS = {
  queue: '排队唤醒 (codex queue --resume / ZCode 自动后台续跑)',
  resume: '同步续跑 (codex exec resume / zcode --resume)',
  dispatch_resume: '隔离 Worktree 续跑 (dispatch.py resume)',
  readonly: '只读查询 (fork --ephemeral read-only / zcode --mode plan)',
};

const ICON_HIDE = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="3" rx="1"/><path d="M3.5 6v6.5A1.5 1.5 0 0 0 5 14h6a1.5 1.5 0 0 0 1.5-1.5V6"/><path d="M6.5 9.5h3"/></svg>`;
const ICON_RESTORE = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8a5 5 0 1 1 1.5 3.6"/><path d="M3 4.5V8h3.5"/></svg>`;

const state = {
  connected: false,
  capabilities: {},
  stats: {
    loadedThreads: 0,
    visibleThreads: 0,
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
  savingSettings: false,

  activeTab: 'tasks',          // tasks | subagents | collab | settings
  narrowView: 'list',          // list | detail (used when container < 640px)
  engineFilter: 'all',         // all | codex | zcode
  detailSubTab: 'history',     // history | ops | git
  showDesktopTasks: false,
  showHiddenDrawer: false,

  spawnDraft: {
    backend: 'codex',
    model: 'auto',
    quality: 'max',
    difficulty: 'auto',
    isolation: 'worktree',
    cwd: '',
    prompt: '',
    taskId: '',
    changeKey: '',
    showAdvanced: false,
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
    if (data.engineSettings) state.engineSettings = data.engineSettings;

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
  state.sendingMessage = true;
  render();
  try {
    const res = await callTool('send_codex_message', {
      threadId: task.id,
      message: msg,
      mode: state.composerMode,
      allowDuplicate: state.allowDuplicate,
    });
    state.composerText = '';
    if (state.composerMode === 'readonly') state.detailSubTab = 'ops';
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
          <span>Codex 额度 · ZCode 无限</span>
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
  const isZcode = t.engine === 'zcode';
  const engineName = isZcode ? 'ZCode' : 'Codex';
  const metaParts = [t.projectName, t.branch].filter(Boolean).join(' · ');
  const modelLabel = t.model || (isZcode ? 'kimi-k3' : 'gpt-6.2');
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
          <span class="argon-box">${engineName}</span>
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
    state.engineFilter === 'zcode' ||
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

  return `
    <aside class="left-rail">
      <div class="rail-toolbar">
        <input id="searchInput" class="search-input" type="text" placeholder="搜索任务…" value="${esc(state.searchQuery)}" />
        <div class="filter-seg">
          <button class="tactile-btn" data-active="${state.engineFilter === 'all'}" data-engine-filter="all">全部</button>
          <button class="tactile-btn" data-active="${state.engineFilter === 'codex'}" data-engine-filter="codex">Codex</button>
          ${state.engineSettings?.config?.zcode?.enabled !== false ? `<button class="tactile-btn" data-active="${state.engineFilter === 'zcode'}" data-engine-filter="zcode">ZCode</button>` : ''}
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
          const isZcode = a.backend === 'zcode';
          const engineName = isZcode ? 'ZCode' : 'Codex';
          return `
            <div class="task-row ${sel ? 'selected' : ''}" data-select-agent="${esc(a.id)}">
              <div class="task-row-line1">
                <span class="status-dot ${dotClass(a.status)}"></span>
                <span class="task-row-title" title="${esc(a.title)}">${esc(a.title)}</span>
              </div>
              <div class="task-row-line2">
                <div style="display:flex;align-items:center;gap:5px;min-width:0;flex:1">
                  <span class="pill-badge ${isZcode ? 'zcode' : ''}">${engineName}</span>
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
  const assistantRoleName = task?.engine === 'zcode' ? 'ZCode' : 'Codex';

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
            <span class="turn-role">${role}</span>
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
  const isZcode = task.engine === 'zcode';
  const engineName = isZcode ? 'ZCode' : 'Codex';

  return `
    <main class="detail-pane">
      <div class="detail-toolbar">
        <div class="detail-toolbar-left">
          <button class="tactile-btn icon-only back-btn" id="btnBackToList" title="返回列表">←</button>
          <span class="status-dot ${dotClass(task.status.code)}"></span>
          <span class="pill-badge ${isZcode ? 'zcode' : ''}">${engineName}</span>
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
          <textarea id="composerInput" placeholder="发送给 ${engineName}…">${esc(state.composerText)}</textarea>
          <div class="composer-foot">
            <div class="composer-left">
              <button class="tactile-btn icon-only" id="btnComposerSpawn" title="新建受管子代理">+</button>
              <span class="tactile-btn">
                <span class="argon-spark">✦</span>
                <span class="argon-box">${engineName}</span>
                <span style="font-weight:650;color:var(--fg-primary)">${esc(task.model || (isZcode ? 'kimi-k3' : 'gpt-6.2'))}</span>
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
                ${!isZcode ? `<option value="queue" ${state.composerMode === 'queue' ? 'selected' : ''}>排队唤醒</option>` : ''}
                <option value="resume" ${state.composerMode === 'resume' || (isZcode && state.composerMode === 'queue') ? 'selected' : ''}>同步续跑</option>
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
  const isZcode = a.backend === 'zcode';
  const engineName = isZcode ? 'ZCode' : 'Codex';
  const metaParts = [a.status, a.model, a.branch, a.effort, fmtTokens(a.tokensUsed)].filter(Boolean);
  const sendText = `【受管子代理｜${engineName} · ${a.taskId}】\n状态: ${a.status} · 模型: ${a.model || '-'} · 分支: ${a.branch}\nWorktree: ${a.worktreePath}\n${a.summary || ''}`;

  return `
    <main class="detail-pane">
      <div class="detail-toolbar">
        <div class="detail-toolbar-left">
          <button class="tactile-btn icon-only back-btn" id="btnBackToList" title="返回列表">←</button>
          <span class="status-dot ${dotClass(a.status)}"></span>
          <span class="pill-badge ${isZcode ? 'zcode' : ''}">${engineName}</span>
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

function buildZcodeModelOptionsHtml(selectedVal, flatModels = [], currentValue = '') {
  const seen = new Set();
  const options = [];
  const addOpt = (val, label) => {
    if (!val || seen.has(val)) return;
    seen.add(val);
    options.push(`<option value="${esc(val)}" ${val === selectedVal ? 'selected' : ''}>${esc(label)}</option>`);
  };
  for (const m of flatModels) {
    addOpt(m.fullId, `${m.providerName} / ${m.modelId}`);
  }
  if (currentValue && !seen.has(currentValue)) {
    addOpt(currentValue, currentValue);
  }
  // Standard well-known defaults if user's local config hasn't been scanned yet
  addOpt('qwen-alibaba-model-studio-cn/kimi-k3', '阿里云百炼 / kimi-k3');
  addOpt('qwen-alibaba-model-studio-cn/deepseek-v4-pro-0813', '阿里云百炼 / deepseek-v4-pro-0813');
  addOpt('qwen-alibaba-model-studio-cn/qwen3.8-max', '阿里云百炼 / qwen3.8-max');
  addOpt('e2a41300-b652-45ec-9f78-ebd2ec7889be/glm-5.3', '腾讯TokenHub / glm-5.3 (1M窗口)');
  addOpt('e2a41300-b652-45ec-9f78-ebd2ec7889be/deepseek-v4-pro-0813', '腾讯TokenHub / deepseek-v4-pro-0813');
  addOpt('e2a41300-b652-45ec-9f78-ebd2ec7889be/kimi-k3', '腾讯TokenHub / kimi-k3');
  addOpt('e2a41300-b652-45ec-9f78-ebd2ec7889be/deepseek-v4.1-flash', '腾讯TokenHub / deepseek-v4.1-flash');
  return options.join('');
}

function renderSettingsWorkspace() {
  const es = state.engineSettings || {};
  const cfg = es.config || {
    codex: { required: true, enabled: true, flagshipModel: 'auto', fastModel: 'auto', defaultQuality: 'smart', defaultEffort: 'xhigh', defaultIsolation: 'worktree' },
    zcode: { required: false, enabled: true, scriptPath: '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs', syncDesktopIndex: true, defaultEffort: 'max', routes: {} },
    customAgents: [],
    policy: { costStrategy: 'effect_first', reviewPolicy: 'heterogeneous', hideDisabledEngineTasks: false },
  };
  const disc = es.discovery || { codex: { models: [] }, zcode: { providers: [], flatModels: [] }, customAgents: [] };
  const codexModels = disc.codex?.models || [];
  const zcodeFlat = disc.zcode?.flatModels || [];
  const zcodeProviders = disc.zcode?.providers || [];
  const zEnabled = cfg.zcode?.enabled !== false;
  const routes = cfg.zcode?.routes || {};

  const routeRows = [
    { key: 'code_and_audit', title: '代码实现 · 单测补齐 · 静态审查', badge: '高频核心', desc: '成块功能模块编写、算法落地、批量单元测试及 Codex 代码的异构交叉初审' },
    { key: 'reasoning_and_business', title: '中文复杂业务 · 安全分析 · 双盲出稿', badge: '深度推理', desc: '复杂产品逻辑推演、越权/安全漏洞分析、大架构方案双盲独立出稿' },
    { key: 'wide_1m_context', title: '100 万超长上下文 · 跨 10+ 文件扫街', badge: '1M 窗口', desc: '全代码库摸底、大型遗留仓库跨模块调用链扫描与全局依赖梳理' },
    { key: 'fast_tool_and_plugin', title: '飞书/办公插件 · 工具调用 · 快速任务', badge: '极速工具', desc: '飞书审批/文档办公插件联动、轻量脚本与高并发工具调用任务' },
  ];

  return `
    <div class="settings-scroll">
      <div class="settings-container">
        <!-- Hero Architecture Summary & Global Action Bar -->
        <section class="taper-card settings-card settings-hero">
          <div class="settings-hero-top">
            <div>
              <div class="settings-title-row">
                <span class="tactile-btn" style="height:24px;padding:0 10px">
                  <span class="argon-spark">✦</span>
                  <span class="argon-box">架构总览</span>
                  <span class="argon-tier">ENGINE ROUTER</span>
                </span>
                <span class="settings-main-title">多引擎协同与智能路由配置中心</span>
              </div>
              <div class="settings-subtitle">
                Codex 作为必选核心底座始终启用；ZCode 与其他 CLI Agent 作为可选备选引擎按需开启，未安装或停用时自动回退至 Codex 独立执行。
              </div>
            </div>
            <div class="settings-hero-actions">
              <button class="tactile-btn" id="btnSettingsProbe" title="重新扫描本机安装的 CLI 与模型配置">↻ 重新探测本机</button>
              <button class="tactile-btn" id="btnSettingsReset" title="恢复为推荐的旗舰路由参数">恢复默认</button>
              <button class="tactile-btn cta" id="btnSettingsSave">${state.savingSettings ? '保存中…' : '✦ 保存并同步配置'}</button>
            </div>
          </div>

          <div class="arch-topology">
            <div class="arch-node">
              <span class="argon-box">主控</span>
              <strong>反重力哈基咪</strong>
              <span class="argon-tier">前端 · 终审 · 拍板</span>
            </div>
            <span class="arch-arrow">⇄</span>
            <div class="arch-node active">
              <span class="argon-box">必选底座</span>
              <strong>OpenAI Codex</strong>
              <span class="status-pill ok">始终启用</span>
            </div>
            <span class="arch-arrow">⇄</span>
            <div class="arch-node ${zEnabled ? 'active' : 'muted'}">
              <span class="argon-box">可选备选</span>
              <strong>ZCode 国模旗舰池</strong>
              <span class="status-pill ${zEnabled ? 'ok' : 'off'}">${zEnabled ? `已启用 (${zcodeFlat.length} 模型)` : '已停用'}</span>
            </div>
          </div>
        </section>

        <!-- Card 1: Required Core Engine - OpenAI Codex -->
        <section class="taper-card settings-card">
          <div class="settings-card-head">
            <div class="settings-title-row">
              <span class="tactile-btn" style="height:24px;padding:0 9px">
                <span class="argon-spark">✦</span>
                <span class="argon-box">Codex</span>
                <span style="font-weight:650;color:var(--fg-primary)">OpenAI 核心底座</span>
                <span class="argon-tier">必选</span>
              </span>
              <span class="settings-hint">高难后端核心架构、复杂并发与状态机排障、操作系统级目录写锁硬沙箱</span>
            </div>
            <span class="status-pill locked">🔒 必选引擎 · 不可关闭</span>
          </div>

          <div class="settings-grid-2">
            <div class="field">
              <label>高难架构 / 状态机默认旗舰模型</label>
              <select id="cfgCodexFlagship">
                <option value="auto" ${cfg.codex?.flagshipModel === 'auto' ? 'selected' : ''}>auto（自动选用本机最新一代旗舰模型）</option>
                ${codexModels.map((m) => `<option value="${esc(m.slug)}" ${cfg.codex?.flagshipModel === m.slug ? 'selected' : ''}>${esc(m.slug)}${m.contextWindow ? ` (${Math.round(m.contextWindow / 1000)}k)` : ''}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label>常规模块 / 快速巡检默认模型</label>
              <select id="cfgCodexFast">
                <option value="auto" ${cfg.codex?.fastModel === 'auto' ? 'selected' : ''}>auto（自动选用宽窗口/高速兄弟模型）</option>
                ${codexModels.map((m) => `<option value="${esc(m.slug)}" ${cfg.codex?.fastModel === m.slug ? 'selected' : ''}>${esc(m.slug)}${m.contextWindow ? ` (${Math.round(m.contextWindow / 1000)}k)` : ''}</option>`).join('')}
              </select>
            </div>
          </div>

          <div class="settings-grid-3">
            <div class="field">
              <label>默认推理强度</label>
              <select id="cfgCodexEffort">
                <option value="xhigh" ${cfg.codex?.defaultEffort === 'xhigh' ? 'selected' : ''}>xhigh（极高推理 · 推荐）</option>
                <option value="max" ${cfg.codex?.defaultEffort === 'max' ? 'selected' : ''}>max（最高满血推理）</option>
                <option value="high" ${cfg.codex?.defaultEffort === 'high' ? 'selected' : ''}>high（标准高推理）</option>
                <option value="medium" ${cfg.codex?.defaultEffort === 'medium' ? 'selected' : ''}>medium（均衡推理）</option>
              </select>
            </div>
            <div class="field">
              <label>默认沙箱隔离模式</label>
              <select id="cfgCodexIsolation">
                <option value="worktree" ${cfg.codex?.defaultIsolation !== 'inplace' ? 'selected' : ''}>独立 Git Worktree（推荐隔离）</option>
                <option value="inplace" ${cfg.codex?.defaultIsolation === 'inplace' ? 'selected' : ''}>原地工作区（In-place）</option>
              </select>
            </div>
            <div class="field">
              <label>Codex CLI 路径（留空自动探测）</label>
              <input id="cfgCodexBin" value="${esc(cfg.codex?.binPath || '')}" placeholder="${esc(disc.codex?.binPath || '自动探测 codex')}" />
            </div>
          </div>
        </section>

        <!-- Card 2: Optional Auxiliary Engine - ZCode National Flagship Pool -->
        <section class="taper-card settings-card ${zEnabled ? '' : 'card-disabled'}">
          <div class="settings-card-head">
            <div class="settings-title-row">
              <span class="tactile-btn" style="height:24px;padding:0 9px">
                <span class="argon-spark">✦</span>
                <span class="argon-box">ZCode</span>
                <span style="font-weight:650;color:var(--fg-primary)">国模旗舰池</span>
                <span class="argon-tier">可选备选</span>
              </span>
              <span class="settings-hint">自动读取本机 ~/.zcode/v2/provider_config.json 渠道与模型，支持四场景点将与三级跨渠道灾备</span>
            </div>
            <button
              type="button"
              class="tactile-btn switch-pill"
              id="btnToggleZcodeEnabled"
              data-active="${zEnabled}"
            >
              <span class="status-dot ${zEnabled ? 'running' : ''}"></span>
              <span>${zEnabled ? '已启用 ZCode 备选引擎' : '已停用（点击启用）'}</span>
            </button>
          </div>

          <div class="zcode-discovery-bar">
            <div>
              <strong>本机探测状态：</strong>
              <span>CLI 脚本 ${disc.zcode?.scriptExists ? '✓ 已就绪' : '⚠ 未检测到默认路径'}</span>
              <span>·</span>
              <span>已发现 <strong>${zcodeProviders.length}</strong> 个渠道（${zcodeProviders.map((p) => `${esc(p.providerName)}: ${p.models.length} 模型`).join(' / ') || '无本机渠道配置，可手动填入或安装 ZCode'}）</span>
            </div>
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              <label class="dup-toggle">
                <input type="checkbox" id="cfgZcodeSyncDesktop" ${cfg.zcode?.syncDesktopIndex !== false ? 'checked' : ''} />
                同步至 ZCode 桌面端任务列表
              </label>
              <label class="dup-toggle">
                <input type="checkbox" id="cfgHideDisabledTasks" ${cfg.policy?.hideDisabledEngineTasks ? 'checked' : ''} />
                停用时隐藏 ZCode 历史会话
              </label>
            </div>
          </div>

          <div class="settings-grid-2" style="margin-bottom:10px">
            <div class="field">
              <label>ZCode CLI 执行脚本路径</label>
              <input id="cfgZcodeScript" value="${esc(cfg.zcode?.scriptPath || '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs')}" />
            </div>
            <div class="field">
              <label>ZCode 全局默认推理挡位</label>
              <select id="cfgZcodeEffort">
                <option value="max" ${cfg.zcode?.defaultEffort !== 'xhigh' && cfg.zcode?.defaultEffort !== 'high' ? 'selected' : ''}>max（满血深度思考 · 推荐）</option>
                <option value="xhigh" ${cfg.zcode?.defaultEffort === 'xhigh' ? 'selected' : ''}>xhigh（极高推理 · Qwen3.8 适用）</option>
                <option value="high" ${cfg.zcode?.defaultEffort === 'high' ? 'selected' : ''}>high（标准高推理）</option>
              </select>
            </div>
          </div>

          <div class="routes-matrix-title">四大任务场景主选模型与跨渠道三级灾备矩阵</div>
          <div class="routes-matrix">
            ${routeRows
              .map((row) => {
                const r = routes[row.key] || {};
                return `
                  <div class="route-box">
                    <div class="route-box-head">
                      <div>
                        <span class="argon-box">${esc(row.badge)}</span>
                        <strong style="margin-left:6px">${esc(row.title)}</strong>
                      </div>
                      <span class="route-box-desc">${esc(row.desc)}</span>
                    </div>
                    <div class="settings-grid-4">
                      <div class="field">
                        <label>主选模型 (Primary)</label>
                        <select data-route-key="${row.key}" data-route-slot="primary">
                          ${buildZcodeModelOptionsHtml(r.primary, zcodeFlat, r.primary)}
                        </select>
                      </div>
                      <div class="field">
                        <label>一级热备 (Fallback 1)</label>
                        <select data-route-key="${row.key}" data-route-slot="fallback1">
                          ${buildZcodeModelOptionsHtml(r.fallback1, zcodeFlat, r.fallback1)}
                        </select>
                      </div>
                      <div class="field">
                        <label>二级跨渠道热备 (Fallback 2)</label>
                        <select data-route-key="${row.key}" data-route-slot="fallback2">
                          ${buildZcodeModelOptionsHtml(r.fallback2, zcodeFlat, r.fallback2)}
                        </select>
                      </div>
                      <div class="field">
                        <label>推理挡位</label>
                        <select data-route-key="${row.key}" data-route-slot="effort">
                          <option value="max" ${r.effort !== 'xhigh' && r.effort !== 'high' ? 'selected' : ''}>max (满血)</option>
                          <option value="xhigh" ${r.effort === 'xhigh' ? 'selected' : ''}>xhigh (极高)</option>
                          <option value="high" ${r.effort === 'high' ? 'selected' : ''}>high (高)</option>
                        </select>
                      </div>
                    </div>
                  </div>
                `;
              })
              .join('')}
          </div>
        </section>

        <!-- Card 3: Other Extensible Backup CLI Agents + Cross-Review Policy -->
        <div class="settings-grid-2">
          <section class="taper-card settings-card">
            <div class="settings-card-head">
              <div class="settings-title-row">
                <span class="tactile-btn" style="height:24px;padding:0 9px">
                  <span class="argon-spark">✦</span>
                  <span class="argon-box">扩展备选</span>
                  <span style="font-weight:650;color:var(--fg-primary)">其他可接入 CLI Agent</span>
                </span>
              </div>
            </div>
            <div class="custom-agents-list">
              ${(cfg.customAgents || [])
                .map((ag, idx) => {
                  const statusObj = (disc.customAgents || []).find((x) => x.id === ag.id) || {};
                  return `
                    <div class="route-box" style="margin-bottom:8px">
                      <div class="route-box-head" style="margin-bottom:6px">
                        <div style="display:flex;align-items:center;gap:6px">
                          <span class="argon-box">${esc(ag.id)}</span>
                          <strong>${esc(ag.name)}</strong>
                          <span class="status-pill ${statusObj.available ? 'ok' : 'off'}">${statusObj.available ? '本机已安装' : '未探测到 CLI'}</span>
                        </div>
                        <label class="dup-toggle">
                          <input type="checkbox" data-custom-agent-idx="${idx}" data-custom-field="enabled" ${ag.enabled ? 'checked' : ''} />
                          作为备选启用
                        </label>
                      </div>
                      <div class="settings-grid-2">
                        <div class="field">
                          <label>命令路径</label>
                          <input data-custom-agent-idx="${idx}" data-custom-field="binPath" value="${esc(ag.binPath || '')}" placeholder="claude / gemini" />
                        </div>
                        <div class="field">
                          <label>默认模型</label>
                          <input data-custom-agent-idx="${idx}" data-custom-field="defaultModel" value="${esc(ag.defaultModel || '')}" />
                        </div>
                      </div>
                    </div>
                  `;
                })
                .join('')}
            </div>
          </section>

          <section class="taper-card settings-card">
            <div class="settings-card-head">
              <div class="settings-title-row">
                <span class="tactile-btn" style="height:24px;padding:0 9px">
                  <span class="argon-spark">✦</span>
                  <span class="argon-box">审查与成本</span>
                  <span style="font-weight:650;color:var(--fg-primary)">异构交叉审查策略</span>
                </span>
              </div>
            </div>
            <div class="field">
              <label>合并前代码静态初审策略 (dispatch.py review --backend auto)</label>
              <select id="cfgPolicyReview">
                <option value="heterogeneous" ${cfg.policy?.reviewPolicy !== 'dual_engine' && cfg.policy?.reviewPolicy !== 'codex_only' ? 'selected' : ''}>异构交叉互审（Codex 写交 ZCode 审，ZCode 写交 Codex 审；未启用备选时自动回退 Codex）</option>
                <option value="dual_engine" ${cfg.policy?.reviewPolicy === 'dual_engine' ? 'selected' : ''}>双引擎最高推理叠加深审（涉及资金、权限、登录、外发消息）</option>
                <option value="codex_only" ${cfg.policy?.reviewPolicy === 'codex_only' ? 'selected' : ''}>仅使用 Codex 旗舰模型审查</option>
              </select>
            </div>
            <div class="field" style="margin-top:10px">
              <label>模型效果与 Token 成本偏好</label>
              <select id="cfgPolicyCost">
                <option value="effect_first" ${cfg.policy?.costStrategy !== 'balanced' ? 'selected' : ''}>不计成本 · 只看最高效果（强制锁定 max / xhigh 最高推理挡位）</option>
                <option value="balanced" ${cfg.policy?.costStrategy === 'balanced' ? 'selected' : ''}>按任务难度自适应均衡（轻量 medium / 常规 high / 高难 xhigh）</option>
              </select>
            </div>
            <div class="settings-footnote">
              配置文件持久化路径：<code>${esc(es.configPath || '~/.local/state/multi-agent-dispatch/engine_config.json')}</code>
            </div>
          </section>
        </div>
      </div>
    </div>
  `;
}

function renderModal() {
  if (!state.modal) return '';
  const task = selectedTask();

  if (state.modal === 'spawn') {
    const es = state.engineSettings || {};
    const cfg = es.config || {};
    const disc = es.discovery || {};
    const zEnabled = cfg.zcode?.enabled !== false;
    const d = state.spawnDraft;
    const effectiveBackend = !zEnabled && d.backend === 'zcode' ? 'codex' : d.backend;
    const cwd = d.cwd || task?.dispatchTask?.repoRoot || task?.cwd || '';

    const codexModels = disc.codex?.models || [];
    const zcodeFlat = disc.zcode?.flatModels || [];

    let modelOptionsHtml = '';
    if (effectiveBackend === 'codex') {
      modelOptionsHtml = `
        <option value="auto" ${d.model === 'auto' ? 'selected' : ''}>✦ 智能自动路由（按任务难度自动匹配最新旗舰 / 高速模型）</option>
        ${codexModels.map((m) => `<option value="${esc(m.slug)}" ${d.model === m.slug ? 'selected' : ''}>${esc(m.slug)}${m.description ? ` · ${esc(m.description.slice(0, 42))}` : ''}</option>`).join('')}
      `;
    } else {
      modelOptionsHtml = `
        <option value="auto" ${d.model === 'auto' ? 'selected' : ''}>✦ 四大场景自动点将（含百炼 + TokenHub 三级跨渠道热备）</option>
        ${zcodeFlat.map((m) => `<option value="${esc(m.fullId)}" ${d.model === m.fullId ? 'selected' : ''}>${esc(m.providerName)} / ${esc(m.modelId)}</option>`).join('')}
        ${!zcodeFlat.length ? `
          <option value="qwen-alibaba-model-studio-cn/kimi-k3">阿里云百炼 / kimi-k3 (综合/业务/审计主选)</option>
          <option value="qwen-alibaba-model-studio-cn/deepseek-v4-pro-0813">阿里云百炼 / deepseek-v4-pro-0813 (深度代码/单测主选)</option>
          <option value="e2a41300-b652-45ec-9f78-ebd2ec7889be/glm-5.3">腾讯TokenHub / glm-5.3 (100万上下文全库扫街)</option>
          <option value="qwen-alibaba-model-studio-cn/qwen3.8-max">阿里云百炼 / qwen3.8-max (飞书/办公插件工具)</option>
        ` : ''}
      `;
    }

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

          <div class="field">
            <label>目标仓库 / 工作区路径</label>
            <input id="mSpawnCwd" value="${esc(cwd)}" placeholder="/Users/.../repo" />
          </div>

          <div class="field">
            <div class="field-label-row">
              <label>选择执行引擎（Codex 必选底座 · ZCode 可选备选）</label>
              <button type="button" class="link-micro-btn" id="btnJumpSettingsFromSpawn">⚙ 引擎与路由设置</button>
            </div>
            <div class="engine-cards-row">
              <button
                type="button"
                class="engine-pick-card ${effectiveBackend === 'codex' ? 'selected' : ''}"
                data-pick-backend="codex"
              >
                <div class="engine-pick-top">
                  <span class="argon-spark">✦</span>
                  <span class="argon-box">Codex</span>
                  <strong>OpenAI 核心引擎</strong>
                  <span class="argon-tier">必选</span>
                </div>
                <div class="engine-pick-desc">高难后端架构 · 状态机并发排障 · OS 级硬沙箱</div>
              </button>

              <button
                type="button"
                class="engine-pick-card ${effectiveBackend === 'zcode' ? 'selected' : ''} ${zEnabled ? '' : 'disabled-card'}"
                data-pick-backend="${zEnabled ? 'zcode' : 'go_settings'}"
              >
                <div class="engine-pick-top">
                  <span class="argon-spark">✦</span>
                  <span class="argon-box">ZCode</span>
                  <strong>国模旗舰池</strong>
                  <span class="argon-tier">${zEnabled ? '备选已启用' : '未启用 · 去开启'}</span>
                </div>
                <div class="engine-pick-desc">
                  ${zEnabled ? '百炼 + TokenHub · Kimi-K3 / DeepSeek-V4 / 1M GLM-5.3' : '当前已作为可选项停用，点击前往设置页一键开启'}
                </div>
              </button>
            </div>
          </div>

          <div class="field">
            <label>模型与场景路由策略</label>
            <select id="mSpawnModel">${modelOptionsHtml}</select>
          </div>

          <div class="spawn-pills-grid">
            <div class="field">
              <label>推理与质量策略</label>
              <div class="pill-seg-group">
                <button type="button" class="tactile-btn" data-spawn-quality="max" data-active="${d.quality === 'max'}">满血效果 (Max)</button>
                <button type="button" class="tactile-btn" data-spawn-quality="smart" data-active="${d.quality === 'smart'}">智能路由 (Smart)</button>
                <button type="button" class="tactile-btn" data-spawn-quality="balanced" data-active="${d.quality === 'balanced'}">均衡 (Balanced)</button>
              </div>
            </div>

            <div class="field">
              <label>工作区沙箱隔离</label>
              <div class="pill-seg-group">
                <button type="button" class="tactile-btn" data-spawn-iso="worktree" data-active="${d.isolation === 'worktree'}">独立 Git Worktree</button>
                <button type="button" class="tactile-btn" data-spawn-iso="inplace" data-active="${d.isolation === 'inplace'}">当前目录 (In-place)</button>
              </div>
            </div>
          </div>

          <div class="field">
            <label>任务难度定级</label>
            <div class="pill-seg-group">
              <button type="button" class="tactile-btn" data-spawn-diff="auto" data-active="${d.difficulty === 'auto'}">✦ 自动识别</button>
              <button type="button" class="tactile-btn" data-spawn-diff="low" data-active="${d.difficulty === 'low'}">轻量 (Low)</button>
              <button type="button" class="tactile-btn" data-spawn-diff="medium" data-active="${d.difficulty === 'medium'}">常规 (Medium)</button>
              <button type="button" class="tactile-btn" data-spawn-diff="hard" data-active="${d.difficulty === 'hard'}">高难 (Hard)</button>
              <button type="button" class="tactile-btn" data-spawn-diff="extreme" data-active="${d.difficulty === 'extreme'}">极限 (Extreme)</button>
            </div>
          </div>

          <div class="field">
            <label>任务指令（清晰说明接口定义、验收标准与需一并修改的同类项）</label>
            <textarea id="mSpawnPrompt" rows="4" placeholder="例如：在隔离工作树中实现某模块并补齐单元测试，完成后运行 pytest 核实…">${esc(d.prompt)}</textarea>
          </div>

          <div class="spawn-adv-wrap">
            <button type="button" class="link-micro-btn" id="btnToggleSpawnAdv">
              ${d.showAdvanced ? '▾ 收起高级绑定选项 (Task ID / Change 标识)' : '▸ 展开高级绑定选项 (自定义 Task ID / 跨会话 Change 标识)'}
            </button>
            ${d.showAdvanced ? `
              <div class="field-grid-2" style="margin-top:8px">
                <div class="field"><label>自定义 Task ID</label><input id="mSpawnTaskId" value="${esc(d.taskId)}" placeholder="留空自动生成" /></div>
                <div class="field"><label>跨会话 Change 标识</label><input id="mSpawnChange" value="${esc(d.changeKey)}" placeholder="如 feat-auth-flow" /></div>
              </div>
            ` : ''}
          </div>

          <div class="modal-foot">
            <button class="tactile-btn" data-close-modal="1">取消</button>
            <button class="tactile-btn cta" id="btnSubmitSpawn">
              <span>✦ 启动 ${effectiveBackend === 'zcode' ? 'ZCode' : 'Codex'} 子代理</span>
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
                <span class="argon-box">${esc(task?.engineLabel || 'Codex')}</span>
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
                <option value="codex">Codex (核心后端)</option>
                <option value="zcode">ZCode (国模旗舰池)</option>
                <option value="antigravity">Antigravity (主控哈基咪)</option>
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
    state.spawnDraft.cwd = state.spawnDraft.cwd || t?.dispatchTask?.repoRoot || t?.cwd || '';
    const zEnabled = state.engineSettings?.config?.zcode?.enabled !== false;
    if (!zEnabled && state.spawnDraft.backend === 'zcode') {
      state.spawnDraft.backend = 'codex';
      state.spawnDraft.model = 'auto';
    }
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
      const target = el.dataset.pickBackend;
      if (target === 'go_settings') {
        state.modal = null;
        state.activeTab = 'settings';
        render();
        return;
      }
      state.spawnDraft.backend = target;
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

  document.getElementById('btnToggleSpawnAdv')?.addEventListener('click', () => {
    syncSpawnTextFields();
    state.spawnDraft.showAdvanced = !state.spawnDraft.showAdvanced;
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
      const zEnabled = state.engineSettings?.config?.zcode?.enabled !== false;
      const backend = !zEnabled && state.spawnDraft.backend === 'zcode' ? 'codex' : state.spawnDraft.backend;
      const modelVal = state.spawnDraft.model?.trim();
      const promptVal = state.spawnDraft.prompt?.trim();
      const cwdVal = state.spawnDraft.cwd?.trim();
      if (!cwdVal) return showToast('请填写工作目录', 'error');
      if (!promptVal) return showToast('请填写任务指令', 'error');

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
      showToast(`已启动 ${backend === 'zcode' ? 'ZCode' : 'Codex'} 子代理`);
      await refreshSnapshot({ silent: true });
      if (res?.op?.id) pollOp(res.op.id, null);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Settings Workspace Events
  const collectSettingsForm = () => {
    const cur = state.engineSettings?.config || {};
    const routes = JSON.parse(JSON.stringify(cur.zcode?.routes || {}));
    document.querySelectorAll('[data-route-key]').forEach((el) => {
      const k = el.dataset.routeKey;
      const slot = el.dataset.routeSlot;
      if (!routes[k]) routes[k] = {};
      routes[k][slot] = el.value;
    });

    const customAgents = JSON.parse(JSON.stringify(cur.customAgents || []));
    document.querySelectorAll('[data-custom-agent-idx]').forEach((el) => {
      const idx = Number(el.dataset.customAgentIdx);
      const field = el.dataset.customField;
      if (!customAgents[idx]) return;
      customAgents[idx][field] = el.type === 'checkbox' ? el.checked : el.value.trim();
    });

    const zBtn = document.getElementById('btnToggleZcodeEnabled');
    const zEnabled = zBtn ? zBtn.dataset.active === 'true' : cur.zcode?.enabled !== false;

    return {
      codex: {
        required: true,
        enabled: true,
        flagshipModel: document.getElementById('cfgCodexFlagship')?.value || 'auto',
        fastModel: document.getElementById('cfgCodexFast')?.value || 'auto',
        defaultEffort: document.getElementById('cfgCodexEffort')?.value || 'xhigh',
        defaultIsolation: document.getElementById('cfgCodexIsolation')?.value || 'worktree',
        binPath: document.getElementById('cfgCodexBin')?.value?.trim() || '',
      },
      zcode: {
        required: false,
        enabled: zEnabled,
        scriptPath: document.getElementById('cfgZcodeScript')?.value?.trim() || '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
        defaultEffort: document.getElementById('cfgZcodeEffort')?.value || 'max',
        syncDesktopIndex: Boolean(document.getElementById('cfgZcodeSyncDesktop')?.checked),
        routes,
      },
      customAgents,
      policy: {
        reviewPolicy: document.getElementById('cfgPolicyReview')?.value || 'heterogeneous',
        costStrategy: document.getElementById('cfgPolicyCost')?.value || 'effect_first',
        hideDisabledEngineTasks: Boolean(document.getElementById('cfgHideDisabledTasks')?.checked),
      },
    };
  };

  document.getElementById('btnToggleZcodeEnabled')?.addEventListener('click', async () => {
    const curEnabled = state.engineSettings?.config?.zcode?.enabled !== false;
    const patch = collectSettingsForm();
    patch.zcode.enabled = !curEnabled;
    try {
      const res = await callTool('console_engine_settings', { action: 'save', config: patch });
      if (res?.engineSettings) state.engineSettings = res.engineSettings;
      if (!patch.zcode.enabled && state.engineFilter === 'zcode') {
        state.engineFilter = 'all';
      }
      await refreshSnapshot({ silent: true });
      showToast(patch.zcode.enabled ? '已启用 ZCode 备选引擎' : '已停用 ZCode 备选引擎（仅使用 Codex）');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btnSettingsSave')?.addEventListener('click', async () => {
    if (state.savingSettings) return;
    state.savingSettings = true;
    const patch = collectSettingsForm();
    render();
    try {
      const res = await callTool('console_engine_settings', { action: 'save', config: patch });
      if (res?.engineSettings) state.engineSettings = res.engineSettings;
      await refreshSnapshot({ silent: true });
      showToast('引擎与路由配置已保存并同步');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      state.savingSettings = false;
      render();
    }
  });

  document.getElementById('btnSettingsProbe')?.addEventListener('click', async () => {
    try {
      const res = await callTool('console_engine_settings', { action: 'probe' });
      if (res?.engineSettings) state.engineSettings = res.engineSettings;
      render();
      const zCount = state.engineSettings?.discovery?.zcode?.flatModels?.length || 0;
      const cCount = state.engineSettings?.discovery?.codex?.models?.length || 0;
      showToast(`探测完成：Codex ${cCount} 模型 · ZCode ${zCount} 模型`);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btnSettingsReset')?.addEventListener('click', async () => {
    try {
      const res = await callTool('console_engine_settings', { action: 'reset' });
      if (res?.engineSettings) state.engineSettings = res.engineSettings;
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
