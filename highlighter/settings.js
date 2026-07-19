const SETTINGS_KEY = 'amhSettings';

const DEFAULT_SETTINGS = {
  enabled: true,
  showTooltip: true,
  opacity: 0.28,
  selector: 'div[class*="type-INBOUND"] p[class*="variant-caption"]',
  customKeywords: [],
  categories: {
    custom_keywords: { enabled: true, label: 'Custom keywords', color: '#a855f7', priority: 5 },
    opt_out: { enabled: true, label: 'Opt out', color: '#ef4444', priority: 10 },
    fuzzy_opt_out: { enabled: true, label: 'Fuzzy opt out', color: '#f97316', priority: 20 },
    tmt: { enabled: true, label: 'Too many texts', color: '#eab308', priority: 30 },
    txt: { enabled: true, label: 'Texting/source question', color: '#3b82f6', priority: 40 },
    not_opt_out: { enabled: true, label: 'Not opt out', color: '#22c55e', priority: 50 }
  }
};

globalThis.SETTINGS_KEY = SETTINGS_KEY;
globalThis.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
