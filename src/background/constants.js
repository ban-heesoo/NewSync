// ==================================================================================================
// CONSTANTS
// ==================================================================================================

export const CONFIG = {
  DB: {
    CACHE: { name: "LyricsCacheDB", version: 2, store: "lyrics" },
    TRANSLATIONS: { name: "TranslationsDB", version: 2, store: "translations" },
    LOCAL: { name: "LocalLyricsDB", version: 2, store: "localLyrics" },
    OFFSETS: { name: "LyricsOffsetDB", version: 1, store: "offsets" }
  },

  CACHE_EXPIRY: {
    aggressive: 24 * 60 * 60 * 1000,
    moderate: 12 * 60 * 60 * 1000
  },

  KPOE_SERVERS: [
    "https://lyricsplus.prjktla.my.id", //youly's main server
    "https://lyricsplus.binimum.org", //binimum's server
    "https://lyricsplus.atomix.one", //atomix mirror
    "https://lyricsplus-seven.vercel.app", //vercel mirror
    "https://lyricsplus.prjktla.workers.dev", //ibra's cf worker
  ],

  GEMINI: {
    MAX_RETRIES: 5,
    MIN_TEXT_SIMILARITY: 0.8
  },

  GOOGLE: {
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 500
  }
};

export const PROVIDERS = {
  KPOE: 'kpoe',
  CUSTOM_KPOE: 'customKpoe',
  UNISON: 'unison',
  LRCRED: 'lrcred',
  BINILYRICS: 'lrcred',
  KUGOU: 'kugou',
  LRCLIB: 'lrclib',
  YTMUSIC: 'ytmusic',
  YTLYRICS: 'ytlyrics',
  SUBTITLES: 'subtitles',
  LOCAL: 'local',
  GEMINI: 'gemini',
  GOOGLE: 'google',
  OPENROUTER: 'openrouter',
  DEEPL: 'deepl',
  DEEPL_KEYLESS: 'deepl-keyless',
  OFFLINE: 'offline'
};

export const MESSAGE_TYPES = {
  FETCH_LYRICS: 'FETCH_LYRICS',
  RESET_CACHE: 'RESET_CACHE',
  GET_CACHED_SIZE: 'GET_CACHED_SIZE',
  TRANSLATE_LYRICS: 'TRANSLATE_LYRICS',
  FETCH_SPONSOR_SEGMENTS: 'FETCH_SPONSOR_SEGMENTS',
  FETCH_SUBTITLES: 'FETCH_SUBTITLES',
  UPLOAD_LOCAL_LYRICS: 'UPLOAD_LOCAL_LYRICS',
  GET_LOCAL_LYRICS_LIST: 'GET_LOCAL_LYRICS_LIST',
  DELETE_LOCAL_LYRICS: 'DELETE_LOCAL_LYRICS',
  FETCH_LOCAL_LYRICS: 'FETCH_LOCAL_LYRICS',
  FETCH_IMAGE: 'FETCH_IMAGE',
  SAVE_LYRICS_OFFSET: 'SAVE_LYRICS_OFFSET',
  GET_LYRICS_OFFSET: 'GET_LYRICS_OFFSET',
  SWITCH_LYRICS_PROVIDER: 'SWITCH_LYRICS_PROVIDER',
  GET_AVAILABLE_PROVIDERS: 'GET_AVAILABLE_PROVIDERS',
  BROADCAST_REFRESH_TRANSLATION: 'BROADCAST_REFRESH_TRANSLATION',
  PREFETCH_LYRICS: 'PREFETCH_LYRICS',
  SAVE_PROVIDER_PIN: 'SAVE_PROVIDER_PIN',
  GET_PROVIDER_PIN: 'GET_PROVIDER_PIN'
};
