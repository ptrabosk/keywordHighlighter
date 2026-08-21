const SETTINGS_KEY = 'amhSettings';

const DEFAULT_SETTINGS = {
  enabled: true,
  showTooltip: true,
  opacity: 0.40,
  selector: 'div[class*="type-INBOUND"] p[class*="variant-caption"]',
  customKeywords: [],
  customKeywordTextByPattern: {},
  categories: {
    user_added: { enabled: true, label: 'User added', color: '#a855f7', priority: 5 },
    opt_out: { enabled: true, label: 'Opt out', color: '#DF6A30', priority: 10 },
    fuzzy_opt_out: { enabled: true, label: 'Fuzzy opt out', color: '#F0B368', priority: 20 },
    test: { enabled: true, label: 'Test', color: '#22c55e', priority: 25 },
    tmt: { enabled: true, label: 'Too many texts', color: '#A3C3F1', priority: 30 },
    txt: { enabled: true, label: 'Texting/source question', color: '#F6DA71', priority: 40 },
    reply: { enabled: true, label: 'Reply', color: '#D6DF22', priority: 50 },
    no_action: { enabled: false, label: 'No action', color: '#94a3b8', priority: 60 },
    close: { enabled: true, label: 'Close', color: '#FAF4DF', priority: 70 }
  }
};

globalThis.SETTINGS_KEY = SETTINGS_KEY;
globalThis.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
