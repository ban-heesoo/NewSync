// ytmusic/index.js

if (typeof LYPLUS_setBgConfig === 'function') {
    LYPLUS_setBgConfig({
        dynamicPlayerSelectors: ['#layout'],
        blurContainerParentSelector: '#layout',
        mutationObserverRootSelector: '#layout',
        artworkSelector: '.image.ytmusic-player-bar'
    });
}

// This script is the bridge between the generic renderer and the YouTube Music UI

// 1. Platform-specific implementations
const uiConfig = {
    player: 'video',
    patchParent: '#lyplus-patch-container',
    selectors: [
        '#lyplus-patch-container',
        'ytmusic-tab-renderer:has(#lyplus-patch-container)',
        'ytmusic-tab-renderer:has(#lyrics-plus-container[style*="display: block"])',
        'ytmusic-app-layout[is-mweb-modernization-enabled] ytmusic-tab-renderer:has(#lyrics-plus-container[style*="display: block"])',
        'ytmusic-player-page:not([is-video-truncation-fix-enabled])[player-fullscreened] ytmusic-tab-renderer:has(#lyrics-plus-container[style*="display: block"])'
    ],
    buttonParent: 'ytmusic-app-layout',
    disableNativeTick: true,
    seekTo: (time) => {
        window.postMessage({ type: 'LYPLUS_SEEK_TO', time: time }, '*');
    }
};
let lyricsRendererInstance = null;

function patchTabRenderer() {
    const tabRenderer = document.querySelector('#tab-renderer');

    if (tabRenderer) {
        let patchWrapper = document.getElementById('lyplus-patch-container');

        if (!patchWrapper) {
            console.log('LyricsPlus: Creating wrapper container...');
            patchWrapper = document.createElement('div');
            patchWrapper.id = 'lyplus-patch-container';
            tabRenderer.appendChild(patchWrapper);
        }

        if (!lyricsRendererInstance) {
            console.log('LyricsPlus: Initializing lyrics renderer...');
            lyricsRendererInstance = new LyricsPlusRenderer(uiConfig);
            window.lyricsRendererInstance = lyricsRendererInstance;
        }
    }
}

function getLyricsRendererInstance() {
    patchTabRenderer();
    if (lyricsRendererInstance) {
        window.lyricsRendererInstance = lyricsRendererInstance;
    }
    return lyricsRendererInstance;
}

//Create the global API for other modules to use
const LyricsPlusAPI = {
    displayLyrics: (...args) => lyricsRendererInstance.displayLyrics(...args),
    displaySongNotFound: () => lyricsRendererInstance.displaySongNotFound(),
    displaySongError: () => lyricsRendererInstance.displaySongError(),
    cleanupLyrics: () => lyricsRendererInstance.cleanupLyrics(),
    updateDisplayMode: (...args) => lyricsRendererInstance.updateDisplayMode(...args),
    updateCurrentTick: (...args) => lyricsRendererInstance.updateCurrentTick(...args),
    setTranslationLoading: (...args) => lyricsRendererInstance.setTranslationLoading(...args)
};

function injectPlatformCSS() {
    if (document.querySelector('link[data-lyrics-plus-platform-style]')) return;
    const linkElement = document.createElement('link');
    linkElement.rel = 'stylesheet';
    linkElement.type = 'text/css';
    if (!pBrowser?.runtime?.getURL) {
        console.warn('Tidal: runtime.getURL unavailable, skipping CSS inject');
        return;
    }
    linkElement.href = pBrowser.runtime.getURL('src/modules/ytmusic/style.css');
    linkElement.setAttribute('data-lyrics-plus-platform-style', 'true');
    document.head.appendChild(linkElement);
}


// Function to inject the DOM script
function injectDOMScript() {
    if (!pBrowser?.runtime?.getURL) {
        console.warn('YTMusic: runtime.getURL unavailable, skipping DOM script inject');
        return;
    }
    const script = document.createElement('script');
    script.src = pBrowser.runtime.getURL('src/inject/ytmusic/songTracker.js');
    script.onload = function () {
        this.remove();
    };
    (document.head || document.documentElement).appendChild(script);

    patchTabRenderer();

}

function isFullscreenSongMode() {
    const playerPage = document.querySelector('ytmusic-player-page');
    return !!playerPage &&
        playerPage.hasAttribute('player-fullscreened') &&
        !playerPage.hasAttribute('video-mode');
}

function removeSongInfoDisplay() {
    const renderer = lyricsRendererInstance || window.lyricsRendererInstance;
    if (renderer && typeof renderer._removeSongInfoDisplay === 'function') {
        renderer._removeSongInfoDisplay();
        return;
    }

    document.querySelectorAll('.lyrics-song-info').forEach(songInfo => songInfo.remove());
}

function addSongInfoFromDOM() {
    const renderer = getLyricsRendererInstance();
    if (renderer && typeof renderer._addSongInfoFromDOM === 'function') {
        renderer._addSongInfoFromDOM();
    }
}

let lastSongTitle = '';
let lastSongArtist = '';

function getCurrentSongInfo() {
    const titleElement = document.querySelector('.title.style-scope.ytmusic-player-bar');
    const byline = document.querySelector('.byline.style-scope.ytmusic-player-bar');

    if (titleElement && byline) {
        return {
            title: titleElement.textContent.trim(),
            artist: byline.textContent.trim()
        };
    }
    return null;
}

function refreshSongInfoIfNeeded(force = false) {
    if (!isFullscreenSongMode()) {
        lastSongTitle = '';
        lastSongArtist = '';
        removeSongInfoDisplay();
        return;
    }

    const currentSong = getCurrentSongInfo();
    const existingSongInfo = document.querySelector('.lyrics-song-info');
    const songChanged = currentSong &&
        (currentSong.title !== lastSongTitle || currentSong.artist !== lastSongArtist);

    if (currentSong && songChanged) {
        lastSongTitle = currentSong.title;
        lastSongArtist = currentSong.artist;
    }

    if (force || !existingSongInfo || songChanged) {
        addSongInfoFromDOM();
    }
}

function setupSongInfoObserver() {
    const playerPage = document.querySelector('ytmusic-player-page');
    if (!playerPage) {
        setTimeout(setupSongInfoObserver, 500);
        return;
    }

    const immediateObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (
                mutation.type === 'attributes' &&
                (mutation.attributeName === 'player-fullscreened' ||
                    mutation.attributeName === 'video-mode')
            ) {
                refreshSongInfoIfNeeded(true);
            }
        }
    });

    immediateObserver.observe(playerPage, {
        attributes: true,
        attributeFilter: ['player-fullscreened', 'video-mode']
    });
}

setupSongInfoObserver();

const globalSongInfoObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
        if (
            mutation.type === 'attributes' &&
            (mutation.attributeName === 'player-fullscreened' ||
                mutation.attributeName === 'video-mode')
        ) {
            refreshSongInfoIfNeeded(true);
        }
    }
});

function setupGlobalSongInfoObserver() {
    if (!document.body) {
        setTimeout(setupGlobalSongInfoObserver, 100);
        return;
    }

    globalSongInfoObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['player-fullscreened', 'video-mode']
    });
}

setupGlobalSongInfoObserver();

let fullscreenSongInfoInterval = null;
function startFullscreenSongInfoCheck() {
    if (fullscreenSongInfoInterval) return;

    fullscreenSongInfoInterval = setInterval(() => {
        refreshSongInfoIfNeeded(false);
    }, 100);
}

setTimeout(startFullscreenSongInfoCheck, 2000);

window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) {
        return;
    }

    if (event.data.type === 'LYPLUS_TIME_UPDATE' && typeof event.data.currentTime === 'number') {
        LyricsPlusAPI.updateCurrentTick(event.data.currentTime);
    }

    if (event.data.type === 'LYPLUS_SONG_CHANGED' && event.data.songInfo?.duration) {
        refreshSongInfoIfNeeded(true);
    }
});
