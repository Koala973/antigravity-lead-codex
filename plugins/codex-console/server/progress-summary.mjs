// All inputs come from one thread. Rollout order, rather than wall-clock time,
// also works for older items that have no timestamp.
const STATUS = new Map([
  ['running', ['执行中', 'info']], ['goal_active', ['执行中', 'info']],
  ['blocked', ['已阻塞', 'warning']], ['limited', ['额度受限', 'danger']],
  ['failed', ['执行异常', 'danger']], ['paused', ['已暂停', 'muted']],
  ['exec_done', ['已完成', 'success']], ['complete', ['已完成', 'success']],
  ['completed', ['已完成', 'success']], ['archived', ['已归档', 'muted']],
]);
const TRACES = new Set(['reasoning', 'commandExecution', 'mcpToolCall', 'webSearch', 'fileChange']);
const CJK = /[\u4e00-\u9fff]/u;

export function unwrapStructuredReply(rawText) {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const { summary } = JSON.parse(text);
      if (typeof summary === 'string' && summary.trim()) return summary.trim();
    } catch { /* Plain text can also contain braces. */ }
  }
  return text;
}

function withoutCodeBlocks(text) {
  return text.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\s*\1\s*$|(?![\s\S]))/gm, '');
}

function plainText(text) {
  return withoutCodeBlocks(unwrapStructuredReply(text))
    .replace(/\[([^\]\n]+)\]\([^\n)]*\)/g, '$1')
    .replace(/\*\*|`+/g, '')
    .replace(/(?<![\w.])__([^_\n]+)__(?![\w.])/g, '$1')
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*•]\s+)/gm, '')
    .trim();
}

function meaningful(text) {
  return /[\p{L}\d]/u.test(text) && !/^(?:好[的]?|收到|明白|谢谢|ok(?:ay)?|thanks|sure|done)[.!。！\s]*$/i.test(text);
}

function short(text, limit) {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= limit ? line : line.slice(0, limit - 1).trimEnd() + '…';
}

function compareItems(a, b) {
  if (a.ordinal != null && b.ordinal != null) return a.ordinal - b.ordinal;
  return (a.createdAtMs || 0) - (b.createdAtMs || 0);
}

// Extract named subjects instead of copying unknown English prose. File paths
// are recognized before terms so "styles.css" survives as a single filename.
const FILE = /(?:[\w@./-]+\/)?(?:[\w@-]+\.)+(?:[cm]?[jt]sx?|css|scss|html?|py|sh|rs|go|java|swift|json|ya?ml|toml|md|sql|sqlite|txt)\b/gi;
const TERMS = [
  [/\b(?:unit tests?|tests?|testing|pytest|unittest|vitest|jest)\b/i, '测试'],
  [/\bbuilds?\b/i, '构建'], [/\bfallbacks?\b/i, '回退逻辑'],
  [/\b(?:UI\s+prefs?|(?:UI\s+)?preferences?)\b/i, '界面偏好'],
  [/\bconfig(?:uration)?s?\b/i, '配置'], [/\b(?:styles?|stylesheets?|CSS)\b/i, '样式'],
  [/\b(?:databases?|sqlite)\b/i, '数据库'], [/\bworktrees?\b/i, '工作树'],
  [/\bdiffs?\b/i, '代码差异'], [/\bcleanup\b/i, '清理'],
  [/\b(?:docs?|documentation)\b/i, '文档'], [/\bservers?\b/i, '服务端'],
  [/\b(?:routing|routers?|routes?)\b/i, '路由'], [/\b(?:JWT\s+)?auth(?:entication)?\b/i, '认证'],
  [/\b(?:code\s+)?reviews?\b/i, '审查结果'], [/\b(?:errors?|failures?|bugs?)\b/i, '错误'],
  [/\bAPI\b/i, 'API'], [/\blayout\b/i, '布局'], [/\btraces?\b/i, '过程记录'],
  [/\b(?:parsers?|parsing)\b/i, '解析逻辑'], [/\b(?:issues?|problems?)\b/i, '问题'],
  [/\b(?:approval|confirmation)\b/i, '确认'], [/\b(?:logs?|records?)\b/i, '记录'],
];

function subjects(text) {
  const files = [...new Set(Array.from(text.matchAll(FILE), m => m[0].split('/').pop()))];
  const words = text.replace(FILE, ' ');
  const terms = TERMS.map(([pattern, label]) => {
    const match = words.match(pattern);
    return match && { index: match.index, label: /^JWT\s/i.test(match[0]) ? 'JWT 认证' : label };
  }).filter(Boolean).sort((a, b) => a.index - b.index).map(term => term.label);
  return { files, terms };
}

function fileList(files, count = files.length) {
  if (!files.length) return count ? `${count} 个文件` : '';
  if (count > 2 || count > files.length) return `${files[0]} 等 ${count} 个文件`;
  return files.join(' 和 ');
}

function verbObject(verb, object) {
  return verb + (/^[a-z\d.]/i.test(object) ? ' ' : '') + object;
}

const ACTIONS = [
  [/\b(?:re-?run(?:ning)?|reran)\b/i, '重新运行', '验证'],
  [/\b(?:read(?:ing)?|inspect(?:ing|ed)?|look(?:ing)? at)\b/i, '查看', '相关内容'],
  [/\b(?:check(?:ing|ed)?|verif(?:y|ying|ied)|validat(?:e|ing|ed))\b/i, '检查', '执行结果'],
  [/\b(?:review(?:ing|ed)?|audit(?:ing|ed)?)\b/i, '审查', '相关改动'],
  [/\b(?:run(?:ning)?|ran|execut(?:e|ing|ed)|test(?:ing|ed)?)\b/i, '运行', '测试'],
  [/\b(?:fix(?:ing|ed)?|resolv(?:e|ing|ed)|patch(?:ing|ed)?)\b/i, '修复', '问题'],
  [/\bdebug(?:ging|ged)?\b/i, '排查', '问题'],
  [/\b(?:updat(?:e|ing|ed)|edit(?:ing|ed)?|modif(?:y|ying|ied)|chang(?:e|ing|ed)|touch(?:ed|ing)?)\b/i, '修改', '相关内容'],
  [/\bimplement(?:ing|ed)?\b/i, '实现', '相关功能'], [/\brefactor(?:ing|ed)?\b/i, '重构', '相关代码'],
  [/\b(?:add(?:ing|ed)?|creat(?:e|ing|ed)|writ(?:e|ing)|wrote)\b/i, '编写', '相关内容'],
  [/\b(?:build(?:ing)?|built)\b/i, '构建', '项目'],
  [/\b(?:polish(?:ing|ed)?|improv(?:e|ing|ed)|optimi[sz](?:e|ing|ed))\b/i, '优化', '相关实现'],
  [/\b(?:clean(?:ing|ed|up)?|remov(?:e|ing|ed)|delet(?:e|ing|ed))\b/i, '清理', '相关内容'],
  [/\bprepar(?:e|ing|ed)\b/i, '准备', '后续工作'],
  [/\b(?:search(?:ing|ed)?|find(?:ing)?|found|look(?:ing)? for)\b/i, '查找', '相关信息'],
  [/\b(?:analy[sz](?:e|ing|ed)|investigat(?:e|ing|ed))\b/i, '分析', '相关情况'],
  [/\bwait(?:ing|ed)?\b/i, '等待', '后续处理'],
];

function actionIn(text) {
  let first;
  for (const [pattern, verb, fallback] of ACTIONS) {
    const match = pattern.exec(text);
    if (match && (!first || match.index < first.index)) first = { match, verb, fallback, index: match.index };
  }
  return first;
}

// Only declarative outcome cues imply a result. "Check whether tests passed"
// and "I'll run the tests" are activities, not evidence of a successful run.
function outcomeFacts(text) {
  const facts = new Set();
  for (const clause of text.split(/(?:[.!?](?=\s|$)|[;\n])/)) {
    if (/\b(?:if|whether|should|might|could|would|will|expect(?:ed)? to|make sure|ensure|checking that)\b/i.test(clause)) continue;
    if (/\b(?:no (?:issues|findings)(?: found)?|no problems found)\b/i.test(clause)) facts.add('审查未发现问题');
    if (/\b(?:tests? (?:were |was )?(?:not (?:run|executed)|skipped)|no tests? (?:were )?run)\b/i.test(clause)) {
      facts.add('测试未运行');
      continue;
    }
    for (const m of clause.matchAll(/\b(?:(no|\d+)\s+)?(?:unit )?tests?\s+(?:(?:have|has|are|were|all|now)\s+)*(did not pass|not passing|failed|failing|passed|passing|pass)\b|\b(\d+)\s+(passing|passed|failing|failed)\s+(?:unit )?tests?\b/gi)) {
      const count = m[1] || m[3];
      const passed = /^pass/i.test(m[2] || m[4]);
      if (/^no$/i.test(count)) facts.add(passed ? '没有测试通过' : '没有测试失败');
      else facts.add(`${count ? count + ' 项' : ''}测试${passed ? '已通过' : '未通过'}`);
    }
    if (/\btests? (?:reported|returned|encountered) (?:an? |\d+ )?errors?\b/i.test(clause)) facts.add('测试报错');
    const ranTests = clause.match(/\b(?:ran|executed) (?:all )?(\d+)?\s*(?:unit )?tests?\b.*?\b(?:all|they) (passed|failed)\b/i);
    if (ranTests) facts.add(`${ranTests[1] ? ranTests[1] + ' 项' : ''}测试${/^passed$/i.test(ranTests[2]) ? '已通过' : '未通过'}`);
    const build = clause.match(/\bbuild (?:has |is )?(passed|succeeded|failed)\b/i);
    if (build) facts.add(/failed/i.test(build[1]) ? '构建失败' : '构建已通过');
  }
  return [...facts];
}

function describeCommand(text) {
  const command = text.split('\n')[0].replace(/^\$\s*/, '').replace(/\s+\[[\w-]+\]$/, '');
  const { files } = subjects(command);
  if (/\bgit\s+diff\s+--check\b/.test(command)) return '检查代码差异';
  if (command.includes('--check')) return files.length ? `检查 ${fileList(files)} 的语法` : '执行检查';
  if (/\bgit\s+(?:diff|status)\b/.test(command)) return '查看代码差异';
  if (/\b(?:cat|sed|head|tail)\s/.test(command)) return verbObject('查看', fileList(files) || '文件内容');
  if (/\b(?:rg|grep|find)\s/.test(command)) return '检索相关内容';
  const builds = /\b(?:build|make|cmake)\b/i.test(command);
  const tests = /\b(?:tests?|pytest|unittest|vitest|jest)\b|\btest[_-]\w/i.test(command);
  if (builds && tests) return '运行构建与测试';
  if (tests) return '运行测试';
  if (builds) return '运行构建';
  return '执行命令';
}

/** Describe a local message or trace without a model, network, or mutable state. */
export function summarizeEnglishToChinese(text, { type = 'agentMessage', live = false } = {}) {
  const clean = plainText(text);
  if (!clean) return '';
  const prefix = live ? '正在' : '';
  if (type === 'commandExecution') return short(prefix + describeCommand(clean), 88);
  if (type === 'fileChange') {
    const files = [...new Set(clean.split('\n').map(line => line.replace(/^[\w-]+:\s*/, '').trim()).filter(Boolean))];
    const name = files[0]?.split('/').pop();
    return short(prefix + verbObject('修改', fileList(name ? [name] : [], files.length) || '文件'), 88);
  }
  if (type === 'mcpToolCall') {
    const name = clean.split(/[\s\[]/)[0];
    return short(prefix + '调用工具' + (name ? ' ' + name : ''), 88);
  }
  if (type === 'webSearch') {
    const query = clean.split('\n')[0].replace(/\s*·\s*\d+ 条结果$/, '');
    const { files, terms } = subjects(query);
    const subject = CJK.test(query) ? query : fileList(files) || terms.join('与') || '相关网页';
    return short(prefix + verbObject('搜索', subject), 88);
  }

  if (CJK.test(clean)) {
    const sentences = clean.match(/[^\n。！？!?]+[。！？!?]?/g) || [];
    return short(sentences.find(sentence => CJK.test(sentence)) || clean, 88);
  }
  const main = clean.replace(/^(?:(?:now|next|then)[,\s]+|(?:let me|I will|I'll|I’ll|I'm|I am|going to)\s+)+/i, '')
    .split(/[.!?](?=\s|$)|[;\n]|(?:,\s*|\s+(?:with|and)\s+)(?=(?:all\s+)?(?:\d+\s+)?(?:passing |unit )?tests?\b.*\b(?:pass\w*|fail\w*)\b|\d+ passing tests?)/i)[0];
  const action = actionIn(main.replace(FILE, match => ' '.repeat(match.length)));
  const facts = outcomeFacts(clean);
  const files = subjects(clean).files;
  const count = Math.max(files.length, Number(clean.match(/\b(\d+)\s+files?\b/i)?.[1]) || 0);
  const fileNames = fileList(files, count);
  let description = '';
  if (action) {
    const { match, verb, fallback } = action;
    const objectText = main.slice(match.index + match[0].length);
    const { files: named, terms } = subjects(objectText);
    const hasFileObject = named.length > 0 || /\d+ files?\b/i.test(objectText);
    const object = terms.slice(0, 3).join('与') || (hasFileObject && verb !== '实现' ? fileNames : fallback);
    const past = /(?:ed|ran|built|wrote|found)$/i.test(match[0]);
    let tense = prefix;
    if (!tense && (/^(?:next|let me|I will|I['’]ll|going to)\b/i.test(clean))) tense = '准备';
    if (!tense && (past || /\b(?:have|has)\s+$/i.test(main.slice(0, match.index)))) tense = '已';
    if (!tense && (/ing$/i.test(match[0]) || /^now\b/i.test(clean))) tense = '正在';
    // A noun in "Tests passed" or "Build failed" isn't an imperative.
    if (!(facts.length && /^(?:test|build|found)$/i.test(match[0]))) {
      description = tense + verbObject(verb, object);
      if (/\b(?:failed|unable) to\s*$/i.test(main.slice(0, match.index))) description = verbObject(verb, object) + '失败';
    }
  }
  if (/\b(?:code )?review (?:is |was )?(?:completed?|finished)\b/i.test(main)) description = '已完成代码审查';
  if (fileNames && !description.includes(fileNames)) {
    description = [description, verbObject('涉及', fileNames)].filter(Boolean).join('，');
  }
  return short([description, ...facts].filter(Boolean).join('，') ||
    (type === 'reasoning' ? '正在梳理任务思路' : 'Codex 已回复'), 88);
}

function planEntries(text) {
  const boxes = [];
  const numbered = [];
  for (const line of withoutCodeBlocks(unwrapStructuredReply(text)).split('\n')) {
    const box = line.match(/^\s*(?:[-*+]\s+)?\[([ xX])\]\s+(.+)/);
    const item = line.match(/^\s*(?:#{1,6}\s+)?(?:step\s+)?\d+\s*(?:[.)]\s+|[:：、]\s*)(.+)/i);
    if (box) boxes.push({ title: plainText(box[2]), checked: box[1].toLowerCase() === 'x' });
    else if (item) numbered.push({ title: plainText(item[1]) });
  }
  return (boxes.length ? boxes : numbered).filter(step => step.title).slice(0, 8);
}

function latestPlan(items) {
  const explicit = items.findLast(item => item.type === 'plan');
  const candidates = [explicit, ...items.filter(item => ['agentMessage', 'userMessage'].includes(item.type)).reverse()];
  for (const item of candidates) {
    if (!item) continue;
    const entries = planEntries(item.text);
    if (entries.length < 2) continue;
    // Ordinary answers can number names, examples or alternatives. A list in
    // prose needs an explicit step marker or actionable titles to be a plan.
    if (item.type === 'plan' || entries[0].checked !== undefined ||
        /(?:\b(?:plan|steps?|checklist)\b|计划|步骤|待办|任务清单)/i.test(item.text) ||
        entries.filter(({ title }) => actionIn(title)?.index === 0 ||
          /^(?:先|再|然后|最后|已|正在)?(?:分析|查看|核对|读取|检查|审查|检索|查找|设计|梳理|整理|修复|排查|更新|修改|调整|接入|实现|运行|执行|验证|测试|构建|创建|编写|准备|清理|部署|确认|完成)/.test(title)).length >= 2) {
      return { item, entries };
    }
  }
  return null;
}

function agentUpdates(items) {
  const distinct = new Set();
  for (const item of items) {
    if (item.type !== 'agentMessage') continue;
    const text = plainText(item.text);
    if (!meaningful(text)) continue;
    const title = short(summarizeEnglishToChinese(text).replace(/[。！？.!?]$/, ''), 34);
    if (!title || title === 'Codex 已回复') continue;
    distinct.delete(title);
    distinct.add(title);
  }
  return [...distinct];
}

function planSteps(plan, items, turns, running, completed, failed) {
  const { entries } = plan;
  if (entries[0].checked !== undefined) {
    const active = running ? entries.findIndex(entry => !entry.checked) : -1;
    return entries.map(({ title, checked }, i) => ({ title, status: checked ? 'done' : i === active ? 'in_progress' : 'pending' }));
  }
  if (completed) return entries.map(({ title }) => ({ title, status: 'done' }));
  // Only activity after this plan is evidence. A first update starts a step.
  // A completed turn and its commentary can describe the same milestone.
  const sincePlan = items.slice(items.indexOf(plan.item) + 1);
  const commentary = agentUpdates(sincePlan.filter(item => item.phase === 'commentary'));
  const turnIds = new Set([plan.item.turnId, ...sincePlan.map(item => item.turnId)]);
  const finished = turns.filter(turn => turn.status === 'completed' && turnIds.has(turn.turn_id)).length;
  const done = Math.min(entries.length - 1, Math.max(0, commentary.length - 1, finished));
  return entries.map(({ title }, i) => {
    let status = 'pending';
    if (i < done) status = 'done';
    else if (i === done && (running || failed)) status = failed ? 'failed' : 'in_progress';
    return { title, status };
  });
}

export function buildThreadProgress({ task, items = [], subAgentItems = [], turns = [] }) {
  const statusCode = task.status?.code || 'idle';
  const [statusLabel, defaultTone] = STATUS.get(statusCode) || ['已就绪', 'muted'];
  const running = statusCode === 'running' || statusCode === 'goal_active';
  const completed = ['exec_done', 'complete', 'completed'].includes(statusCode);
  const failed = statusCode === 'failed';
  const ordered = [...items].sort(compareItems);
  const agents = [...subAgentItems].sort(compareItems);
  const plan = latestPlan(ordered);
  let source = 'summary';
  let steps = [];
  if (plan) {
    source = 'plan';
    steps = planSteps(plan, ordered, turns, running, completed, failed);
  } else {
    const updates = agentUpdates(ordered).slice(-6);
    if (updates.length >= 2) {
      source = 'commentary';
      const lastStatus = completed ? 'done' : failed ? 'failed' : running ? 'in_progress' : 'pending';
      steps = updates.map((title, i) => ({ title, status: i < updates.length - 1 ? 'done' : lastStatus }));
    } else {
      const latest = new Map();
      for (const agent of agents) {
        const key = agent.agentThreadId || agent.agentPath;
        if (key) latest.set(key, agent);
      }
      if (latest.size >= 2) {
        source = 'subagents';
        steps = [...latest.values()].map(agent => ({
          title: short(agent.agentNickname || agent.agentPath || agent.agentThreadId, 34),
          status: agent.kind === 'completed' ? 'done' : agent.kind === 'failed' ? 'failed' : 'in_progress',
        }));
      }
    }
  }

  const latestMessage = ordered.findLast(item => item.type === 'agentMessage' && meaningful(plainText(item.text)));
  const trace = ordered.findLast(item => TRACES.has(item.type) && item.text?.trim());
  const newest = ordered.at(-1);
  const live = running && trace && trace === newest && (!agents.length || compareItems(trace, agents.at(-1)) > 0);
  const currentAction = live ? summarizeEnglishToChinese(trace.text, { type: trace.type, live: true }) : null;
  const messageSummary = summarizeEnglishToChinese(latestMessage?.text || task.summary || '');
  const summary = messageSummary || currentAction || (trace && summarizeEnglishToChinese(trace.text, { type: trace.type })) ||
    (steps.length ? `共 ${steps.length} 个${source === 'subagents' ? '子代理任务' : '计划步骤'}` : '暂无进度记录');
  return {
    statusCode, statusLabel, statusTone: task.status?.tone || defaultTone, summary, currentAction,
    steps, completedSteps: steps.filter(step => step.status === 'done').length, totalSteps: steps.length, source,
    updatedAtMs: Math.max(task.updatedAtMs || 0, ...ordered.map(item => item.createdAtMs || 0), ...agents.map(item => item.createdAtMs || 0)),
  };
}
