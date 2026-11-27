import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_ZCODE_SCRIPT = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';

const KNOWN_PROVIDER_LABELS = {
  'qwen-alibaba-model-studio-cn': '阿里云百炼',
  'e2a41300-b652-45ec-9f78-ebd2ec7889be': '腾讯TokenHub',
};

// The v1 settings page seeded its routes from the local provider list, falling
// back to these benchmark choices. Do not enable a scenario for an untouched form.
function legacyScenarioDefaults(models) {
  const bailian = 'qwen-alibaba-model-studio-cn/';
  const tokenhub = 'e2a41300-b652-45ec-9f78-ebd2ec7889be/';
  const kimi = bailian + 'kimi-k3', deepseek = bailian + 'deepseek-v4-pro-0813', qwen = bailian + 'qwen3.8-max';
  const kimiTH = tokenhub + 'kimi-k3', deepseekTH = tokenhub + 'deepseek-v4-pro-0813';
  const glm = tokenhub + 'glm-5.3', flash = tokenhub + 'deepseek-v4.1-flash';
  function route(effort, ...preferences) {
    const [primary, fallback1, fallback2] = preferences.map((pair, i) =>
      pair.find(id => models.includes(id)) || models[i] || models[0] || pair[0]);
    return { primary, fallback1, fallback2, effort };
  }
  return {
    wide_1m_context: route('max', [glm, kimi], [kimi, deepseek], [deepseek, kimiTH]),
    reasoning_and_business: route('max', [kimi, kimiTH], [kimiTH, qwen], [qwen, deepseek]),
    fast_tool_and_plugin: route('xhigh', [qwen, flash], [flash, kimi], [kimi, kimiTH]),
  };
}

const ENGINE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const scenarioEfforts = {
  wide_context: 'max', architecture_concurrency: 'xhigh',
  chinese_business_security: 'max', unit_tests_and_tools: 'max',
};

export function expandPath(value) {
  if (value === '~') return os.homedir();
  return value?.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value || '';
}

export function dispatchStateDir() {
  return expandPath(process.env.AGY_DISPATCH_STATE_DIR || '~/.local/state/multi-agent-dispatch');
}

export function engineConfigPath() {
  return expandPath(process.env.AGY_ENGINE_CONFIG_FILE || path.join(dispatchStateDir(), 'engine_config.json'));
}

function isFile(file, executable = false) {
  try {
    if (executable) fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function findCliBin(name) {
  if (!name) return null;
  const bin = expandPath(name);
  if (bin.includes(path.sep)) return isFile(bin, true) ? bin : null;
  const dirs = [
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean),
    '~/.local/bin', '~/.npm-global/bin', '~/.volta/bin', '/opt/homebrew/bin', '/usr/local/bin',
  ];
  return dirs.map(dir => path.join(expandPath(dir), bin)).find(file => isFile(file, true)) || null;
}

export function resolveCodexBin() {
  return findCliBin(process.env.CODEX_BIN) || findCliBin('codex')
    || findCliBin('/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex');
}

export function resolveNodeBin() {
  return findCliBin(process.env.NODE_BIN) || findCliBin('node');
}

const genericExec = '{bin} -p {prompt} --model {model}';
function customEngine(id, name = id, model = '', templates = [genericExec, genericExec, '{bin} --resume {session_id} -p {prompt} --model {model}']) {
  const [execTemplate, readonlyTemplate, resumeTemplate] = templates;
  return {
    id, name, builtin: false, kind: 'custom_cli', enabled: false, binPath: id, configFilePath: '',
    models: { primaryModel: model, fallbackModel: '', defaultEffort: 'high' },
    adapter: { execTemplate, readonlyTemplate, resumeTemplate, syncDesktopIndex: false },
  };
}

export function buildDefaultEngineConfig() {
  const codex = {
    id: 'codex', name: 'OpenAI Codex', builtin: true, kind: 'codex', enabled: true,
    binPath: '', configFilePath: '~/.codex/models_cache.json',
    models: { primaryModel: 'auto', fallbackModel: '', defaultEffort: 'xhigh' },
    adapter: {
      execTemplate: 'codex exec -C {cwd} -m {model} -c model_reasoning_effort="{effort}" -s {sandbox} --json -',
      readonlyTemplate: 'codex exec review -m {model} -c model_reasoning_effort="{effort}" -c sandbox_mode="read-only" --json',
      resumeTemplate: 'codex exec resume -m {model} -c model_reasoning_effort="{effort}" {session_id} -',
      syncDesktopIndex: false,
    },
  };
  const zcode = {
    id: 'zcode', name: 'ZCode CLI', builtin: true, kind: 'zcode', enabled: false,
    binPath: DEFAULT_ZCODE_SCRIPT, configFilePath: '~/.zcode/v2/provider_config.json',
    models: { primaryModel: 'qwen-alibaba-model-studio-cn/kimi-k3', fallbackModel: 'qwen-alibaba-model-studio-cn/deepseek-v4-pro-0813', defaultEffort: 'max' },
    adapter: {
      execTemplate: 'node {bin} -p {prompt} --cwd {cwd} --mode build --json --no-color',
      readonlyTemplate: 'node {bin} -p {prompt} --cwd {cwd} --mode plan --json --no-color',
      resumeTemplate: 'node {bin} --resume {session_id} -p {prompt} --cwd {cwd} --mode build --json --no-color',
      syncDesktopIndex: true,
    },
  };
  const claudeArgs = '-p {prompt} --model {model}';
  const geminiArgs = '-p {prompt} -m {model} --output-format json';
  const claude = customEngine('claude', 'Claude Code', 'claude-sonnet-4-6', [
    `{bin} ${claudeArgs} --output-format json`, `{bin} ${claudeArgs} --permission-mode plan --output-format json`,
    `{bin} --resume {session_id} ${claudeArgs} --output-format json`,
  ]);
  const gemini = customEngine('gemini', 'Gemini CLI', 'gemini-2.5-pro', [
    `{bin} ${geminiArgs}`, `{bin} ${geminiArgs}`, `{bin} --resume {session_id} ${geminiArgs}`,
  ]);
  return {
    version: 2, updatedAtMs: 0,
    engines: [codex, zcode, { ...claude, builtin: true, configFilePath: '~/.claude.json' },
      { ...gemini, builtin: true, configFilePath: '~/.gemini/settings.json' }],
    workflowRoles: {
      primaryBuilder: { engineId: 'codex', model: 'auto', effort: 'xhigh' },
      reviewer: { mode: 'auto_heterogeneous', engineId: '', model: 'auto', effort: 'max' },
      scenarios: Object.fromEntries(Object.entries(scenarioEfforts).map(([id, effort]) =>
        [id, { enabled: false, engineId: '', model: '', fallbackModel: '', effort }])),
    },
    policy: { costStrategy: 'effect_first', defaultIsolation: 'worktree', hideDisabledEngineTasks: false },
  };
}

// Apply only fields defined by the schema, preserving nested partial updates.
function fields(base, patch) {
  return Object.fromEntries(Object.entries(base).map(([key, value]) =>
    [key, typeof patch?.[key] === typeof value ? patch[key] : value]));
}

function mergeRegistry(rows, current, { replaceEngines = false } = {}) {
  if (!Array.isArray(rows)) throw new Error('engines 必须是数组');
  const existing = new Map(current.map(engine => [engine.id, engine]));
  const seen = new Set();
  const engines = rows.map(row => {
    const id = row?.id;
    if (typeof id !== 'string' || !ENGINE_ID.test(id) || ['auto', 'all'].includes(id)) {
      throw new Error(`无效的 CLI 引擎 ID: ${id}`);
    }
    if (seen.has(id)) throw new Error(`重复的 CLI 引擎 ID: ${id}`);
    seen.add(id);
    const base = existing.get(id) || customEngine(id);
    return {
      ...fields(base, row), builtin: base.builtin, kind: base.kind,
      models: fields(base.models, row.models), adapter: fields(base.adapter, row.adapter),
    };
  });
  if (replaceEngines) return engines.concat(current.filter(engine => engine.builtin && !seen.has(engine.id)));
  for (const engine of engines) existing.set(engine.id, engine);
  return [...existing.values()];
}

function validateTemplates(engine) {
  for (const field of ['execTemplate', 'readonlyTemplate', 'resumeTemplate']) {
    let quote = '', escaped = false;
    for (const ch of engine.adapter[field]) {
      if (escaped) escaped = false;
      else if (ch === '\\' && quote !== "'") escaped = true;
      else if (ch === quote) quote = '';
      else if (!quote && (ch === '"' || ch === "'")) quote = ch;
    }
    if (quote || escaped) throw new Error(`引擎 ${engine.id} 的 ${field} 模板引号未闭合或转义不完整`);
  }
}

export function migrateV1ToV2(saved, defaults = buildDefaultEngineConfig(), saving = false) {
  const engines = defaults.engines.map(engine => structuredClone(engine));
  const codex = engines.find(e => e.id === 'codex');
  const zcode = engines.find(e => e.id === 'zcode');
  const c = saved.codex || {};
  const z = saved.zcode || {};
  Object.assign(codex, fields(codex, { enabled: c.enabled, binPath: c.binPath }));
  codex.models = fields(codex.models, {
    primaryModel: c.flagshipModel, fallbackModel: c.fastModel === 'auto' ? '' : c.fastModel, defaultEffort: c.defaultEffort,
  });
  Object.assign(zcode, fields(zcode, { enabled: z.enabled, binPath: z.scriptPath }));
  zcode.models = fields(zcode.models, {
    primaryModel: z.routes?.code_and_audit?.primary || undefined, fallbackModel: z.routes?.code_and_audit?.fallback1 || undefined,
    defaultEffort: z.defaultEffort,
  });
  zcode.adapter = fields(zcode.adapter, { syncDesktopIndex: z.syncDesktopIndex });

  let migrated = engines;
  if (Array.isArray(saved.customAgents)) {
    const rows = [codex, zcode];
    for (const old of saved.customAgents) {
      const args = old.argsTemplate?.trim();
      if (['codex', 'zcode'].includes(old.id)) throw new Error(`重复的 CLI 引擎 ID: ${old.id}`);
      rows.push({
        id: old.id, name: old.name === 'Claude Code CLI' && old.id === 'claude' ? 'Claude Code' : old.name,
        enabled: old.enabled, binPath: old.binPath, configFilePath: old.configFilePath,
        models: { primaryModel: old.defaultModel, defaultEffort: old.effort },
        adapter: args ? { execTemplate: args.includes('{bin}') ? args : `{bin} ${args}` } : {},
      });
    }
    migrated = mergeRegistry(rows, engines);
  }
  const roles = structuredClone(defaults.workflowRoles);
  const mappings = { wide_1m_context: 'wide_context', reasoning_and_business: 'chinese_business_security', fast_tool_and_plugin: 'unit_tests_and_tools' };
  if (z.routes) {
    const discovered = discoverZcodeEnvironment(z.scriptPath).flatModels.map(m => m.id);
    const oldDefaults = legacyScenarioDefaults(discovered);
    const benchmarks = legacyScenarioDefaults([]);
    for (const [key, scenario] of Object.entries(mappings)) {
      const route = z.routes[key];
      const old = oldDefaults[key];
      const customized = defaults => Object.keys(old).some(k => route?.[k] && route[k] !== defaults[k]);
      if (customized(old) && customized(benchmarks[key])) {
        const backup = route.fallback2 && route.fallback2 !== old.fallback2 && route.fallback1 === old.fallback1
          ? route.fallback2 : route.fallback1 || route.fallback2 || old.fallback1;
        roles.scenarios[scenario] = {
          enabled: true, engineId: 'zcode', model: route.primary || old.primary,
          fallbackModel: backup, effort: route.effort || old.effort,
        };
      }
    }
  }
  if (saved.policy?.reviewPolicy) {
    roles.reviewer = { mode: saved.policy.reviewPolicy === 'codex_only' ? 'explicit' : 'auto_heterogeneous',
      engineId: saved.policy.reviewPolicy === 'codex_only' ? 'codex' : '', model: 'auto', effort: 'max' };
  }
  const base = {
    version: 2, updatedAtMs: saved.updatedAtMs ?? defaults.updatedAtMs,
    engines: migrated, workflowRoles: roles,
    policy: fields(defaults.policy, { ...saved.policy, defaultIsolation: c.defaultIsolation ?? saved.policy?.defaultIsolation }),
  };
  const recoveryId = saved.version !== 2 && c.enabled === false ? 'zcode' : null;
  return normalizeV2(saved, base, saving, recoveryId);
}

function normalize(saved, current, saving = false) {
  const legacy = ['codex', 'zcode', 'customAgents'].some(k => Object.hasOwn(saved, k));
  return legacy || (!saving && saved.version !== 2) || saved.version === 1
    ? migrateV1ToV2(saved, current, saving)
    : normalizeV2(saved, current, saving);
}

function normalizeV2(saved, base, saving, recoveryId = null) {
  let engines = saved.engines === undefined ? base.engines : mergeRegistry(saved.engines, base.engines, {
    replaceEngines: !saving || saved.replaceEngines === true,
  });
  if (!saving && saved.version === 2 && Array.isArray(saved.engines)) {
    // Restore missing builtin definitions without enabling engines absent from the stored registry.
    const storedIds = new Set(saved.engines.map(e => e.id));
    for (const engine of engines) {
      if (!storedIds.has(engine.id)) engine.enabled = false;
    }
  }
  if (saving && saved.removeEngineIds !== undefined) {
    if (!Array.isArray(saved.removeEngineIds) || saved.removeEngineIds.some(id => typeof id !== 'string')) {
      throw new Error('removeEngineIds 必须是引擎 ID 字符串数组');
    }
    const removed = new Set(saved.removeEngineIds);
    const builtin = engines.find(engine => engine.builtin && removed.has(engine.id));
    if (builtin) throw new Error(`内置引擎 ${builtin.id} 只支持停用，无法删除`);
    engines = engines.filter(engine => !removed.has(engine.id));
  }
  let active = engines.filter(e => e.enabled);
  if (!active.length) {
    if (saving) throw new Error('至少需要启用 1 个 CLI 引擎，无法全部关闭');
    const recovered = engines.find(e => e.id === recoveryId) || engines[0];
    recovered.enabled = true;
    active = [recovered];
  }
  const roles = saved.workflowRoles || {};
  const primaryBuilder = fields(base.workflowRoles.primaryBuilder, roles.primaryBuilder);
  const reviewer = fields(base.workflowRoles.reviewer, roles.reviewer);
  const missingBuilder = !saving && saved.version === 2 && !saved.workflowRoles?.primaryBuilder?.engineId;
  if (missingBuilder || !active.some(e => e.id === primaryBuilder.engineId)) {
    Object.assign(primaryBuilder, { engineId: active[0].id, model: 'auto' });
  }
  if (reviewer.mode !== 'explicit' || !active.some(e => e.id === reviewer.engineId)) {
    Object.assign(reviewer, { mode: 'auto_heterogeneous', engineId: '' });
  }
  const scenarios = Object.fromEntries(Object.entries(base.workflowRoles.scenarios).map(([id, role]) =>
    [id, fields(role, roles.scenarios?.[id])]));
  return { version: 2, updatedAtMs: saved.updatedAtMs ?? base.updatedAtMs, engines,
    workflowRoles: { primaryBuilder, reviewer, scenarios }, policy: fields(base.policy, saved.policy) };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function loadEngineConfig() {
  const defaults = buildDefaultEngineConfig();
  const saved = readJson(engineConfigPath());
  return saved && typeof saved === 'object' && !Array.isArray(saved) ? normalize(saved, defaults) : defaults;
}

function persist(config) {
  const file = engineConfigPath();
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return config;
}

export function saveEngineConfig(patch = {}) {
  const config = normalize(patch, loadEngineConfig(), true);
  config.engines.forEach(validateTemplates);
  config.updatedAtMs = Date.now();
  return persist(config);
}

export function resetEngineConfig() {
  return persist(buildDefaultEngineConfig());
}

export function codexCatalogOverride(file) {
  return expandPath(process.env.AGY_MODELS_CACHE_FILE || (file !== '~/.codex/models_cache.json' && file) || '');
}

function codexCachePaths(file) {
  const override = codexCatalogOverride(file);
  if (override) return [override];
  const home = expandPath(process.env.CODEX_HOME || '~/.codex');
  return ['models_cache.json', 'models_cache.codex_work_desktop.json'].map(name => path.join(home, name));
}

export function engineConfigFile(engine) {
  if (!engine) return '';
  if (engine.kind === 'codex') {
    const candidates = codexCachePaths(engine.configFilePath);
    return candidates.find(file => isFile(file)) || candidates[0];
  }
  if (engine.kind === 'zcode') {
    const file = engine.configFilePath;
    return expandPath(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ||
      (file && file !== '~/.zcode/v2/provider_config.json' ? file :
        path.join(process.env.ZCODE_HOME || '~/.zcode', 'v2', 'provider_config.json')));
  }
  return expandPath(engine.configFilePath);
}

export function discoverCodexModels(file) {
  const seen = new Map();
  for (const cache of codexCachePaths(file)) {
    const raw = readJson(cache);
    const list = raw?.models || raw;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const id = String(item?.slug || item?.id || '').trim();
      if (!id || seen.has(id) || (item.visibility && item.visibility !== 'list') || item.supported_in_api === false) continue;
      seen.set(id, { id, label: id, description: item.description || '', contextWindow: Number(item.context_window || 0), priority: item.priority ?? 999 });
    }
  }
  return [...seen.values()].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .map(({ priority, ...model }) => model);
}

export function discoverZcodeEnvironment(customScriptPath = '', configFilePath = '') {
  const scriptPath = expandPath(customScriptPath || DEFAULT_ZCODE_SCRIPT);
  const providerConfigPath = engineConfigFile({ kind: 'zcode', configFilePath });
  const raw = readJson(providerConfigPath);
  const providers = [];
  const flatModels = [];
  const providerLabels = { ...KNOWN_PROVIDER_LABELS };
  const rules = raw?.config?.providerConfigRules?.providerRules;
  for (const rule of Array.isArray(rules) ? rules : []) {
    const providerId = rule?.providerId;
    if (!providerId) continue;
    const providerName = rule.providerName || providerLabels[providerId] || providerId;
    const ids = rule.config?.modelOrder || rule.config?.personalModelIds || [];
    const models = Array.isArray(ids) ? [...new Set(ids.filter(id => typeof id === 'string' && id && !id.includes('/')))] : [];
    providerLabels[providerId] = providerName;
    providers.push({ providerId, providerName, models });
    for (const modelId of models) {
      flatModels.push({ id: `${providerId}/${modelId}`, label: `${providerName} / ${modelId}`, providerId, providerName, modelId });
    }
  }
  return { scriptPath, scriptExists: isFile(scriptPath), providerConfigPath, providers, flatModels, providerLabels };
}

function discoverCustomModels(engine, file) {
  const ids = new Set();
  const add = value => { if (typeof value === 'string' && value.trim() && value !== 'auto') ids.add(value.trim()); };
  function addModel(item) {
    add(typeof item === 'string' ? item : item?.id || item?.modelId || item?.model_id || item?.slug || item?.name);
  }
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const field = key.replace(/[_-]/g, '').toLowerCase();
      if (/(?:model|modelid|modelname)$/.test(field)) {
        addModel(child);
      } else if (['models', 'modelids', 'modelorder', 'availablemodels', 'modelnames'].includes(field)) {
        if (Array.isArray(child)) child.forEach(addModel);
        else if (child && typeof child === 'object') Object.keys(child).forEach(add);
      }
      visit(child);
    }
  }
  const raw = file && readJson(file);
  visit(Array.isArray(raw) ? { models: raw } : raw);
  const curated = { claude: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'], gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'] };
  if (engine.builtin) (curated[engine.id] || []).forEach(add);
  add(engine.models.primaryModel);
  add(engine.models.fallbackModel);
  return [...ids].map(id => ({ id, label: id }));
}

export function getEngineDiscoverySnapshot() {
  const config = loadEngineConfig();
  const engines = Object.fromEntries(config.engines.map(engine => {
    const { id, kind, binPath } = engine;
    const resolvedConfigPath = engineConfigFile(engine);
    let providers = [], models, detectedBin;
    if (kind === 'codex') {
      detectedBin = binPath ? findCliBin(binPath) : resolveCodexBin();
      models = discoverCodexModels(engine.configFilePath);
    } else if (kind === 'zcode') {
      const z = discoverZcodeEnvironment(binPath, engine.configFilePath);
      detectedBin = z.scriptExists ? z.scriptPath : null;
      providers = z.providers;
      models = z.flatModels;
    } else {
      detectedBin = findCliBin(binPath || id);
      models = discoverCustomModels(engine, resolvedConfigPath);
    }
    return [id, { id, available: Boolean(detectedBin && (kind !== 'zcode' || resolveNodeBin())), detectedBin,
      configExists: isFile(resolvedConfigPath), resolvedConfigPath, providers, models }];
  }));
  return { configPath: engineConfigPath(), config, discovery: { engines } };
}
