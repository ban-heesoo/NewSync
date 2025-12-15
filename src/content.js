// Expose fetchAndDisplayLyrics and t globally for other modules to use
window.LyricsPlusAPI = {
    fetchAndDisplayLyrics: fetchAndDisplayLyrics,
    t: t,
    sendMessageToBackground: (message) => {
        return new Promise((resolve) => {
            const pBrowser = typeof browser !== 'undefined'
                ? browser
                : (typeof chrome !== 'undefined' ? chrome : null);
            pBrowser.runtime.sendMessage(message, (response) => {
                resolve(response);
            });
        });
    }
};

// Load settings and initialize based on isEnabled setting
// Initialize immediately to ensure songTracker.js is injected right away
// This fixes the issue where lyrics don't work on first install or after reinstall
initializeLyricsPlus();

loadSettings(() => {
    if (!currentSettings.isEnabled) {
        // If disabled, we can still keep the injection but won't process song changes
        console.log('LyricsPlus is disabled in settings');
    }
});

function injectPlatformCSS() {
    const pBrowser = typeof browser !== 'undefined'
        ? browser
        : (typeof chrome !== 'undefined' ? chrome : null);
    if (document.querySelector('link[data-lyrics-plus-platform-style]')) return;
    const linkElement = document.createElement('link');
    linkElement.rel = 'stylesheet';
    linkElement.type = 'text/css';
    if (!pBrowser?.runtime?.getURL) {
        console.warn('LyricsPlus: runtime.getURL unavailable, skipping platform CSS inject');
        return;
    }
    const hostname = window.location.hostname;
    if (hostname.includes('music.youtube.com')) {
        linkElement.href = pBrowser.runtime.getURL('src/modules/ytmusic/style.css');
    } else if (hostname.includes('listen.tidal.com')) {
        linkElement.href = pBrowser.runtime.getURL('src/modules/tidal/style.css');
    } else {
        return;
    }
    linkElement.setAttribute('data-lyrics-plus-platform-style', 'true');
    document.head.appendChild(linkElement);
}

function injectDOMScript() {
    const pBrowser = typeof browser !== 'undefined'
        ? browser
        : (typeof chrome !== 'undefined' ? chrome : null);
    if (!pBrowser?.runtime?.getURL) {
        console.warn('LyricsPlus: runtime.getURL unavailable, skipping DOM script inject');
        return;
    }
    const hostname = window.location.hostname;
    if (hostname.includes('music.youtube.com')) {
        const script = document.createElement('script');
        script.src = pBrowser.runtime.getURL('src/inject/ytmusic/songTracker.js');
        script.onload = function () {
            this.remove();
        };
        (document.head || document.documentElement).appendChild(script);
    }
}

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
                // Check if extension is enabled (defaults to true if settings not loaded yet)
                if (currentSettings && !currentSettings.isEnabled) {
                    return;
                }

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
}


function injectCssFile() {
    const pBrowser = typeof browser !== 'undefined'
        ? browser
        : (typeof chrome !== 'undefined' ? chrome : null);
    if (document.querySelector('link[data-lyrics-plus-style]')) return;
    const lyricsElement = document.createElement('link');
    lyricsElement.rel = 'stylesheet';
    lyricsElement.type = 'text/css';
    if (!pBrowser?.runtime?.getURL) {
        console.warn('LyricsPlus: runtime.getURL unavailable, skipping CSS inject');
        return;
    }
    lyricsElement.href = pBrowser.runtime.getURL('src/modules/lyrics/lyrics.css');
    lyricsElement.setAttribute('data-lyrics-plus-style', 'true');
    document.head.appendChild(lyricsElement);
}