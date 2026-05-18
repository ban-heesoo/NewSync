// ==================================================================================================
// SERVICE WORKER - MAIN
// ==================================================================================================

import { MessageHandler } from './core/messageHandler.js';
import { LyricsService } from './core/lyricsService.js';

const pBrowser = typeof browser !== 'undefined'
  ? browser
  : (typeof chrome !== 'undefined' ? chrome : null);

const RELOAD_MUSIC_TABS_AFTER_EXTENSION_RELOAD = 'reloadMusicTabsAfterExtensionReload';
const MUSIC_TAB_URL_PATTERNS = [
  '*://*.music.youtube.com/*',
  '*://*.music.apple.com/*',
  '*://*.tidal.com/*',
];

// ==================================================================================================
// INITIALIZATION
// ==================================================================================================

console.log('Service Worker initialized');
LyricsService.clearExpiredCache();

function storageLocalGet(keys) {
  return new Promise((resolve, reject) => {
    if (!pBrowser?.storage?.local?.get) {
      resolve({});
      return;
    }

    pBrowser.storage.local.get(keys, (result) => {
      if (pBrowser.runtime?.lastError) {
        reject(pBrowser.runtime.lastError);
      } else {
        resolve(result || {});
      }
    });
  });
}

function storageLocalRemove(keys) {
  return new Promise((resolve, reject) => {
    if (!pBrowser?.storage?.local?.remove) {
      resolve();
      return;
    }

    pBrowser.storage.local.remove(keys, () => {
      if (pBrowser.runtime?.lastError) {
        reject(pBrowser.runtime.lastError);
      } else {
        resolve();
      }
    });
  });
}

function queryTabs(queryInfo) {
  return new Promise((resolve, reject) => {
    if (!pBrowser?.tabs?.query) {
      resolve([]);
      return;
    }

    pBrowser.tabs.query(queryInfo, (tabs) => {
      if (pBrowser.runtime?.lastError) {
        reject(pBrowser.runtime.lastError);
      } else {
        resolve(tabs || []);
      }
    });
  });
}

function reloadTab(tabId) {
  return new Promise((resolve) => {
    if (!pBrowser?.tabs?.reload || !tabId) {
      resolve();
      return;
    }

    pBrowser.tabs.reload(tabId, () => resolve());
  });
}

async function reloadMusicTabsAfterExtensionReload() {
  try {
    const result = await storageLocalGet({
      [RELOAD_MUSIC_TABS_AFTER_EXTENSION_RELOAD]: null,
    });
    const pendingReload = result[RELOAD_MUSIC_TABS_AFTER_EXTENSION_RELOAD];

    if (!pendingReload) return;

    await storageLocalRemove(RELOAD_MUSIC_TABS_AFTER_EXTENSION_RELOAD);

    const createdAt = Number(pendingReload.createdAt || 0);
    if (!createdAt || Date.now() - createdAt > 30000) return;

    const musicTabs = await queryTabs({ url: MUSIC_TAB_URL_PATTERNS });
    await Promise.all(musicTabs.map((tab) => reloadTab(tab.id)));
  } catch (error) {
    console.error('Service Worker: failed to reload music tabs after extension reload', error);
  }
}

reloadMusicTabsAfterExtensionReload();

if (pBrowser?.runtime?.onMessage) {
  pBrowser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Handle BROADCAST_REFRESH_TRANSLATION special case
    if (message.type === 'BROADCAST_REFRESH_TRANSLATION') {
      try {
        const MUSIC_TAB_PATTERNS = [
          '*://*.music.youtube.com/*',
          '*://*.music.apple.com/*',
          '*://*.tidal.com/*'
        ];
        
        // Query all music tabs and send REFRESH_TRANSLATION to each
        MUSIC_TAB_PATTERNS.forEach(pattern => {
          pBrowser.tabs.query({ url: pattern }, (tabs) => {
            if (tabs && tabs.length > 0) {
              tabs.forEach(tab => {
                pBrowser.tabs.sendMessage(tab.id, { type: 'REFRESH_TRANSLATION' }, () => {
                  // Ignore runtime errors if tab does not have the content script context.
                  if (pBrowser.runtime?.lastError) {
                    return;
                  }
                });
              });
            }
          });
        });
        
        sendResponse({ success: true });
        return true;
      } catch (error) {
        console.error('Error broadcasting refresh translation:', error);
        sendResponse({ success: false, error: error.message });
        return true;
      }
    }
    
    // Handle all other messages via MessageHandler
    return MessageHandler.handle(message, sender, sendResponse);
  });
} else {
  console.error('Service Worker: runtime messaging not available');
}
