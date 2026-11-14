// ==================================================================================================
// EXTERNAL SERVICE - KUGOU (Better Lyrics "Legato" public lyrics search & LRC download)
// ==================================================================================================

import { DataParser } from '../utils/dataParser.js';
import { parseSyncedLyrics } from '../../lib/parser.js';

const KUGOU_SEARCH_URL = 'https://lyrics.kugou.com/search';
const KUGOU_DOWNLOAD_URL = 'https://lyrics.kugou.com/download';

function normalizeForMatch(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[\(\[][^\)\]]*[\)\]]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeBase64Utf8(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

export class KuGouService {
  static async fetch(songInfo, fetchOptions = {}) {
    let lyrics = await this.fetchFromAPI(songInfo, fetchOptions);
    if (lyrics) return lyrics;

    if (songInfo.isVideo) {
      const cleanTitle = (songInfo.title || '')
        .replace(/[\(\[](?:official(?:\s+music)?\s+video|music\s+video|mv|lyrics?)[\)\]]/gi, '')
        .trim();

      if (cleanTitle && (cleanTitle !== songInfo.title || songInfo.duration > 0)) {
        lyrics = await this.fetchFromAPI({ ...songInfo, duration: 0, title: cleanTitle }, fetchOptions);
        if (lyrics) return lyrics;
      }
    }

    return null;
  }

  static selectBestCandidate(candidates, songInfo) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;

    const targetTitle = normalizeForMatch(songInfo.title);
    const targetArtist = normalizeForMatch(songInfo.artist);
    const targetDurationMs = Math.round((songInfo.duration || 0) * 1000);

    let best = null;
    let bestScore = -Infinity;

    for (const item of candidates) {
      if (!item || !item.id || !item.accesskey) continue;

      const itemDurationMs = Number(item.duration) || 0;
      if (targetDurationMs > 0 && itemDurationMs > 0) {
        if (Math.abs(itemDurationMs - targetDurationMs) > 15000) continue;
      }

      const itemTitle = normalizeForMatch(item.song);
      const itemArtist = normalizeForMatch(item.singer);

      let score = Number(item.score) || 0;
      score = Math.min(score, 60);

      if (targetTitle && itemTitle) {
        if (targetTitle === itemTitle) score += 50;
        else if (itemTitle.includes(targetTitle) || targetTitle.includes(itemTitle)) score += 25;
        else score -= 35;
      }

      if (targetArtist && itemArtist) {
        if (targetArtist === itemArtist) score += 35;
        else if (itemArtist.includes(targetArtist) || targetArtist.includes(itemArtist)) score += 18;
        else score -= 30;
      }

      if (targetDurationMs > 0 && itemDurationMs > 0) {
        const diffSec = Math.abs(itemDurationMs - targetDurationMs) / 1000;
        if (diffSec <= 2) score += 25;
        else if (diffSec <= 5) score += 12;
        else if (diffSec > 10) score -= 15;
      }

      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }

    return bestScore > 10 ? best : null;
  }

  static async fetchFromAPI(songInfo, fetchOptions = {}) {
    const title = (songInfo.title || '').trim();
    const artist = (songInfo.artist || '').trim();
    const keyword = artist ? `${artist} - ${title}` : title;
    if (!keyword) return null;

    const durationMs = songInfo.duration > 0 ? Math.round(songInfo.duration * 1000) : '';
    const searchParams = new URLSearchParams({
      ver: '1',
      man: 'yes',
      client: 'pc',
      keyword,
      hash: ''
    });
    if (durationMs) searchParams.set('duration', String(durationMs));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const signal = fetchOptions.signal || controller.signal;

    try {
      const searchRes = await fetch(`${KUGOU_SEARCH_URL}?${searchParams}`, {
        ...fetchOptions,
        signal
      });
      clearTimeout(timeoutId);
      if (!searchRes.ok) return null;

      const searchData = await searchRes.json();
      const candidate = this.selectBestCandidate(searchData?.candidates, songInfo);
      if (!candidate) return null;

      const dlController = new AbortController();
      const dlTimeoutId = setTimeout(() => dlController.abort(), 8000);
      const dlParams = new URLSearchParams({
        ver: '1',
        client: 'pc',
        id: String(candidate.id),
        accesskey: String(candidate.accesskey),
        fmt: 'lrc',
        charset: 'utf8'
      });

      const dlRes = await fetch(`${KUGOU_DOWNLOAD_URL}?${dlParams}`, {
        ...fetchOptions,
        signal: fetchOptions.signal || dlController.signal
      });
      clearTimeout(dlTimeoutId);
      if (!dlRes.ok) return null;

      const dlData = await dlRes.json();
      if (!dlData?.content) return null;

      const rawLrc = decodeBase64Utf8(dlData.content);
      const normalizedLrc = rawLrc.replace(/^\[(\d):/gm, '[0$1:');
      const kpoeData = parseSyncedLyrics(normalizedLrc);
      if (!kpoeData?.lyrics?.length) return null;

      // Drop pure LRC metadata lines like "作词："/"作曲：" or credits noise if desired, keep songWriters clean
      kpoeData.metadata = {
        ...kpoeData.metadata,
        title: candidate.song || songInfo.title || '',
        artist: candidate.singer || songInfo.artist || '',
        source: 'KuGou (Legato)',
        sourceUrl: 'https://www.kugou.com/',
        provider: 'kugou'
      };

      const parsed = DataParser.parseKPoeFormat(kpoeData);
      if (!parsed) return null;

      parsed.provider = 'kugou';
      if (!parsed.metadata) parsed.metadata = {};
      parsed.metadata.provider = 'kugou';
      parsed.metadata.source = 'KuGou (Legato)';
      parsed.metadata.sourceUrl = 'https://www.kugou.com/';
      return parsed;
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error('KuGou error:', error);
      }
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
