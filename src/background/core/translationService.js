// ==================================================================================================
// TRANSLATION SERVICE
// ==================================================================================================

import { state } from '../storage/state.js';
import { translationsDB } from '../storage/database.js';
import { SettingsManager } from '../storage/settings.js';
import { PROVIDERS } from '../constants.js';
import { Utilities } from '../utils/utilities.js';
import { LyricsService } from './lyricsService.js';
import { DataParser } from '../utils/dataParser.js';
import { getPrimaryLanguageCode, findFallbackLanguage } from '../../lib/parser.js';

import { UnisonService } from '../services/unisonService.js';
import { GoogleProvider } from '../services/translation/providers/GoogleProvider.js';
import { GeminiProvider } from '../services/translation/providers/GeminiProvider.js';
import { OpenRouterProvider } from '../services/translation/providers/OpenRouterProvider.js';
import { DeepLProvider } from '../services/translation/providers/DeepLProvider.js';
import { DeepLKeylessProvider } from '../services/translation/providers/DeepLKeylessProvider.js';

export class TranslationService {
  static unisonRomanizeCache = new Map();

  static createCacheKey(songInfo, action, targetLang, targetScript) {
    const baseLyricsCacheKey = LyricsService.createCacheKey(songInfo);
    return `${baseLyricsCacheKey} - ${action} - ${targetLang} - ${targetScript}`;
  }

  static async getOrFetch(songInfo, action, targetLang, forceReload = false) {
    const settings = await SettingsManager.getTranslationSettings();
    const customLang = settings.customTranslateTarget ? settings.customTranslateTarget.trim() : '';
    const actualTargetLang = (customLang && customLang !== 'auto')
      ? customLang
      : (targetLang || 'en');

    const targetScript = settings.transliterationTargetScript || 'latin';
    const cacheSuffix = action === 'translate'
      ? `${settings.translationProvider || PROVIDERS.GOOGLE}`
      : targetScript;

    const translatedKey = this.createCacheKey(songInfo, action, actualTargetLang, cacheSuffix);

    const { lyrics: originalLyrics, version: originalVersion } =
      await LyricsService.getOrFetch(songInfo, forceReload);

    if (Utilities.isEmptyLyrics(originalLyrics)) {
      throw new Error('Original lyrics not found or empty');
    }

    if (!forceReload) {
      const cached = await this.getCached(translatedKey, originalVersion);
      if (cached) return cached;
    }

    const translatedData = await this.performTranslation(
      originalLyrics,
      action,
      actualTargetLang,
      settings,
      songInfo,
      targetScript
    );

    const finalTranslatedLyrics = { ...originalLyrics, data: translatedData };

    state.setCached(translatedKey, {
      translatedLyrics: finalTranslatedLyrics,
      originalVersion
    });

    await translationsDB.set({
      key: translatedKey,
      translatedLyrics: finalTranslatedLyrics,
      originalVersion
    });

    return finalTranslatedLyrics;
  }

  static async getCached(key, originalVersion) {
    // Check memory
    if (state.hasCached(key)) {
      const cached = state.getCached(key);
      if (cached && cached.originalVersion === originalVersion) {
        return cached.translatedLyrics;
      } else {
        state.deleteCached(key);
      }
    }

    const dbCached = await translationsDB.get(key);
    if (dbCached) {
      if (dbCached.originalVersion === originalVersion) {
        state.setCached(key, {
          translatedLyrics: dbCached.translatedLyrics,
          originalVersion: dbCached.originalVersion
        });
        return dbCached.translatedLyrics;
      } else {
        await translationsDB.delete(key);
      }
    }

    return null;
  }

  static getProvider(providerName, settings) {
    switch (providerName) {
      case PROVIDERS.GEMINI:
        return new GeminiProvider(settings);
      case PROVIDERS.OPENROUTER:
        return new OpenRouterProvider(settings);
      case PROVIDERS.DEEPL:
        return new DeepLProvider(settings);
      case PROVIDERS.DEEPL_KEYLESS:
      case 'deeplKeyless':
        return new DeepLKeylessProvider(settings);
      case PROVIDERS.OFFLINE:
      case PROVIDERS.GOOGLE:
      default:
        return new GoogleProvider(settings);
    }
  }

  static async performTranslation(originalLyrics, action, targetLang, settings, songInfo = {}, targetScript = 'latin') {
    if (action === 'translate') {
      return this.translate(originalLyrics, targetLang, settings, songInfo);
    } else if (action === 'romanize') {
      return this.romanize(originalLyrics, settings, songInfo, targetLang, targetScript);
    }

    return originalLyrics.data;
  }

  static resolveEmbeddedTranslation(line, targetLang) {
    if (!line || !targetLang) return null;

    if (line.translations && typeof line.translations === 'object') {
      const availableLangs = Object.keys(line.translations);
      const matchedLang = findFallbackLanguage(availableLangs, targetLang);
      if (matchedLang && line.translations[matchedLang]?.text) {
        return line.translations[matchedLang];
      }
    }

    const embedded = line.translation;
    if (embedded && embedded.text) {
      const targetPrimary = getPrimaryLanguageCode(targetLang).toLowerCase();
      const embeddedPrimary = getPrimaryLanguageCode(embedded.lang || '').toLowerCase();
      if (embeddedPrimary && embeddedPrimary === targetPrimary) {
        return embedded;
      }
    }

    return null;
  }

  static async translate(originalLyrics, targetLang, settings, songInfo = {}) {
    const provider = this.getProvider(settings.translationProvider, settings);

    const linesToTranslate = [];
    const indicesToTranslate = [];
    const finalTranslations = new Array(originalLyrics.data.length).fill(null);
    const resolvedTranslationObjects = new Array(originalLyrics.data.length).fill(null);

    originalLyrics.data.forEach((line, index) => {
      const matched = this.resolveEmbeddedTranslation(line, targetLang);
      if (matched && matched.text) {
        resolvedTranslationObjects[index] = matched;
        let combinedTransText = matched.text;
        if (matched.backgroundText && !combinedTransText.includes(matched.backgroundText)) {
          combinedTransText = `${combinedTransText} (${matched.backgroundText})`;
        }
        finalTranslations[index] = combinedTransText;
      } else {
        linesToTranslate.push(line.text);
        indicesToTranslate.push(index);
      }
    });

    if (linesToTranslate.length > 0) {
      let fetchedTranslations;

      if (settings.translationProvider === PROVIDERS.GOOGLE) {
        try {
          const allTexts = originalLyrics.data.map(l => l.text || '');
          const unisonData = await UnisonService.translateBatch(allTexts, targetLang, 'auto', songInfo?.videoId);
          if (unisonData && Array.isArray(unisonData.lines) && unisonData.lines.length === allTexts.length) {
            const classifier = Utilities.createScriptClassifier(allTexts);
            let filledCount = 0;

            // Also warm Unison's coalesced romanization cache so concurrent romanization skips extra network calls
            const romCacheEntries = allTexts.map((txt, idx) => {
              const u = unisonData.lines[idx];
              if (u?.romanization && classifier.hasNonLatinScript(txt)) {
                return u.romanization;
              }
              return null;
            });
            if (romCacheEntries.some(Boolean)) {
              const cacheKey = `${songInfo?.videoId || ''}::${allTexts.join('\n')}`;
              if (this.unisonRomanizeCache.size > 30) {
                this.unisonRomanizeCache.delete(this.unisonRomanizeCache.keys().next().value);
              }
              this.unisonRomanizeCache.set(cacheKey, romCacheEntries);
            }

            fetchedTranslations = indicesToTranslate.map(origIdx => {
              const u = unisonData.lines[origIdx];
              const origText = allTexts[origIdx];
              if (u && (u.translation !== undefined)) {
                filledCount++;
                if (u.translation && u.needsTranslation) {
                  return u.translation;
                }
                return origText;
              }
              return null;
            });

            if (filledCount < indicesToTranslate.length) {
              fetchedTranslations = null;
            }
          }
        } catch (unisonErr) {
          console.warn('Unison batch translate fallback to Google:', unisonErr?.message);
          fetchedTranslations = null;
        }
      }

      if (!fetchedTranslations) {
        try {
          fetchedTranslations = await provider.translate(linesToTranslate, targetLang, songInfo);
        } catch (error) {
          console.warn(`Translation with ${settings.translationProvider} failed, falling back to Google:`, error);
          // Fallback to Google if the primary provider fails
          if (settings.translationProvider !== PROVIDERS.GOOGLE) {
            const fallbackProvider = new GoogleProvider(settings);
            fetchedTranslations = await fallbackProvider.translate(linesToTranslate, targetLang, songInfo);
          } else {
            throw error;
          }
        }
      }

      fetchedTranslations.forEach((trans, i) => {
        const originalIndex = indicesToTranslate[i];
        finalTranslations[originalIndex] = trans;
      });
    }

    return originalLyrics.data.map((line, index) => {
      const matchedObj = resolvedTranslationObjects[index];
      const out = {
        ...line,
        translatedText: finalTranslations[index] || line.text
      };
      if (matchedObj) {
        out.translation = matchedObj;
        if (Array.isArray(matchedObj.syllabus) && matchedObj.syllabus.length > 0) {
          out.translatedSyllabus = matchedObj.syllabus;
          out.chunk = matchedObj.syllabus;
        }
        if (matchedObj.backgroundText) {
          out.translatedBackgroundText = matchedObj.backgroundText;
        }
      }
      return out;
    });
  }

  /**
   * Builds the ordered list of providers to try for romanization/transliteration.
   */
  static resolveRomanizationProviders(settings, targetScript) {
    const candidates = [];
    const push = (name) => {
      if (name && !candidates.includes(name)) candidates.push(name);
    };

    const selected = (!settings.romanizationProvider || settings.romanizationProvider === PROVIDERS.OFFLINE)
      ? PROVIDERS.GOOGLE
      : settings.romanizationProvider;
    const isAiProvider = selected === PROVIDERS.GEMINI || selected === PROVIDERS.OPENROUTER;

    if (targetScript && targetScript !== 'latin') {
      if (isAiProvider) push(selected);
      if (settings.geminiApiKey) push(PROVIDERS.GEMINI);
      if (settings.openRouterApiKey) push(PROVIDERS.OPENROUTER);
    } else {
      push(selected);
      push(PROVIDERS.GOOGLE);
    }

    return candidates;
  }

  static async romanize(originalLyrics, settings, songInfo = {}, targetLang, targetScript = 'latin') {
    if (targetScript === 'latin') {
      const hasPrebuilt = originalLyrics.data.some(line =>
        line.romanizedText ||
        (line.syllabus && line.syllabus.some(syl => syl.romanizedText)) ||
        (line.transliterations && Object.keys(line.transliterations).length > 0)
      );

      if (hasPrebuilt) {
        console.log("Using prebuilt romanization");
        return originalLyrics.data.map(line => {
          let chosenTranslit = line.transliteration;
          if (line.transliterations && typeof line.transliterations === 'object') {
            const avail = Object.keys(line.transliterations);
            const matchedLang = (targetLang && findFallbackLanguage(avail, targetLang)) || avail[0];
            if (matchedLang && line.transliterations[matchedLang]) {
              chosenTranslit = line.transliterations[matchedLang];
            }
          }

          let alignedSyls = line.syllabus;
          if (chosenTranslit && Array.isArray(line.syllabus) && line.syllabus.length > 0) {
            const newlyAligned = DataParser.alignTransliterationSyllabus(line.syllabus, chosenTranslit);
            if (newlyAligned) alignedSyls = newlyAligned;
          }

          const hasWordRoman = Array.isArray(alignedSyls) && alignedSyls.some(s => s.romanizedText);
          const chunk = hasWordRoman
            ? alignedSyls.map(s => ({ text: s.romanizedText || s.text }))
            : undefined;
          const resolvedText = chosenTranslit?.text || line.romanizedText || line.text;

          return {
            text: resolvedText,
            romanizedText: resolvedText,
            chunk
          };
        });
      }
    }

    const candidates = this.resolveRomanizationProviders(settings, targetScript);
    let lastError = null;

    if (targetScript === 'latin' && candidates[0] === PROVIDERS.GOOGLE) {
      const allTexts = originalLyrics.data.map(l => l.text || '');
      const classifier = Utilities.createScriptClassifier(allTexts);
      const hasAnyNonLatin = allTexts.some(t => classifier.hasNonLatinScript(t));
      if (!hasAnyNonLatin) {
        return originalLyrics.data.map(line => ({ ...line }));
      }

      // Check coalesced Unison romanization cache or hit Unison /translate for line-synced / non-Word lyrics
      if (originalLyrics.type !== 'Word') {
        const cacheKey = `${songInfo?.videoId || ''}::${allTexts.join('\n')}`;
        let unisonRoms = this.unisonRomanizeCache.get(cacheKey);
        if (!unisonRoms) {
          try {
            const uData = await UnisonService.translateBatch(allTexts, targetLang || 'en', 'auto', songInfo?.videoId);
            if (uData && Array.isArray(uData.lines) && uData.lines.length === allTexts.length) {
              unisonRoms = allTexts.map((txt, idx) =>
                (uData.lines[idx]?.romanization && classifier.hasNonLatinScript(txt)) ? uData.lines[idx].romanization : null
              );
            }
          } catch (e) {}
        }

        if (Array.isArray(unisonRoms) && unisonRoms.some(Boolean)) {
          return originalLyrics.data.map((line, index) => {
            const rom = unisonRoms[index] || line.text;
            return {
              ...line,
              text: rom,
              romanizedText: rom
            };
          });
        }
      }
    }

    for (const providerName of candidates) {
      try {
        const provider = this.getProvider(providerName, settings);
        return await provider.romanize(originalLyrics, targetLang, songInfo, targetScript);
      } catch (error) {
        lastError = error;
        console.warn(`Romanization with ${providerName} failed, trying next available provider:`, error.message);
      }
    }

    if (lastError) throw lastError;
    throw new Error(
      targetScript !== 'latin'
        ? `Transliteration into "${targetScript}" script requires Gemini or OpenRouter. Please set an API key in the settings.`
        : 'Romanization failed: no provider available.'
    );
  }
}
