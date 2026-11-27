import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_ZCODE_SCRIPT, codexCatalogOverride, engineConfigFile, expandPath, loadEngineConfig, resolveCodexBin, resolveNodeBin } from './engine-config.mjs';
export { resolveCodexBin, resolveNodeBin } from './engine-config.mjs';

const execFileAsync = promisify(execFile);

const DEFAULT_DISPATCH_SCRIPT = path.join(
  os.homedir(),
  '.gemini',
  'config',
  'skills',
  'multi-agent-dispatch',
  'scripts',
  'dispatch.py'
);

function dispatchScript() {
  return expandPath(process.env.AGY_DISPATCH_SCRIPT || DEFAULT_DISPATCH_SCRIPT);
}

const ZCODE_BUILTIN_CFG =
  '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json';

export const DIAGNOSE_BLOCKER_PROMPT =
  '请基于当前完整上下文和 Goal 目标，用 3~5 条要点精炼说明：' +
  '1) 当前明确卡点或阻塞原因是什么；' +
  '2) 已完成和未完成的关键项分别是什么；' +
  '3) 需要用户或主控做出的下一步最小决策/动作是什么。' +
  '请严格保持只读，不要修改任何文件或执行写操作。';

function isExecutable(p) {
  if (!p) return false;
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function resolvePythonBin() {
  const candidates = [
    process.env.PYTHON_BIN,
    path.join(os.homedir(), '.local', 'bin', 'python3'),
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
  ];
  for (const c of candidates) {
    if (isExecutable(c)) return c;
  }
  return 'python3';
}

export function buildExecEnv(engine) {
  const extraPaths = [
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.npm-global', 'bin'),
    path.join(os.homedir(), '.volta', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const curPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const merged = [...new Set([...extraPaths, ...curPath])];
  const env = {
    ...process.env,
    PATH: merged.join(path.delimiter),
  };
  if (fs.existsSync(ZCODE_BUILTIN_CFG) && !env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) {
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = ZCODE_BUILTIN_CFG;
  }
  if (engine?.kind === 'zcode') env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = engineConfigFile(engine);
  if (engine?.kind === 'codex') {
    const catalog = codexCatalogOverride(engine.configFilePath);
    if (catalog) env.AGY_MODELS_CACHE_FILE = catalog;
  }
  return env;
}

function codexCatalogArgs(engine) {
  const file = codexCatalogOverride(engine.configFilePath);
  return file && fs.existsSync(file) ? ['-c', 'model_catalog_json=' + JSON.stringify(file)] : [];
}

function safeCwd(cwd) {
  if (cwd && fs.existsSync(cwd)) {
    try {
      if (fs.statSync(cwd).isDirectory()) return cwd;
    } catch {
      // fallback
    }
  }
  return os.homedir();
}

function extractZcodeReply(stdoutText) {
  const trimmed = (stdoutText || '').trim();
  if (!trimmed) return '';
  const lines = trimmed.split('\n');
  const texts = [];
  for (const rawLine of lines) {
    const ln = rawLine.trim();
    if (!ln) continue;
    try {
      const obj = JSON.parse(ln);
      for (const k of ['result', 'response', 'text', 'content', 'message', 'output']) {
        const val = obj?.[k];
        if (typeof val === 'string' && val.trim()) {
          texts.push(val.trim());
        } else if (val && typeof val.text === 'string' && val.text.trim()) {
          texts.push(val.text.trim());
        }
      }
    } catch {
      // ignore non-json line
    }
  }
  return texts.length ? texts[texts.length - 1] : trimmed;
}

export class CodexRunner {
  constructor(consoleDb) {
    this.consoleDb = consoleDb;
    this.pythonBin = resolvePythonBin();
  }

  get codexBin() {
    const codex = loadEngineConfig().engines.find(engine => engine.id === 'codex');
    return expandPath(codex?.binPath) || resolveCodexBin() || 'codex';
  }

  getRuntimeInfo() {
    const { engines } = loadEngineConfig();
    const codex = engines.find(e => e.id === 'codex');
    const zcode = engines.find(e => e.id === 'zcode');
    const zcodeScript = expandPath(zcode?.binPath || DEFAULT_ZCODE_SCRIPT);
    const nodeBin = resolveNodeBin();
    const script = dispatchScript();
    return {
      codexBin: expandPath(codex?.binPath) || resolveCodexBin(), codexConfigFile: engineConfigFile(codex),
      nodeBin, zcodeAvailable: Boolean(nodeBin && fs.existsSync(zcodeScript)), zcodeScript,
      zcodeConfigFile: engineConfigFile(zcode), dispatchAvailable: fs.existsSync(script), dispatchScript: script,
    };
  }

  sessionEngine(id, threadId) {
    const key = id || (String(threadId).startsWith('sess_') ? 'zcode' : 'codex');
    const engine = loadEngineConfig().engines.find(e => e.id === key);
    if (!engine?.enabled) {
      throw new Error(`引擎未启用或已移除: ${key}`);
    }
    return engine;
  }

  startCliResume({ engine, threadId, taskId, prompt, cwd, readonly, opType, dedupKey }) {
    const script = dispatchScript();
    const useDispatch = fs.existsSync(script) && (engine.kind !== 'zcode' || !readonly);
    if (engine.kind !== 'zcode' && !useDispatch) throw new Error(`未找到多端调度脚本: ${script}`);
    const dir = safeCwd(cwd);
    let bin, args;
    if (useDispatch) {
      bin = this.pythonBin;
      args = [script, 'resume', '--backend', engine.id,
        ...(taskId && (!readonly || threadId === taskId) ? ['--task-id', taskId] : ['--session-id', threadId, '--cwd', dir]),
        ...(readonly ? ['--sandbox', 'read-only', '--no-network'] : []), '--prompt', prompt];
    } else {
      bin = resolveNodeBin() || 'node';
      args = [expandPath(engine.binPath) || this.getRuntimeInfo().zcodeScript, '--resume', threadId, '-p', prompt,
        '--cwd', dir, '--mode', readonly ? 'plan' : 'build', '--json', '--no-color'];
    }
    const mode = readonly ? (useDispatch ? 'dispatch_readonly' : 'zcode_plan_readonly')
      : (useDispatch ? 'dispatch_resume' : 'zcode_resume');
    const op = this.consoleDb.createOp({ threadId, opType, prompt, mode, dedupKey, meta: { taskId, cwd: dir, engine: engine.id } });
    const child = spawn(bin, args, { cwd: dir, env: buildExecEnv(engine), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', spawnError = '';
    child.stdout.on('data', chunk => { if (stdout.length < 200_000) stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { if (stderr.length < 80_000) stderr += chunk.toString('utf8'); });
    const timer = readonly ? setTimeout(() => child.kill('SIGTERM'), 180_000) : null;
    child.on('error', err => { spawnError = err.message; });
    child.on('close', code => {
      clearTimeout(timer);
      let outputText = extractZcodeReply(stdout);
      try { outputText = JSON.parse(stdout)?.report?.summary || outputText; } catch { /* plain text */ }
      this.consoleDb.finishOp(op.id, {
        status: code === 0 ? 'succeeded' : 'failed', outputText,
        errorText: spawnError || stderr.trim() || (code !== 0 ? `${engine.name} 退出码 ${code}` : null),
        metaPatch: { exitCode: code },
      });
    });
    return op;
  }

  /**
   * Read-only question or blocker diagnosis through the session engine.
   * - Codex thread: `codex exec fork --ephemeral -c sandbox_mode="read-only"`
   * - Registered custom CLIs: dispatch resume --sandbox read-only.
   * - ZCode session: `node zcode.cjs --resume <id> -p <prompt> --mode plan --json`
   */
  startReadonlyAsk({ threadId, prompt, cwd, opType = 'readonly_ask', engine = null, taskId = null }) {
    if (!threadId || String(threadId).trim().startsWith('-')) {
      throw new Error('无效的会话 ID');
    }
    const actualPrompt = (prompt || '').trim() || DIAGNOSE_BLOCKER_PROMPT;
    const entry = this.sessionEngine(engine, threadId);
    if (entry.kind !== 'codex') {
      return this.startCliResume({ engine: entry, threadId, taskId, prompt: actualPrompt, cwd, readonly: true, opType });
    }
    const op = this.consoleDb.createOp({
      threadId, opType, prompt: actualPrompt, mode: 'fork_readonly', meta: { cwd: safeCwd(cwd), engine: entry.id },
    });

    const outFile = path.join(os.tmpdir(), `codex-console-${op.id}.txt`);
    const args = [
      'exec',
      'fork',
      ...codexCatalogArgs(entry),
      '--ephemeral',
      '--skip-git-repo-check',
      '-c',
      'sandbox_mode="read-only"',
      '-c',
      'approval_policy="never"',
      '-o',
      outFile,
      threadId,
      actualPrompt,
    ];

    const child = spawn(this.codexBin, args, {
      cwd: safeCwd(cwd),
      env: buildExecEnv(entry),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 200_000) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 80_000) stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }, 180_000);

    child.on('error', (err) => {
      clearTimeout(timer);
      this.consoleDb.finishOp(op.id, {
        status: 'failed',
        errorText: `启动 codex 失败: ${err.message}`,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      let finalMsg = '';
      if (fs.existsSync(outFile)) {
        try {
          finalMsg = fs.readFileSync(outFile, 'utf8').trim();
          fs.unlinkSync(outFile);
        } catch {
          // ignore
        }
      }
      const outputText = finalMsg || stdout.trim();
      if (code === 0 && outputText) {
        this.consoleDb.finishOp(op.id, {
          status: 'succeeded',
          outputText,
          errorText: stderr.trim() || null,
          metaPatch: { exitCode: code },
        });
      } else {
        this.consoleDb.finishOp(op.id, {
          status: code === 0 ? 'succeeded' : 'failed',
          outputText: outputText || '',
          errorText:
            stderr.trim() ||
            (code !== 0 ? `codex exec fork 退出码 ${code}` : '未返回正文内容'),
          metaPatch: { exitCode: code },
        });
      }
    });

    return op;
  }

  /**
   * Send a message to an existing engine session:
   * - ZCode (`sess_...`): routes via `dispatch.py resume --backend zcode` or `zcode.cjs --resume`
   * - Codex (`mode='queue'`): `codex queue --thread <id> --message <msg> --resume`
   * - Codex (`mode='resume'`): `codex exec resume <id> <msg>`
   * - `mode='dispatch_resume'`: `dispatch.py resume --task-id <taskId> --prompt <msg>`
   */
  async sendMessage({
    threadId,
    message,
    mode = 'queue',
    cwd = null,
    allowDuplicate = false,
    taskId = null,
    engine = null,
  }) {
    const cleanMsg = (message || '').trim();
    if (!cleanMsg) {
      throw new Error('消息内容不能为空');
    }
    const entry = this.sessionEngine(engine, threadId);

    if (mode === 'readonly') {
      return this.startReadonlyAsk({
        threadId,
        prompt: cleanMsg,
        cwd,
        opType: 'readonly_ask',
        engine: entry.id, taskId,
      });
    }

    const dedupKey = this.consoleDb.makeDedupKey(threadId, mode, cleanMsg);
    if (!allowDuplicate) {
      const dup = this.consoleDb.findRecentDuplicate(dedupKey, 60_000);
      if (dup) {
        throw new Error(
          `60秒内已投递过相同消息（操作 ${dup.id}，状态 ${dup.status}）。如需重发，请勾选「允许重复投递」。`
        );
      }
    }

    if (entry.kind !== 'codex' || (mode === 'dispatch_resume' && taskId && fs.existsSync(dispatchScript()))) {
      return this.startCliResume({ engine: entry, threadId, taskId, prompt: cleanMsg, cwd, readonly: false,
        opType: taskId ? 'dispatch_resume' : 'exec_resume', dedupKey });
    }

    if (mode === 'queue') {
      const op = this.consoleDb.createOp({
        threadId,
        opType: 'queue_send',
        prompt: cleanMsg,
        mode: 'queue',
        dedupKey,
        meta: { cwd: safeCwd(cwd) },
      });

      const args = ['queue', ...codexCatalogArgs(entry), '--thread', threadId, '--message', cleanMsg, '--resume'];
      const validCwd = safeCwd(cwd);
      if (cwd && validCwd === cwd) {
        args.push('-C', validCwd);
      }

      try {
        const { stdout, stderr } = await execFileAsync(this.codexBin, args, {
          cwd: validCwd,
          env: buildExecEnv(entry),
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        });
        return this.consoleDb.finishOp(op.id, {
          status: 'succeeded',
          outputText: (stdout || '').trim() || '消息已入队并触发唤醒（codex queue --resume）',
          errorText: (stderr || '').trim() || null,
          metaPatch: { exitCode: 0 },
        });
      } catch (err) {
        return this.consoleDb.finishOp(op.id, {
          status: 'failed',
          outputText: (err.stdout || '').trim(),
          errorText: (err.stderr || err.message || 'codex queue 执行失败').trim(),
          metaPatch: { exitCode: err.code ?? -1 },
        });
      }
    }

    // Default async exec resume
    const op = this.consoleDb.createOp({
      threadId,
      opType: 'exec_resume',
      prompt: cleanMsg,
      mode: 'resume',
      dedupKey,
      meta: { cwd: safeCwd(cwd) },
    });

    const outFile = path.join(os.tmpdir(), `codex-console-resume-${op.id}.txt`);
    const child = spawn(
      this.codexBin,
      ['exec', 'resume', ...codexCatalogArgs(entry), '--skip-git-repo-check', '-o', outFile, threadId, cleanMsg],
      {
        cwd: safeCwd(cwd),
        env: buildExecEnv(entry),
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      if (stdout.length < 200_000) stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      if (stderr.length < 80_000) stderr += c.toString('utf8');
    });
    child.on('error', (err) => {
      this.consoleDb.finishOp(op.id, {
        status: 'failed',
        errorText: `启动 codex exec resume 失败: ${err.message}`,
      });
    });
    child.on('close', (code) => {
      let finalMsg = '';
      if (fs.existsSync(outFile)) {
        try {
          finalMsg = fs.readFileSync(outFile, 'utf8').trim();
          fs.unlinkSync(outFile);
        } catch {
          // ignore
        }
      }
      this.consoleDb.finishOp(op.id, {
        status: code === 0 ? 'succeeded' : 'failed',
        outputText: finalMsg || stdout.trim(),
        errorText: stderr.trim() || (code !== 0 ? `codex exec resume 退出码 ${code}` : null),
        metaPatch: { exitCode: code },
      });
    });

    return op;
  }

  /**
   * Spawn a managed worker via dispatch.py run.
   */
  spawnWorker({
    cwd,
    prompt,
    backend = 'auto',
    model = '',
    taskId = '',
    difficulty = 'auto',
    quality = 'smart',
    isolation = loadEngineConfig().policy.defaultIsolation,
    network = false,
    changeKey = '',
    goalTitle = '',
  }) {
    const cleanCwd = (cwd || '').trim();
    const cleanPrompt = (prompt || '').trim();
    const cleanBackend = (backend || 'auto').trim() || 'auto';
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(cleanBackend) || cleanBackend === 'all') {
      throw new Error(`无效的 CLI 引擎 ID: ${cleanBackend}`);
    }
    const script = dispatchScript();
    if (!cleanCwd || !fs.existsSync(cleanCwd)) {
      throw new Error(`目标工作目录不存在: ${cleanCwd || '(空)'}`);
    }
    if (!cleanPrompt) {
      throw new Error('任务指令（Prompt）不能为空');
    }
    if (!fs.existsSync(script)) {
      throw new Error(`未找到多端调度脚本: ${script}`);
    }

    const useNetwork = Boolean(network);
    const op = this.consoleDb.createOp({
      threadId: null,
      opType: 'spawn_worker',
      prompt: cleanPrompt,
      mode: `${cleanBackend}/${quality}/${difficulty}/${isolation}${useNetwork ? '/net' : ''}`,
      meta: {
        cwd: cleanCwd,
        backend: cleanBackend,
        model: model || null,
        taskId: taskId || null,
        changeKey: changeKey || null,
        network: useNetwork,
      },
    });

    const args = [
      script,
      'run',
      '--cwd',
      cleanCwd,
      '--backend',
      cleanBackend,
      '--difficulty',
      difficulty,
      '--quality',
      quality,
      '--isolation',
      isolation,
      '--prompt',
      cleanPrompt,
    ];
    if (model && model.trim()) {
      args.push('--model', model.trim());
    }
    if (useNetwork) {
      args.push('--network');
    }
    if (taskId && taskId.trim()) {
      args.push('--task-id', taskId.trim());
    }

    const child = spawn(this.pythonBin, args, {
      cwd: cleanCwd,
      env: buildExecEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      if (stdout.length < 250_000) stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      if (stderr.length < 80_000) stderr += c.toString('utf8');
    });

    child.on('error', (err) => {
      this.consoleDb.finishOp(op.id, {
        status: 'failed',
        errorText: `启动 dispatch.py 失败: ${err.message}`,
      });
    });

    child.on('close', (code) => {
      let parsed = null;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        parsed = null;
      }
      const sessionId = parsed?.session_id || null;
      const actualBackend = parsed?.backend || cleanBackend;
      const finalTaskId = parsed?.task_id || taskId || null;

      if (changeKey && changeKey.trim()) {
        try {
          this.consoleDb.upsertBinding({
            changeKey: changeKey.trim(),
            goalTitle: (goalTitle || '').trim() || cleanPrompt.slice(0, 80),
            threadId: sessionId,
            taskId: finalTaskId,
            ownerRole: actualBackend,
            status: code === 0 ? 'completed' : 'blocked',
            repoPath: cleanCwd,
            branch: parsed?.branch || null,
            notes: parsed?.report?.summary || parsed?.summary || '',
          });
        } catch {
          // ignore binding failure
        }
      }

      this.consoleDb.finishOp(op.id, {
        status: code === 0 ? 'succeeded' : 'failed',
        outputText: parsed
          ? JSON.stringify(parsed, null, 2)
          : stdout.trim(),
        errorText: stderr.trim() || (code !== 0 ? `dispatch.py 退出码 ${code}` : null),
        metaPatch: {
          exitCode: code,
          backend: actualBackend,
          taskId: finalTaskId,
          sessionId,
          branch: parsed?.branch || null,
        },
      });
    });

    return op;
  }

  /**
   * Read-only Git status, diff stat, and BLACKBOARD preview for a directory
   */
  async inspectGit(cwd) {
    const dir = safeCwd(cwd);
    const result = {
      cwd: dir,
      isGit: false,
      branch: null,
      statusShort: '',
      diffStat: '',
      files: [],
      hasBlackboard: false,
      blackboardPath: null,
      blackboardPreview: '',
    };

    try {
      const { stdout: branchOut } = await execFileAsync(
        'git',
        ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'],
        { timeout: 4000 }
      );
      result.isGit = true;
      result.branch = branchOut.trim();

      const { stdout: stOut } = await execFileAsync(
        'git',
        ['-C', dir, 'status', '--short'],
        { timeout: 4000 }
      );
      result.statusShort = stOut.trim();
      result.files = result.statusShort
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 40)
        .map((line) => {
          const xy = line.slice(0, 2).trim() || 'M';
          const file = line.slice(2).trim().replace(/^"|"$/g, '');
          return {
            xy,
            file,
            absPath: path.resolve(dir, file),
          };
        });

      const { stdout: diffOut } = await execFileAsync(
        'git',
        ['-C', dir, 'diff', '--stat'],
        { timeout: 4000 }
      );
      result.diffStat = diffOut.trim();
    } catch (err) {
      result.error = err.message;
    }

    const bbCandidates = [
      path.join(dir, 'docs', 'BLACKBOARD.md'),
      path.join(dir, 'BLACKBOARD.md'),
    ];
    for (const p of bbCandidates) {
      if (fs.existsSync(p)) {
        result.hasBlackboard = true;
        result.blackboardPath = p;
        try {
          result.blackboardPreview = fs.readFileSync(p, 'utf8').slice(0, 1200);
        } catch {
          // ignore
        }
        break;
      }
    }

    return result;
  }
}
