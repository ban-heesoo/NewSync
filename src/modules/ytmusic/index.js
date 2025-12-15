// ytmusic/index.js

// This script is the bridge between the generic renderer and the YouTube Music UI

// 1. Platform-specific implementations
const uiConfig = {
    player: 'video',
    patchParent: '#tab-renderer',
    selectors: [
        'ytmusic-tab-renderer:has(#lyrics-plus-container[style*="display: block"])',
        'ytmusic-app-layout[is-mweb-modernization-enabled] ytmusic-tab-renderer:has(#lyrics-plus-container[style*="display: block"])',
        'ytmusic-player-page:not([is-video-truncation-fix-enabled])[player-fullscreened] ytmusic-tab-renderer:has(#lyrics-plus-container[style*="display: block"])'
    ],
    disableNativeTick: true,
    seekTo: (time) => {
        try {
            console.log('YTMusic uiConfig: Dispatching seek with time', time);
            
            // Primary method: postMessage (works better in Firefox)
            try {
                window.postMessage({ type: 'LYPLUS_SEEK_TO', time }, '*');
                console.log('YTMusic uiConfig: postMessage sent successfully');
            } catch (pmError) {
                console.warn('YTMusic uiConfig: postMessage failed, trying CustomEvent', pmError);
            }
            
            // Fallback method: CustomEvent
            try {
                const event = new CustomEvent('LYPLUS_SEEK_TO', { 
                    detail: { time },
                    bubbles: true,
                    cancelable: true
                });
                window.dispatchEvent(event);
                console.log('YTMusic uiConfig: CustomEvent dispatched successfully');
            } catch (ceError) {
                console.error('YTMusic uiConfig: CustomEvent also failed', ceError);
            }
        } catch (error) {
            console.error('YTMusic uiConfig: Error dispatching seek event', error);
        }
    }
};

// 2. Create the renderer instance
const lyricsRendererInstance = new LyricsPlusRenderer(uiConfig);

// Make it globally available for other observers
window.lyricsRendererInstance = lyricsRendererInstance;

// 3. Create the global API for other modules to use
const LyricsPlusAPI = {
  displayLyrics: (...args) => lyricsRendererInstance.displayLyrics(...args),
  displaySongNotFound: () => lyricsRendererInstance.displaySongNotFound(),
  displaySongError: () => lyricsRendererInstance.displaySongError(),
  cleanupLyrics: () => lyricsRendererInstance.cleanupLyrics(),
  updateDisplayMode: (...args) => lyricsRendererInstance.updateDisplayMode(...args),
  updateCurrentTick: (...args) => lyricsRendererInstance.updateCurrentTick(...args)
};

window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) {
        return;
    }

    if (event.data.type === 'LYPLUS_TIME_UPDATE' && typeof event.data.currentTime === 'number') {
        LyricsPlusAPI.updateCurrentTick(event.data.currentTime)
    }

    if (event.data.type === 'LYPLUS_SONG_CHANGED') {
        const playerPage = document.querySelector('ytmusic-player-page');
        const isFullscreen = playerPage && playerPage.hasAttribute('player-fullscreened');
        const isVideoMode = playerPage && playerPage.hasAttribute('video-mode');
        
        if (isFullscreen && !isVideoMode && window.lyricsRendererInstance) {
            const currentSong = getCurrentSongInfo();
            if (currentSong) {
                lastSongTitle = currentSong.title;
                lastSongArtist = currentSong.artist;
            }
            window.lyricsRendererInstance._addSongInfoFromDOM();
        }
    }
});

// Setup immediate song info observer - scrape directly from DOM without waiting for lyrics
function setupImmediateSongInfoObserver() {
  const playerPage = document.querySelector('ytmusic-player-page');
  if (playerPage) {
    const immediateObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'player-fullscreened') {
          const isFullscreen = mutation.target.hasAttribute('player-fullscreened');
          const isVideoMode = mutation.target.hasAttribute('video-mode');
          
          if (isFullscreen && !isVideoMode) {
            if (window.lyricsRendererInstance) {
              window.lyricsRendererInstance._addSongInfoFromDOM();
            }
          } else if (!isFullscreen) {
            const existingSongInfo = document.querySelector('.lyrics-song-info');
            if (existingSongInfo) {
              existingSongInfo.remove();
            }
          }
        }
      });
    });
    
    immediateObserver.observe(playerPage, {
      attributes: true,
      attributeFilter: ['player-fullscreened', 'video-mode']
    });
  } else {
    setTimeout(setupImmediateSongInfoObserver, 500);
  }
}

// Setup immediate observer
setupImmediateSongInfoObserver();

// Global observer for fullscreen changes
const globalObserver = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    if (mutation.type === 'attributes' && mutation.attributeName === 'player-fullscreened') {
      const playerPage = mutation.target;
      const isFullscreen = playerPage.hasAttribute('player-fullscreened');
      const isVideoMode = playerPage.hasAttribute('video-mode');
      
      if (isFullscreen && !isVideoMode) {
        if (window.lyricsRendererInstance) {
          window.lyricsRendererInstance._addSongInfoFromDOM();
        }
      } else if (!isFullscreen) {
        const existingSongInfo = document.querySelector('.lyrics-song-info');
        if (existingSongInfo) {
          existingSongInfo.remove();
        }
      }
    }
  });
});

// Observe document body for fullscreen changes
globalObserver.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['player-fullscreened']
});

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

// Aggressive fallback: Check for fullscreen and song changes every 100ms
let fullscreenCheckInterval = null;
function startFullscreenCheck() {
  if (fullscreenCheckInterval) return;
  
  fullscreenCheckInterval = setInterval(() => {
    const playerPage = document.querySelector('ytmusic-player-page');
    if (playerPage) {
      const isFullscreen = playerPage.hasAttribute('player-fullscreened');
      const isVideoMode = playerPage.hasAttribute('video-mode');
      
      if (isFullscreen && !isVideoMode) {
        const currentSong = getCurrentSongInfo();
        const existingSongInfo = document.querySelector('.lyrics-song-info');
        
        // Check if song changed or song info doesn't exist
        const songChanged = currentSong && 
          (currentSong.title !== lastSongTitle || currentSong.artist !== lastSongArtist);
        
        if (songChanged) {
          lastSongTitle = currentSong.title;
          lastSongArtist = currentSong.artist;
        }
        
        if ((!existingSongInfo || songChanged) && window.lyricsRendererInstance) {
          window.lyricsRendererInstance._addSongInfoFromDOM();
        }
      } else {
        lastSongTitle = '';
        lastSongArtist = '';
      }
    }
  }, 100);
}

// Start aggressive check after a delay
setTimeout(startFullscreenCheck, 2000);