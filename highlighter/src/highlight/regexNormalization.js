(function installRegexNormalization(globalScope) {
  'use strict';

  function isRegexQuestionMarkSyntax(output) {
    const previous = String(output || '').at(-1);
    return Boolean(previous && !/[\s(|]/.test(previous));
  }

  function normalizeRegexPatternForSearch(pattern) {
    let output = '';
    let escaped = false;
    let inCharacterClass = false;
    let inQuantifierBrace = false;
    let skippedQuantifiableToken = false;
    const text = String(pattern || '');

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) {
        output += char;
        escaped = false;
        skippedQuantifiableToken = false;
        continue;
      }
      if (char === '\\') {
        output += char;
        escaped = true;
        skippedQuantifiableToken = false;
        continue;
      }
      if (char === '[') inCharacterClass = true;
      if (char === ']') inCharacterClass = false;
      if (!inCharacterClass && char === '{') {
        inQuantifierBrace = true;
        output += char;
        continue;
      }
      if (inQuantifierBrace) {
        output += char;
        if (char === '}') inQuantifierBrace = false;
        continue;
      }
      if (!inCharacterClass && /['`\u2018\u2019\u201c\u201d]/.test(char)) {
        skippedQuantifiableToken = true;
        continue;
      }
      if (!inCharacterClass && char === '?' && skippedQuantifiableToken) {
        skippedQuantifiableToken = false;
        continue;
      }
      skippedQuantifiableToken = false;
      if (!inCharacterClass && char === '?' && (output.endsWith('(') || isRegexQuestionMarkSyntax(output))) {
        output += char;
        continue;
      }
      if (!inCharacterClass && /[!=]/.test(char) && (output.endsWith('(?') || output.endsWith('(?<'))) {
        output += char;
        continue;
      }
      if (!inCharacterClass && char === ':' && output.endsWith('(?')) {
        output += char;
        continue;
      }
      if (!inCharacterClass && char === '.' && /[*+]/.test(text[index + 1] || '')) {
        output += char;
        continue;
      }
      if (!inCharacterClass && /[-,.:;!?]/.test(char)) {
        output += '\\s+';
        continue;
      }
      output += char;
    }
    return output.replace(/\\s\+\s+/g, '\\s+');
  }

  globalScope.AMH_REGEX_NORMALIZATION = Object.freeze({ normalizeRegexPatternForSearch });
})(typeof globalThis !== 'undefined' ? globalThis : this);
