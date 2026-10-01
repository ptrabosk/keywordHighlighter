(function installRegexNormalization(globalScope) {
  'use strict';

  // Rewrites a registry regex so it runs against normalized message text:
  // apostrophes/quotes are dropped (with any "?" that made them optional) and
  // literal punctuation becomes `\s+`, while regex syntax is left intact.
  const DROPPED_QUOTES = /['`‘’“”]/;
  const PUNCTUATION = /[-,.:;!?]/;

  function normalizeRegexPatternForSearch(pattern) {
    const text = String(pattern || '');
    const state = {
      output: '',
      escaped: false,
      inCharacterClass: false,
      inQuantifierBrace: false,
      skippedQuantifiableToken: false
    };
    for (let index = 0; index < text.length; index += 1) {
      consumeCharacter(state, text[index], text[index + 1] || '');
    }
    return state.output.replace(/\\s\+\s+/g, '\\s+');
  }

  function consumeCharacter(state, char, next) {
    if (consumeEscape(state, char)) return;
    trackCharacterClass(state, char);
    if (consumeQuantifierBrace(state, char)) return;
    if (state.inCharacterClass) {
      state.skippedQuantifiableToken = false;
      state.output += char;
      return;
    }
    consumeOutsideCharacterClass(state, char, next);
  }

  // Escaped characters (and the backslash itself) are copied verbatim.
  function consumeEscape(state, char) {
    if (!state.escaped && char !== '\\') return false;
    state.output += char;
    state.escaped = !state.escaped;
    state.skippedQuantifiableToken = false;
    return true;
  }

  function trackCharacterClass(state, char) {
    if (char === '[') state.inCharacterClass = true;
    if (char === ']') state.inCharacterClass = false;
  }

  // `{n,m}` quantifiers are copied verbatim so their commas stay literal.
  function consumeQuantifierBrace(state, char) {
    if (!state.inCharacterClass && char === '{') {
      state.inQuantifierBrace = true;
      state.output += char;
      return true;
    }
    if (!state.inQuantifierBrace) return false;
    state.output += char;
    if (char === '}') state.inQuantifierBrace = false;
    return true;
  }

  function consumeOutsideCharacterClass(state, char, next) {
    if (DROPPED_QUOTES.test(char)) {
      state.skippedQuantifiableToken = true;
      return;
    }
    const followsDroppedQuote = state.skippedQuantifiableToken;
    state.skippedQuantifiableToken = false;
    if (char === '?' && followsDroppedQuote) return;
    if (isPreservedRegexSyntax(state.output, char, next)) {
      state.output += char;
      return;
    }
    state.output += PUNCTUATION.test(char) ? '\\s+' : char;
  }

  function isPreservedRegexSyntax(output, char, next) {
    switch (char) {
      case '?':
        return output.endsWith('(') || isRegexQuestionMarkSyntax(output);
      case '!':
      case '=':
        return output.endsWith('(?') || output.endsWith('(?<');
      case ':':
        return output.endsWith('(?');
      case '.':
        return next === '*' || next === '+';
      default:
        return false;
    }
  }

  function isRegexQuestionMarkSyntax(output) {
    const previous = String(output || '').at(-1);
    return Boolean(previous && !/[\s(|]/.test(previous));
  }

  globalScope.AMH_REGEX_NORMALIZATION = Object.freeze({ normalizeRegexPatternForSearch });
})(typeof globalThis !== 'undefined' ? globalThis : this);
