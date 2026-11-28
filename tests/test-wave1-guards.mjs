import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkVersions } from '../scripts/check-version.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function resolveBash() {
  if (process.platform === 'win32') {
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    if (fs.existsSync(gitBash)) return gitBash;
  }
  return 'bash';
}

function testWorkflowsAndCommunityFiles() {
  assert.ok(!fs.existsSync(path.join(ROOT, 'docs', 'workflows', 'ci.yml')), 'stale docs/workflows/ci.yml must be removed');
  assert.ok(!fs.existsSync(path.join(ROOT, 'docs', 'workflows', 'release.yml')), 'stale docs/workflows/release.yml must be removed');

  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(ci, /concurrency:/);
  assert.match(ci, /cancel-in-progress:\s*true/);
  assert.match(ci, /timeout-minutes:/);
  assert.match(ci, /ubuntu-latest/);
  assert.match(ci, /macos-latest/);
  assert.match(ci, /git diff --exit-code -- plugins\/codex-console\/dist\//);
  assert.match(ci, /scripts\/check-version\.mjs/);
  assert.match(ci, /scripts\/verify-mcp-handshake\.mjs/);

  const release = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(release, /permissions:\s*\n\s*contents:\s*write/);
  assert.match(release, /timeout-minutes:/);
  assert.match(release, /scripts\/check-version\.mjs --tag/);
  assert.ok(
    release.indexOf('Run Full Test Suite Before Packaging') < release.indexOf('Package Prebuilt UI Release Tarball'),
    'release workflow must run tests before packaging'
  );
  assert.ok(
    release.indexOf('Package Prebuilt UI Release Tarball') < release.indexOf('Verify Unpacked Tarball'),
    'release workflow must verify unpacked tarball after packaging'
  );
  assert.ok(
    release.indexOf('Verify Unpacked Tarball') < release.indexOf('Generate SHA256SUMS.txt'),
    'release workflow must verify unpacked tarball before generating checksums'
  );
  assert.ok(
    release.indexOf('Generate SHA256SUMS.txt') < release.indexOf('Publish GitHub Release'),
    'release workflow must generate checksums before publishing'
  );

  for (const rel of [
    '.github/ISSUE_TEMPLATE/bug_report.yml',
    '.github/ISSUE_TEMPLATE/feature_request.yml',
    '.github/PULL_REQUEST_TEMPLATE.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
  ]) {
    const full = path.join(ROOT, rel);
    assert.ok(fs.existsSync(full), `missing community file: ${rel}`);
    assert.ok(fs.readFileSync(full, 'utf8').trim().length > 100, `community file unexpectedly short: ${rel}`);
  }
}

function testVersionConsistencyChecker() {
  const baseline = checkVersions({ root: ROOT });
  assert.equal(baseline.ok, true, `checkVersions failed: ${baseline.errors.join('; ')}`);
  assert.equal(baseline.version, '2.0.0');

  const tagOk = checkVersions({ root: ROOT, tag: 'v2.0.0' });
  assert.equal(tagOk.ok, true, `tag match failed: ${tagOk.errors.join('; ')}`);

  const tagBad = checkVersions({ root: ROOT, tag: 'v1.9.9' });
  assert.equal(tagBad.ok, false);
  assert.ok(tagBad.errors.some(e => e.includes('Release tag')));

  // Copy minimal files into a temp repo and verify single-file drift is caught
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alc-ver-test-'));
  try {
    const files = [
      'plugins/codex-console/package.json',
      'plugins/codex-console/package-lock.json',
      'plugins/codex-console/plugin.json',
      'plugins/codex-console/server/index.mjs',
      'plugins/codex-console/server/quota.mjs',
      'plugins/codex-console/ui/main.js',
      'plugins/codex-console/dist/app.html',
      'plugins/codex-auto-router/plugin.json',
      'README.md',
      'README_EN.md',
      'CHANGELOG.md',
    ];
    for (const rel of files) {
      const dest = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), dest);
    }
    assert.equal(checkVersions({ root: tmp }).ok, true);

    // Mutate one manifest version -> must fail
    const routerJson = path.join(tmp, 'plugins/codex-auto-router/plugin.json');
    const originalRouter = fs.readFileSync(routerJson, 'utf8');
    fs.writeFileSync(routerJson, originalRouter.replace('"2.0.0"', '"1.0.2"'));
    const mutated = checkVersions({ root: tmp });
    assert.equal(mutated.ok, false);
    assert.ok(mutated.errors.some(e => e.includes('codex-auto-router/plugin.json')));
    fs.writeFileSync(routerJson, originalRouter);

    // Mutate dist/app.html built App version -> must fail
    const distHtml = path.join(tmp, 'plugins/codex-console/dist/app.html');
    const originalDist = fs.readFileSync(distHtml, 'utf8');
    fs.writeFileSync(distHtml, originalDist.replaceAll('2.0.0', '1.3.1'));
    const staleDist = checkVersions({ root: tmp });
    assert.equal(staleDist.ok, false);
    assert.ok(staleDist.errors.some(e => e.includes('dist/app.html')));
    fs.writeFileSync(distHtml, originalDist);

    // Mutate server/index.mjs with unlinked variable -> must fail
    const serverIdx = path.join(tmp, 'plugins/codex-console/server/index.mjs');
    const originalIdx = fs.readFileSync(serverIdx, 'utf8');
    fs.writeFileSync(serverIdx, originalIdx.replace('version: PLUGIN_VERSION,', "version: '1.3.1',"));
    const staleIdx = checkVersions({ root: tmp });
    assert.equal(staleIdx.ok, false);
    assert.ok(staleIdx.errors.some(e => e.includes('server/index.mjs')));
    fs.writeFileSync(serverIdx, originalIdx);

    // Mutate CHANGELOG.md latest heading -> must fail
    const changelog = path.join(tmp, 'CHANGELOG.md');
    const originalChangelog = fs.readFileSync(changelog, 'utf8');
    fs.writeFileSync(changelog, originalChangelog.replace('## [2.0.0]', '## [1.9.0]'));
    const staleChangelog = checkVersions({ root: tmp });
    assert.equal(staleChangelog.ok, false);
    assert.ok(staleChangelog.errors.some(e => e.includes('CHANGELOG.md')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function testPrivacyAndSecretScanner() {
  const bash = resolveBash();
  const scriptSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'privacy-check.sh'), 'utf8');
  assert.doesNotMatch(scriptSrc, /\/tmp\/alc_privacy_hit\.txt/, 'privacy-check.sh must not use fixed /tmp path');
  assert.match(scriptSrc, /mktemp/);
  assert.match(scriptSrc, /trap\s+cleanup\s+EXIT/);

  const clean = spawnSync(bash, ['scripts/privacy-check.sh'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(clean.status, 0, `privacy-check.sh failed on repo:\n${clean.stdout}\n${clean.stderr}`);

  // Test injected synthetic secrets (constructed dynamically so this test file stays clean)
  const cases = [
    ['openai', 'KEY=' + 'sk-' + 'proj-' + 'AbCdEf0123456789GhIjKlMnOpQrStUv'],
    ['anthropic', 'KEY=' + 'sk-' + 'ant-' + 'api03-AbCdEf0123456789GhIjKlMnOp'],
    ['github', 'TOKEN=' + 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'],
    ['github_pat', 'TOKEN=' + 'github_' + 'pat_' + '11ABCDEF0123456789abcdef_0123456789'],
    ['google', 'API=' + 'AIza' + 'SyD1234567890abcdefghijklmnopqrstuvwx'],
    ['aws', 'AWS=' + 'AKIA' + 'IOSFODNN7EXAMPLE'],
    ['slack', 'SLACK=' + 'xox' + 'b-123456789012-123456789012-AbCdEfGhIj'],
    ['pem', '-----BEGIN ' + 'OPENSSH ' + 'PRIVATE KEY-----\nfake'],
  ];

  for (const [name, sample] of cases) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `alc-sec-${name}-`));
    try {
      fs.writeFileSync(path.join(tmp, 'sample.txt'), sample + '\n');
      const res = spawnSync(bash, ['scripts/privacy-check.sh', tmp], { cwd: ROOT, encoding: 'utf8' });
      assert.notEqual(res.status, 0, `privacy-check.sh failed to catch ${name} secret`);
      assert.doesNotMatch(res.stdout, new RegExp(sample.slice(5, 20)), `privacy-check.sh leaked secret text for ${name}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

testWorkflowsAndCommunityFiles();
testVersionConsistencyChecker();
testPrivacyAndSecretScanner();
console.log('[PASS] Wave 1 workflow, community files, single-version, and privacy/secret guards passed.');
