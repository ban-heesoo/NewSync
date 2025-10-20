console.log('NewSync: Content script loading...');

// Simple test to see if extension is working
console.log('NewSync: Extension is running!');

// Use window to avoid conflicts with other scripts
window.currentSettings = window.currentSettings || {
    lyricsProvider: 'kpoe',
    wordByWord: true,
    lightweight: false,
    isEnabled: true,
    useSponsorBlock: false,
    largerTextMode: 'lyrics',
    dynamicPlayerPage: true,
    dynamicPlayerFullscreen: true,
    overrideGeminiPrompt: false,
    customGeminiPrompt: '',
};

// Simple load settings function
function loadSettings(callback) {
    try {
        const pBrowser = chrome || browser;
        if (typeof pBrowser !== 'undefined' && pBrowser.storage) {
            pBrowser.storage.local.get(window.currentSettings, (result) => {
                if (pBrowser.runtime.lastError) {
                    console.error("Error loading settings:", pBrowser.runtime.lastError);
                    if (callback) callback(window.currentSettings);
                } else {
                    if (callback) callback(result);
                }
            });
        } else {
            if (callback) callback(window.currentSettings);
        }
    } catch (error) {
        console.error("Error in loadSettings:", error);
        if (callback) callback(window.currentSettings);
    }
}

loadSettings((settings) => {
    console.log('NewSync: Settings loaded:', settings);
    window.currentSettings = { ...window.currentSettings, ...settings };
    console.log('NewSync: Current settings:', window.currentSettings);
    if (window.currentSettings.isEnabled) {
        console.log('NewSync: Extension enabled, initializing...');
        initializeLyricsPlus();
    } else {
        console.log('NewSync: Extension disabled');
    }
});

// Expose API for other modules to use
window.LyricsPlusAPI = {
    sendMessageToBackground: (message) => {
        return new Promise((resolve) => {
            const pBrowser = chrome || browser;
            pBrowser.runtime.sendMessage(message, (response) => {
                resolve(response);
            });
        });
    }
};

function initializeLyricsPlus() {
    console.log('NewSync: Initializing lyrics plus...');
    // Inject the DOM script
    injectPlatformCSS();
    injectDOMScript();
    injectCssFile();
    console.log('NewSync: Initialization complete');
}

// Listen for messages from the injected script
window.addEventListener('message', function (event) {
    // Only accept messages from the same frame
    if (event.source !== window) return;

    // Check if the message has our prefix
    if (event.data.type && event.data.type.startsWith('LYPLUS_')) {
        // Handle song info updates
        if (event.data.type === 'LYPLUS_SONG_CHANGED') {
            const songInfo = event.data.songInfo;
            const isNewSong = event.data.isNewSong; // Get the new song flag
            console.log('Song changed (received in extension):', songInfo);

            // Don't fetch lyrics if title or artist is empty
            if (!songInfo.title.trim() || !songInfo.artist.trim()) {
                console.log('Missing title or artist, skipping lyrics fetch.');
                return;
            }

            // Call the lyrics fetching function with the new song info and new song flag
            fetchAndDisplayLyrics(songInfo, isNewSong);
        }
    }
});

/**
 * Listen for settings updates from popup
 * Updates dynamic background when settings change
 */
// Listen for settings updates from popup
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'NEWSYNC_SETTINGS_UPDATED') {
            console.log('Settings updated from popup:', message.settings);
            console.log('Dynamic background settings:', {
                dynamicPlayerPage: message.settings.dynamicPlayerPage,
                dynamicPlayerFullscreen: message.settings.dynamicPlayerFullscreen
            });
            console.log('Settings keys received:', Object.keys(message.settings));
            
            // Update current settings and reapply dynamic background
            const previousEnabled = window.currentSettings.isEnabled;
            window.currentSettings = message.settings;
            
            // Note: Enable/disable toggle now requires page reload
            // The actual enable/disable logic is handled during initialization
            
            // Apply dynamic background changes (will be handled by injected scripts)
            // The injected scripts will receive the settings update via postMessage
            
            // Decide whether only dynamic background settings changed
            try {
                const previousSettings = (typeof window.previousSettingsSnapshot === 'object') ? window.previousSettingsSnapshot : {};
                const currentSettings = window.currentSettings || {};
                const keys = new Set([...Object.keys(previousSettings), ...Object.keys(currentSettings)]);
                const dynamicOnlyKeys = new Set([
                    'dynamicPlayerPage',
                    'dynamicPlayerFullscreen',
                    'useSongPaletteFullscreen',
                    'useSongPaletteAllModes',
                    'overridePaletteColor'
                ]);
                let changedKeys = [];
                keys.forEach(k => {
                    if (previousSettings[k] !== currentSettings[k]) changedKeys.push(k);
                });
                const onlyDynamicChanged = changedKeys.length > 0 && changedKeys.every(k => dynamicOnlyKeys.has(k));

                if (onlyDynamicChanged) {
                    // Apply dynamic background only, do not refresh lyrics
                    window.postMessage({ type: 'UPDATE_DYNAMIC_BG' }, '*');
                    // Apply immediately and also with a small delay to ensure DOM is ready
                    if (typeof window.applyDynamicPlayerClass === 'function') {
                        window.applyDynamicPlayerClass();
                        setTimeout(() => { window.applyDynamicPlayerClass(); }, 50);
                    }
                } else {
                    // Send full settings update to injected scripts
                    window.postMessage({
                        type: 'UPDATE_SETTINGS',
                        settings: window.currentSettings
                    }, '*');
                }
                // Update snapshot after handling
                window.previousSettingsSnapshot = { ...currentSettings };
            } catch (e) {
                console.warn('NewSync: Failed to diff settings in content script; sending UPDATE_SETTINGS', e);
                window.postMessage({
                    type: 'UPDATE_SETTINGS',
                    settings: window.currentSettings
                }, '*');
            }
        } else if (message.type === 'UPDATE_DYNAMIC_BG_ONLY') {
            // Handle dynamic background only update from popup
            console.log('NewSync: Received UPDATE_DYNAMIC_BG_ONLY from popup');
            window.postMessage({ type: 'UPDATE_DYNAMIC_BG' }, '*');
            if (typeof window.applyDynamicPlayerClass === 'function') {
                setTimeout(() => { window.applyDynamicPlayerClass(); }, 100);
            }
            sendResponse({ success: true });
        }
    });
}


function injectPlatformCSS() {
    if (document.querySelector('link[data-lyrics-plus-platform-style]')) return;
    const pBrowser = chrome || browser;
    const linkElement = document.createElement('link');
    linkElement.rel = 'stylesheet';
    linkElement.type = 'text/css';
    linkElement.href = pBrowser.runtime.getURL('src/modules/ytmusic/style.css');
    linkElement.setAttribute('data-lyrics-plus-platform-style', 'true');
    document.head.appendChild(linkElement);
}

function injectDOMScript() {
    const pBrowser = chrome || browser;
    const script = document.createElement('script');
    script.src = pBrowser.runtime.getURL('src/inject/ytmusic/songTracker.js');
    script.onload = function () {
        this.remove();
    };
    (document.head || document.documentElement).appendChild(script);
}

function injectCssFile() {
    const pBrowser = chrome || browser;
    if (document.querySelector('link[data-lyrics-plus-style]')) return;
    const lyricsElement = document.createElement('link');
    lyricsElement.rel = 'stylesheet';
    lyricsElement.type = 'text/css';
    lyricsElement.href = pBrowser.runtime.getURL('src/modules/lyrics/lyrics.css');
    lyricsElement.setAttribute('data-lyrics-plus-style', 'true');
    document.head.appendChild(lyricsElement);
}