import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCodexBin } from './runner.mjs';

const DISPATCH_STATE_DIR =
  process.env.AGY_DISPATCH_STATE_DIR ||
  path.join(os.homedir(), '.local', 'state', 'multi-agent-dispatch');

const ENGINE_CONFIG_PATH =
  process.env.AGY_ENGINE_CONFIG_FILE ||
  path.join(DISPATCH_STATE_DIR, 'engine_config.json');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const ZCODE_HOME = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode');
const DEFAULT_ZCODE_SCRIPT = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';

const KNOWN_PROVIDER_LABELS = {
  'qwen-alibaba-model-studio-cn': '阿里云百炼',
  'e2a41300-b652-45ec-9f78-ebd2ec7889be': '腾讯TokenHub',
};

function isExecutable(p) {
  if (!p) return false;
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findCliBin(name) {
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidates = [
    ...pathDirs.map((d) => path.join(d, name)),
    path.join(os.homedir(), '.local', 'bin', name),
    path.join(os.homedir(), '.npm-global', 'bin', name),
    '/opt/homebrew/bin/' + name,
    '/usr/local/bin/' + name,
  ];
  for (const c of candidates) {
    if (isExecutable(c)) return c;
  }
  return null;
}

export function discoverCodexModels() {
  const cacheCandidates = [
    path.join(CODEX_HOME, 'models_cache.json'),
    path.join(CODEX_HOME, 'models_cache.codex_work_desktop.json'),
  ];
  const models = [];
  const seen = new Set();
  for (const p of cacheCandidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const list = Array.isArray(raw?.models) ? raw.models : Array.isArray(raw) ? raw : [];
      for (const item of list) {
        const slug = String(item?.slug || item?.id || '').trim();
        if (!slug || seen.has(slug)) continue;
        if (item?.visibility && item.visibility !== 'list') continue;
        if (item?.supported_in_api === false) continue;
        seen.add(slug);
        models.push({
          slug,
          description: String(item?.description || ''),
          contextWindow: Number(item?.context_window || 0),
          priority: typeof item?.priority === 'number' ? item.priority : 999,
        });
      }
    } catch {
      // ignore malformed cache
    }
  }
  models.sort((a, b) => a.priority - b.priority || a.slug.localeCompare(b.slug));
  if (!models.length) {
    return [
      { slug: 'gpt-6.2-astra', description: 'Codex Flagship Model', contextWindow: 400000, priority: 1 },
      { slug: 'gpt-6.2-sol', description: 'Codex Fast & Wide Model', contextWindow: 400000, priority: 2 },
      { slug: 'gpt-5.4', description: 'Codex Frontier Model', contextWindow: 400000, priority: 3 },
      { slug: 'gpt-5.4-mini', description: 'Codex Fast Frontier Mini', contextWindow: 400000, priority: 4 },
    ];
  }
  return models;
}

export function discoverZcodeEnvironment(customScriptPath = '') {
  const scriptPath = customScriptPath || DEFAULT_ZCODE_SCRIPT;
  const scriptExists = fs.existsSync(scriptPath);
  const cliDbPath = path.join(ZCODE_HOME, 'cli', 'db', 'db.sqlite');
  const cliDbExists = fs.existsSync(cliDbPath);
  const personalCfgPath =
    process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ||
    path.join(ZCODE_HOME, 'v2', 'provider_config.json');

  const providers = [];
  const flatModels = [];
  const providerLabels = { ...KNOWN_PROVIDER_LABELS };

  if (fs.existsSync(personalCfgPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(personalCfgPath, 'utf8'));
      const rules = raw?.config?.providerConfigRules?.providerRules || [];
      for (const r of rules) {
        const pid = String(r?.providerId || '').trim();
        if (!pid) continue;
        const pname = String(r?.providerName || KNOWN_PROVIDER_LABELS[pid] || pid).trim();
        providerLabels[pid] = pname;
        const rcfg = r?.config || {};
        const rawModels = rcfg.modelOrder || rcfg.personalModelIds || [];
        const cleanModels = rawModels
          .map((m) => String(m || '').trim())
          .filter((m) => m && !m.includes('/'));
        providers.push({
          providerId: pid,
          providerName: pname,
          models: cleanModels,
        });
        for (const m of cleanModels) {
          flatModels.push({
            fullId: `${pid}/${m}`,
            providerId: pid,
            providerName: pname,
            modelId: m,
            displayLabel: `${pname} / ${m}`,
          });
        }
      }
    } catch {
      // ignore
    }
  }

  return {
    installed: scriptExists || cliDbExists,
    scriptExists,
    scriptPath,
    cliDbExists,
    providerConfigPath: personalCfgPath,
    providers,
    flatModels,
    providerLabels,
  };
}

function buildDefaultZcodeRoutes(zcodeEnv) {
  const flat = zcodeEnv?.flatModels || [];
  const hasModel = (fullId) => flat.some((m) => m.fullId === fullId);

  const pickOrFirst = (preferredList, fallbackIdx = 0) => {
    for (const cand of preferredList) {
      if (hasModel(cand)) return cand;
    }
    if (flat[fallbackIdx]) return flat[fallbackIdx].fullId;
    if (flat[0]) return flat[0].fullId;
    return preferredList[0];
  };

  return {
    code_and_audit: {
      label: '成块代码与算法 · 单测补齐 · 交叉静态审查',
      primary: pickOrFirst([
        'qwen-alibaba-model-studio-cn/kimi-k3',
        'qwen-alibaba-model-studio-cn/deepseek-v4-pro-0813',
      ], 0),
      fallback1: pickOrFirst([
        'qwen-alibaba-model-studio-cn/deepseek-v4-pro-0813',
        'e2a41300-b652-45ec-9f78-ebd2ec7889be/deepseek-v4-pro-0813',
      ], 1),
      fallback2: pickOrFirst([
        'e2a41300-b652-45ec-9f78-ebd2ec7889be/deepseek-v4-pro-0813',
        'e2a41300-b652-45ec-9f78-ebd2ec7889be/kimi-k3',
      ], 2),
      effort: 'max',
    },
    reasoning_and_business: {
      label: '中文复杂业务逻辑 · 安全测试分析 · 大方案双盲出稿',
      primary: pickOrFirst([
        'qwen-alibaba-model-studio-cn/kimi-k3',
        'e2a41300-b652-45ec-9f78-ebd2ec7889be/kimi-k3',
      ], 0),
      fallback1: pickOrFirst([
        'e2a41300-b652-45ec-9f78-ebd2ec7889be/kimi-k3',
        'qwen-alibaba-model-studio-cn/qwen3.8-max',
      ], 1),
      fallback2: pickOrFirst([
        'qwen-alibaba-model-studio-cn/qwen3.8-max',
        'qwen-alibaba-model-studio-cn/deepseek-v4-pro-0813',
      ], 2),
      effort: 'max',
    },
    wide_1m_context: {
      label: '100 万超长上下文全库大扫街 · 跨 10+ 文件摸底',
      primary: pickOrFirst([
        'e2a41300-b652-45ec-9f78-ebd2ec7889be/glm-5.3',
        'qwen-alibaba-model-studio-cn/kimi-k3',
      ], 0),
      fallback1: pickOrFirst([
        'qwen-alibaba-model-studio-cn/kimi-k3',
        'qwen-alibaba-model-studio-cn/deepseek-v4-pro-0813',
      ], 1),
      fallback2: pickOrFirst([
        'qwen-alibaba-model-studio-cn/deepseek-v4-pro-0813',
        'e2a41300-b652-45ec-9f78-ebd2ec7889be/kimi-k3',
      ], 2),
      effort: 'max',
    },
    fast_tool_and_plugin: {
      label: '飞书/办公插件 · 工具调用 · 快速轻量任务',
      primary: pickOrFirst([
        'qwen-alibaba-model-studio-cn/qwen3.8-max',
        'e2a41300-b652-45ec-9f78-ebd2ec7889be/deepseek-v4.1-flash',
      ], 0),
      fallback1: pickOrFirst([
        'e2a41300-b652-45ec-9f78-ebd2ec7889be/deepseek-v4.1-flash',
        'qwen-alibaba-model-studio-cn/kimi-k3',
      ], 1),
      fallback2: pickOrFirst([
        'qwen-alibaba-model-studio-cn/kimi-k3',
        'e2a41300-b652-45ec-9f78-ebd2ec7889be/kimi-k3',
      ], 2),
      effort: 'xhigh',
    },
  };
}

export function buildDefaultEngineConfig() {
  const zcodeEnv = discoverZcodeEnvironment();
  return {
    version: 1,
    updatedAtMs: Date.now(),
    codex: {
      required: true,
      enabled: true,
      binPath: '',
      flagshipModel: 'auto',
      fastModel: 'auto',
      defaultQuality: 'smart',
      defaultEffort: 'xhigh',
      defaultIsolation: 'worktree',
    },
    zcode: {
      required: false,
      enabled: Boolean(zcodeEnv.installed),
      scriptPath: DEFAULT_ZCODE_SCRIPT,
      syncDesktopIndex: true,
      defaultEffort: 'max',
      routes: buildDefaultZcodeRoutes(zcodeEnv),
    },
    customAgents: [
      {
        id: 'claude',
        name: 'Claude Code CLI',
        enabled: false,
        binPath: findCliBin('claude') || 'claude',
        defaultModel: 'claude-sonnet-4-6',
        effort: 'high',
        argsTemplate: '-p {prompt} --model {model}',
        description: '可选接入 Anthropic Claude Code 终端代理作为补充备选引擎',
      },
      {
        id: 'gemini',
        name: 'Gemini CLI',
        enabled: false,
        binPath: findCliBin('gemini') || 'gemini',
        defaultModel: 'gemini-2.5-pro',
        effort: 'high',
        argsTemplate: '-p {prompt} -m {model}',
        description: '可选接入 Google Gemini CLI 终端代理作为补充备选引擎',
      },
    ],
    policy: {
      costStrategy: 'effect_first', // effect_first | balanced
      reviewPolicy: 'heterogeneous', // heterogeneous | dual_engine | codex_only
      hideDisabledEngineTasks: false,
    },
  };
}

export function loadEngineConfig() {
  const defaults = buildDefaultEngineConfig();
  if (!fs.existsSync(ENGINE_CONFIG_PATH)) {
    return defaults;
  }
  try {
    const saved = JSON.parse(fs.readFileSync(ENGINE_CONFIG_PATH, 'utf8'));
    if (!saved || typeof saved !== 'object') return defaults;
    const mergedRoutes = { ...defaults.zcode.routes };
    if (saved.zcode?.routes && typeof saved.zcode.routes === 'object') {
      for (const k of Object.keys(mergedRoutes)) {
        if (saved.zcode.routes[k] && typeof saved.zcode.routes[k] === 'object') {
          mergedRoutes[k] = {
            ...mergedRoutes[k],
            ...saved.zcode.routes[k],
          };
        }
      }
    }
    return {
      version: 1,
      updatedAtMs: saved.updatedAtMs || defaults.updatedAtMs,
      codex: {
        ...defaults.codex,
        ...(saved.codex || {}),
        required: true,
        enabled: true, // Codex is always required and enabled
      },
      zcode: {
        ...defaults.zcode,
        ...(saved.zcode || {}),
        required: false,
        routes: mergedRoutes,
      },
      customAgents: Array.isArray(saved.customAgents) && saved.customAgents.length
        ? saved.customAgents
        : defaults.customAgents,
      policy: {
        ...defaults.policy,
        ...(saved.policy || {}),
      },
    };
  } catch {
    return defaults;
  }
}

export function saveEngineConfig(patch = {}) {
  const cur = loadEngineConfig();
  const next = {
    version: 1,
    updatedAtMs: Date.now(),
    codex: {
      ...cur.codex,
      ...(patch.codex || {}),
      required: true,
      enabled: true,
    },
    zcode: {
      ...cur.zcode,
      ...(patch.zcode || {}),
      required: false,
      routes: {
        ...cur.zcode.routes,
        ...(patch.zcode?.routes || {}),
      },
    },
    customAgents: Array.isArray(patch.customAgents) ? patch.customAgents : cur.customAgents,
    policy: {
      ...cur.policy,
      ...(patch.policy || {}),
    },
  };

  fs.mkdirSync(path.dirname(ENGINE_CONFIG_PATH), { recursive: true });
  const tmpPath = `${ENGINE_CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, ENGINE_CONFIG_PATH);
  return next;
}

export function resetEngineConfig() {
  const defaults = buildDefaultEngineConfig();
  fs.mkdirSync(path.dirname(ENGINE_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(ENGINE_CONFIG_PATH, JSON.stringify(defaults, null, 2) + '\n', 'utf8');
  return defaults;
}

export function getEngineDiscoverySnapshot() {
  const config = loadEngineConfig();
  const codexBin = config.codex.binPath || resolveCodexBin();
  const codexModels = discoverCodexModels();
  const zcodeEnv = discoverZcodeEnvironment(config.zcode.scriptPath);
  const customStatuses = (config.customAgents || []).map((ag) => ({
    ...ag,
    detectedBin: findCliBin(ag.binPath || ag.id),
    available: Boolean(findCliBin(ag.binPath || ag.id) || isExecutable(ag.binPath)),
  }));

  return {
    configPath: ENGINE_CONFIG_PATH,
    config,
    discovery: {
      codex: {
        available: Boolean(codexBin),
        binPath: codexBin,
        models: codexModels,
      },
      zcode: zcodeEnv,
      customAgents: customStatuses,
    },
  };
}
