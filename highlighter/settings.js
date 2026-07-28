const SETTINGS_KEY = 'amhSettings';

const DEFAULT_SETTINGS = {
  enabled: true,
  showTooltip: true,
  opacity: 0.28,
  selector: 'div[class*="type-INBOUND"] p[class*="variant-caption"]',
  customKeywords: [],
  customKeywordTextByPattern: {},
  categories: {
    user_added: { enabled: true, label: 'User added', color: '#a855f7', priority: 5 },
    opt_out: { enabled: true, label: 'Opt out', color: '#ef4444', priority: 10 },
    fuzzy_opt_out: { enabled: true, label: 'Fuzzy opt out', color: '#f97316', priority: 20 },
    tmt: { enabled: true, label: 'Too many texts', color: '#eab308', priority: 30 },
    txt: { enabled: true, label: 'Texting/source question', color: '#8b5cf6', priority: 40 },
    reply: { enabled: true, label: 'Reply', color: '#22c55e', priority: 50 },
    no_action: { enabled: false, label: 'No action', color: '#94a3b8', priority: 60 },
    close: { enabled: true, label: 'Close', color: '#64748b', priority: 70 }
  }
};

globalThis.SETTINGS_KEY = SETTINGS_KEY;
globalThis.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
