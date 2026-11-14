// ytmusic/index.js

if (typeof LYPLUS_setBgConfig === 'function') {
    LYPLUS_setBgConfig({
        dynamicPlayerSelectors: ['#layout'],
        blurContainerParentSelector: '#layout',
        mutationObserverRootSelector: '#layout',
        artworkSelector: '.image.ytmusic-player-bar, img.ytmusicTrackInfoThumbnail, .ytmusicTrackInfoThumbnail'
    });
}

// This script is the bridge between the generic renderer and the YouTube Music UI

// 1. Platform-specific implementations
const uiConfig = {
    player: 'video',
    patchParent: '#lyplus-patch-container',
    selectors: [
        '#lyplus-patch-container.is-visible',
        '#lyplus-patch-container',
        'ytmusic-tab-renderer.is-visible',
        'ytmusic-tab-renderer',
        'ytmusic-app-layout[is-mweb-modernization-enabled] ytmusic-tab-renderer.is-visible',
        'ytmusic-player-page:not([is-video-truncation-fix-enabled])[player-fullscreened] ytmusic-tab-renderer.is-visible'
    ],
    buttonParent: 'ytmusic-app-layout',
    disableNativeTick: true,
    isPlaying: () => {
        const video = document.querySelector('video');
        return video ? (!video.paused && !video.ended) : false;
    },
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
            if (window.__lyplusLyricsVisible) {
                patchWrapper.classList.add('is-visible');
            }
            tabRenderer.appendChild(patchWrapper);
        }

        if (!document.getElementById('lyrics-plus-container')) {
            console.log('LyricsPlus: Lyrics container missing, checking for reuse...');

            if (!lyricsRendererInstance) {
                lyricsRendererInstance = new LyricsPlusRenderer(uiConfig);
            }
            window.lyricsRendererInstance = lyricsRendererInstance;
            if (window.__lyplusLyricsVisible) {
                document.getElementById('lyrics-plus-container')?.classList.add('is-visible');
            }
        } else if (lyricsRendererInstance) {
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

// Create the global API for other modules to use
const LyricsPlusAPI = {
    displayLyrics: (...args) => lyricsRendererInstance?.displayLyrics(...args),
    displaySongNotFound: (...args) => lyricsRendererInstance?.displaySongNotFound(...args),
    displaySongError: (...args) => lyricsRendererInstance?.displaySongError(...args),
    cleanupLyrics: () => lyricsRendererInstance?.cleanupLyrics(),
    updateDisplayMode: (...args) => lyricsRendererInstance?.updateDisplayMode(...args),
    updateCurrentTick: (...args) => lyricsRendererInstance?.updateCurrentTick(...args),
    setPlaybackState: (...args) => lyricsRendererInstance?.setPlaybackState(...args),
    setTranslationLoading: (...args) => lyricsRendererInstance?.setTranslationLoading(...args),
    showToast: (...args) => lyricsRendererInstance?.showToast(...args),
    setUserOffset: (...args) => lyricsRendererInstance?.setUserOffset(...args),
    setAvailableProviders: (...args) => lyricsRendererInstance?.setAvailableProviders(...args)
};

function injectPlatformCSS() {
    if (document.querySelector('link[data-lyrics-plus-platform-style]')) return;
    const linkElement = document.createElement('link');
    linkElement.rel = 'stylesheet';
    linkElement.type = 'text/css';
    if (!pBrowser?.runtime?.getURL) {
        console.warn('YTMusic: runtime.getURL unavailable, skipping CSS inject');
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

// --- NewSync Fullscreen Song Info ---
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
const TITLE_SEL = '.title.style-scope.ytmusic-player-bar, .ytmusicTrackInfoTitle';
const BYLINE_SEL = '.byline.style-scope.ytmusic-player-bar, .ytmusicTrackInfoByline';

function getCurrentSongInfo() {
    const titleElement = document.querySelector(TITLE_SEL);
    const byline = document.querySelector(BYLINE_SEL);

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
        if (window.AnimatedArtManager && typeof window.AnimatedArtManager.handleSongChange === 'function') {
            window.AnimatedArtManager.handleSongChange(event.data.songInfo);
        }
    }
});

// --- Fullscreen Cursor Auto-Hide ---
const CURSOR_IDLE_DELAY = 2000;
const FULLSCREEN_SELECTOR = [
    'ytmusic-app-layout[player-fullscreened]',
    'ytmusic-app-layout[player-ui-state="FULLSCREEN"]',
    'ytmusic-player-page[player-fullscreened]',
    '#layout[player-ui-state="FULLSCREEN"]'
].join(',');

let isFullscreen = false;
let cursorHidden = false;
let idleTimer = 0;
let lastActivity = 0;
let activityAbort = null;
let fsCheckQueued = false;

function computeFullscreen() {
    return !!(
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.querySelector(FULLSCREEN_SELECTOR)
    );
}

function setCursorHidden(hidden) {
    if (cursorHidden === hidden) return;
    cursorHidden = hidden;
    document.documentElement.classList.toggle('lyplus-hide-cursor', hidden);
    document.body?.classList.toggle('lyplus-hide-cursor', hidden);
}

function checkIdle() {
    idleTimer = 0;
    const remaining = CURSOR_IDLE_DELAY - (performance.now() - lastActivity);
    if (remaining > 16) {
        idleTimer = setTimeout(checkIdle, remaining);
        return;
    }
    if (isFullscreen) setCursorHidden(true);
}

function onActivity() {
    lastActivity = performance.now();
    if (cursorHidden) setCursorHidden(false);
    if (!idleTimer) idleTimer = setTimeout(checkIdle, CURSOR_IDLE_DELAY);
}

function applyFullscreenState() {
    fsCheckQueued = false;
    const next = computeFullscreen();
    if (next === isFullscreen) return;
    isFullscreen = next;

    if (next) {
        activityAbort = new AbortController();
        const opts = { passive: true, signal: activityAbort.signal };
        window.addEventListener('pointermove', onActivity, opts);
        window.addEventListener('pointerdown', onActivity, opts);
        window.addEventListener('keydown', onActivity, opts);
        window.addEventListener('wheel', onActivity, opts);
        window.addEventListener('blur', () => setCursorHidden(false), opts);
        onActivity();
    } else {
        activityAbort?.abort();
        activityAbort = null;
        clearTimeout(idleTimer);
        idleTimer = 0;
        setCursorHidden(false);
    }
}

function queueFullscreenCheck() {
    if (fsCheckQueued) return;
    fsCheckQueued = true;
    requestAnimationFrame(applyFullscreenState);
}

function initFullscreenCursorManager() {
    document.addEventListener('fullscreenchange', queueFullscreenCheck, { passive: true });
    document.addEventListener('webkitfullscreenchange', queueFullscreenCheck, { passive: true });

    new MutationObserver(queueFullscreenCheck).observe(document.documentElement, {
        attributes: true,
        subtree: true,
        attributeFilter: ['player-fullscreened', 'player-ui-state']
    });

    applyFullscreenState();
}

initFullscreenCursorManager();
