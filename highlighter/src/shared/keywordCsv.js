(function installKeywordCsv(globalScope) {
  'use strict';

  const HEADERS = Object.freeze(['keyword']);
  // Backups exported before hover text was removed; the second column is ignored.
  const LEGACY_HEADERS = Object.freeze(['keyword', 'hover text']);

  function parseRows(input) {
    const text = String(input || '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let afterQuote = false;

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (inQuotes) {
        if (character === '"') {
          if (text[index + 1] === '"') {
            field += '"';
            index += 1;
          } else {
            inQuotes = false;
            afterQuote = true;
          }
        } else {
          field += character;
        }
        continue;
      }

      if (afterQuote && character !== ',' && character !== '\r' && character !== '\n') {
        throw new Error('Unexpected character after closing quote');
      }
      if (character === '"') {
        if (field) throw new Error('Unexpected quote in unquoted field');
        inQuotes = true;
        afterQuote = false;
      } else if (character === ',') {
        row.push(field);
        field = '';
        afterQuote = false;
      } else if (character === '\r' || character === '\n') {
        if (character === '\r' && text[index + 1] === '\n') index += 1;
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        afterQuote = false;
      } else {
        field += character;
      }
    }

    if (inQuotes) throw new Error('Unterminated quoted field');
    row.push(field);
    rows.push(row);
    while (rows.length && rows.at(-1).every((value) => value === '')) rows.pop();
    return rows;
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
