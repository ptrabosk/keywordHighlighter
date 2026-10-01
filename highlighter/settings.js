const SETTINGS_KEY = 'amhSettings';

const DEFAULT_SETTINGS = {
  enabled: true,
  showTooltip: true,
  opacity: 0.25,
  selector: 'div[class*="type-INBOUND"] p[class*="variant-caption"]',
  customKeywords: [],
  categories: {
    opt_out: { label: 'Opt out', color: '#fa8d75', priority: 10 },
    fuzzy_opt_out: { label: 'Fuzzy opt out', color: '#ffcb99', priority: 20 },
    txt: { label: 'Texting Explanation', color: '#8fded4', priority: 30 },
    tmt: { label: 'Too many texts', color: '#8fded4', priority: 40 },
    reply: { label: 'Reply', color: '#bbcfa4', priority: 50 },
    close: { label: 'Close', color: '#FAF4DF', priority: 60 },
    user_added: { label: 'User added', color: '#a855f7', priority: 70 }
  }
};

globalThis.SETTINGS_KEY = SETTINGS_KEY;
globalThis.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
