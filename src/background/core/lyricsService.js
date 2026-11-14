// ==================================================================================================
// LYRICS SERVICE
// ==================================================================================================

import { state } from '../storage/state.js';
import { lyricsDB, localLyricsDB, translationsDB, offsetsDB } from '../storage/database.js';
import { SettingsManager } from '../storage/settings.js';
import { CONFIG, PROVIDERS } from '../constants.js';
import { DataParser } from '../utils/dataParser.js';
import { Utilities } from '../utils/utilities.js';
import { KPoeService } from '../services/kpoeService.js';
import { LRCLibService } from '../services/lrclibService.js';
import { UnisonService } from '../services/unisonService.js';
import { LrcredService } from '../services/lrcredService.js';
import { KuGouService } from '../services/kugouService.js';
import { YouTubeService } from '../services/youtubeService.js';
import { parseAppleTTML } from '../../lib/parser.js';

export class LyricsService {
  static songProvidersCache = new Map();
  static ongoingProviderFetches = new Map();

  static cacheProviderLyrics(cacheKey, provider, lyrics) {
    if (!lyrics || Utilities.isEmptyLyrics(lyrics)) return;
    if (!lyrics.metadata) lyrics.metadata = {};
    lyrics.metadata.provider = provider;
    lyrics.provider = provider;

    if (!this.songProvidersCache.has(cacheKey)) {
      if (this.songProvidersCache.size > 30) {
        const firstKey = this.songProvidersCache.keys().next().value;
        this.songProvidersCache.delete(firstKey);
        this.ongoingProviderFetches.delete(firstKey);
      }
      this.songProvidersCache.set(cacheKey, new Map());
    }
    this.songProvidersCache.get(cacheKey).set(provider, lyrics);
  }

  static setOngoingProviderFetch(cacheKey, provider, promise) {
    if (!this.ongoingProviderFetches.has(cacheKey)) {
      if (this.ongoingProviderFetches.size > 30) {
        const firstKey = this.ongoingProviderFetches.keys().next().value;
        this.ongoingProviderFetches.delete(firstKey);
      }
      this.ongoingProviderFetches.set(cacheKey, new Map());
    }
    this.ongoingProviderFetches.get(cacheKey).set(provider, promise);
    promise.finally(() => {
      const m = this.ongoingProviderFetches.get(cacheKey);
      if (m) m.delete(provider);
    });
  }

  static getProviderLyricsFromCache(cacheKey, provider) {
    return this.songProvidersCache.get(cacheKey)?.get(provider) || null;
  }

  static createCacheKey(songInfo) {
    const duration = songInfo.duration || '';
    return `${songInfo.title} - ${songInfo.artist} - ${songInfo.album} - ${duration}`;
  }

  static async clearExpiredCache() {
    try {
      const settings = await SettingsManager.get({ cacheStrategy: 'aggressive' });

      if (settings.cacheStrategy === 'none') {
        const stats = await lyricsDB.estimateSize();
        if (stats.count > 0) {
          await Promise.all([lyricsDB.clear(), translationsDB.clear()]);
          console.log('Cleared all cache as strategy is none.');
        }
        return;
      }

      const expirationTime = CONFIG.CACHE_EXPIRY[settings.cacheStrategy];
      if (!expirationTime) return;

      const [deletedLyrics, deletedTrans] = await Promise.all([
        lyricsDB.deleteExpired(expirationTime),
        translationsDB.deleteExpired(expirationTime)
      ]);

      if (deletedLyrics > 0 || deletedTrans > 0) {
        console.log(`Cleared expired cache: ${deletedLyrics} lyrics, ${deletedTrans} translations.`);
      }
    } catch (error) {
      console.error('Error clearing expired cache:', error);
    }
  }

  static async getOrFetch(songInfo, forceReload = false, requestedSource = null) {
    if (requestedSource && requestedSource !== 'auto') {
      return this.fetchSpecificSource(songInfo, requestedSource, forceReload);
    }

    const cacheKey = this.createCacheKey(songInfo);
    let embeddedFallback = null;

    // Parse Apple Music TTML if provided
    if (songInfo.appleMusicTTML && typeof songInfo.appleMusicTTML === 'string') {
      try {
        songInfo.lyricsJSON = parseAppleTTML(songInfo.appleMusicTTML);
      } catch (error) {
        console.error('Error parsing Apple Music TTML:', error);
      }
    }

    if (songInfo.lyricsJSON && songInfo.lyricsJSON.lyrics.length > 0) {
      let parsedApple = null;
      try {
        parsedApple = DataParser.parseKPoeFormat(songInfo.lyricsJSON);
        if (parsedApple && !Utilities.isEmptyLyrics(parsedApple)) {
          parsedApple.provider = 'kpoe';
          if (!parsedApple.metadata) parsedApple.metadata = {};
          parsedApple.metadata.provider = 'kpoe';
          this.cacheProviderLyrics(cacheKey, 'kpoe', parsedApple);
        }
      } catch (e) {
        console.error('Error caching Apple Music lyrics:', e);
      }

      const settings = await SettingsManager.get({ appleMusicTTMLBypass: false });
      const lyricsJsonType = (songInfo.lyricsJSON.type || '').toUpperCase();

      const embeddedResult = {
        lyrics: parsedApple || DataParser.parseKPoeFormat(songInfo.lyricsJSON),
        version: Date.now()
      };
      if (embeddedResult.lyrics) {
        this.ensureAttribution(embeddedResult.lyrics, songInfo);
      }

      if (!settings.appleMusicTTMLBypass || lyricsJsonType === "WORD") {
        if (!forceReload && state.hasCached(cacheKey)) {
          const cached = state.getCached(cacheKey);
          if (cached && !Utilities.isEmptyLyrics(cached.lyrics)) {
            this.ensureAttribution(cached.lyrics, songInfo);
            return cached;
          }
        }
        console.log('Using embedded lyrics (platform specific)');
        state.setCached(cacheKey, embeddedResult);
        return embeddedResult;
      }

      console.log('Apple Music TTML bypass active. Attempting to fetch external lyrics...');
      embeddedFallback = embeddedResult;
    }

    let result = null;

    if (songInfo.ytMusicLyrics) {
      try {
        const parsedYT = DataParser.parseYTMusicFormat(songInfo.ytMusicLyrics, songInfo);
        if (parsedYT && !Utilities.isEmptyLyrics(parsedYT)) {
          parsedYT.provider = 'ytmusic';
          if (!parsedYT.metadata) parsedYT.metadata = {};
          parsedYT.metadata.provider = 'ytmusic';
          this.cacheProviderLyrics(cacheKey, 'ytmusic', parsedYT);
        }
      } catch (e) {
        console.error('Error parsing YouTube Music lyrics:', e);
      }
    }

    if (!forceReload) {
      if (state.hasCached(cacheKey)) {
        result = state.getCached(cacheKey);
      } else {
        result = await this.getFromDB(cacheKey) || await this.checkLocalLyrics(songInfo);
        if (result) state.setCached(cacheKey, result);
      }
      if (result?.lyrics) {
        const prov = result.lyrics.provider || this.detectProvider(result.lyrics);
        result.lyrics.provider = prov;
        if (!result.lyrics.metadata) result.lyrics.metadata = {};
        result.lyrics.metadata.provider = prov;
        if ((prov === PROVIDERS.UNISON && songInfo.isVideo) || prov === PROVIDERS.SUBTITLES || prov === 'subtitles') {
          result.lyrics.ignoreSponsorblock = true;
        }
        this.cacheProviderLyrics(cacheKey, prov, result.lyrics);
      }
    }

    if (!result) {
      try {
        if (state.hasOngoingFetch(cacheKey)) {
          result = await state.getOngoingFetch(cacheKey);
        } else {
          const fetchPromise = this.fetchNewLyrics(songInfo, cacheKey, forceReload);
          state.setOngoingFetch(cacheKey, fetchPromise);
          result = await fetchPromise;
        }
      } catch (error) {
        if (!embeddedFallback) {
          throw error;
        }
        console.log('External lyrics fetch failed or none found. Evaluating fallback to embedded Apple Music lyrics:', error?.message);
        result = null;
      }
    }

    if (embeddedFallback) {
      const extLyrics = result?.lyrics || result;
      const extType = (extLyrics?.type || '').toUpperCase();
      const hasExtLyrics = extLyrics && !Utilities.isEmptyLyrics(extLyrics);

      if (!hasExtLyrics) {
        console.log('No external lyrics found. Reverting to embedded Apple Music lyrics.');
        state.setCached(cacheKey, embeddedFallback);
        return embeddedFallback;
      }

      if (extType === "WORD") {
        console.log('External lyrics are WORD synced. Using external lyrics.');
        return result;
      }

      if (extType === "LINE") {
        const extScore = this.scoreLyrics(extLyrics);
        const embeddedScore = this.scoreLyrics(embeddedFallback.lyrics);
        console.log(`Comparing LINE synced lyrics richness - External score: ${extScore}, Apple Music score: ${embeddedScore}`);

        if (extScore > embeddedScore) {
          console.log('External LINE synced lyrics are richer than Apple Music. Using external lyrics.');
          return result;
        } else {
          console.log('Apple Music LINE synced lyrics are equal or richer. Reverting to embedded Apple Music lyrics.');
          state.setCached(cacheKey, embeddedFallback);
          return embeddedFallback;
        }
      }

      console.log(`External lyrics type is ${extType || 'unsynced'}. Reverting to embedded Apple Music line-synced lyrics.`);
      if (embeddedFallback?.lyrics) {
        this.ensureAttribution(embeddedFallback.lyrics, songInfo);
      }
      state.setCached(cacheKey, embeddedFallback);
      return embeddedFallback;
    }

    if (result?.lyrics) {
      this.ensureAttribution(result.lyrics, songInfo);
    }

    return result;
  }

  static async getFromDB(key) {
    const settings = await SettingsManager.get({ cacheStrategy: 'aggressive' });

    if (settings.cacheStrategy === 'none') {
      return null;
    }

    const result = await lyricsDB.get(key);
    if (!result) return null;

    const age = Date.now() - result.timestamp;
    const expirationTime = CONFIG.CACHE_EXPIRY[settings.cacheStrategy];

    if (age < expirationTime) {
      return { lyrics: result.lyrics, version: result.version };
    }

    await lyricsDB.delete(key);
    return null;
  }

  static async checkLocalLyrics(songInfo) {
    const localLyricsList = await localLyricsDB.getAll();
    const matched = localLyricsList.find(item => {
      if (item.songInfo.title !== songInfo.title || item.songInfo.artist !== songInfo.artist) {
        return false;
      }
      if (item.songInfo.duration && songInfo.duration) {
        return Math.abs(item.songInfo.duration - songInfo.duration) < 2;
      }
      return true;
    });

    if (matched) {
      const fetchedLocal = await localLyricsDB.get(matched.songId);
      if (fetchedLocal) {
        console.log(`Found local lyrics for "${songInfo.title}"`);
        const lyrics = DataParser.parseKPoeFormat(fetchedLocal.lyrics);
        lyrics.provider = PROVIDERS.LOCAL;
        if (!lyrics.metadata) lyrics.metadata = {};
        lyrics.metadata.provider = PROVIDERS.LOCAL;
        this.cacheProviderLyrics(this.createCacheKey(songInfo), PROVIDERS.LOCAL, lyrics);
        return {
          lyrics: lyrics,
          version: fetchedLocal.timestamp || matched.songId
        };
      }
    }

    return null;
  }

  static async fetchNewLyrics(songInfo, cacheKey, forceReload) {
    try {
      const settings = await SettingsManager.getLyricsSettings();
      const fetchOptions = settings.cacheStrategy === 'none' ? { cache: 'no-store' } : {};
      const pinnedProvider = songInfo.pinnedProvider || await this.getPinnedProvider(songInfo.videoId);
      const providers = this.getProviderOrder(settings, songInfo, settings.preferUnisonVideo, pinnedProvider);

      let ytReferenceText = '';
      if (songInfo.ytMusicLyrics) {
        const plainFromYt = songInfo.ytMusicLyrics.plain ||
          (Array.isArray(songInfo.ytMusicLyrics.timed)
            ? songInfo.ytMusicLyrics.timed.map(l => l?.text || '').filter(Boolean).join('\n')
            : '');
        if (plainFromYt && plainFromYt.trim()) {
          ytReferenceText = plainFromYt;
          try {
            const parsedYtPlain = this.buildYtPlainLyrics(songInfo);
            if (parsedYtPlain && !Utilities.isEmptyLyrics(parsedYtPlain)) {
              this.cacheProviderLyrics(cacheKey, PROVIDERS.YTLYRICS, parsedYtPlain);
            }
          } catch (e) {}
        }
      }

      const promises = providers.map((provider) => {
        const fetchPromise = this.fetchFromProvider(provider, songInfo, settings, fetchOptions, forceReload, null)
          .then(result => {
            if (result && !Utilities.isEmptyLyrics(result)) {
              this.cacheProviderLyrics(cacheKey, provider, result);
            }
            return result;
          })
          .catch(() => null);

        this.setOngoingProviderFetch(cacheKey, provider, fetchPromise);
        return fetchPromise;
      });

      if (songInfo.videoId && songInfo.subtitle) {
        const subPromise = YouTubeService.fetchSubtitles(songInfo)
          .then(subLyrics => {
            if (subLyrics && !Utilities.isEmptyLyrics(subLyrics)) {
              this.cacheProviderLyrics(cacheKey, 'subtitles', subLyrics);
            }
            return subLyrics;
          })
          .catch(() => null);
        this.setOngoingProviderFetch(cacheKey, 'subtitles', subPromise);
      }

      const lyrics = await this.raceWithEarlyExit(promises, providers, pinnedProvider, ytReferenceText);

      let finalLyrics = lyrics;

      if (songInfo.videoId && (!pinnedProvider || pinnedProvider === 'ytmusic')) {
        const cachedYt = this.getProviderLyricsFromCache(cacheKey, 'ytmusic');
        if (cachedYt && !Utilities.isEmptyLyrics(cachedYt)) {
          if (Utilities.isEmptyLyrics(finalLyrics) || this.scoreLyrics(cachedYt) > this.scoreLyrics(finalLyrics)) {
            finalLyrics = cachedYt;
          }
        }
      }

      if (Utilities.isEmptyLyrics(finalLyrics) && songInfo.videoId && songInfo.subtitle) {
        const cachedSub = this.getProviderLyricsFromCache(cacheKey, 'subtitles');
        if (cachedSub) {
          finalLyrics = cachedSub;
        } else {
          finalLyrics = await YouTubeService.fetchSubtitles(songInfo);
          if (finalLyrics && !Utilities.isEmptyLyrics(finalLyrics)) {
            this.cacheProviderLyrics(cacheKey, 'subtitles', finalLyrics);
          }
        }
      }

      if (Utilities.isEmptyLyrics(finalLyrics)) {
        throw new Error('No lyrics found from any provider');
      }

      const winningProvider = finalLyrics?.provider || this.detectProvider(finalLyrics);
      if ((winningProvider === PROVIDERS.UNISON && songInfo.isVideo) || winningProvider === PROVIDERS.SUBTITLES || winningProvider === 'subtitles') {
        finalLyrics.ignoreSponsorblock = true;
      }

      if (winningProvider && finalLyrics) {
        if ((!finalLyrics.metadata?.songWriters || !finalLyrics.metadata.songWriters.length) && songInfo.songWriters?.length) {
          if (!finalLyrics.metadata) finalLyrics.metadata = {};
          finalLyrics.metadata.songWriters = songInfo.songWriters;
        }
        this.ensureAttribution(finalLyrics, songInfo);
        this.cacheProviderLyrics(cacheKey, winningProvider, finalLyrics);
      }

      const version = Date.now();
      const result = { lyrics: finalLyrics, version };

      state.setCached(cacheKey, result);

      if (settings.cacheStrategy !== 'none') {
        await lyricsDB.set({ key: cacheKey, lyrics: finalLyrics, version, timestamp: Date.now(), duration: songInfo.duration });
      }

      return result;

    } finally {
      state.deleteOngoingFetch(cacheKey);
    }
  }

  static extractPlainLyricsText(lyricsObj) {
    if (!lyricsObj || !Array.isArray(lyricsObj.data)) return '';
    return lyricsObj.data
      .map(l => (l?.text || '').trim())
      .filter(Boolean)
      .join('\n');
  }

  static stringSimilarity(str1, str2, substringLength = 2) {
    const a = (str1 || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const b = (str2 || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (a.length < substringLength || b.length < substringLength) return 0;
    const map = new Map();
    for (let i = 0; i <= a.length - substringLength; i++) {
      const sub = a.substring(i, i + substringLength);
      map.set(sub, (map.get(sub) || 0) + 1);
    }
    let match = 0;
    for (let j = 0; j <= b.length - substringLength; j++) {
      const sub = b.substring(j, j + substringLength);
      const count = map.get(sub) || 0;
      if (count > 0) {
        map.set(sub, count - 1);
        match++;
      }
    }
    return (match * 2) / (a.length + b.length - (substringLength - 1) * 2);
  }

  static isUsableYtReference(ytReferenceText) {
    if (!ytReferenceText || typeof ytReferenceText !== 'string') return false;
    const trimmed = ytReferenceText.trim();
    if (trimmed.length < 40) return false;
    if (trimmed.endsWith('...') || trimmed.endsWith('…')) return false;
    const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
    return lines.length >= 4;
  }

  static computeAgreedIndices(results, providers) {
    // Exclude plain YT lyrics itself from independent consensus voting
    const entries = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r || Utilities.isEmptyLyrics(r)) continue;
      if (providers[i] === PROVIDERS.YTLYRICS) continue;
      const text = this.extractPlainLyricsText(r);
      if (text.length < 20) continue;
      entries.push({ idx: i, source: providers[i], text });
    }
    if (entries.length < 2) return new Set();

    let bestSupporters = [];
    for (const entry of entries) {
      const supporters = entries
        .filter(other => this.stringSimilarity(entry.text, other.text) >= 0.5)
        .map(other => other.idx);
      if (supporters.length > bestSupporters.length) {
        bestSupporters = supporters;
      }
    }

    if (bestSupporters.length >= 2 && bestSupporters.length * 2 > entries.length) {
      return new Set(bestSupporters);
    }
    return new Set();
  }

  static raceWithEarlyExit(promises, providers, pinnedProvider = null, ytReferenceText = '') {
    const hasYtRef = this.isUsableYtReference(ytReferenceText);
    const normPin = pinnedProvider ? pinnedProvider.toLowerCase() : null;

    return new Promise((resolve) => {
      const results = new Array(promises.length).fill(undefined);
      const pending = new Set(promises.map((_, i) => i));
      let won = false;
      let graceTimer = null;

      const clearGraceTimer = () => {
        if (graceTimer) {
          clearTimeout(graceTimer);
          graceTimer = null;
        }
      };

      const getBestCandidate = () => {
        const agreedIndices = hasYtRef ? this.computeAgreedIndices(results, providers) : new Set();
        let bestIdx = -1;
        let bestScore = -1;

        for (let i = 0; i < results.length; i++) {
          if (pending.has(i)) continue;
          const r = results[i];
          if (!r || Utilities.isEmptyLyrics(r)) continue;

          const baseScore = this.scoreLyrics(r);
          let effectiveScore = baseScore;
          const prov = (providers[i] || '').toLowerCase();

          if (normPin && prov === normPin) {
            effectiveScore += 10000;
          } else if (hasYtRef && prov !== PROVIDERS.YTLYRICS) {
            const text = this.extractPlainLyricsText(r);
            const sim = this.stringSimilarity(text, ytReferenceText);
            if (sim >= 0.45) {
              effectiveScore += 500;
            } else if (agreedIndices.has(i)) {
              effectiveScore += 250; // Majority consensus across independent providers reinstates it
            } else {
              effectiveScore -= 1500; // Unverified outlier compared against YT lyrics
            }
          }

          if (effectiveScore > bestScore) {
            bestScore = effectiveScore;
            bestIdx = i;
          }
        }

        return bestIdx !== -1
          ? { idx: bestIdx, score: bestScore, baseScore: this.scoreLyrics(results[bestIdx]), lyrics: results[bestIdx] }
          : null;
      };

      const resolveWinner = (winner) => {
        if (won) return;
        won = true;
        clearGraceTimer();
        resolve(winner);
      };

      const tryResolve = () => {
        if (won) return;

        const best = getBestCandidate();

        if (pending.size === 0) {
          return resolveWinner(best?.lyrics || null);
        }

        if (!best) return;

        // If the pinned provider has already resolved with valid lyrics, win immediately
        if (normPin && (providers[best.idx] || '').toLowerCase() === normPin) {
          return resolveWinner(best.lyrics);
        }

        const WORD_PROVIDERS = new Set([
          PROVIDERS.KPOE,
          PROVIDERS.CUSTOM_KPOE,
          PROVIDERS.UNISON,
          PROVIDERS.LRCRED,
          'binilyrics'
        ]);

        const pendingWordIndices = [...pending].filter(i => WORD_PROVIDERS.has(providers[i]));

        if (best.baseScore >= 3000 && best.score >= 2000) {
          if (pendingWordIndices.length === 0) {
            return resolveWinner(best.lyrics);
          }

          const blockedByEarlier = pendingWordIndices.some(i => i < best.idx);
          if (best.baseScore >= 3150 && !blockedByEarlier) {
            return resolveWinner(best.lyrics);
          }

          if (!graceTimer) {
            graceTimer = setTimeout(() => {
              if (!won) {
                const finalBest = getBestCandidate();
                resolveWinner(finalBest?.lyrics || null);
              }
            }, 2000);
          }
        } else if (best.baseScore >= 2000 && best.score >= 1500 && pendingWordIndices.length === 0) {
          const blockedByEarlier = [...pending].some(i => i < best.idx);
          if (!blockedByEarlier) {
            return resolveWinner(best.lyrics);
          }
        }
      };

      promises.forEach((p, i) => {
        Promise.resolve(p).then(result => {
          results[i] = result;
          pending.delete(i);
          tryResolve();
        }).catch(() => {
          results[i] = null;
          pending.delete(i);
          tryResolve();
        });
      });
    });
  }

  static scoreLyrics(lyrics) {
    if (Utilities.isEmptyLyrics(lyrics)) return 0;

    const type = (lyrics.type || '').toUpperCase();
    const lines = lyrics.data || lyrics.lyrics || [];
    const hasSyllables = Array.isArray(lines) && lines.some(
      l => Array.isArray(l.syllabus) && l.syllabus.length > 0
    );

    let baseScore = 1000;
    if (type === 'WORD' || hasSyllables) {
      baseScore = 3000;
    } else if (type === 'LINE') {
      baseScore = 2000;
    }

    let richScore = 0;
    const metadata = lyrics.metadata || {};

    const hasAgents = metadata.agents && typeof metadata.agents === 'object' && Object.keys(metadata.agents).length > 0;
    const hasLineSingers = Array.isArray(lines) && lines.some(l => l.element?.singer && l.element.singer.trim() !== '');
    if (hasAgents) {
      const agentCount = Object.keys(metadata.agents).length;
      richScore += 100 + Math.min(agentCount, 5) * 10;
    } else if (hasLineSingers) {
      richScore += 60;
    }

    const hasSongPartsMeta = Array.isArray(metadata.songParts) && metadata.songParts.length > 0 && metadata.songParts.some(p => p && p.name && p.name.trim() !== '');
    const hasLineSongParts = Array.isArray(lines) && lines.some(l => (l.element?.songPartIndex != null && l.element.songPartIndex >= 0) || (l.element?.songPart && l.element.songPart.trim() !== ''));
    if (hasSongPartsMeta) {
      richScore += 80;
    } else if (hasLineSongParts) {
      richScore += 40;
    }

    const hasBackgroundVocals = Array.isArray(lines) && lines.some(l =>
      (Array.isArray(l.syllabus) && l.syllabus.some(s => s.isBackground)) ||
      l.element?.isBackground === true
    );
    if (hasBackgroundVocals) {
      richScore += 40;
    }

    const hasTransliterations = (metadata.transliterations && typeof metadata.transliterations === 'object' && Object.keys(metadata.transliterations).length > 0) ||
      (Array.isArray(lines) && lines.some(l => l.transliteration || l.romanizedText || (Array.isArray(l.syllabus) && l.syllabus.some(s => s.romanizedText))));
    if (hasTransliterations) {
      richScore += 30;
    }

    const hasTranslations = (metadata.translations && typeof metadata.translations === 'object' && Object.keys(metadata.translations).length > 0) ||
      (Array.isArray(lines) && lines.some(l => l.translation));
    if (hasTranslations) {
      richScore += 20;
    }

    if (Array.isArray(metadata.songWriters) && metadata.songWriters.length > 0) {
      richScore += 10;
    }

    return baseScore + richScore;
  }

  static async getPinnedProvider(videoId) {
    if (!videoId) return null;
    try {
      const rec = await offsetsDB.get(`PIN:${videoId}`);
      return rec?.provider || null;
    } catch (e) {
      return null;
    }
  }

  static async savePinnedProvider(videoId, provider) {
    if (!videoId) return;
    const key = `PIN:${videoId}`;
    if (!provider || provider === 'auto' || provider === 'local') {
      await offsetsDB.delete(key);
    } else {
      await offsetsDB.set({ key, provider, updatedAt: Date.now() });
    }
  }

  static buildYtPlainLyrics(songInfo) {
    if (!songInfo?.ytMusicLyrics) return null;
    const ytData = songInfo.ytMusicLyrics;
    const plain = ytData.plain ||
      (Array.isArray(ytData.timed)
        ? ytData.timed.map(l => (l?.text || '').trim()).filter(Boolean).join('\n')
        : '');
    if (!plain) return null;
    const parsed = DataParser.parseYTMusicFormat({ ...ytData, plain, timed: [], synced: false }, songInfo);
    if (!parsed) return null;
    parsed.provider = PROVIDERS.YTLYRICS;
    if (!parsed.metadata) parsed.metadata = {};
    parsed.metadata.provider = PROVIDERS.YTLYRICS;
    const rawSrc = ytData.provider || 'YouTube';
    parsed.metadata.source = rawSrc.includes('YT') ? rawSrc : `${rawSrc} (YT Lyrics)`;
    return parsed;
  }

  static getProviderOrder(settings, songInfo = null, preferUnisonVideo = false, pinnedProvider = null) {
    const defaultOrder = ['kpoe', 'lrcred', 'unison', 'kugou', 'lrclib', 'ytlyrics'];

    let providersList = (settings.lyricsProviderOrder || '')
      .split(',')
      .map(p => {
        const trimmed = p.trim();
        return trimmed === 'binilyrics' ? 'lrcred' : trimmed;
      })
      .filter(Boolean);
    if (!providersList.length) providersList = defaultOrder;

    let validProviders = providersList.filter(p => [
      PROVIDERS.KPOE, PROVIDERS.CUSTOM_KPOE, PROVIDERS.UNISON, PROVIDERS.LRCRED, PROVIDERS.KUGOU, PROVIDERS.LRCLIB, PROVIDERS.YTLYRICS
    ].includes(p));

    if (!settings.customKpoeUrl) {
      validProviders = validProviders.filter(p => p !== PROVIDERS.CUSTOM_KPOE);
    }

    const pin = pinnedProvider && pinnedProvider !== 'auto' && pinnedProvider !== 'local'
      ? pinnedProvider
      : null;

    if (pin) {
      const idx = validProviders.indexOf(pin);
      if (idx > 0) {
        validProviders.splice(idx, 1);
      }
      if (idx !== 0) {
        validProviders.unshift(pin);
      }
    } else if (preferUnisonVideo && songInfo?.isVideo && validProviders.includes(PROVIDERS.UNISON)) {
      const unisonIndex = validProviders.indexOf(PROVIDERS.UNISON);
      if (unisonIndex > 0) {
        validProviders.splice(unisonIndex, 1);
        validProviders.unshift(PROVIDERS.UNISON);
      }
    }

    return validProviders;
  }

  static detectProvider(lyrics) {
    if (lyrics?.provider) return lyrics.provider;
    if (lyrics?.metadata?.provider) return lyrics.metadata.provider;
    const source = (lyrics?.metadata?.source || '').toLowerCase();
    if (source.includes('kugou') || source.includes('legato')) return PROVIDERS.KUGOU;
    if (source.includes('yt lyrics')) return PROVIDERS.YTLYRICS;
    if (source.includes('lrcred') || source.includes('lrc-red') || source.includes('lrc.red') || source.includes('bini')) return PROVIDERS.LRCRED;
    if (source.includes('unison')) return PROVIDERS.UNISON;
    if (source.includes('lrclib')) return PROVIDERS.LRCLIB;
    if (source.includes('local')) return PROVIDERS.LOCAL;
    if (source.includes('subtitles') || source.includes('captions')) return PROVIDERS.SUBTITLES;
    if (source.includes('lyricfind') || source.includes('youtube music') || source.includes('ytmusic')) return PROVIDERS.YTMUSIC;
    if (source.includes('apple') || source.includes('qq') || source.includes('kpoe') || source.includes('lyrics+')) return PROVIDERS.KPOE;
    return PROVIDERS.KPOE;
  }

  static ensureAttribution(lyrics, songInfo = {}) {
    if (!lyrics) return;
    if (!lyrics.metadata) lyrics.metadata = {};

    const provider = (lyrics.provider || lyrics.metadata.provider || this.detectProvider(lyrics) || '').toLowerCase();
    const source = (lyrics.metadata.source || '').toLowerCase();

    // 1. Unison
    if (provider === 'unison' || source === 'unison') {
      if (!lyrics.metadata.source) lyrics.metadata.source = 'Unison';
      if (!lyrics.metadata.sourceUrl) {
        const videoId = lyrics.metadata.videoId || songInfo.videoId;
        const unisonId = lyrics.metadata.unisonId || lyrics.id;
        if (videoId) {
          lyrics.metadata.sourceUrl = `https://unison.betterlyrics.org/song/${encodeURIComponent(videoId)}${unisonId ? `?variantId=${encodeURIComponent(unisonId)}` : ''}`;
        } else if (unisonId) {
          lyrics.metadata.sourceUrl = `https://unison.betterlyrics.org/song/?variantId=${encodeURIComponent(unisonId)}`;
        } else {
          lyrics.metadata.sourceUrl = 'https://unison.betterlyrics.org/';
        }
      }
      const submitter = lyrics.metadata.submitter || lyrics.metadata.curator;
      if (!lyrics.metadata.curatorUrl && typeof submitter === 'object' && submitter?.keyId) {
        lyrics.metadata.curatorUrl = `https://unison.betterlyrics.org/curator/${encodeURIComponent(submitter.keyId)}`;
      }
      if (!lyrics.metadata.curator && submitter) {
        lyrics.metadata.curator = typeof submitter === 'object'
          ? (submitter.displayName || submitter.name)
          : submitter;
      }
    }
    // 2. lrc.red
    else if (provider === 'lrcred' || provider === 'binilyrics' || source.includes('lrc.red') || source.includes('lrcred') || source.includes('bini')) {
      if (!lyrics.metadata.source) lyrics.metadata.source = 'lrc.red';
      if (!lyrics.metadata.sourceUrl) {
        const isrc = lyrics.metadata.isrc || lyrics.isrc || songInfo.isrc;
        lyrics.metadata.sourceUrl = isrc ? `https://lrc.red/s/${encodeURIComponent(isrc)}` : 'https://lrc.red/';
      }
    }
    // 3. LRCLIB
    else if (provider === 'lrclib' || source.includes('lrclib')) {
      if (!lyrics.metadata.source) lyrics.metadata.source = 'LRCLIB';
      if (!lyrics.metadata.sourceUrl) {
        const trackId = lyrics.metadata.id || lyrics.metadata.trackId || lyrics.id;
        lyrics.metadata.sourceUrl = trackId ? `https://lrclib.net/tracks/${encodeURIComponent(trackId)}` : 'https://lrclib.net/';
      }
    }
    // 4. KuGou (Legato)
    else if (provider === 'kugou' || source.includes('kugou') || source.includes('legato')) {
      if (!lyrics.metadata.source) lyrics.metadata.source = 'KuGou (Legato)';
      if (!lyrics.metadata.sourceUrl) {
        lyrics.metadata.sourceUrl = 'https://www.kugou.com/';
      }
    }
    // 5. KPoe / Lyrics+
    else if (
      provider === 'kpoe' ||
      provider === 'customkpoe' ||
      source.includes('lyrics+') ||
      source.includes('kpoe') ||
      source.includes('apple') ||
      source.includes('qq')
    ) {
      if (!lyrics.metadata.sourceUrl) {
        const title = lyrics.metadata.title || songInfo.title || '';
        const artist = lyrics.metadata.artist || songInfo.artist || '';
        const album = lyrics.metadata.album || songInfo.album || '';
        const dur = lyrics.metadata.duration || songInfo.duration || 0;

        const params = new URLSearchParams();
        if (title) params.set('title', title);
        if (artist) params.set('artist', artist);
        if (album) params.set('album', album);
        if (dur > 0) params.set('duration', Math.round(dur));

        lyrics.metadata.sourceUrl = `https://youlyplus.prjktla.my.id/findlyrics.html?${params.toString()}`;
      }
    }
  }

  static async fetchFromProvider(provider, songInfo, settings, fetchOptions, forceReload, signal) {
    const opts = { ...fetchOptions, signal };
    let lyrics = null;
    switch (provider) {
      case PROVIDERS.KPOE:
        lyrics = await KPoeService.fetch(songInfo, settings.lyricsSourceOrder, forceReload, opts);
        break;

      case PROVIDERS.CUSTOM_KPOE:
        if (settings.customKpoeUrl)
          lyrics = await KPoeService.fetchCustom(songInfo, settings.customKpoeUrl, settings.lyricsSourceOrder, forceReload, opts);
        break;

      case PROVIDERS.UNISON:
        lyrics = await UnisonService.fetch(songInfo, opts);
        break;

      case PROVIDERS.LRCRED:
      case 'binilyrics':
        lyrics = await LrcredService.fetch(songInfo, opts);
        break;

      case PROVIDERS.KUGOU:
        lyrics = await KuGouService.fetch(songInfo, opts);
        break;

      case PROVIDERS.LRCLIB:
        lyrics = await LRCLibService.fetch(songInfo, opts);
        break;

      case PROVIDERS.YTLYRICS:
        lyrics = this.buildYtPlainLyrics(songInfo);
        break;

      case PROVIDERS.LOCAL:
        const localResult = await this.checkLocalLyrics(songInfo);
        lyrics = localResult?.lyrics || null;
        break;

      default:
        lyrics = null;
    }

    if (lyrics && !Utilities.isEmptyLyrics(lyrics)) {
      if (!lyrics.metadata) lyrics.metadata = {};
      lyrics.metadata.provider = provider;
      lyrics.provider = provider;
    }

    return lyrics;
  }

  static async getProviderLyrics(songInfo, provider) {
    const cacheKey = this.createCacheKey(songInfo);
    let lyrics = this.getProviderLyricsFromCache(cacheKey, provider);
    let fromCache = true;

    if (!lyrics || Utilities.isEmptyLyrics(lyrics)) {
      fromCache = false;
      const ongoingSongMap = this.ongoingProviderFetches.get(cacheKey);
      if (ongoingSongMap && ongoingSongMap.has(provider)) {
        try {
          const ongoingLyrics = await ongoingSongMap.get(provider);
          if (ongoingLyrics && !Utilities.isEmptyLyrics(ongoingLyrics)) {
            lyrics = ongoingLyrics;
            fromCache = true;
          }
        } catch (err) {
          // Fallback to fetch below
        }
      }
    }

    if (!lyrics || Utilities.isEmptyLyrics(lyrics)) {
      const settings = await SettingsManager.getLyricsSettings();
      const fetchOptions = settings.cacheStrategy === 'none' ? { cache: 'no-store' } : {};

      if (provider === 'subtitles') {
        lyrics = await YouTubeService.fetchSubtitles(songInfo);
      } else if (provider === 'ytmusic' || provider === PROVIDERS.YTMUSIC) {
        if (songInfo.ytMusicLyrics) {
          lyrics = DataParser.parseYTMusicFormat(songInfo.ytMusicLyrics, songInfo);
        }
      } else if (provider === 'ytlyrics' || provider === PROVIDERS.YTLYRICS) {
        lyrics = this.buildYtPlainLyrics(songInfo);
      } else {
        lyrics = await this.fetchFromProvider(provider, songInfo, settings, fetchOptions, false, null);
      }

      if (lyrics && !Utilities.isEmptyLyrics(lyrics)) {
        if ((provider === PROVIDERS.UNISON && songInfo.isVideo) || provider === PROVIDERS.SUBTITLES || provider === 'subtitles') {
          lyrics.ignoreSponsorblock = true;
        }
        if (!lyrics.metadata) lyrics.metadata = {};
        lyrics.metadata.provider = provider;
        lyrics.provider = provider;
        this.cacheProviderLyrics(cacheKey, provider, lyrics);
      }
    }

    if (lyrics && !Utilities.isEmptyLyrics(lyrics)) {
      this.ensureAttribution(lyrics, songInfo);
      const version = Date.now();
      const result = { lyrics, version, fromCache };
      state.setCached(cacheKey, { lyrics, version });
      const settings = await SettingsManager.getLyricsSettings();
      if (settings.cacheStrategy !== 'none') {
        await lyricsDB.set({ key: cacheKey, lyrics, version, timestamp: Date.now(), duration: songInfo.duration });
      }
      return result;
    }

    return null;
  }

  static async fetchSpecificSource(songInfo, source, forceReload = true) {
    const settings = await SettingsManager.getLyricsSettings();
    const fetchOptions = { cache: 'no-store' };
    const kpoeSources = ['apple', 'qq'];
    const cacheKey = this.createCacheKey(songInfo);

    let lyrics = null;
    if (kpoeSources.includes(source)) {
      lyrics = await KPoeService.fetch(songInfo, source, forceReload, fetchOptions);
      if (!lyrics && settings.customKpoeUrl) {
        lyrics = await KPoeService.fetchCustom(songInfo, settings.customKpoeUrl, source, forceReload, fetchOptions);
      }
    } else if (source === PROVIDERS.LRCLIB) {
      lyrics = await LRCLibService.fetch(songInfo, fetchOptions);
    } else if (source === PROVIDERS.UNISON) {
      lyrics = await UnisonService.fetch(songInfo, fetchOptions);
    } else if (source === PROVIDERS.LRCRED || source === 'lrcred' || source === 'binilyrics') {
      lyrics = await LrcredService.fetch(songInfo, fetchOptions);
    } else if (source === PROVIDERS.KUGOU || source === 'kugou') {
      lyrics = await KuGouService.fetch(songInfo, fetchOptions);
    } else if (source === 'subtitles') {
      lyrics = await YouTubeService.fetchSubtitles(songInfo);
    } else if (source === 'ytlyrics' || source === PROVIDERS.YTLYRICS) {
      lyrics = this.buildYtPlainLyrics(songInfo);
    } else if (source === 'ytmusic' || source === PROVIDERS.YTMUSIC) {
      const cached = this.getProviderLyricsFromCache(cacheKey, 'ytmusic');
      if (cached && !Utilities.isEmptyLyrics(cached)) {
        lyrics = cached;
      } else if (songInfo.ytMusicLyrics) {
        lyrics = DataParser.parseYTMusicFormat(songInfo.ytMusicLyrics, songInfo);
      }
    } else if (source === PROVIDERS.LOCAL) {
      const localResult = await this.checkLocalLyrics(songInfo);
      lyrics = localResult?.lyrics || null;
    }

    if (Utilities.isEmptyLyrics(lyrics)) {
      throw new Error(`No lyrics found from source: ${source}`);
    }

    if ((source === PROVIDERS.UNISON && songInfo.isVideo) || source === PROVIDERS.SUBTITLES || source === 'subtitles') {
      lyrics.ignoreSponsorblock = true;
    }

    if (!lyrics.metadata) lyrics.metadata = {};
    lyrics.metadata.provider = source;
    lyrics.provider = source;
    this.ensureAttribution(lyrics, songInfo);
    this.cacheProviderLyrics(cacheKey, source, lyrics);

    const version = Date.now();
    const result = { lyrics, version };
    state.setCached(cacheKey, result);
    if (settings.cacheStrategy !== 'none') {
      await lyricsDB.set({ key: cacheKey, lyrics, version, timestamp: Date.now(), duration: songInfo.duration });
    }
    return result;
  }

  static async getLyricsOffset(songInfo, provider = null) {
    if (!songInfo || !songInfo.title) return 0;
    const artist = songInfo.artist || '';
    const album = (songInfo.album || '').trim();
    const duration = songInfo.duration || '';
    const normProv = provider ? String(provider).trim().toLowerCase() : '';

    const cacheKey = this.createCacheKey(songInfo);
    if (normProv) {
      if (songInfo.videoId) {
        const videoProvRecord = await offsetsDB.get(`VID:${songInfo.videoId}::${normProv}`);
        if (videoProvRecord && typeof videoProvRecord.offsetMs === 'number') {
          return videoProvRecord.offsetMs;
        }
      }
      const cacheProvRecord = await offsetsDB.get(`${cacheKey}::${normProv}`);
      if (cacheProvRecord && typeof cacheProvRecord.offsetMs === 'number') {
        return cacheProvRecord.offsetMs;
      }
    }

    const cacheRecord = await offsetsDB.get(cacheKey);
    if (cacheRecord && typeof cacheRecord.offsetMs === 'number') {
      return cacheRecord.offsetMs;
    }

    if (duration) {
      const durationKey = `${songInfo.title} - ${artist} - ${duration}`;
      const durationRecord = await offsetsDB.get(durationKey);
      if (durationRecord && typeof durationRecord.offsetMs === 'number') {
        return durationRecord.offsetMs;
      }
    }

    if (album) {
      const albumKey = `${songInfo.title} - ${artist} - ${album}`;
      const record = await offsetsDB.get(albumKey);
      if (record && typeof record.offsetMs === 'number') {
        return record.offsetMs;
      }
    }

    const legacyKey = `${songInfo.title} - ${artist}`;
    const record = await offsetsDB.get(legacyKey);
    return record?.offsetMs || 0;
  }

  static async saveLyricsOffset(songInfo, offsetMs, provider = null) {
    if (!songInfo || !songInfo.title) return;
    const artist = songInfo.artist || '';
    const album = (songInfo.album || '').trim();
    const duration = songInfo.duration || '';
    const baseKey = this.createCacheKey(songInfo);
    const normProv = provider ? String(provider).trim().toLowerCase() : '';

    if (normProv) {
      const provKey = songInfo.videoId ? `VID:${songInfo.videoId}::${normProv}` : `${baseKey}::${normProv}`;
      if (offsetMs === 0) {
        await offsetsDB.delete(provKey);
        await offsetsDB.delete(`${baseKey}::${normProv}`);
      } else {
        await offsetsDB.set({ key: provKey, offsetMs, provider: normProv, duration: songInfo.duration || null, updatedAt: Date.now() });
      }
      return;
    }

    if (offsetMs === 0) {
      await offsetsDB.delete(baseKey);
      if (duration) {
        await offsetsDB.delete(`${songInfo.title} - ${artist} - ${duration}`);
      }
      if (album) {
        await offsetsDB.delete(`${songInfo.title} - ${artist} - ${album}`);
      }
      await offsetsDB.delete(`${songInfo.title} - ${artist}`);
    } else {
      await offsetsDB.set({ key: baseKey, offsetMs, duration: songInfo.duration || null, updatedAt: Date.now() });
    }
  }

  static async getAvailableProviders(songInfo) {
    if (!songInfo || !songInfo.title) return [];
    const cacheKey = this.createCacheKey(songInfo);

    const ongoingMap = this.ongoingProviderFetches.get(cacheKey);
    if (ongoingMap && ongoingMap.size > 0) {
      const ongoingPromises = Array.from(ongoingMap.values());
      await Promise.race([
        Promise.allSettled(ongoingPromises),
        new Promise(resolve => setTimeout(resolve, 1200))
      ]);
    }

    const available = [];
    const cachedMap = this.songProvidersCache.get(cacheKey);
    if (cachedMap) {
      for (const [provider, lyrics] of cachedMap.entries()) {
        if (lyrics && !Utilities.isEmptyLyrics(lyrics)) {
          available.push(provider);
        }
      }
    }
    return available;
  }
}
