// ==================================================================================================
// EXTERNAL SERVICE - YOUTUBE
// ==================================================================================================

import { DataParser } from '../utils/dataParser.js';
import { SettingsManager } from '../storage/settings.js';

export class YouTubeService {
  static async fetchSubtitles(songInfo) {
    try {
      const subtitleInfo = songInfo.subtitle;
      if (!subtitleInfo?.captionTracks?.length) return null;

      // Filter out ASR (auto-generated) and auto-translated captions
      // Auto-translated captions have vssId starting with 'a.' (e.g., 'a.ar' for Arabic auto-translate)
      const validTracks = subtitleInfo.captionTracks.filter(
        t => t.kind !== 'asr' && !t.vssId?.startsWith('a.')
      );
      
      if (!validTracks.length) return null;

      // Determine preferred language: settings override > browser UI language (fallback 'en')
      const translationSettings = await SettingsManager.getTranslationSettings();
      const { overrideTranslateTarget = false, customTranslateTarget = '' } = translationSettings;
      
      const pBrowser = chrome || browser;
      const browserLang = (typeof pBrowser !== 'undefined' && pBrowser.i18n && typeof pBrowser.i18n.getUILanguage === 'function') 
        ? pBrowser.i18n.getUILanguage() 
        : 'en';
      const preferredLang = (overrideTranslateTarget && customTranslateTarget ? customTranslateTarget : browserLang).split('-')[0];

      // Selection order: 1) default/original caption, 2) preferred language, 3) any remaining valid track
      // This ensures we avoid auto-translated captions and prefer original content
      const defaultTrack = validTracks.find(t => t.isDefault);
      let selectedTrack = defaultTrack
        || validTracks.find(t => (t.languageCode || t.lang || '').split('-')[0] === preferredLang)
        || validTracks.find(t => t.vssId && t.vssId.includes(`.${preferredLang}`))
        || validTracks[0];

      if (!selectedTrack) return null; // No suitable captions

      const url = new URL(selectedTrack.baseUrl || selectedTrack.url);
      url.searchParams.set('fmt', 'json3');

      const response = await fetch(url.toString());
      if (!response.ok) return null;

      const data = await response.json();
      const langCode = (selectedTrack.languageCode || selectedTrack.lang || (selectedTrack.vssId ? selectedTrack.vssId.split('.').pop() : '') || '').split('-')[0];
      return DataParser.parseYouTubeSubtitles(data, { ...songInfo, language: langCode });
    } catch (error) {
      console.error("YouTube subtitles error:", error);
      return null;
    }
  }
}

