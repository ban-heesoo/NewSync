// ==================================================================================================
// EXTERNAL SERVICE - UNISON (unison.betterlyrics.org with unison.boidu.dev fallback)
// ==================================================================================================

import { DataParser } from '../utils/dataParser.js';

const UNISON_BASE_URLS = [
  'https://unison.betterlyrics.org',
  'https://unison.boidu.dev'
];

export class UnisonService {
  static inFlightTranslate = new Map();

  static async fetch(songInfo, fetchOptions = {}) {
    // Try video ID lookup first (exact match)
    if (songInfo.videoId) {
      const result = await this.fetchByVideoId(songInfo.videoId, fetchOptions, songInfo);
      if (result) return result;
    }

    // Fall back to metadata search
    let lyrics = await this.fetchByMetadata(songInfo, fetchOptions);
    if (lyrics) return lyrics;

    if (songInfo.isVideo) {
      const cleanTitle = (songInfo.title || '')
        .replace('(Official Video)', '')
        .replace('(Official Music Video)', '')
        .trim();

      if (cleanTitle !== songInfo.title || songInfo.duration > 0) {
        lyrics = await this.fetchByMetadata({ ...songInfo, duration: 0, title: cleanTitle }, fetchOptions);
        if (lyrics) return lyrics;
      }
    }

    return null;
  }

  static async fetchByVideoId(videoId, fetchOptions, songInfo = {}) {
    const path = `/lyrics?v=${encodeURIComponent(videoId)}`;
    const result = await this.fetchWithFallback(path, fetchOptions, { ...songInfo, videoId });
    if (result) {
      result.byVideoId = true;
      if (!result.metadata) result.metadata = {};
      result.metadata.byVideoId = true;
      result.metadata.provider = 'unison';
      result.provider = 'unison';
    }
    return result;
  }

  static async fetchByMetadata(songInfo, fetchOptions) {
    const params = new URLSearchParams({
      song: songInfo.title,
      artist: songInfo.artist
    });

    if (songInfo.album) params.append('album', songInfo.album);
    if (songInfo.duration > 0) params.append('duration', songInfo.duration);

    const path = `/lyrics?${params}`;
    const result = await this.fetchWithFallback(path, fetchOptions, songInfo);
    if (result) {
      result.byVideoId = false;
      if (!result.metadata) result.metadata = {};
      result.metadata.byVideoId = false;
      result.metadata.provider = 'unison';
      result.provider = 'unison';
    }
    return result;
  }

  static async fetchWithFallback(path, fetchOptions, songInfo = {}) {
    for (const baseUrl of UNISON_BASE_URLS) {
      const result = await this.fetchAndParse(`${baseUrl}${path}`, fetchOptions, songInfo);
      if (result) return result;
    }
    return null;
  }

  /**
   * Calls Unison's coalesced /translate endpoint returning both translation and romanization
   * in a single pass. Concurrent identical requests share one network promise.
   */
  static translateBatch(lines, targetLang, sourceLang = 'auto', videoId = undefined) {
    if (!Array.isArray(lines) || lines.length === 0 || !targetLang) {
      return Promise.resolve(null);
    }

    const bodyObj = { lines, to: targetLang };
    if (sourceLang && sourceLang !== 'auto') bodyObj.from = sourceLang;
    if (videoId) bodyObj.videoId = videoId;
    const body = JSON.stringify(bodyObj);

    const existing = this.inFlightTranslate.get(body);
    if (existing) return existing;

    const req = this._fetchTranslateBatch(body, lines.length).finally(() => {
      this.inFlightTranslate.delete(body);
    });
    this.inFlightTranslate.set(body, req);
    return req;
  }

  static async _fetchTranslateBatch(body, expectedLength) {
    for (const baseUrl of UNISON_BASE_URLS) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`${baseUrl}/translate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok) continue;

        const json = await response.json();
        const payload = json?.data || json;
        if (Array.isArray(payload?.lines) && payload.lines.length === expectedLength) {
          return {
            lines: payload.lines,
            detectedLang: payload.detectedLang || ''
          };
        }
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.warn(`Unison translate error on ${baseUrl}:`, error.message);
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }
    return null;
  }

  static async fetchAndParse(url, fetchOptions, songInfo = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) return null;

      const json = await response.json();
      if (!json.success || !json.data) return null;

      return DataParser.parseUnisonFormat(json.data, songInfo);
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('Unison error:', error);
      }
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
