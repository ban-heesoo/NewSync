// ==================================================================================================
// SETTINGS MANAGEMENT
// ==================================================================================================

import { PROVIDERS } from '../constants.js';

export class SettingsManager {
  static async get(keys) {
    if (typeof browser !== 'undefined' && browser.storage?.local) {
      return browser.storage.local.get(keys);
    }
    return new Promise(resolve => chrome.storage.local.get(keys, resolve));
  }

  static async getLyricsSettings() {
    const settings = await this.get({
      'lyricsProviderOrder': 'kpoe,lrcred,unison,kugou,lrclib,ytmusic,ytlyrics',
      'lyricsSourceOrder': 'apple,qq',
      'customKpoeUrl': '',
      'cacheStrategy': 'aggressive',
      'preferUnisonVideo': false
    });
    const providers = typeof settings.lyricsProviderOrder === 'string'
      ? settings.lyricsProviderOrder.split(',')
          .map(p => p.trim())
          .map(p => (p === 'biniLyrics' || p === 'binilyrics' ? PROVIDERS.LRCRED : p))
          .filter(Boolean)
      : [];
    settings.lyricsProviderOrder = providers.length ? [...new Set(providers)].join(',') : 'kpoe,lrcred,unison,kugou,lrclib,ytmusic,ytlyrics';

    const sources = typeof settings.lyricsSourceOrder === 'string'
      ? settings.lyricsSourceOrder.split(',').map(source => source.trim()).filter(source => ['apple', 'qq'].includes(source))
      : [];
    settings.lyricsSourceOrder = sources.length ? sources.join(',') : 'apple,qq';
    return settings;
  }

  static async getTranslationSettings() {
    const settings = await this.get({
      'translationProvider': PROVIDERS.GOOGLE,
      'romanizationProvider': PROVIDERS.GOOGLE,
      'transliterationTargetScript': 'latin',
      'geminiApiKey': '',
      'geminiModel': 'gemini-pro',
      'geminiRomanizationModel': 'gemini-pro',
      'overrideTranslateTarget': false,
      'customTranslateTarget': '',
      'overrideGeminiPrompt': false,
      'customGeminiPrompt': '',
      'overrideGeminiRomanizePrompt': false,
      'customGeminiRomanizePrompt': '',
      'openRouterApiKey': '',
      'openRouterModel': 'google/gemini-2.0-flash-001',
      'deeplApiKey': ''
    });
    if (settings.translationProvider === 'deeplKeyless') {
      settings.translationProvider = PROVIDERS.DEEPL_KEYLESS;
    }
    if (!settings.romanizationProvider || settings.romanizationProvider === PROVIDERS.OFFLINE) {
      settings.romanizationProvider = PROVIDERS.GOOGLE;
    }
    return settings;
  }
}
