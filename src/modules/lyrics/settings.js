const pBrowser = chrome || browser;


window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;

    if (event.data.type === 'UPDATE_SETTINGS') {
        console.log("Received new settings:", event.data.settings);
        updateSettings(event.data.settings);
    }
});

let currentSettings = {
    lyricsProvider: 'kpoe', // Can be 'kpoe' or 'lrclib'
    lyricsSourceOrder: 'apple,lyricsplus,musixmatch,spotify,musixmatch-word', // For KPoe provider
    wordByWord: true,
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
    customCSS: '',
    // Translation settings
    translationProvider: 'google', // 'google' or 'gemini'
    geminiApiKey: '',
    geminiModel: 'gemini-2.5-flash', // NewSync enhancement - updated default model
    overrideTranslateTarget: false,
    customTranslateTarget: '',
    overrideGeminiPrompt: false,
    customGeminiPrompt: `You are a professional translator for song lyrics.
Translate the following lines into {targetLang}.
Your most important task is to preserve the original meaning, emotion, and tone of each line.
After ensuring the meaning is preserved, try to make the translation sound natural in {targetLang}.`,
    // New settings for translation/romanization toggle
    translationEnabled: false,
    romanizationEnabled: false,
    largerTextMode: "lyrics" // "lyrics" or "romanization"
};

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
    
    // Apply dynamic background with a small delay to ensure DOM is ready
    setTimeout(() => {
        applyDynamicPlayerClass();
    }, 100);
    
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

    // Check if we're in fullscreen mode
    const playerPageElement = document.querySelector('ytmusic-player-page');
    const isFullscreen = playerPageElement && playerPageElement.hasAttribute('player-fullscreened');
    
    // Apply dynamic background based on current mode
    const shouldEnableDynamic = isFullscreen ? 
        currentSettings.dynamicPlayerFullscreen : 
        currentSettings.dynamicPlayerPage;

    console.log('NewSync: Dynamic background check:', {
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
    const playerPageElement = document.querySelector('ytmusic-player-page');
    if (!playerPageElement) return;

    const observer = new MutationObserver(() => {
        applyDynamicPlayerClass();
    });

    observer.observe(playerPageElement, {
        attributes: true,
        attributeFilter: ['player-fullscreened']
    });
}

// Initialize the listener when settings are loaded
if (typeof currentSettings !== 'undefined') {
    setupDynamicBackgroundListener();
}

// Expose applyDynamicPlayerClass globally for content script
window.applyDynamicPlayerClass = applyDynamicPlayerClass;