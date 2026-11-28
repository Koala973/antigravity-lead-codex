#!/usr/bin/env node
/**
 * Verify that all version declarations across the repository match the single
 * canonical version in plugins/codex-console/package.json (and an optional
 * --tag vX.Y.Z argument).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT = path.resolve(__dirname, '..');

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function parseArgs(argv) {
  let root = DEFAULT_ROOT;
  let tag = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root' && argv[i + 1]) {
      root = path.resolve(argv[++i]);
    } else if (arg.startsWith('--root=')) {
      root = path.resolve(arg.slice('--root='.length));
    } else if (arg === '--tag' && argv[i + 1]) {
      tag = argv[++i];
    } else if (arg.startsWith('--tag=')) {
      tag = arg.slice('--tag='.length);
    } else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/check-version.mjs [--root <repoDir>] [--tag <vX.Y.Z>]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { root, tag };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function checkVersions({ root = DEFAULT_ROOT, tag = null } = {}) {
  const errors = [];
  const p = rel => path.join(root, rel);

  const pkgPath = p('plugins/codex-console/package.json');
  const pkg = readJson(pkgPath);
  const expected = pkg.version;

  if (typeof expected !== 'string' || !SEMVER_RE.test(expected)) {
    errors.push(`plugins/codex-console/package.json: invalid semver version "${expected}"`);
    return { ok: false, version: expected, errors };
  }

  if (tag !== null) {
    const normalizedTag = tag.startsWith('v') ? tag.slice(1) : tag;
    if (normalizedTag !== expected) {
      errors.push(`Release tag "${tag}" does not match canonical version "${expected}"`);
    }
  }

  const checkEqual = (label, actual) => {
    if (actual !== expected) {
      errors.push(`${label}: expected "${expected}", found "${actual}"`);
    }
  };

  // 1. Manifest JSON files
  const lock = readJson(p('plugins/codex-console/package-lock.json'));
  checkEqual('plugins/codex-console/package-lock.json (version)', lock.version);
  checkEqual('plugins/codex-console/package-lock.json (packages[""].version)', lock.packages?.['']?.version);

  const consolePlugin = readJson(p('plugins/codex-console/plugin.json'));
  checkEqual('plugins/codex-console/plugin.json', consolePlugin.version);

  const routerPlugin = readJson(p('plugins/codex-auto-router/plugin.json'));
  checkEqual('plugins/codex-auto-router/plugin.json', routerPlugin.version);

  // 2. Runtime JS entrypoints (must read package.json version directly or declare exact matching literal)
  const serverIndex = fs.readFileSync(p('plugins/codex-console/server/index.mjs'), 'utf8');
  const serverVersionMatch = serverIndex.match(/new\s+McpServer\s*\(\s*\{[\s\S]*?version\s*:\s*([^,\n}]+)/);
  if (!serverVersionMatch) {
    errors.push('plugins/codex-console/server/index.mjs: could not locate McpServer version');
  } else {
    const expr = serverVersionMatch[1].trim();
    if (/^['"]/.test(expr)) {
      checkEqual('plugins/codex-console/server/index.mjs (McpServer version)', expr.replace(/^['"]|['"]$/g, ''));
    } else {
      const varRe = new RegExp(`const\\s+${escapeRegExp(expr)}\\s*=\\s*JSON\\.parse\\([\\s\\S]*?package\\.json[\\s\\S]*?\\)\\.version`);
      if (!varRe.test(serverIndex)) {
        errors.push(`plugins/codex-console/server/index.mjs: McpServer version "${expr}" is neither "${expected}" nor derived from package.json`);
      }
    }
  }

  const quotaSrc = fs.readFileSync(p('plugins/codex-console/server/quota.mjs'), 'utf8');
  const quotaVersionMatch = quotaSrc.match(/clientInfo\s*:\s*\{\s*name\s*:\s*['"]codex-console['"]\s*,\s*version\s*:\s*([^,\n}]+)/);
  if (!quotaVersionMatch) {
    errors.push('plugins/codex-console/server/quota.mjs: could not locate clientInfo version');
  } else {
    const expr = quotaVersionMatch[1].trim();
    if (/^['"]/.test(expr)) {
      checkEqual('plugins/codex-console/server/quota.mjs (clientInfo.version)', expr.replace(/^['"]|['"]$/g, ''));
    } else {
      const readsDefaultPkg = /const\s+DEFAULT_CLIENT_VERSION\s*=\s*JSON\.parse\([\s\S]*?package\.json[\s\S]*?\)\.version/.test(quotaSrc);
      const usesDefaultParam = new RegExp(`${escapeRegExp(expr)}\\s*=\\s*DEFAULT_CLIENT_VERSION`).test(quotaSrc);
      if (!readsDefaultPkg || !usesDefaultParam) {
        errors.push(`plugins/codex-console/server/quota.mjs: clientInfo version "${expr}" is neither "${expected}" nor defaulted from package.json`);
      }
    }
  }

  const uiMain = fs.readFileSync(p('plugins/codex-console/ui/main.js'), 'utf8');
  const uiVersionMatch = uiMain.match(/new\s+App\s*\(\s*\{[\s\S]*?version\s*:\s*([^,\n}]+)/);
  if (!uiVersionMatch) {
    errors.push('plugins/codex-console/ui/main.js: could not locate App version');
  } else {
    const expr = uiVersionMatch[1].trim();
    if (/^['"]/.test(expr)) {
      checkEqual('plugins/codex-console/ui/main.js (App version)', expr.replace(/^['"]|['"]$/g, ''));
    } else {
      const importRe = new RegExp(`import\\s*\\{[^}]*\\bversion\\s+as\\s+${escapeRegExp(expr)}\\b[^}]*\\}\\s*from\\s*['"]\\.\\.\\/package\\.json['"]`);
      if (!importRe.test(uiMain)) {
        errors.push(`plugins/codex-console/ui/main.js: App version "${expr}" is neither "${expected}" nor imported from ../package.json`);
      }
    }
  }

  // 3. Built UI bundle must reflect the same version
  const distHtmlPath = p('plugins/codex-console/dist/app.html');
  if (!fs.existsSync(distHtmlPath)) {
    errors.push('plugins/codex-console/dist/app.html: missing built UI bundle (run npm run build:ui)');
  } else {
    const distHtml = fs.readFileSync(distHtmlPath, 'utf8');
    const escapedVer = escapeRegExp(expected);
    const directRe = new RegExp(`name\\s*:\\s*["']Antigravity Lead Codex["']\\s*,\\s*version\\s*:\\s*["']${escapedVer}["']`);
    const identMatch = distHtml.match(/name\s*:\s*["']Antigravity Lead Codex["']\s*,\s*version\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)/);
    let distVersionOk = directRe.test(distHtml);
    if (!distVersionOk && identMatch) {
      const ident = escapeRegExp(identMatch[1]);
      const bindingRe = new RegExp(`(?:const|let|var|,)\\s*${ident}\\s*=\\s*["']${escapedVer}["']`);
      distVersionOk = bindingRe.test(distHtml);
    }
    if (!distVersionOk) {
      errors.push(`plugins/codex-console/dist/app.html: built App version does not match "${expected}" (run npm run build:ui)`);
    }
  }

  // 4. README badges & release archive examples
  for (const readmeName of ['README.md', 'README_EN.md']) {
    const readmePath = p(readmeName);
    if (!fs.existsSync(readmePath)) continue;
    const text = fs.readFileSync(readmePath, 'utf8');
    const badgeMatch = text.match(/badge\/release-v([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)-/);
    if (!badgeMatch) {
      errors.push(`${readmeName}: missing release version badge (badge/release-v${expected}-...)`);
    } else {
      checkEqual(`${readmeName} (release badge)`, badgeMatch[1]);
    }
    const altMatch = text.match(/alt="Release v([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)"/);
    if (altMatch) {
      checkEqual(`${readmeName} (release badge alt)`, altMatch[1]);
    }
    const tarballMatches = [...text.matchAll(/antigravity-lead-codex-v([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/g)];
    for (const m of tarballMatches) {
      checkEqual(`${readmeName} (release archive example)`, m[1]);
    }
    const refMatches = [...text.matchAll(/--ref\s+v([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/g)];
    for (const m of refMatches) {
      checkEqual(`${readmeName} (--ref example)`, m[1]);
    }
  }

  // 5. CHANGELOG.md latest heading
  const changelog = fs.readFileSync(p('CHANGELOG.md'), 'utf8');
  const latestHeading = changelog.match(/^## \[([^\]]+)\]/m);
  if (!latestHeading) {
    errors.push('CHANGELOG.md: missing "## [X.Y.Z]" version heading');
  } else {
    checkEqual('CHANGELOG.md (latest heading)', latestHeading[1]);
  }

  return { ok: errors.length === 0, version: expected, errors };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const result = checkVersions(opts);
    if (!result.ok) {
      console.error('[FAIL] Version consistency check failed:');
      for (const err of result.errors) {
        console.error(`  - ${err}`);
      }
      process.exit(1);
    }
    console.log(`[PASS] All repository versions consistently match ${result.version}.`);
  } catch (err) {
    console.error(`[FAIL] ${err.message}`);
    process.exit(1);
  }
}
