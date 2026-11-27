import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function expandPath(value) {
  if (value === '~') return os.homedir();
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function isFile(file, executable = false) {
  try {
    if (executable) fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function findExecutable(name) {
  if (!name) return null;
  const bin = expandPath(name);
  if (bin.includes(path.sep)) return isFile(bin, true) ? path.resolve(bin) : null;
  const dirs = [
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean),
    '~/.local/bin', '~/.npm-global/bin', '~/.volta/bin', '/opt/homebrew/bin', '/usr/local/bin',
  ];
  return dirs.map(dir => path.resolve(expandPath(dir), bin)).find(file => isFile(file, true)) || null;
}

export function resolveCodexBin() {
  return findExecutable(process.env.CODEX_BIN) || findExecutable('codex')
    || findExecutable('/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex');
}

export function resolveNodeBin() {
  return findExecutable(process.env.NODE_BIN) || findExecutable('node') || findExecutable(process.execPath);
}

function loadCatalog(file) {
  const override = process.env.AGY_MODELS_CACHE_FILE || file;
  const home = expandPath(process.env.CODEX_HOME || '~/.codex');
  const paths = override ? [expandPath(override)] :
    ['models_cache.json', 'models_cache.codex_work_desktop.json'].map(name => path.join(home, name));

  for (const cachePath of paths) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch {
      continue;
    }
    const entries = raw?.models ?? raw;
    if (!Array.isArray(entries)) continue;
    const models = new Map();
    for (const entry of entries) {
      const id = entry?.slug || entry?.id;
      if (typeof id !== 'string' || !/^[A-Za-z0-9._/:@-]{1,160}$/.test(id) || models.has(id)
          || (entry.visibility != null && entry.visibility !== 'list') || entry.supported_in_api === false) continue;
      models.set(id, {
        id, label: id, description: typeof entry.description === 'string' ? entry.description : '',
        priority: Number.isInteger(entry.priority) ? entry.priority : 9999,
        contextWindow: Number.isInteger(entry.context_window) ? entry.context_window : 0,
      });
    }
    if (models.size) return { cachePath, models: [...models.values()].sort(compareModels) };
  }
  return { cachePath: paths.find(file => isFile(file)) || paths[0], models: [] };
}

function modelGeneration(id) {
  const match = id.match(/(\d+)(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2] || 0)] : [-1, -1];
}

function compareGeneration(left, right) {
  const [a, b] = modelGeneration(left.id);
  const [c, d] = modelGeneration(right.id);
  return c - a || d - b;
}

function compareModels(a, b) {
  return compareGeneration(a, b) || a.priority - b.priority || a.id.localeCompare(b.id);
}

export function discoverCodexModels(file) {
  return loadCatalog(file).models;
}

function flagshipRank(model) {
  if (/(?:^|-)(astra|pro|max)(?:-|$)/i.test(model.id)) return 0;
  return /most capable|complex/i.test(model.description) ? 1 : 2;
}

function fastRank(model) {
  return /go-to|fast|sol|mini|flash/i.test(model.id + ' ' + model.description) ? 0 : 1;
}

export function getCodexEnvironmentSnapshot() {
  const { cachePath, models } = loadCatalog();
  const binPath = resolveCodexBin();
  const newest = models.filter(model => compareGeneration(model, models[0]) === 0);
  const candidates = newest.length && modelGeneration(newest[0].id)[0] < 0 ? newest.slice(0, 3) : newest;
  const flagship = [...candidates].sort((a, b) =>
    flagshipRank(a) - flagshipRank(b) || a.priority - b.priority || b.contextWindow - a.contextWindow)[0];
  const wideFast = candidates.filter(model => model !== flagship).sort((a, b) =>
    b.contextWindow - a.contextWindow || fastRank(a) - fastRank(b) || a.priority - b.priority)[0];
  return {
    available: Boolean(binPath), binPath, cacheExists: isFile(cachePath), cachePath,
    flagshipModel: flagship?.id || 'gpt-6.2-astra',
    wideFastModel: wideFast?.id || flagship?.id || 'gpt-6.2-sol',
    models,
  };
}
