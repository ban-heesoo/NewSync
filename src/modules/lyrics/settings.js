const pBrowser = chrome || browser;


window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;

    if (event.data.type === 'UPDATE_SETTINGS') {
        console.log("Received new settings:", event.data.settings);
        updateSettings(event.data.settings);
    }
});

// Initialize with empty object - settings will be loaded from storage
let currentSettings = {};

function loadSettings(callback) {
    storageLocalGet({
        lyricsProvider: 'kpoe',
        lyricsSourceOrder: 'apple,lyricsplus,musixmatch,spotify,musixmatch-word',
        wordByWord: true,
        lineByLine: true,
        lightweight: false,
        isEnabled: true,
        useSponsorBlock: false,
        autoHideLyrics: false,
        cacheStrategy: 'aggressive',
        fontSize: 16,
        hideOffscreen: true, // New compatibility setting
        fadePastLines: true,
        compabilityWipe: false, // New compatibility setting
        blurInactive: false,
        dynamicPlayerPage: true,
    dynamicPlayerFullscreen: true,
        // Translation settings
        translationProvider: 'google',
        geminiApiKey: '',
        geminiModel: 'gemini-2.5-flash', // Default Gemini model updated
        overrideTranslateTarget: false,
        customTranslateTarget: '',
        overrideGeminiPrompt: false,
        customGeminiPrompt: `You are a professional translator for song lyrics.
Translate the following lines into {targetLang}.
Your most important task is to preserve the original meaning, emotion, and tone of each line.
After ensuring the meaning is preserved, try to make the translation sound natural in {targetLang}.`,
        translationEnabled: false,
        romanizationEnabled: false,
        useSongPaletteFullscreen: false, // Ensure this is loaded
        useSongPaletteAllModes: false, // Ensure this is loaded
        overridePaletteColor: '', // Add this to be loaded from storage
        largerTextMode: "lyrics" // "lyrics" or "romanization"
    }).then((items) => {
        currentSettings = items;
        console.log(currentSettings);
        if (callback) callback();
    });
}

function updateSettings(newSettings) {
    console.log('NewSync: Updating settings in settings.js:', newSettings);
    console.log('NewSync: Dynamic background settings being updated:', {
        dynamicPlayerPage: newSettings.dynamicPlayerPage,
        dynamicPlayerFullscreen: newSettings.dynamicPlayerFullscreen
    });
    
    // Merge new settings with existing settings instead of replacing
    currentSettings = { ...currentSettings, ...newSettings };
    console.log('NewSync: Updated currentSettings:', currentSettings);
    
    // Apply dynamic background immediately and with a small delay to ensure DOM is ready
    applyDynamicPlayerClass();
    setTimeout(() => {
        applyDynamicPlayerClass();
    }, 50);
    
    pBrowser.runtime.sendMessage({
        type: 'SETTINGS_CHANGED',
        settings: currentSettings
    });
}

/**
 * Applies or removes dynamic-player class based on current mode and settings
 * @private
 */
function applyDynamicPlayerClass() {
    const layoutElement = document.getElementById('layout');
    if (!layoutElement) {
        console.warn('NewSync: Layout element not found for dynamic background');
        return;
    }

    // Check if we're in fullscreen mode by looking at player page element
    const playerPageElement = document.querySelector('ytmusic-player-page');
    const isFullscreen = playerPageElement && playerPageElement.hasAttribute('player-fullscreened');
    
    // Check if player page is open by looking at layout element's player-ui-state
    const playerUiState = layoutElement.getAttribute('player-ui-state');
    const isPlayerPageOpen = playerUiState === 'PLAYER_PAGE_OPEN' || playerUiState === 'MINIPLAYER_IN_PLAYER_PAGE';
    
    // Apply dynamic background based on current mode
    const shouldEnableDynamic = isFullscreen ? 
        currentSettings.dynamicPlayerFullscreen : 
        (isPlayerPageOpen ? currentSettings.dynamicPlayerPage : false);

    console.log('NewSync: Dynamic background check:', {
        playerUiState,
        isPlayerPageOpen,
        isFullscreen,
        dynamicPlayerPage: currentSettings.dynamicPlayerPage,
        dynamicPlayerFullscreen: currentSettings.dynamicPlayerFullscreen,
        shouldEnableDynamic,
        currentClass: layoutElement.classList.contains('dynamic-player')
    });

    if (shouldEnableDynamic) {
        layoutElement.classList.add('dynamic-player');
        console.log('NewSync: Dynamic background enabled');
    } else {
        layoutElement.classList.remove('dynamic-player');
        console.log('NewSync: Dynamic background disabled');
    }
}

/**
 * Sets up a MutationObserver to watch for fullscreen changes and update dynamic background
 * @private
 */
function setupDynamicBackgroundListener() {
    const layoutElement = document.getElementById('layout');
    const playerPageElement = document.querySelector('ytmusic-player-page');
    
    if (!layoutElement) return;

    const observer = new MutationObserver(() => {
        applyDynamicPlayerClass();
    });

    // Watch layout element for player-ui-state changes
    observer.observe(layoutElement, {
        attributes: true,
        attributeFilter: ['player-ui-state']
    });
    
    // Also watch player page element for fullscreen changes
    if (playerPageElement) {
        observer.observe(playerPageElement, {
            attributes: true,
            attributeFilter: ['player-fullscreened']
        });
    }
}

// Load settings and initialize
loadSettings(() => {
    console.log('NewSync: Settings loaded in settings.js:', currentSettings);
    setupDynamicBackgroundListener();
    
    // Apply dynamic background after settings are loaded
    if (typeof window.applyDynamicPlayerClass === 'function') {
        window.applyDynamicPlayerClass();
    }
    
    // Also call LYPLUS_setupBlurEffect if it exists
    if (typeof window.LYPLUS_setupBlurEffect === 'function') {
        window.LYPLUS_setupBlurEffect();
    }
});

// Expose applyDynamicPlayerClass globally for content script
window.applyDynamicPlayerClass = applyDynamicPlayerClass;

// Also expose LYPLUS_setupBlurEffect if it exists
if (typeof window.LYPLUS_setupBlurEffect === 'undefined') {
    // Import from dynamicBkg.js if available
    window.LYPLUS_setupBlurEffect = () => {
        console.log('LYPLUS_setupBlurEffect not available yet');
    };
}