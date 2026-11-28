#!/usr/bin/env node
/**
 * Real MCP stdio handshake verifier:
 * Spawns codex-console via run-server.sh (or node server/index.mjs) and verifies:
 *   1. initialize (tools + resources capabilities, serverInfo.name & optional version)
 *   2. notifications/initialized
 *   3. tools/list (open_codex_console + ui://codex-console/app.html metadata)
 *   4. resources/read (text/html;profile=mcp-app HTML payload)
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

function parseArgs(argv) {
  let launcher = null;
  let dataDir = null;
  let expectedVersion = null;
  let timeoutMs = 10_000;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--data-dir' && argv[i + 1]) {
      dataDir = argv[++i];
    } else if (arg.startsWith('--data-dir=')) {
      dataDir = arg.slice('--data-dir='.length);
    } else if (arg === '--expected-version' && argv[i + 1]) {
      expectedVersion = argv[++i];
    } else if (arg.startsWith('--expected-version=')) {
      expectedVersion = arg.slice('--expected-version='.length);
    } else if (arg === '--timeout-ms' && argv[i + 1]) {
      timeoutMs = Number(argv[++i]);
    } else if (arg === '-h' || arg === '--help') {
      console.log(
        'Usage: node scripts/verify-mcp-handshake.mjs <run-server.sh|server/index.mjs> [--data-dir <dir>] [--expected-version <X.Y.Z>]'
      );
      process.exit(0);
    } else if (!launcher) {
      launcher = arg;
    } else if (!dataDir) {
      dataDir = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!launcher) {
    throw new Error('Missing launcher path (run-server.sh or server/index.mjs).');
  }
  return { launcher, dataDir, expectedVersion, timeoutMs };
}

export async function verifyMcpHandshake({
  launcher,
  dataDir = null,
  expectedVersion = null,
  timeoutMs = 10_000,
  env = process.env,
}) {
  const ownsDataDir = !dataDir;
  const effectiveDataDir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'alc-handshake-'));
  const useNodeDirectly = launcher.endsWith('.mjs') || launcher.endsWith('.js');
  const cmd = useNodeDirectly ? process.execPath : 'bash';
  const args = useNodeDirectly
    ? ['--no-warnings', launcher, '--data-dir', effectiveDataDir]
    : [launcher, '--data-dir', effectiveDataDir];

  const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  const pending = new Map();
  let nextId = 1;
  let buf = '';
  let stderr = '';

  child.stderr.setEncoding('utf8').on('data', chunk => {
    stderr += chunk;
  });
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(msg.id);
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
    }
  });
  child.on('close', code => {
    for (const { timer, reject } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(`MCP server exited unexpectedly (code=${code}). stderr: ${stderr}`));
    }
    pending.clear();
  });

  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout waiting for ${method} (${timeoutMs}ms). stderr: ${stderr}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  try {
    const init = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'verify-mcp-handshake', version: expectedVersion || '2.0.0' },
    });
    assert.ok(init?.capabilities?.tools, 'initialize missing tools capability');
    assert.ok(init?.capabilities?.resources, 'initialize missing resources capability');
    assert.equal(init?.serverInfo?.name, 'codex-console', 'unexpected serverInfo.name');
    if (expectedVersion) {
      assert.equal(init?.serverInfo?.version, expectedVersion, 'serverInfo.version mismatch');
    }

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const listed = await rpc('tools/list');
    assert.ok(Array.isArray(listed?.tools) && listed.tools.length > 0, 'tools/list returned no tools');
    const openTool = listed.tools.find(t => t.name === 'open_codex_console');
    assert.ok(openTool, 'tools/list missing open_codex_console');
    const resourceUri = openTool?._meta?.ui?.resourceUri;
    assert.equal(resourceUri, 'ui://codex-console/app.html', 'unexpected open_codex_console resourceUri');

    const res = await rpc('resources/read', { uri: resourceUri });
    const content = res?.contents?.[0];
    assert.equal(content?.mimeType, 'text/html;profile=mcp-app', 'unexpected resource mimeType');
    assert.ok(typeof content?.text === 'string' && content.text.length > 10_000, 'UI HTML bundle unexpectedly small');
    assert.match(content.text, /<!doctype html>/i, 'UI resource is not a valid HTML document');

    return {
      serverInfo: init.serverInfo,
      toolCount: listed.tools.length,
      htmlBytes: content.text.length,
    };
  } finally {
    try {
      child.stdin.end();
      child.kill();
    } catch {
      // ignore cleanup failure
    }
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 2000))]);
    if (ownsDataDir) {
      fs.rmSync(effectiveDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  verifyMcpHandshake(parseArgs(process.argv.slice(2)))
    .then(summary => {
      console.log(
        `[PASS] MCP stdio handshake OK: ${summary.serverInfo.name}@${summary.serverInfo.version} ` +
          `(${summary.toolCount} tools, ${summary.htmlBytes}B UI bundle).`
      );
    })
    .catch(err => {
      console.error(`[FAIL] MCP stdio handshake failed: ${err.message}`);
      process.exit(1);
    });
}
