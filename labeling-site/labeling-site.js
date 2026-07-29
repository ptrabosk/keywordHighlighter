const RULE_SOURCE = '../highlighter/data/rules/opt_out_deterministic_rules.json';
const RULE_EXAMPLES_SOURCE = 'rule_examples.json';
const HIGHLIGHT_CORE_SOURCE = '../highlighter/src/highlight/core.js';
const STORAGE_KEY = 'deterministic-rule-labels:v1';

const state = {
  rules: [],
  proceduralLogicByKey: {},
  examplesByRuleId: {},
  labels: loadLabels(),
  filters: {
    search: '',
    reviewed: 'all',
    category: 'all',
    subcategory: 'all',
    action: 'all'
  }
};

const els = {
  reviewedCount: document.querySelector('#reviewedCount'),
  totalCount: document.querySelector('#totalCount'),
  searchInput: document.querySelector('#searchInput'),
  reviewFilter: document.querySelector('#reviewFilter'),
  categoryFilter: document.querySelector('#categoryFilter'),
  subcategoryFilter: document.querySelector('#subcategoryFilter'),
  actionFilter: document.querySelector('#actionFilter'),
  exportButton: document.querySelector('#exportButton'),
  filterPanel: document.querySelector('.filter-panel'),
  filterSummary: document.querySelector('#filterSummary'),
  statusLine: document.querySelector('#statusLine'),
  ruleList: document.querySelector('#ruleList')
};

init().catch((error) => {
  console.error('[Rule labeler] Failed to initialize:', error);
  els.statusLine.textContent = 'Failed to load rules. Start a local server and check the console for details.';
});

async function init() {
  setInitialFilterPanelState();
  const [proceduralLogicByKey, examplesByRuleId, rules] = await Promise.all([
    loadProceduralLogic(),
    loadRuleExamples(),
    loadRules()
  ]);
  state.proceduralLogicByKey = proceduralLogicByKey;
  state.examplesByRuleId = examplesByRuleId;
  state.rules = rules.map(normalizeRule);
  renderFilters();
  bindControls();
  render();
}

function setInitialFilterPanelState() {
  if (window.matchMedia('(max-width: 1000px)').matches) {
    els.filterPanel.open = false;
  }
}

async function loadRules() {
  const response = await fetch(RULE_SOURCE);
  if (!response.ok) throw new Error(`Rules fetch failed for ${RULE_SOURCE}: ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload.rules) ? payload.rules : flattenRules(payload.rules);
}

async function loadRuleExamples() {
  const response = await fetch(RULE_EXAMPLES_SOURCE);
  if (!response.ok) throw new Error(`Rule examples fetch failed for ${RULE_EXAMPLES_SOURCE}: ${response.status}`);
  return response.json();
}

function flattenRules(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => flattenRules(item, output));
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  if (typeof value.pattern === 'string' && (typeof value.action === 'string' || typeof value.tag === 'string')) {
    output.push(value);
    return output;
  }
  Object.values(value).forEach((nested) => flattenRules(nested, output));
  return output;
}

function normalizeRule(rule, index) {
  const pattern = String(rule.pattern || '').trim();
  const actualRuleLogic = getActualRuleLogic(rule, pattern);
  return {
    ...rule,
    id: rule.id || `rule-${index + 1}`,
    name: rule.name || 'unnamed_rule',
    action: rule.action || rule.tag || rule.category || 'unknown',
    category: rule.category || rule.subcategory || 'uncategorized',
    subcategory: rule.subcategory || '',
    matchScope: rule.match_scope || '',
    matchTarget: rule.match_target || '',
    conditionSummary: rule.condition_summary || pattern || 'No trigger condition provided.',
    pattern,
    actualRuleLogic,
    examples: normalizeRuleExamples(rule.id)
  };
}

function normalizeRuleExamples(ruleId) {
  const entry = state.examplesByRuleId[ruleId];
  if (!entry) return null;
  return {
    caught: String(entry.caught || ''),
    notCaught: String(entry.notCaught || ''),
    brandMessage: String(entry.brandMessage || ''),
    patternHash: String(entry.patternHash || ''),
    ruleName: String(entry.ruleName || '')
  };
}

function bindControls() {
  els.searchInput.addEventListener('input', () => {
    state.filters.search = els.searchInput.value.trim().toLowerCase();
    render();
  });
  els.reviewFilter.addEventListener('change', () => {
    state.filters.reviewed = els.reviewFilter.value;
    render();
  });
  els.categoryFilter.addEventListener('change', () => {
    state.filters.category = els.categoryFilter.value;
    render();
  });
  els.subcategoryFilter.addEventListener('change', () => {
    state.filters.subcategory = els.subcategoryFilter.value;
    render();
  });
  els.actionFilter.addEventListener('change', () => {
    state.filters.action = els.actionFilter.value;
    render();
  });
  els.exportButton.addEventListener('click', exportLabels);
  els.ruleList.addEventListener('change', handleRuleChange);
}

function renderFilters() {
  renderSelect(els.categoryFilter, 'All categories', uniqueValues('category'));
  renderSelect(els.subcategoryFilter, 'All subcategories', uniqueValues('subcategory'));
  renderSelect(els.actionFilter, 'All actions', uniqueValues('action'));
}

function renderSelect(select, allLabel, values) {
  select.innerHTML = [
    `<option value="all">${escapeHtml(allLabel)}</option>`,
    ...values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
  ].join('');
}

function uniqueValues(key) {
  return Array.from(new Set(state.rules.map((rule) => rule[key]).filter(Boolean))).sort();
}

function render() {
  const visibleRules = getVisibleRules();
  const reviewedCount = state.rules.filter((rule) => Boolean(state.labels[rule.id]?.checked)).length;
  els.reviewedCount.textContent = String(reviewedCount);
  els.totalCount.textContent = `of ${state.rules.length} reviewed`;
  els.statusLine.textContent = `${visibleRules.length} rules shown`;
  els.filterSummary.textContent = filterSummaryText(visibleRules.length);
  els.ruleList.innerHTML = visibleRules.map(renderRule).join('');
}

function filterSummaryText(visibleCount) {
  const activeFilters = [];
  if (state.filters.search) activeFilters.push('search');
  if (state.filters.reviewed !== 'all') activeFilters.push(state.filters.reviewed);
  if (state.filters.category !== 'all') activeFilters.push(state.filters.category);
  if (state.filters.subcategory !== 'all') activeFilters.push(state.filters.subcategory);
  if (state.filters.action !== 'all') activeFilters.push(state.filters.action);
  return activeFilters.length ? `${visibleCount} shown` : 'All rules';
}

function getVisibleRules() {
  return state.rules.filter((rule) => {
    const label = state.labels[rule.id] || {};
    if (state.filters.reviewed === 'checked' && !label.checked) return false;
    if (state.filters.reviewed === 'unchecked' && label.checked) return false;
    if (state.filters.category !== 'all' && rule.category !== state.filters.category) return false;
    if (state.filters.subcategory !== 'all' && rule.subcategory !== state.filters.subcategory) return false;
    if (state.filters.action !== 'all' && rule.action !== state.filters.action) return false;
    if (!state.filters.search) return true;
    return searchableRuleText(rule).includes(state.filters.search);
  });
}

function searchableRuleText(rule) {
  return [
    rule.id,
    rule.name,
    rule.pattern,
    rule.actualRuleLogic.value,
    rule.action,
    rule.category,
    rule.subcategory,
    rule.examples?.caught,
    rule.examples?.notCaught,
    rule.examples?.brandMessage
  ].join(' ').toLowerCase();
}

function renderRule(rule) {
  const label = state.labels[rule.id] || {};
  return `
    <article class="rule-card" data-rule-id="${escapeHtml(rule.id)}">
      <div class="check-cell">
        <input type="checkbox" data-field="checked" ${label.checked ? 'checked' : ''} aria-label="Mark ${escapeHtml(rule.id)} reviewed">
      </div>
      <div class="rule-body">
        <div class="rule-head">
          <span class="rule-id">${escapeHtml(rule.id)}</span>
          <span class="rule-name">${escapeHtml(rule.name)}</span>
        </div>
        <div class="chips">
          ${renderChip('action', rule.action)}
          ${renderChip('category', rule.category)}
          ${renderChip('subcategory', rule.subcategory)}
          ${renderChip('scope', rule.matchScope)}
        </div>
        <div class="rule-grid">
          <div>
            <div class="field">
              <span class="field-label">Pattern</span>
              <pre>${escapeHtml(rule.actualRuleLogic.value)}</pre>
            </div>
          </div>
          <div>
            <div class="field">
              <span class="field-label">Examples</span>
              <div class="explanation">
                ${renderVerifiedExamples(rule.examples)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </article>
  `;
}

function renderChip(label, value) {
  if (!value) return '';
  return `<span class="chip">${escapeHtml(label)}: ${escapeHtml(value)}</span>`;
}

function renderExampleList(items, className) {
  if (!items.length) return '';
  return `<ul class="${className}">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderVerifiedExamples(examples) {
  if (!examples) return '<div class="example-warning">Missing validated examples.</div>';
  return `
    <dl class="example-pairs">
      ${examples.brandMessage ? renderExampleRow('Brand', examples.brandMessage, 'context') : ''}
      ${renderExampleRow('Caught', examples.caught, 'caught')}
      ${renderExampleRow('Not caught', examples.notCaught, 'not-caught')}
    </dl>
  `;
}

function renderExampleRow(label, value, kind) {
  return `
    <div class="example-row example-row--${escapeHtml(kind)}">
      <dt class="example-label">${escapeHtml(label)}</dt>
      <dd class="example-value">${escapeHtml(value)}</dd>
    </div>
  `;
}

function handleRuleChange(event) {
  if (event.target.dataset.field !== 'checked') return;
  const ruleId = event.target.closest('[data-rule-id]')?.dataset.ruleId;
  if (!ruleId) return;
  updateLabel(ruleId, { checked: event.target.checked });
  render();
}

function updateLabel(ruleId, patch) {
  state.labels[ruleId] = {
    ...(state.labels[ruleId] || {}),
    ...patch,
    updatedAt: new Date().toISOString()
  };
  saveLabels();
}

function loadLabels() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch (_error) {
    return {};
  }
}

function saveLabels() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.labels));
}

function exportLabels() {
  const rows = state.rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    pattern: rule.actualRuleLogic.value,
    caughtExample: rule.examples?.caught || '',
    notCaughtExample: rule.examples?.notCaught || '',
    brandMessage: rule.examples?.brandMessage || '',
    examplePatternHash: rule.examples?.patternHash || '',
    action: rule.action,
    category: rule.category,
    subcategory: rule.subcategory,
    checked: Boolean(state.labels[rule.id]?.checked),
    updatedAt: state.labels[rule.id]?.updatedAt || ''
  }));
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'deterministic-rule-labels.json';
  link.click();
  URL.revokeObjectURL(url);
}

async function loadProceduralLogic() {
  try {
    const response = await fetch(HIGHLIGHT_CORE_SOURCE);
    if (!response.ok) return {};
    return extractProceduralLogic(await response.text());
  } catch (error) {
    console.warn('[Rule labeler] Could not load highlight core source:', error);
    return {};
  }
}

function extractProceduralLogic(source) {
  const map = {};
  const body = source.match(/function getProceduralRegex\(rule\) \{([\s\S]*?)\n  \}/)?.[1] || '';
  const branchRe = /if \(([\s\S]*?)\)\s*(?:\{\s*)?return\s+([\s\S]*?);/g;
  let match;
  while ((match = branchRe.exec(body))) {
    const condition = match[1].replace(/\s+/g, ' ').trim();
    const returnValue = match[2].replace(/\s+/g, ' ').trim();
    const ids = Array.from(condition.matchAll(/rule\.id === '([^']+)'/g)).map((idMatch) => idMatch[1]);
    const names = Array.from(condition.matchAll(/rule\.name === '([^']+)'/g)).map((nameMatch) => nameMatch[1]);
    const logic = `if (${condition}) return ${returnValue};`;
    ids.forEach((id) => { map[`id:${id}`] = logic; });
    names.forEach((name) => { map[`name:${name}`] = logic; });
  }
  return map;
}

function getActualRuleLogic(rule, pattern) {
  const proceduralLogic = state.proceduralLogicByKey[`id:${rule.id}`] || state.proceduralLogicByKey[`name:${rule.name}`];
  if (proceduralLogic) {
    return {
      source: 'highlighter/src/highlight/core.js getProceduralRegex()',
      value: proceduralLogic
    };
  }

  const scope = String(rule.match_scope || '');
  if (rule.id === 'rule_317fdbf0a6758d04' || rule.name === 'zapOptOuts.workflow.node_4.opt_out.not_opted_in') {
    return {
      source: 'highlighter/src/highlight/core.js getRegexPattern() rule override',
      value: "return /(?:never|didnt)\\s*(?:opted\\s+in|signed\\s+up|subscribed?)|(?:opted\\s+in|signed\\s+up)/gi;"
    };
  }
  if (rule.id === 'rule_9501f80f59e3b9fd' || rule.name === 'zapOptOuts.deterministic_js.not_opt_out.020.i_m') {
    return {
      source: 'highlighter/src/highlight/core.js getRegexPattern() rule override',
      value: 'return /i\\s*m|im/gi;'
    };
  }
  if (rule.id === 'rule_bc981d8e383b5305') {
    return {
      source: 'highlighter/src/highlight/core.js getRegexPattern() rule override',
      value: "return /\\b(no more messages|no more texts|don't reach out|do not send|don't send|stop messaging|stop texting|unsubscribe|remove me|delete me|opt out|opt-out|unsub|ban me|stop)\\b/gi;"
    };
  }
  if (rule.name === 'opt_outs_ml.hot_topic_opt_out') {
    return {
      source: 'run_deterministic_rules.py is_hot_topic_detector_match()',
      value: 'return isHotTopicPrompt(brandMessage) && /\\b(?:4|four|never)\\b/i.test(customerMessage);'
    };
  }
  if (rule.name === 'opt_outs_ml.hot_topic_not_opt_out') {
    return {
      source: 'run_deterministic_rules.py is_hot_topic_detector_match()',
      value: 'return isHotTopicPrompt(brandMessage) && !/\\b(?:4|four|never)\\b/i.test(customerMessage);'
    };
  }
  if (scope.includes('extension_ready_phrase') && /\.\.\.$/.test(pattern)) {
    return {
      source: 'highlighter/src/highlight/core.js stemPatternToRegex()',
      value: `return /\\b${escapeRegexForDisplay(pattern.replace(/\.\.\.$/, '').trim())}\\w*\\b/gi;`
    };
  }
  if (rule.type === 'regex' || scope.includes('regex')) {
    return {
      source: scope.includes('normalized') ? 'highlighter/src/highlight/core.js normalizeRegexPatternForSearch() + RegExp' : 'highlighter/src/highlight/core.js RegExp(pattern, flags)',
      value: `return new RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(uniqueRegexFlags(`${rule.flags || 'i'}g`))});`
    };
  }
  if (scope.includes('phrase') || scope.includes('normalized') || scope.includes('keyword') || scope.includes('full')) {
    return {
      source: 'highlighter/src/highlight/core.js phraseToFlexibleRegex()',
      value: `return /${phraseToFlexibleRegexForDisplay(pattern)}/gi;`
    };
  }
  if (isProceduralRule(rule, pattern)) {
    return {
      source: 'JSON procedural description; no matching getProceduralRegex() branch found',
      value: rule.condition_summary || pattern || '(procedural rule without displayable code logic)'
    };
  }
  return {
    source: 'highlighter/src/highlight/core.js RegExp(pattern, flags)',
    value: `return new RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(uniqueRegexFlags(`${rule.flags || 'i'}g`))});`
  };
}

function explainPattern(rule, pattern) {
  if (isProceduralRule(rule, pattern)) {
    return {
      summary: '',
      matches: proceduralExamples(rule, pattern)
    };
  }

  if (hasDisplayAlternatives(pattern)) return explainDisplayAlternatives(pattern);
  if (hasSimpleTopLevelPipes(pattern)) return explainTopLevelPipes(pattern);
  if (hasNestedRegexAlternatives(pattern)) return explainNestedRegexAlternatives(pattern);
  if (hasSimpleRegexAlternatives(pattern)) return explainRegexAlternatives(pattern);
  if (/\([^)]+\)\?/.test(pattern)) return explainOptionalGroup(pattern);
  if (/\\w\*|\.\.\./.test(pattern)) return explainStemPattern(pattern);

  return {
    summary: '',
    matches: [readableRegexSample(pattern)]
  };
}

function explainDisplayAlternatives(pattern) {
  const examples = expandSlashPattern(pattern);
  return {
    summary: '',
    matches: examples.map((example) => quote(example))
  };
}

function expandSlashPattern(pattern) {
  const parts = pattern.split(/\s+\/\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return [pattern];

  const lastTokens = parts.at(-1).split(/\s+/);
  if (lastTokens.length > 1 && parts.slice(0, -1).every((part) => !part.includes(' '))) {
    const suffix = lastTokens.slice(1).join(' ');
    return [
      ...parts.slice(0, -1).map((part) => `${part} ${suffix}`),
      parts.at(-1)
    ];
  }

  const suffix = longestCommonSuffix(parts);
  const prefix = longestCommonPrefix(parts);
  if (suffix) {
    return parts.map((part) => `${part}${suffix}`.trim());
  }
  if (prefix) {
    return parts.map((part) => `${prefix}${part}`.trim());
  }
  return parts;
}

function longestCommonSuffix(parts) {
  const tokenized = parts.map((part) => part.split(/\s+/));
  const last = tokenized.at(-1) || [];
  const suffix = [];
  for (let offset = 1; offset <= last.length; offset += 1) {
    const token = last[last.length - offset];
    if (!tokenized.every((tokens) => tokens.length >= offset && tokens[tokens.length - offset] === token)) break;
    suffix.unshift(token);
  }
  return suffix.length ? ` ${suffix.join(' ')}` : '';
}

function longestCommonPrefix(parts) {
  const tokenized = parts.map((part) => part.split(/\s+/));
  const first = tokenized[0] || [];
  const prefix = [];
  for (let index = 0; index < first.length; index += 1) {
    const token = first[index];
    if (!tokenized.every((tokens) => tokens[index] === token)) break;
    prefix.push(token);
  }
  return prefix.length ? `${prefix.join(' ')} ` : '';
}

function explainTopLevelPipes(pattern) {
  const examples = pattern.split('|').map((part) => quote(readableRegexSample(part))).slice(0, 8);
  return {
    summary: '',
    matches: examples
  };
}

function explainRegexAlternatives(pattern) {
  const group = pattern.match(/\(([^()]*\|[^()]*)\)/);
  const options = group[1].split('|');
  const examples = options.map((option) => quote(readableRegexSample(pattern.replace(group[0], option)))).slice(0, 8);
  return {
    summary: '',
    matches: examples
  };
}

function explainNestedRegexAlternatives(pattern) {
  return {
    summary: '',
    matches: expandRegexPattern(pattern).slice(0, 20).map((example) => quote(readableRegexSample(example)))
  };
}

function explainOptionalGroup(pattern) {
  const withoutOptional = pattern.replace(/\(([^)]+)\)\?/g, '');
  const withOptional = pattern.replace(/\(([^)]+)\)\?/g, '$1');
  return {
    summary: '',
    matches: [quote(readableRegexSample(withoutOptional)), quote(readableRegexSample(withOptional))]
  };
}

function explainStemPattern(pattern) {
  const stem = pattern.replace(/\\b/g, '').replace(/\\w\*/g, '').replace(/\.\.\./g, '').replace(/\\/g, '');
  return {
    summary: '',
    matches: [quote(stem), quote(`${stem}ing`), quote(`${stem}ed`)]
  };
}

function isProceduralRule(rule, pattern) {
  return rule.match_scope === 'procedural' || !pattern || looksLikeProceduralDescription(pattern);
}

function looksLikeProceduralDescription(pattern) {
  const value = String(pattern || '');
  return /\b(?:customer|brand|message|detector|matches|contains|normalized|reply|including|configured)\b/i.test(value) && value.includes(' ');
}

function proceduralExamples(rule, pattern) {
  const value = `${rule.condition_summary || ''} ${pattern}`.toLowerCase();
  if (value.includes('exactly one ascii letter')) return [quote('x'), quote('A')];
  if (value.includes('only digits')) return [quote('45'), quote('123')];
  if (value.includes('hot topic') && value.includes('contains 4')) return [quote('4'), quote('never')];
  if (value.includes('hot topic') && value.includes('does not contain 4')) return [quote('2'), quote('weekly')];
  return [];
}

function hasDisplayAlternatives(value) {
  return /\s\/\s/.test(String(value || ''));
}

function hasSimpleTopLevelPipes(pattern) {
  return pattern.includes('|') && !/[()]/.test(pattern);
}

function hasSimpleRegexAlternatives(pattern) {
  return /\([^()]*\|[^()]*\)/.test(pattern);
}

function hasNestedRegexAlternatives(pattern) {
  return /\([^)]*\|[^)]*\)/.test(pattern);
}

function expandRegexPattern(pattern) {
  let variants = [String(pattern || '')];
  let changed = true;
  while (changed) {
    changed = false;
    const next = [];
    for (const variant of variants) {
      const group = findInnermostAlternativeGroup(variant);
      if (!group) {
        next.push(variant);
        continue;
      }
      changed = true;
      for (const option of group.options) {
        next.push(`${variant.slice(0, group.start)}${option}${variant.slice(group.end)}`);
      }
    }
    variants = next.slice(0, 40);
  }
  return variants;
}

function findInnermostAlternativeGroup(value) {
  const text = String(value || '');
  const stack = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '(') stack.push(index);
    if (char !== ')') continue;
    const start = stack.pop();
    if (start === undefined) continue;
    const body = text.slice(start + 1, index).replace(/^\?:/, '');
    if (!body.includes('|') || /[()]/.test(body)) continue;
    return {
      start,
      end: index + 1,
      options: body.split('|')
    };
  }
  return null;
}

function readableRegexSample(pattern) {
  return String(pattern || '')
    .replace(/\^\s\*/g, '')
    .replace(/\s\*\$/g, '')
    .replace(/\^\\s\*/g, '')
    .replace(/\\s\*\$/g, '')
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\\b/g, '')
    .replace(/\\s\+/g, ' ')
    .replace(/\\s\*/g, ' ')
    .replace(/\\s/g, ' ')
    .replace(/\\w\*/g, '')
    .replace(/\(\?:/g, '(')
    .replace(/[()]/g, '')
    .replace(/\?/g, '')
    .replace(/\*/g, '')
    .replace(/\+/g, '')
    .replace(/\\/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'match';
}

function phraseToFlexibleRegexForDisplay(value) {
  if (hasDisplayAlternatives(value)) return displayAlternativesToRegexForDisplay(value);
  const words = String(value || '').trim().split(/\s+/).filter(Boolean).map(escapeRegexForDisplay);
  if (!words.length) return '';
  return `\\b${joinFlexibleWordsForDisplay(words)}\\b`;
}

function displayAlternativesToRegexForDisplay(value) {
  const parts = String(value || '').split(/\s+\/\s+/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return '';
  const prefix = parts[0].split(/\s+/).filter(Boolean).map(escapeRegexForDisplay);
  if (prefix.length < 2) return `\\b(?:${parts.map(escapeRegexForDisplay).join('|')})\\b`;
  const lead = prefix[0];
  const firstAlternative = prefix.slice(1).join('[\\W_]+');
  const alternatives = [firstAlternative, ...parts.slice(1).map(escapeRegexForDisplay)]
    .filter(Boolean)
    .join('|');
  return `\\b${lead}[\\W_]+(?:${alternatives})(?:[\\W_]+(?:me|you|us|again|anymore))*\\b`;
}

function joinFlexibleWordsForDisplay(words) {
  const output = [];
  for (let index = 0; index < words.length; index += 1) {
    if (index > 0) output.push(isContractionPairForDisplay(words[index - 1], words[index]) ? '[\\W_]*' : '[\\W_]+');
    output.push(words[index]);
  }
  return output.join('');
}

function isContractionPairForDisplay(left, right) {
  return /^(?:i|you|we|they|he|she|it|that|there|what|who|do|don|doesn|didn|can|couldn|wouldn|shouldn|won|isn|aren|wasn|werent|havent|hasnt|hadnt)$/i.test(left)
    && /^(?:m|re|ve|ll|d|s|t)$/i.test(right);
}

function escapeRegexForDisplay(value) {
  return String(value || '').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function uniqueRegexFlags(flags) {
  return Array.from(new Set(String(flags || '').split(''))).filter((flag) => 'dgimsuvy'.includes(flag)).join('');
}

function quote(value) {
  return `"${value}"`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
