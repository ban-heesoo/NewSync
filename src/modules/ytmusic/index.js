// This script is the bridge between the generic renderer and the YouTube Music UI

// Browser compatibility - use window to avoid conflicts
window.pBrowser = window.pBrowser || chrome || browser;

// 1. Platform-specific implementations
const uiConfig = {
    player: 'video',
    patchParent: '#tab-renderer',
    selectors: [
            'ytmusic-tab-renderer:has(#lyrics-plus-container[style*="display: block"])',
            'ytmusic-app-layout[is-mweb-modernization-enabled] ytmusic-tab-renderer:has(#lyrics-plus-container[style*="display: block"])',
            'ytmusic-player-page:not([is-video-truncation-fix-enabled])[player-fullscreened] ytmusic-tab-renderer:has(#lyrics-plus-container[style*="display: block"])'
        ]
};

// Note: lyricsRendererInstance and LyricsPlusAPI are now defined in src/modules/lyrics/lyricsRenderer.js

function injectPlatformCSS() {
    if (document.querySelector('link[data-lyrics-plus-platform-style]')) return;
    const linkElement = document.createElement('link');
    linkElement.rel = 'stylesheet';
    linkElement.type = 'text/css';
    linkElement.href = window.pBrowser.runtime.getURL('src/modules/ytmusic/style.css');
    linkElement.setAttribute('data-lyrics-plus-platform-style', 'true');
    document.head.appendChild(linkElement);
}

// Function to inject the DOM script
function injectDOMScript() {
    const script = document.createElement('script');
    script.src = window.pBrowser.runtime.getURL('src/inject/ytmusic/songTracker.js');
    script.onload = function () {
        this.remove();
    };
    (document.head || document.documentElement).appendChild(script);
}