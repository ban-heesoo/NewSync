loadSettings(() => {
    if (currentSettings.isEnabled) {
        initializeLyricsPlus();
    }
});

// Expose fetchAndDisplayLyrics and t globally for other modules to use
window.LyricsPlusAPI = {
    fetchAndDisplayLyrics: fetchAndDisplayLyrics,
    t: t,
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
    // Inject the DOM script
    injectPlatformCSS();
    injectDOMScript();
    injectCssFile();

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
            if (message.type === 'YOUPLUS_SETTINGS_UPDATED') {
                console.log('Settings updated from popup:', message.settings);
                // Update current settings and reapply dynamic background
                currentSettings = message.settings;
                if (typeof applyDynamicPlayerClass === 'function') {
                    applyDynamicPlayerClass();
                }
            }
        });
    }
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