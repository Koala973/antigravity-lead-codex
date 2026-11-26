import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DISPATCH_SCRIPT = path.join(
  os.homedir(),
  '.gemini',
  'config',
  'skills',
  'multi-agent-dispatch',
  'scripts',
  'dispatch.py'
);

const ZCODE_SCRIPT = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
const ZCODE_BUILTIN_CFG =
  '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json';
const ZCODE_PERSONAL_CFG = path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json');

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

export function resolveCodexBin() {
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidates = [
    process.env.CODEX_BIN,
    ...pathDirs.map((dir) => path.join(dir, 'codex')),
    path.join(os.homedir(), '.local', 'bin', 'codex'),
    path.join(os.homedir(), '.npm-global', 'bin', 'codex'),
    path.join(os.homedir(), '.volta', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  ];
  for (const c of candidates) {
    if (isExecutable(c)) return c;
  }
  return 'codex';
}

export function resolveNodeBin() {
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidates = [
    process.env.NODE_BIN,
    ...pathDirs.map((dir) => path.join(dir, 'node')),
    path.join(os.homedir(), '.local', 'bin', 'node'),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
  ];
  for (const c of candidates) {
    if (isExecutable(c)) return c;
  }
  return 'node';
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

export function buildExecEnv() {
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
  if (fs.existsSync(ZCODE_PERSONAL_CFG) && !env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) {
    env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = ZCODE_PERSONAL_CFG;
  }
  return env;
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
    this.codexBin = resolveCodexBin();
    this.nodeBin = resolveNodeBin();
    this.pythonBin = resolvePythonBin();
  }

  getRuntimeInfo() {
    return {
      codexBin: this.codexBin,
      nodeBin: this.nodeBin,
      zcodeAvailable: fs.existsSync(ZCODE_SCRIPT),
      zcodeScript: ZCODE_SCRIPT,
      dispatchAvailable: fs.existsSync(DISPATCH_SCRIPT),
      dispatchScript: DISPATCH_SCRIPT,
    };
  }

  /**
   * Non-destructive read-only question / blocker diagnosis:
   * - Codex thread: `codex exec fork --ephemeral -c sandbox_mode="read-only"`
   * - ZCode session (`sess_...`): `node zcode.cjs --resume <id> -p <prompt> --mode plan --json`
   */
  startReadonlyAsk({ threadId, prompt, cwd, opType = 'readonly_ask', engine = null }) {
    if (!threadId || String(threadId).trim().startsWith('-')) {
      throw new Error('无效的会话 ID');
    }
    const actualPrompt = (prompt || '').trim() || DIAGNOSE_BLOCKER_PROMPT;
    const isZcode = engine === 'zcode' || String(threadId || '').startsWith('sess_');
    const op = this.consoleDb.createOp({
      threadId,
      opType,
      prompt: actualPrompt,
      mode: isZcode ? 'zcode_plan_readonly' : 'fork_readonly',
      meta: { cwd: safeCwd(cwd), engine: isZcode ? 'zcode' : 'codex' },
    });

    if (isZcode) {
      const args = [
        ZCODE_SCRIPT,
        '--resume',
        threadId,
        '-p',
        actualPrompt,
        '--cwd',
        safeCwd(cwd),
        '--mode',
        'plan',
        '--json',
        '--no-color',
      ];
      const child = spawn(this.nodeBin, args, {
        cwd: safeCwd(cwd),
        env: buildExecEnv(),
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
        } catch {}
      }, 180_000);
      child.on('error', (err) => {
        clearTimeout(timer);
        this.consoleDb.finishOp(op.id, {
          status: 'failed',
          errorText: `启动 ZCode 只读诊断失败: ${err.message}`,
        });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const outputText = extractZcodeReply(stdout);
        this.consoleDb.finishOp(op.id, {
          status: code === 0 ? 'succeeded' : 'failed',
          outputText: outputText || '',
          errorText:
            stderr.trim() ||
            (code !== 0 ? `ZCode 只读提问退出码 ${code}` : outputText ? null : '未返回正文内容'),
          metaPatch: { exitCode: code },
        });
      });
      return op;
    }

    const outFile = path.join(os.tmpdir(), `codex-console-${op.id}.txt`);
    const args = [
      'exec',
      'fork',
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
      env: buildExecEnv(),
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
   * Send a message to an existing Codex or ZCode session:
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
    const isZcode = engine === 'zcode' || String(threadId || '').startsWith('sess_');

    if (mode === 'readonly') {
      return this.startReadonlyAsk({
        threadId,
        prompt: cleanMsg,
        cwd,
        opType: 'readonly_ask',
        engine: isZcode ? 'zcode' : 'codex',
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

    if (isZcode) {
      const op = this.consoleDb.createOp({
        threadId,
        opType: taskId ? 'dispatch_resume' : 'exec_resume',
        prompt: cleanMsg,
        mode: taskId ? 'dispatch_resume' : 'zcode_resume',
        dedupKey,
        meta: { taskId, cwd: safeCwd(cwd), engine: 'zcode' },
      });

      const args = fs.existsSync(DISPATCH_SCRIPT)
        ? [
            DISPATCH_SCRIPT,
            'resume',
            '--backend',
            'zcode',
            ...(taskId ? ['--task-id', taskId] : ['--session-id', threadId, '--cwd', safeCwd(cwd)]),
            '--prompt',
            cleanMsg,
          ]
        : [
            ZCODE_SCRIPT,
            '--resume',
            threadId,
            '-p',
            cleanMsg,
            '--cwd',
            safeCwd(cwd),
            '--mode',
            'build',
            '--json',
            '--no-color',
          ];
      const bin = fs.existsSync(DISPATCH_SCRIPT) ? this.pythonBin : this.nodeBin;
      const child = spawn(bin, args, {
        cwd: safeCwd(cwd),
        env: buildExecEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => {
        if (stdout.length < 200_000) stdout += c.toString('utf8');
      });
      child.stderr.on('data', (c) => {
        if (stderr.length < 80_000) stderr += c.toString('utf8');
      });
      child.on('close', (code) => {
        let outText = stdout.trim();
        try {
          const parsed = JSON.parse(outText);
          if (parsed?.report?.summary) outText = parsed.report.summary;
        } catch {
          outText = extractZcodeReply(outText);
        }
        this.consoleDb.finishOp(op.id, {
          status: code === 0 ? 'succeeded' : 'failed',
          outputText: outText,
          errorText: stderr.trim() || (code !== 0 ? `ZCode 续跑退出码 ${code}` : null),
          metaPatch: { exitCode: code },
        });
      });
      return op;
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

      const args = ['queue', '--thread', threadId, '--message', cleanMsg, '--resume'];
      const validCwd = safeCwd(cwd);
      if (cwd && validCwd === cwd) {
        args.push('-C', validCwd);
      }

      try {
        const { stdout, stderr } = await execFileAsync(this.codexBin, args, {
          cwd: validCwd,
          env: buildExecEnv(),
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

    if (mode === 'dispatch_resume' && taskId && fs.existsSync(DISPATCH_SCRIPT)) {
      const op = this.consoleDb.createOp({
        threadId,
        opType: 'dispatch_resume',
        prompt: cleanMsg,
        mode: 'dispatch_resume',
        dedupKey,
        meta: { taskId, cwd: safeCwd(cwd) },
      });

      const child = spawn(
        this.pythonBin,
        [DISPATCH_SCRIPT, 'resume', '--task-id', taskId, '--prompt', cleanMsg],
        {
          cwd: safeCwd(cwd),
          env: buildExecEnv(),
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
      child.on('close', (code) => {
        this.consoleDb.finishOp(op.id, {
          status: code === 0 ? 'succeeded' : 'failed',
          outputText: stdout.trim(),
          errorText: stderr.trim() || (code !== 0 ? `dispatch resume 退出码 ${code}` : null),
          metaPatch: { exitCode: code },
        });
      });
      return op;
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
      ['exec', 'resume', '--skip-git-repo-check', '-o', outFile, threadId, cleanMsg],
      {
        cwd: safeCwd(cwd),
        env: buildExecEnv(),
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
   * Spawn a new managed Codex or ZCode worker via dispatch.py run
   */
  spawnWorker({
    cwd,
    prompt,
    backend = 'codex',
    model = '',
    taskId = '',
    difficulty = 'auto',
    quality = 'smart',
    isolation = 'worktree',
    network = false,
    changeKey = '',
    goalTitle = '',
  }) {
    const cleanCwd = (cwd || '').trim();
    const cleanPrompt = (prompt || '').trim();
    const cleanBackend = backend === 'zcode' ? 'zcode' : 'codex';
    if (!cleanCwd || !fs.existsSync(cleanCwd)) {
      throw new Error(`目标工作目录不存在: ${cleanCwd || '(空)'}`);
    }
    if (!cleanPrompt) {
      throw new Error('任务指令（Prompt）不能为空');
    }
    if (!fs.existsSync(DISPATCH_SCRIPT)) {
      throw new Error(`未找到多端调度脚本: ${DISPATCH_SCRIPT}`);
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
      DISPATCH_SCRIPT,
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
      const finalTaskId = parsed?.task_id || taskId || null;

      if (changeKey && changeKey.trim()) {
        try {
          this.consoleDb.upsertBinding({
            changeKey: changeKey.trim(),
            goalTitle: (goalTitle || '').trim() || cleanPrompt.slice(0, 80),
            threadId: sessionId,
            taskId: finalTaskId,
            ownerRole: cleanBackend,
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
          backend: cleanBackend,
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
