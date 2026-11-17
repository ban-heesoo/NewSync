const pBrowser = typeof browser !== 'undefined'
    ? browser
    : (typeof chrome !== 'undefined' ? chrome : null);

const defaultSettings = {
    lyricsProvider: 'kpoe',
    lyricsProviderOrder: 'kpoe,lrcred,unison,kugou,lrclib,ytmusic,ytlyrics',
    lyricsSourceOrder: 'apple,qq',
    wordByWord: true,
    lightweight: false,
    isEnabled: true,
    useSponsorBlock: false,
    autoHideLyrics: false,
    cacheStrategy: 'aggressive',
    fontSize: 16,
    hideOffscreen: true,
    blurInactive: false,
    dynamicPlayer: false,
    dynamicBgStyle: 'android', // 'ipad' or 'android'
    audioBeatSync: false,
    relaxScroll: false,
    customCSS: '',
    translationProvider: 'google',
    geminiApiKey: '',
    geminiModel: 'gemini-flash-lite-latest',
    overrideTranslateTarget: false,
    customTranslateTarget: '',
    overrideGeminiPrompt: false,
    customGeminiPrompt: '',
    overrideGeminiRomanizePrompt: false,
    customGeminiRomanizePrompt: '',
    romanizationProvider: 'google',
    transliterationTargetScript: 'latin',
    geminiRomanizationModel: 'gemini-flash-latest',
    useSongPaletteFullscreen: false,
    useSongPaletteAllModes: false,
    overridePaletteColor: '',
    largerTextMode: 'lyrics', // 'lyrics' or 'romanization'
    hidePhoneticDup: false,
    bkgOverlap: true,
    animatedAlbumArt: true,
    customKpoeUrl: '',
    appleMusicTTMLBypass: false,
    openRouterApiKey: '',
    openRouterModel: 'google/gemma-3n-e2b-it:free',
    deeplApiKey: '',
    preferUnisonVideo: false,
    lyricOffset: 0,
    globalLyricOffset: 0,
    richsyncOffsetTrim: 0,
    lineOffsetTrim: 0
};

let currentSettings = { ...defaultSettings };
let _lastAppliedDynamicPlayer = null;
let _lastInjectedCustomCSS = null;
let _cachedCustomStyleTag = null;

function sanitizeSettingsInPlace(settings) {
    if (!settings || typeof settings !== 'object') return;
    if (typeof settings.lyricsSourceOrder === 'string') {
        const sources = settings.lyricsSourceOrder.split(',')
            .map(source => source.trim())
            .filter(source => ['apple', 'qq'].includes(source));
        settings.lyricsSourceOrder = sources.length ? [...new Set(sources)].join(',') : 'apple,qq';
    }
    if (typeof settings.lyricsProviderOrder === 'string') {
        const providers = settings.lyricsProviderOrder.split(',')
            .map(p => p.trim())
            .map(p => (p === 'biniLyrics' || p === 'binilyrics' ? 'lrcred' : p))
            .filter(Boolean);
        settings.lyricsProviderOrder = providers.length ? [...new Set(providers)].join(',') : 'kpoe,lrcred,unison,kugou,lrclib,ytmusic,ytlyrics';
    }
    if (settings.translationProvider === 'deeplKeyless') {
        settings.translationProvider = 'deepl-keyless';
    }
    if (settings.romanizationProvider === 'offline') {
        settings.romanizationProvider = 'google';
    }
}

window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.type !== 'UPDATE_SETTINGS') return;

    console.log("Received new settings:", event.data.settings);
    updateSettings(event.data.settings);
});

function loadSettings(callback) {
    storageLocalGet(defaultSettings).then((items) => {
        currentSettings = items;
        sanitizeSettingsInPlace(currentSettings);
        console.log(currentSettings);
        applyDynamicPlayerClass(true);
        injectCustomCSS(currentSettings.customCSS);
        if (callback) callback();
    });
}

function updateSettings(newSettings) {
    if (!newSettings || typeof newSettings !== 'object') return;
    const sanitized = { ...newSettings };
    sanitizeSettingsInPlace(sanitized);

    const changedKeys = [];
    for (const key of Object.keys(sanitized)) {
        if (currentSettings[key] !== sanitized[key]) {
            changedKeys.push(key);
        }
    }

    currentSettings = { ...currentSettings, ...sanitized };

    if (sanitized.dynamicPlayer !== undefined) {
        applyDynamicPlayerClass(false);
    }
    if (sanitized.customCSS !== undefined) {
        injectCustomCSS(currentSettings.customCSS);
    }

    if (changedKeys.length === 0) return;

    window.dispatchEvent(new CustomEvent('YOUPLUS_SETTINGS_UPDATED', {
        detail: {
            settings: currentSettings,
            changedKeys
        }
    }));
}

if (pBrowser && pBrowser.storage) {
    pBrowser.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') {
            const changedSettings = {};
            for (let key in changes) {
                changedSettings[key] = changes[key].newValue;
            }
            console.log("Settings updated via storage:", changedSettings);
            updateSettings(changedSettings);
        }
    });
}

function applyDynamicPlayerClass(force = false) {
    const enabled = !!currentSettings.dynamicPlayer;
    if (!force && _lastAppliedDynamicPlayer === enabled) return;
    _lastAppliedDynamicPlayer = enabled;

    const layoutElement = document.getElementById('layout');
    if (layoutElement && layoutElement.classList.contains('dynamic-player') !== enabled) {
        layoutElement.classList.toggle('dynamic-player', enabled);
    }
    if (typeof LYPLUS_bgConfig !== 'undefined' && Array.isArray(LYPLUS_bgConfig.dynamicPlayerSelectors)) {
        for (let i = 0; i < LYPLUS_bgConfig.dynamicPlayerSelectors.length; i++) {
            const el = document.querySelector(LYPLUS_bgConfig.dynamicPlayerSelectors[i]);
            if (el && el.classList.contains('dynamic-player') !== enabled) {
                el.classList.toggle('dynamic-player', enabled);
            }
        }
    }
}

function injectCustomCSS(customCSS) {
    const nextCSS = customCSS || '';
    if (_lastInjectedCustomCSS === nextCSS) return;

    let styleTag = (_cachedCustomStyleTag && _cachedCustomStyleTag.isConnected)
        ? _cachedCustomStyleTag
        : document.getElementById('lyrics-plus-custom-css');

    if (!styleTag) {
        if (!nextCSS) {
            _lastInjectedCustomCSS = '';
            return;
        }
        styleTag = document.createElement('style');
        styleTag.id = 'lyrics-plus-custom-css';
        document.head.appendChild(styleTag);
    }

    _cachedCustomStyleTag = styleTag;
    _lastInjectedCustomCSS = nextCSS;
    if (styleTag.textContent !== nextCSS) {
        styleTag.textContent = nextCSS;
    }
}
