// ==================================================================================================
// UTILITIES
// ==================================================================================================

export class Utilities {
  static isEmptyLyrics(lyrics) {
    return !lyrics || 
           !lyrics.data || 
           lyrics.data.length === 0 || 
           lyrics.data.every(line => !line.text);
  }

  static isPurelyLatinScript(text) {
    return /^[\p{Script=Latin}\p{N}\p{P}\p{S}\s]*$/u.test(text);
  }

  /**
   * Ported from better-lyrics nonLatinScript.ts:
   * Distinguishes genuine non-Latin words from stylized Latin words that substitute
   * a minority of Cyrillic or Greek lookalike letters (e.g. "Sтαr", "BОSS").
   */
  static createScriptClassifier(songLines = []) {
    const LATIN_LETTERS = /\p{Script=Latin}/gu;
    const LATIN_LOOKALIKE_LETTERS = /[\p{Script=Cyrillic}\p{Script=Greek}]/gu;
    const NON_LETTERS = /[^\p{L}\p{M}]+/u;
    const NON_LATIN_CHAR = /[^\p{Script=Latin}\p{N}\p{P}\p{S}\s]/u;

    const scriptBalance = (str) => ({
      latin: str ? (str.match(LATIN_LETTERS)?.length ?? 0) : 0,
      lookalikes: str ? (str.match(LATIN_LOOKALIKE_LETTERS)?.length ?? 0) : 0
    });

    const leansLatin = ({ latin, lookalikes }) =>
      latin === lookalikes ? null : latin > lookalikes;

    const songBalance = scriptBalance(Array.isArray(songLines) ? songLines.join('\n') : '');

    const isStylizedLatinWord = (word, lineBalance) => {
      const balance = scriptBalance(word);
      if (balance.lookalikes === 0) return false;
      const wLean = leansLatin(balance);
      if (wLean !== null) return wLean;
      const lLean = leansLatin(lineBalance);
      if (lLean !== null) return lLean;
      const sLean = leansLatin(songBalance);
      return sLean ?? false;
    };

    const hasNonLatinScript = (text) => {
      if (!text || this.isPurelyLatinScript(text)) return false;
      const lineBalance = scriptBalance(text);
      return text.split(NON_LETTERS).some(word => word && NON_LATIN_CHAR.test(word) && !isStylizedLatinWord(word, lineBalance));
    };

    return { hasNonLatinScript };
  }

  /**
   * Returns true if the text contains at least one character belonging to the
   * polished target script. Used to validate transliteration output and decide
   * which source lines already live in the requested target script.
   * @param {string} text - The text to inspect.
   * @param {string} script - One of: latin, japanese, korean, cyrillic, devanagari, arabic, hebrew, greek, thai.
   * @returns {boolean}
   */
  static containsScript(text, script) {
    if (!text) return false;
    switch (script) {
      case 'japanese':
        return /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
      case 'korean':
        return /[\p{Script=Hangul}]/u.test(text);
      case 'cyrillic':
        return /[\p{Script=Cyrillic}]/u.test(text);
      case 'devanagari':
        return /[\p{Script=Devanagari}]/u.test(text);
      case 'arabic':
        return /[\p{Script=Arabic}]/u.test(text);
      case 'hebrew':
        return /[\p{Script=Hebrew}]/u.test(text);
      case 'greek':
        return /[\p{Script=Greek}]/u.test(text);
      case 'thai':
        return /[\p{Script=Thai}]/u.test(text);
      case 'latin':
        return /[\p{Script=Latin}]/u.test(text);
      default:
        return false;
    }
  }

  /**
   * Returns true when the text can be considered "already in" the target script,
   * i.e. lines that do not need to be transliterated.
   * For the latin target this requires the whole string to be Latin;
   * for other targets merely containing a character of that script is enough.
   * @param {string} text - The text to inspect.
   * @param {string} targetScript - The requested target script.
   * @returns {boolean}
   */
  static isInTargetScript(text, targetScript) {
    if (!text) return false;
    if (targetScript === 'latin' || !targetScript) {
      return this.isPurelyLatinScript(text);
    }
    return this.containsScript(text, targetScript);
  }

  static normalizeText(text) {
    return text
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/[^\w\s]/g, '');
  }

  static levenshteinDistance(s1, s2) {
    const track = Array(s2.length + 1)
      .fill(null)
      .map(() => Array(s1.length + 1).fill(null));

    for (let i = 0; i <= s1.length; i++) {
      track[0][i] = i;
    }

    for (let j = 0; j <= s2.length; j++) {
      track[j][0] = j;
    }

    for (let j = 1; j <= s2.length; j++) {
      for (let i = 1; i <= s1.length; i++) {
        const indicator = s1[i - 1] === s2[j - 1] ? 0 : 1;
        track[j][i] = Math.min(
          track[j][i - 1] + 1,
          track[j - 1][i] + 1,
          track[j - 1][i - 1] + indicator
        );
      }
    }

    return track[s2.length][s1.length];
  }
  
  static delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
