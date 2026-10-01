(function installKeywordCsv(globalScope) {
  'use strict';

  const HEADERS = Object.freeze(['keyword']);
  // Backups exported before hover text was removed; the second column is ignored.
  const LEGACY_HEADERS = Object.freeze(['keyword', 'hover text']);

  // RFC 4180-style parser: quoted fields may contain commas, newlines, and
  // doubled quotes. Trailing blank rows are dropped.
  function parseRows(input) {
    const text = String(input || '').replace(/^\uFEFF/, '');
    const state = { rows: [], row: [], field: '', inQuotes: false, afterQuote: false };
    let index = 0;
    while (index < text.length) {
      index += state.inQuotes ? consumeQuoted(state, text, index) : consumeUnquoted(state, text, index);
    }
    if (state.inQuotes) throw new Error('Unterminated quoted field');
    endRow(state);
    while (state.rows.length && state.rows.at(-1).every((value) => value === '')) state.rows.pop();
    return state.rows;
  }

  // Each consumer returns the number of characters it used.
  function consumeQuoted(state, text, index) {
    if (text[index] !== '"') {
      state.field += text[index];
      return 1;
    }
    if (text[index + 1] === '"') {
      state.field += '"';
      return 2;
    }
    state.inQuotes = false;
    state.afterQuote = true;
    return 1;
  }

  function consumeUnquoted(state, text, index) {
    const character = text[index];
    if (state.afterQuote && !isFieldBoundary(character)) throw new Error('Unexpected character after closing quote');
    if (character === '"') {
      if (state.field) throw new Error('Unexpected quote in unquoted field');
      state.inQuotes = true;
      state.afterQuote = false;
      return 1;
    }
    if (character === ',') {
      endField(state);
      return 1;
    }
    if (character === '\r' || character === '\n') {
      endRow(state);
      return character === '\r' && text[index + 1] === '\n' ? 2 : 1;
    }
    state.field += character;
    return 1;
  }

  function isFieldBoundary(character) {
    return character === ',' || character === '\r' || character === '\n';
  }

  function endField(state) {
    state.row.push(state.field);
    state.field = '';
    state.afterQuote = false;
  }

  function endRow(state) {
    endField(state);
    state.rows.push(state.row);
    state.row = [];
  }

  function parseKeywordCsv(input) {
    const rows = parseRows(input);
    const header = rows.shift();
    const columns = [HEADERS, LEGACY_HEADERS].find((expected) => headerMatches(header, expected));
    if (!columns) throw new Error('Row 1 must contain the header keyword');

    return rows
      .filter((values) => values.some((value) => value !== ''))
      .map((values) => {
        if (values.length > columns.length) {
          throw new Error(`CSV rows may contain only ${columns.length === 1 ? 'one column' : 'two columns'}`);
        }
        return { keyword: values[0] || '' };
      });
  }

  function headerMatches(header, expected) {
    return Boolean(header) && header.length === expected.length && header.every((value, index) => value === expected[index]);
  }

  function escapeField(value) {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  function serializeKeywordCsv(entries = []) {
    const rows = [
      HEADERS,
      ...entries.map((entry) => [entry?.keyword || ''])
    ];
    return `${rows.map((values) => values.map(escapeField).join(',')).join('\r\n')}\r\n`;
  }

  globalScope.AMH_KEYWORD_CSV = Object.freeze({
    parseKeywordCsv,
    serializeKeywordCsv
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
