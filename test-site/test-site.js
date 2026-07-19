const MANUAL_KEY = 'amhQaManualChecks';
const CUSTOM_KEYWORD = 'launch code';

const state = {
  conversations: [],
  selectedIds: new Set(),
  manualChecks: loadManualChecks(),
  filters: {
    category: 'all',
    status: 'all'
  },
  dynamicAdded: false,
  statuses: new Map(),
  lastSummary: null
};

const els = {
  originPill: document.querySelector('#originPill'),
  selectAll: document.querySelector('#selectAll'),
  clearSelection: document.querySelector('#clearSelection'),
  categoryFilter: document.querySelector('#categoryFilter'),
  statusFilter: document.querySelector('#statusFilter'),
  addDynamicMessage: document.querySelector('#addDynamicMessage'),
  conversationCount: document.querySelector('#conversationCount'),
  conversationList: document.querySelector('#conversationList'),
  conversationDeck: document.querySelector('#conversationDeck'),
  issueList: document.querySelector('#issueList'),
  expectedFound: document.querySelector('#expectedFound'),
  missingExpected: document.querySelector('#missingExpected'),
  unexpectedHighlights: document.querySelector('#unexpectedHighlights'),
  highlightedInbound: document.querySelector('#highlightedInbound'),
  loadedRules: document.querySelector('#loadedRules'),
  activeRules: document.querySelector('#activeRules')
};

async function init() {
  state.conversations = [...curatedConversations, ...await loadGeneratedRuleConversations()];
  seedSelection();
  renderCategoryFilter();
  bindControls();
  render();
  scheduleQaRefresh();
}

function bindControls() {
  els.selectAll.addEventListener('click', () => {
    for (const conversation of getFilteredConversations({ ignoreStatus: true })) {
      state.selectedIds.add(conversation.id);
    }
    render();
    scheduleQaRefresh();
  });

  els.clearSelection.addEventListener('click', () => {
    state.selectedIds.clear();
    render();
    scheduleQaRefresh();
  });

  els.categoryFilter.addEventListener('change', () => {
    state.filters.category = els.categoryFilter.value;
    render();
    scheduleQaRefresh();
  });

  els.statusFilter.addEventListener('change', () => {
    state.filters.status = els.statusFilter.value;
    render();
    scheduleQaRefresh();
  });

  els.addDynamicMessage.addEventListener('click', () => {
    state.dynamicAdded = true;
    state.selectedIds.add('dynamic-mutation');
    render();
    scheduleQaRefresh();
  });
}

function seedSelection() {
  for (const conversation of curatedConversations.slice(0, 6)) {
    state.selectedIds.add(conversation.id);
  }
}

function render() {
  renderConversationList();
  renderConversationDeck();
}

function renderCategoryFilter() {
  const categories = Array.from(new Set(state.conversations.map((conversation) => conversation.category))).sort();
  els.categoryFilter.innerHTML = [
    '<option value="all">All categories</option>',
    ...categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`)
  ].join('');
}

function renderConversationList() {
  const conversations = getFilteredConversations();
  const fragment = document.createDocumentFragment();
  for (const conversation of conversations) {
    const item = document.createElement('label');
    item.className = 'conversation-item';
    item.dataset.selected = String(state.selectedIds.has(conversation.id));

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selectedIds.has(conversation.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selectedIds.add(conversation.id);
      else state.selectedIds.delete(conversation.id);
      render();
      scheduleQaRefresh();
    });

    const copy = document.createElement('span');
    copy.innerHTML = `
      <span class="conversation-title">${escapeHtml(conversation.title)}</span>
      <span class="conversation-summary">${escapeHtml(conversation.category)} - ${escapeHtml(conversation.summary)}</span>
    `;

    const status = document.createElement('span');
    status.className = 'status-dot';
    status.dataset.status = state.statuses.get(conversation.id) || 'unknown';

    item.append(checkbox, copy, status);
    fragment.appendChild(item);
  }

  els.conversationList.innerHTML = '';
  els.conversationList.appendChild(fragment);
  els.conversationCount.textContent = `${conversations.length} shown`;
}

function renderConversationDeck() {
  const selected = getSelectedConversations();
  els.conversationDeck.innerHTML = '';

  if (!selected.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Select one or more conversations to run QA checks.';
    els.conversationDeck.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const conversation of selected) {
    fragment.appendChild(renderConversation(conversation));
  }
  els.conversationDeck.appendChild(fragment);
}

function renderConversation(conversation) {
  const article = document.createElement('article');
  article.className = 'conversation-card';
  article.dataset.conversationId = conversation.id;

  const expectedTags = Array.from(new Set(getExpectations(conversation).map((expectation) => expectation.tag)));
  article.innerHTML = `
    <div class="conversation-header">
      <div>
        <h3>${escapeHtml(conversation.title)}</h3>
        <p>${escapeHtml(conversation.summary)}</p>
      </div>
      <label class="manual-check">
        <input type="checkbox" ${state.manualChecks[conversation.id] ? 'checked' : ''}>
        Manually checked
      </label>
    </div>
    <div class="messages"></div>
    <div class="expectations">
      ${expectedTags.length ? expectedTags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('') : '<span class="tag">expects no highlight</span>'}
    </div>
  `;

  article.querySelector('.manual-check input').addEventListener('change', (event) => {
    state.manualChecks[conversation.id] = event.target.checked;
    saveManualChecks();
    renderConversationList();
  });

  const messages = article.querySelector('.messages');
  for (const message of getRenderableMessages(conversation)) {
    messages.appendChild(renderMessage(conversation, message));
  }

  return article;
}

function renderMessage(conversation, message) {
  const wrapper = document.createElement('div');
  wrapper.className = `message type-${message.direction === 'outbound' ? 'OUTBOUND' : 'INBOUND'}`;
  wrapper.dataset.messageId = message.id;
  wrapper.dataset.conversationId = conversation.id;
  wrapper.dataset.hidden = String(message.hidden === true);
  wrapper.dataset.allowHighlight = String(message.direction === 'inbound' && message.hidden !== true && getMessageExpectations(message).length > 0);

  wrapper.innerHTML = `
    <div class="bubble">
      <p class="variant-caption">${escapeHtml(message.text)}</p>
    </div>
    <p class="variant-micro">${escapeHtml(message.time || 'QA')}</p>
  `;
  return wrapper;
}

function scheduleQaRefresh() {
  window.clearTimeout(scheduleQaRefresh.timer);
  scheduleQaRefresh.timer = window.setTimeout(refreshQa, 260);
}

async function refreshQa() {
  const selected = getSelectedConversations();
  const summary = analyzeVisibleOutput(selected);
  state.lastSummary = summary;

  els.expectedFound.textContent = summary.expectedFound;
  els.missingExpected.textContent = summary.missing.length;
  els.unexpectedHighlights.textContent = summary.unexpected.length;
  els.highlightedInbound.textContent = summary.highlightedInbound;
  els.loadedRules.textContent = summary.extensionStats?.loadedRules ?? 'n/a';
  els.activeRules.textContent = summary.extensionStats?.activeRules ?? 'n/a';

  els.originPill.textContent = summary.extensionStats ? 'Extension content script active' : 'Open with unpacked extension loaded';
  els.originPill.dataset.ready = String(Boolean(summary.extensionStats));

  state.statuses.clear();
  for (const conversation of selected) {
    const conversationIssues = summary.missing.concat(summary.unexpected).filter((issue) => issue.conversationId === conversation.id);
    state.statuses.set(conversation.id, conversationIssues.length ? 'fail' : 'pass');
  }

  renderIssues(summary);
  renderConversationList();
}

function analyzeVisibleOutput(selected) {
  const extensionStats = readExtensionStats();
  const highlights = Array.from(els.conversationDeck.querySelectorAll('.amh-highlight'));
  const highlightedInboundMessages = new Set();
  const expected = selected.flatMap((conversation) => getExpectations(conversation).map((expectation) => ({
    ...expectation,
    conversationId: conversation.id,
    conversationTitle: conversation.title
  })));

  let expectedFound = 0;
  const missing = [];

  for (const expectation of expected) {
    const found = highlights.some((highlight) => {
      const message = highlight.closest('.message');
      if (!message || message.dataset.conversationId !== expectation.conversationId) return false;
      if (highlight.dataset.amhRuleTag !== expectation.tag) return false;
      return normalize(highlight.textContent).includes(normalize(expectation.contains));
    });
    if (found) expectedFound += 1;
    else missing.push(expectation);
  }

  const unexpected = [];
  for (const highlight of highlights) {
    const message = highlight.closest('.message');
    if (!message) continue;
    if (message.classList.contains('type-INBOUND')) highlightedInboundMessages.add(message);
    if (message.dataset.allowHighlight === 'true') continue;
    unexpected.push({
      conversationId: message.dataset.conversationId,
      text: highlight.textContent,
      tag: highlight.dataset.amhRuleTag || 'unknown'
    });
  }

  return {
    expectedFound,
    missing,
    unexpected,
    highlightedInbound: highlightedInboundMessages.size,
    extensionStats,
    extensionError: readExtensionError()
  };
}

function renderIssues(summary) {
  els.issueList.innerHTML = '';
  const fragment = document.createDocumentFragment();

  if (summary.extensionError) {
    fragment.appendChild(renderIssue(`Extension initialization failed: ${summary.extensionError}`, 'info'));
  } else if (!summary.extensionStats) {
    fragment.appendChild(renderIssue('The test site is open, but no extension stats were found. Reload the unpacked extension, then refresh this page.', 'info'));
  }

  for (const issue of summary.missing.slice(0, 8)) {
    fragment.appendChild(renderIssue(`Missing ${issue.tag} in ${issue.conversationTitle}: "${issue.contains}"`));
  }

  for (const issue of summary.unexpected.slice(0, 8)) {
    fragment.appendChild(renderIssue(`Unexpected ${issue.tag} highlight in ${issue.conversationId}: "${issue.text}"`));
  }

  const hidden = summary.missing.length + summary.unexpected.length - fragment.childElementCount;
  if (hidden > 0) {
    fragment.appendChild(renderIssue(`${hidden} additional issues hidden. Filter failing conversations for details.`, 'info'));
  }

  els.issueList.appendChild(fragment);
}

function renderIssue(text, kind = 'error') {
  const issue = document.createElement('div');
  issue.className = 'issue';
  issue.dataset.kind = kind;
  issue.textContent = text;
  return issue;
}

function getFilteredConversations({ ignoreStatus = false } = {}) {
  return state.conversations.filter((conversation) => {
    if (state.filters.category !== 'all' && conversation.category !== state.filters.category) return false;
    if (ignoreStatus || state.filters.status === 'all') return true;
    if (state.filters.status === 'manual') return Boolean(state.manualChecks[conversation.id]);
    if (state.filters.status === 'unchecked') return !state.manualChecks[conversation.id];
    return state.statuses.get(conversation.id) === state.filters.status;
  });
}

function getSelectedConversations() {
  return state.conversations.filter((conversation) => state.selectedIds.has(conversation.id));
}

function getRenderableMessages(conversation) {
  const messages = conversation.messages.filter((message) => message.when !== 'dynamic' || state.dynamicAdded);
  if (conversation.id === 'dynamic-mutation' && !state.dynamicAdded) {
    return messages.filter((message) => message.when !== 'dynamic');
  }
  return messages;
}

function getExpectations(conversation) {
  return getRenderableMessages(conversation).flatMap(getMessageExpectations);
}

function getMessageExpectations(message) {
  if (message.hidden || message.direction !== 'inbound') return [];
  return message.expects || [];
}

function readExtensionStats() {
  const raw = document.documentElement.dataset.amhStats;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function readExtensionError() {
  return document.documentElement.dataset.amhInitError || '';
}

async function loadGeneratedRuleConversations() {
  try {
    const response = await fetch('../highlighter/data/rules/consolidated_rules.json');
    const payload = await response.json();
    const rules = [];
    flattenRules(payload.rules, [], rules);
    state.generatedRuleCount = rules.length;
    return rules.map((rule, index) => {
      const sample = sampleForRule(rule);
      return {
        id: `generated-${index}`,
        title: `Rule ${index + 1}: ${rule.name}`,
        summary: rule.groupPath || rule.source || 'Generated from consolidated rules',
        category: `generated:${rule.tag}`,
        generated: true,
        messages: [{
          id: `generated-${index}-message`,
          direction: 'inbound',
          text: sample,
          time: 'generated',
          expects: [{ tag: rule.tag, contains: firstRegexMatch(rule, sample) || sample }]
        }]
      };
    });
  } catch (error) {
    console.warn('[QA site] Could not load generated rules:', error);
    state.generatedRuleCount = 0;
    return [];
  }
}

function flattenRules(value, path, output) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenRules(item, path.concat(index), output));
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (typeof value.pattern === 'string' && typeof value.tag === 'string') {
    output.push({
      name: value.name || 'unnamed_rule',
      tag: value.tag,
      pattern: value.pattern,
      flags: value.flags || '',
      source: value.source || '',
      groupPath: path.filter((part) => typeof part === 'string').join('.')
    });
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    flattenRules(nested, path.concat(key), output);
  }
}

function sampleForRule(rule) {
  if (knownSamples[rule.pattern]) return knownSamples[rule.pattern];
  return regexToReadableSample(rule.pattern);
}

function firstRegexMatch(rule, sample) {
  try {
    const flags = Array.from(new Set(`${rule.flags || 'i'}g`.split(''))).filter((flag) => 'dgimsuvy'.includes(flag)).join('');
    const match = new RegExp(rule.pattern, flags).exec(sample);
    return match && match[0] ? match[0] : '';
  } catch (_error) {
    return '';
  }
}

function regexToReadableSample(pattern) {
  const sample = String(pattern)
    .replace(/\^\s\*/g, '')
    .replace(/\s\*\$/g, '')
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\[\.!\?,;:\]\*/g, '')
    .replace(/\\b/g, '')
    .replace(/\\s\+/g, ' ')
    .replace(/\\s\*/g, '')
    .replace(/\\s/g, ' ')
    .replace(/\(\?:/g, '(')
    .replace(/\(([^()|]+)\|[^()]+\)/g, '$1')
    .replace(/\(([^()]+)\)\?/g, '')
    .replace(/\(([^()]+)\)/g, '$1')
    .replace(/\[[^\]]+\]/g, 'stop')
    .replace(/\?/g, '')
    .replace(/\+/g, '')
    .replace(/\*/g, '')
    .replace(/\\/g, '')
    .replace(/\|.*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return sample || 'stop';
}

function loadManualChecks() {
  try {
    return JSON.parse(window.localStorage.getItem(MANUAL_KEY) || '{}');
  } catch (_error) {
    return {};
  }
}

function saveManualChecks() {
  window.localStorage.setItem(MANUAL_KEY, JSON.stringify(state.manualChecks));
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

const curatedConversations = [
  {
    id: 'opt-out-direct',
    title: 'Jordan M.',
    summary: 'Direct opt-out language',
    category: 'opt_out',
    messages: [
      { id: 'm1', direction: 'outbound', text: 'Thanks for shopping with us. Reply if you need help with your order.', time: '10:11 AM' },
      { id: 'm2', direction: 'inbound', text: 'Please stop texting me and remove me from your list.', time: '10:12 AM', expects: [
        { tag: 'opt_out', contains: 'stop texting' },
        { tag: 'opt_out', contains: 'remove me from your list' }
      ] }
    ]
  },
  {
    id: 'txt-source-question',
    title: 'Casey R.',
    summary: 'Source and why-texting questions',
    category: 'txt',
    messages: [
      { id: 'm1', direction: 'inbound', text: 'Why are you texting me? How did you get my number?', time: '10:13 AM', expects: [
        { tag: 'txt', contains: 'Why are you texting me' },
        { tag: 'txt', contains: 'How did you get my number' }
      ] }
    ]
  },
  {
    id: 'too-many-texts',
    title: 'Morgan P.',
    summary: 'Too many texts request',
    category: 'tmt',
    messages: [
      { id: 'm1', direction: 'inbound', text: 'You send too many texts. Please text me less often.', time: '10:14 AM', expects: [
        { tag: 'tmt', contains: 'too many texts' },
        { tag: 'tmt', contains: 'text me less often' }
      ] }
    ]
  },
  {
    id: 'fuzzy-opt-out',
    title: 'Riley S.',
    summary: 'Fuzzy intent without explicit unsubscribe',
    category: 'fuzzy_opt_out',
    messages: [
      { id: 'm1', direction: 'inbound', text: 'I am not interested anymore. I am done with this brand.', time: '10:15 AM', expects: [
        { tag: 'fuzzy_opt_out', contains: 'not interested' },
        { tag: 'fuzzy_opt_out', contains: 'done with this brand' }
      ] }
    ]
  },
  {
    id: 'not-opt-out-service',
    title: 'Taylor S.',
    summary: 'Service requests classify as not opt out only when standalone',
    category: 'not_opt_out',
    messages: [
      { id: 'm1', direction: 'inbound', text: 'Where is my order?', time: '10:16 AM', expects: [
        { tag: 'not_opt_out', contains: 'Where is my order' }
      ] },
      { id: 'm2', direction: 'inbound', text: 'Update my address.', time: '10:17 AM', expects: [
        { tag: 'not_opt_out', contains: 'Update my address' }
      ] },
      { id: 'm3', direction: 'inbound', text: 'Can you help me track my order and update my address?', time: '10:18 AM' }
    ]
  },
  {
    id: 'overlap-priority',
    title: 'Avery L.',
    summary: 'Overlapping opt-out and frequency language',
    category: 'overlap',
    messages: [
      { id: 'm1', direction: 'inbound', text: 'Stop sending me so many messages. Slow down on the texts.', time: '10:18 AM', expects: [
        { tag: 'tmt', contains: 'Stop sending me so many messages' },
        { tag: 'tmt', contains: 'Slow down on the texts' }
      ] }
    ]
  },
  {
    id: 'outbound-negative',
    title: 'Outbound Guard',
    summary: 'Outbound phrases and embedded non-opt-outs must not count',
    category: 'negative',
    messages: [
      { id: 'm1', direction: 'outbound', text: 'If you want to unsubscribe, reply STOP at any time.', time: '10:22 AM' },
      { id: 'm2', direction: 'inbound', text: 'Thanks, I just needed help with sizing.', time: '10:23 AM' }
    ]
  },
  {
    id: 'hidden-negative',
    title: 'Hidden Message Guard',
    summary: 'Hidden inbound phrase should not be highlighted or counted',
    category: 'negative',
    messages: [
      { id: 'm1', direction: 'inbound', text: 'Please stop texting this hidden row.', time: 'hidden', hidden: true },
      { id: 'm2', direction: 'inbound', text: 'Where is my order?', time: 'visible', expects: [
        { tag: 'not_opt_out', contains: 'Where is my order' }
      ] }
    ]
  },
  {
    id: 'dynamic-mutation',
    title: 'Dynamic Mutation',
    summary: 'Use the toolbar button to append a new inbound message',
    category: 'dynamic',
    messages: [
      { id: 'm1', direction: 'outbound', text: 'This thread starts quiet. Add the dynamic inbound message from the toolbar.', time: '10:25 AM' },
      { id: 'm2', direction: 'inbound', text: 'Please stop texting me so much.', time: 'added live', when: 'dynamic', expects: [
        { tag: 'opt_out', contains: 'stop texting' }
      ] }
    ]
  },
  {
    id: 'custom-keyword',
    title: 'Custom Keyword',
    summary: `Add "${CUSTOM_KEYWORD}" in the extension popup`,
    category: 'custom_keywords',
    messages: [
      { id: 'm1', direction: 'inbound', text: `Please flag ${CUSTOM_KEYWORD} for this shopper.`, time: '10:27 AM', expects: [
        { tag: 'custom_keywords', contains: CUSTOM_KEYWORD }
      ] }
    ]
  }
];

const knownSamples = {
  '^done$': 'done',
  '^stop$': 'stop',
  '^quit$': 'quit',
  '^end$': 'end',
  '^remove$': 'remove',
  '^quiet$': 'quiet',
  '^unsubscribe$': 'unsubscribe',
  '^finished$': 'finished',
  '^pause$': 'pause',
  '^shush$': 'shush',
  '^bye$': 'bye'
};

init().catch((error) => {
  console.error('[QA site] Failed to initialize:', error);
  els.issueList.appendChild(renderIssue('Test site failed to initialize. Check the console for details.', 'info'));
});
