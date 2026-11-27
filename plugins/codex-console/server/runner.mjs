import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveCodexBin } from './engine-config.mjs';
export { resolveCodexBin, resolveNodeBin } from './engine-config.mjs';

const execFileAsync = promisify(execFile);
const dispatchRelativePath = '../../../skills/multi-agent-dispatch/scripts/dispatch.py';

function dispatchScript() {
  if (process.env.AGY_DISPATCH_SCRIPT) {
    const configured = process.env.AGY_DISPATCH_SCRIPT;
    return path.resolve(configured.startsWith('~/') ? path.join(os.homedir(), configured.slice(2)) : configured);
  }
  const sibling = fileURLToPath(new URL(dispatchRelativePath, import.meta.url));
  if (fs.existsSync(sibling)) return sibling;
  return path.join(os.homedir(), '.gemini', 'config', 'skills', 'multi-agent-dispatch', 'scripts', 'dispatch.py');
}

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

export function buildExecEnv() {
  const extraPaths = [
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.npm-global', 'bin'),
    path.join(os.homedir(), '.volta', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  const curPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return { ...process.env, PATH: [...new Set([...curPath, ...extraPaths])].join(path.delimiter) };
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

function checkThreadId(threadId) {
  if (typeof threadId !== 'string' || !threadId.trim() || threadId.trimStart().startsWith('-')) {
    throw new Error('无效的 Codex 会话 ID');
  }
}

function cliOption(name, value) {
  return value.startsWith('-') ? [name + '=' + value] : [name, value];
}

// Keep the child running after the MCP request finishes. Record startup errors on
// close, when stdout and stderr are also complete, so each operation settles once.
function startProcess(bin, args, cwd, onClose, timeout = 0) {
  let child;
  try {
    child = spawn(bin, args, {
      cwd, env: buildExecEnv(), stdio: ['ignore', 'pipe', 'pipe'], timeout,
    });
  } catch (error) {
    onClose({ status: 'failed', errorText: error.message, metaPatch: { exitCode: null } });
    return;
  }
  let stdout = '', stderr = '', startupError = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', text => { if (stdout.length < 250_000) stdout += text; });
  child.stderr.on('data', text => { if (stderr.length < 80_000) stderr += text; });
  child.on('error', err => { startupError = err.message; });
  child.on('close', (code, signal) => {
    onClose({
      status: code === 0 ? 'succeeded' : 'failed',
      outputText: stdout.trim(),
      errorText: startupError || stderr.trim() || (signal ? '进程终止 ' + signal : code ? '退出码 ' + code : null),
      metaPatch: { exitCode: code },
    });
  });
}

export class CodexRunner {
  constructor(consoleDb) {
    this.consoleDb = consoleDb;
    this.pythonBin = resolvePythonBin();
  }

  get codexBin() {
    return resolveCodexBin();
  }

  getRuntimeInfo() {
    const script = dispatchScript();
    return {
      cwd: process.cwd(), codexBin: this.codexBin,
      dispatchAvailable: fs.existsSync(script), dispatchScript: script,
    };
  }

  startReadonlyAsk({ threadId, prompt, cwd, opType = 'readonly_ask' }) {
    const question = (prompt || '').trim() || DIAGNOSE_BLOCKER_PROMPT;
    return this.startCodexExec({ threadId, prompt: question, cwd, opType, mode: 'fork_readonly' });
  }

  startCodexExec({ threadId, prompt, cwd, opType, mode, dedupKey }) {
    checkThreadId(threadId);
    const dir = safeCwd(cwd);
    const op = this.consoleDb.createOp({ threadId, prompt, opType, mode, dedupKey, meta: { cwd: dir } });
    const output = path.join(os.tmpdir(), 'codex-console-' + op.id + '.txt');
    const readonly = mode === 'fork_readonly';
    const args = ['exec', ...(readonly
      ? ['fork', '--ephemeral', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"']
      : ['resume']), '--skip-git-repo-check', '-o', output, '--', threadId, prompt];
    startProcess(this.codexBin || 'codex', args, dir, result => {
      try {
        result.outputText = fs.readFileSync(output, 'utf8').trim() || result.outputText;
      } catch { /* stdout also works when the CLI did not write a final message. */ }
      try { fs.unlinkSync(output); } catch { /* No readable final-message file. */ }
      this.consoleDb.finishOp(op.id, result);
    }, readonly ? 180_000 : 0);
    return op;
  }

  async sendMessage({ threadId, message, mode = 'queue', cwd = null, allowDuplicate = false, taskId = null }) {
    checkThreadId(threadId);
    const prompt = (message || '').trim();
    if (!prompt) throw new Error('消息内容不能为空');
    if (mode === 'readonly') return this.startReadonlyAsk({ threadId, prompt, cwd });

    const dir = safeCwd(cwd);
    const dedupKey = this.consoleDb.makeDedupKey(threadId, mode, prompt);
    const duplicate = !allowDuplicate && this.consoleDb.findRecentDuplicate(dedupKey, 60_000);
    if (duplicate) {
      throw new Error('60秒内已投递过相同消息（操作 ' + duplicate.id + '）。如需重发，请勾选「重发」。');
    }

    if (mode === 'dispatch_resume') {
      const script = dispatchScript();
      if (!taskId) throw new Error('Dispatch 续跑需要已关联的调度任务 ID');
      if (!fs.existsSync(script)) throw new Error('未找到 Codex 调度脚本 ' + script);
      const op = this.consoleDb.createOp({ threadId, prompt, mode, opType: 'dispatch_resume', dedupKey, meta: { cwd: dir, taskId } });
      const args = [script, 'resume', '--task-id', taskId, ...cliOption('--prompt', prompt)];
      startProcess(this.pythonBin, args, dir, result => this.consoleDb.finishOp(op.id, result));
      return op;
    }
    if (mode === 'resume') {
      return this.startCodexExec({ threadId, prompt, cwd, opType: 'exec_resume', mode, dedupKey });
    }
    if (mode !== 'queue') throw new Error('未知的消息模式 ' + mode);

    const op = this.consoleDb.createOp({ threadId, prompt, mode, opType: 'queue_send', dedupKey, meta: { cwd: dir } });
    const args = ['queue', '--thread', threadId, ...cliOption('--message', prompt), '--resume'];
    if (cwd === dir) args.push('-C', dir);
    try {
      const { stdout, stderr } = await execFileAsync(this.codexBin || 'codex', args, {
        cwd: dir, env: buildExecEnv(), timeout: 30_000, maxBuffer: 1024 * 1024,
      });
      return this.consoleDb.finishOp(op.id, {
        status: 'succeeded', outputText: stdout.trim() || '消息已入队并触发唤醒',
        errorText: stderr.trim() || null, metaPatch: { exitCode: 0 },
      });
    } catch (err) {
      return this.consoleDb.finishOp(op.id, {
        status: 'failed', outputText: (err.stdout || '').trim(),
        errorText: (err.stderr || err.message).trim(), metaPatch: { exitCode: err.code ?? -1 },
      });
    }
  }

  spawnWorker({ cwd, prompt, model = '', taskId = '', difficulty = 'auto', quality = 'smart',
    isolation = 'worktree', network = false, changeKey = '', goalTitle = '' }) {
    const dir = (cwd || '').trim();
    const instruction = (prompt || '').trim();
    if (!dir || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('目标工作目录不存在 ' + (dir || '(空)'));
    }
    if (!instruction) throw new Error('任务指令不能为空');
    const script = dispatchScript();
    if (!fs.existsSync(script)) throw new Error('未找到 Codex 调度脚本 ' + script);
    const args = [
      script, 'run', '--cwd', path.resolve(dir), '--difficulty', difficulty, '--quality', quality,
      '--isolation', isolation, ...cliOption('--prompt', instruction),
    ];
    if (model.trim()) args.push('--model', model.trim());
    if (network) args.push('--network');
    if (taskId.trim()) args.push('--task-id', taskId.trim());

    const op = this.consoleDb.createOp({
      opType: 'spawn_worker', prompt: instruction,
      mode: [quality, difficulty, isolation, ...(network ? ['net'] : [])].join('/'),
      meta: { cwd: dir, model: model || null, taskId: taskId || null, changeKey: changeKey || null, network },
    });
    startProcess(this.pythonBin, args, dir, result => {
      let report;
      try { report = JSON.parse(result.outputText); } catch { /* Failed runs can return plain text. */ }
      const sessionId = report?.session_id || null;
      const actualTaskId = report?.task_id || taskId || null;
      result.metaPatch = { ...result.metaPatch, sessionId, taskId: actualTaskId, branch: report?.branch || null };
      if (changeKey.trim()) {
        try {
          this.consoleDb.upsertBinding({
            changeKey: changeKey.trim(), goalTitle: goalTitle.trim() || instruction.slice(0, 80),
            threadId: sessionId, taskId: actualTaskId, ownerRole: 'codex',
            status: result.status === 'succeeded' && (report?.report?.status || report?.status) === 'completed'
              ? 'completed' : 'blocked',
            repoPath: dir, branch: report?.branch || null, notes: report?.report?.summary || report?.summary || '',
          });
        } catch (error) {
          result.errorText = [result.errorText, '保存 Change 绑定失败 ' + error.message].filter(Boolean).join('\n');
        }
      }
      this.consoleDb.finishOp(op.id, result);
    });
    return op;
  }

  async inspectGit(cwd) {
    if (!cwd || !fs.existsSync(cwd)) {
      return { isGit: false, error: '工作目录不存在或已被清理', cwd };
    }
    const blackboardPath = [path.join(cwd, 'docs', 'BLACKBOARD.md'), path.join(cwd, 'BLACKBOARD.md')]
      .find(file => fs.statSync(file, { throwIfNoEntry: false })?.isFile()) || null;
    let blackboardPreview = '';
    if (blackboardPath) {
      try { blackboardPreview = fs.readFileSync(blackboardPath, 'utf8').slice(0, 1200); } catch { /* Optional preview. */ }
    }
    try {
      const [{ stdout: branch }, { stdout: status }, { stdout: diffStat }] = await Promise.all([
        execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 5000 }),
        execFileAsync('git', ['status', '--short'], { cwd, timeout: 5000 }),
        execFileAsync('git', ['diff', '--stat'], { cwd, timeout: 5000 }),
      ]);
      const files = status
        .split('\n')
        .map((l) => l.trimEnd())
        .filter(Boolean)
        .map((line) => ({
          xy: line.slice(0, 2).trim() || 'M',
          file: line.slice(3).trim(),
          absPath: path.join(cwd, line.slice(3).trim()),
        }));
      return {
        isGit: true,
        cwd,
        branch: branch.trim(),
        statusShort: status.trim(),
        diffStat: diffStat.trim(),
        files,
        hasBlackboard: Boolean(blackboardPath), blackboardPath, blackboardPreview,
      };
    } catch (err) {
      return {
        isGit: false,
        cwd,
        hasBlackboard: Boolean(blackboardPath), blackboardPath, blackboardPreview,
        error: (err.stderr || err.message || '非 Git 仓库').trim(),
      };
    }
  }
}
