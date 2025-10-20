import { loadSettings, saveSettings, updateSettings, getSettings, updateCacheSize, clearCache, setupSettingsMessageListener } from './settingsManager.js';
import { startFullPreviewSync } from './previewManager.js';

let currentSettings = {}; // Will be initialized when loaded from storage

// Shows a notification bar telling the user to reload their YTM tab
function showReloadNotification() {
    const notification = document.getElementById('reload-notification');
    if (notification) {
        notification.style.display = 'flex'; // Use flex to align items
    }
}

// Hides the notification bar
function hideReloadNotification() {
    const notification = document.getElementById('reload-notification');
    if (notification) {
        notification.style.display = 'none';
    }
}

/**
 * Sets up listeners for controls that should save automatically on change
 * Maps DOM element IDs to setting keys and their types
 */
function setupAutoSaveListeners() {
    const autoSaveControls = [
        // General
        { id: 'enabled', key: 'isEnabled', type: 'checkbox' },
        { id: 'default-provider', key: 'lyricsProvider', type: 'value' },
        { id: 'custom-kpoe-url', key: 'customKpoeUrl', type: 'value' }, // Add custom KPoe URL
        { id: 'sponsor-block', key: 'useSponsorBlock', type: 'checkbox' },
        { id: 'wordByWord', key: 'wordByWord', type: 'checkbox' },
        // Appearance
        { id: 'lightweight', key: 'lightweight', type: 'checkbox' },
        { id: 'hide-offscreen', key: 'hideOffscreen', type: 'checkbox' },
        { id: 'fade-past-lines', key: 'fadePastLines', type: 'checkbox' },
        { id: 'compability-wipe', key: 'compabilityWipe', type: 'checkbox' },
        { id: 'blur-inactive', key: 'blurInactive', type: 'checkbox' },
        { id: 'dynamic-player-page', key: 'dynamicPlayerPage', type: 'checkbox' },
        { id: 'dynamic-player-fullscreen', key: 'dynamicPlayerFullscreen', type: 'checkbox' },
        { id: 'useSongPaletteFullscreen', key: 'useSongPaletteFullscreen', type: 'checkbox' },
        { id: 'useSongPaletteAllModes', key: 'useSongPaletteAllModes', type: 'checkbox' },
        { id: 'overridePaletteColor', key: 'overridePaletteColor', type: 'value' },
        { id: 'larger-text-mode', key: 'largerTextMode', type: 'value' },
        // Translation
        { id: 'translation-provider', key: 'translationProvider', type: 'value' },
        { id: 'gemini-model', key: 'geminiModel', type: 'value' },
        { id: 'override-translate-target', key: 'overrideTranslateTarget', type: 'checkbox' },
        { id: 'override-gemini-prompt', key: 'overrideGeminiPrompt', type: 'checkbox' },
        { id: 'override-gemini-romanize-prompt', key: 'overrideGeminiRomanizePrompt', type: 'checkbox' }, // New auto-save for romanize prompt override
        { id: 'romanization-provider', key: 'romanizationProvider', type: 'value' }, // Auto-save romanization provider
        { id: 'gemini-romanization-model', key: 'geminiRomanizationModel', type: 'value' }, // Auto-save Gemini romanization model
        // Cache
        { id: 'cache-strategy', key: 'cacheStrategy', type: 'value' },
    ];

    autoSaveControls.forEach(control => {
        const element = document.getElementById(control.id);
        if (element) {
            element.addEventListener('change', (e) => {
                const value = control.type === 'checkbox' ? e.target.checked : e.target.value;
                const newSetting = { [control.key]: value };

                // Update both the global settings and local reference
                updateSettings(newSetting);
                currentSettings = { ...currentSettings, ...newSetting };
                saveSettings();
                
                // Check if dynamic background settings changed
                const dynamicBackgroundSettings = [
                    'dynamic-player-page', 'dynamic-player-fullscreen'
                ];
                
                if (dynamicBackgroundSettings.includes(control.id)) {
                    // Send settings update to YouTube Music tab to apply dynamic background
                    try {
                        if (typeof chrome !== 'undefined' && chrome.tabs) {
                            chrome.tabs.query({ url: "*://music.youtube.com/*" }, (tabs) => {
                                if (tabs && tabs.length > 0) {
                                    tabs.forEach(tab => {
                                        chrome.tabs.sendMessage(tab.id, {
                                            type: 'NEWSYNC_SETTINGS_UPDATED',
                                            settings: currentSettings
                                        }).catch(() => {
                                            // Tab might not be ready, ignore error
                                        });
                                    });
                                }
                            });
                        }
                    } catch (error) {
                        console.warn('Failed to notify YouTube Music tab:', error);
                    }
                    showStatusMessage('Setting saved!', false, control.id);
                    return;
                }
                
                // Only show reload notification for settings that require page reload
                const settingsRequiringReload = [
                    'default-provider', 'custom-kpoe-url', 'sponsor-block', 
                    'translation-provider', 'gemini-model', 'romanization-provider', 
                    'gemini-romanization-model', 'override-translate-target', 
                    'custom-translate-target', 'override-gemini-prompt', 
                    'custom-gemini-prompt', 'override-gemini-romanize-prompt', 
                    'custom-gemini-romanize-prompt'
                ];
                
                if (settingsRequiringReload.includes(control.id)) {
                    showReloadNotification();
                } else {
                    showStatusMessage('Setting saved!', false, control.id);
                }

                // Handle UI visibility toggles for specific controls
                if (control.id === 'default-provider') {
                    toggleKpoeSourcesVisibility();
                    toggleCustomKpoeUrlVisibility();
                    toggleLocalLyricsVisibility();
                } else if (control.id === 'translation-provider') {
                    toggleGeminiSettingsVisibility();
                } else if (control.id === 'romanization-provider') {
                    toggleRomanizationModelVisibility();
                } else if (control.id === 'override-translate-target') {
                    toggleTranslateTargetVisibility();
                } else if (control.id === 'override-gemini-prompt') {
                    toggleGeminiPromptVisibility();
                } else if (control.id === 'override-gemini-romanize-prompt') {
                    toggleGeminiRomanizePromptVisibility();
                }
            });
        }
    });
}

function updateFormElements(settings) {
    // General settings
    document.getElementById('enabled').checked = settings.isEnabled;
    document.getElementById('default-provider').value = settings.lyricsProvider;
    document.getElementById('sponsor-block').checked = settings.useSponsorBlock;
    document.getElementById('lightweight').checked = settings.lightweight;
    document.getElementById('wordByWord').checked = settings.wordByWord;
    document.getElementById('hide-offscreen').checked = settings.hideOffscreen;
    document.getElementById('fade-past-lines').checked = !!settings.fadePastLines;
    document.getElementById('compability-wipe').checked = settings.compabilityWipe;
    document.getElementById('blur-inactive').checked = settings.blurInactive;
    document.getElementById('dynamic-player-page').checked = settings.dynamicPlayerPage;
    document.getElementById('dynamic-player-fullscreen').checked = settings.dynamicPlayerFullscreen;
    document.getElementById('useSongPaletteFullscreen').checked = settings.useSongPaletteFullscreen;
    document.getElementById('useSongPaletteAllModes').checked = settings.useSongPaletteAllModes;
    document.getElementById('overridePaletteColor').value = settings.overridePaletteColor;
    document.getElementById('larger-text-mode').value = settings.largerTextMode;
    
    // Custom KPoe Server URL
    const customKpoeUrlInput = document.getElementById('custom-kpoe-url');
    if (customKpoeUrlInput) {
        customKpoeUrlInput.value = settings.customKpoeUrl || '';
    }

    // Romanization settings
    document.getElementById('romanization-provider').value = settings.romanizationProvider;
    document.getElementById('gemini-romanization-model').value = settings.geminiRomanizationModel || 'gemini-1.5-pro-latest';

    // Translation settings
    document.getElementById('translation-provider').value = settings.translationProvider;
    const geminiApiKeyInput = document.getElementById('gemini-api-key');
    geminiApiKeyInput.value = settings.geminiApiKey || '';
    geminiApiKeyInput.type = 'password'; // Ensure it's hidden by default

    document.getElementById('gemini-model').value = settings.geminiModel || 'gemini-2.5-flash'; // Default to gemini-2.5-flash
    document.getElementById('override-translate-target').checked = settings.overrideTranslateTarget;
    document.getElementById('custom-translate-target').value = settings.customTranslateTarget || '';
    document.getElementById('override-gemini-prompt').checked = settings.overrideGeminiPrompt;
    document.getElementById('custom-gemini-prompt').value = settings.customGeminiPrompt || '';
    document.getElementById('override-gemini-romanize-prompt').checked = settings.overrideGeminiRomanizePrompt; // Update UI for new setting
    document.getElementById('custom-gemini-romanize-prompt').value = settings.customGeminiRomanizePrompt || ''; // Update UI for new setting
    toggleGeminiSettingsVisibility();
    toggleKpoeSourcesVisibility();
    toggleTranslateTargetVisibility();
    toggleGeminiPromptVisibility();
    toggleGeminiRomanizePromptVisibility(); // New visibility toggle for romanize prompt
    toggleCustomKpoeUrlVisibility(); // New visibility toggle
    toggleLocalLyricsVisibility(); // New visibility toggle for local lyrics
    toggleRomanizationModelVisibility(); // New visibility toggle for romanization model

    // Populate draggable KPoe sources
    populateDraggableSources();

    // Appearance settings
    document.getElementById('custom-css').value = settings.customCSS;

    // Cache settings
    document.getElementById('cache-strategy').value = settings.cacheStrategy;
    updateCacheSize(); // This function is now in settingsManager.js
}

// Update UI elements to reflect current settings
function updateUI(settings) {
    currentSettings = { ...settings }; // Create a proper copy of settings
    
    // Update all form elements
    updateFormElements(settings);
    
    // Version display is handled in DOMContentLoaded
}

// Tab navigation
document.querySelectorAll('.navigation-drawer .nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        // Update active menu item
        document.querySelectorAll('.navigation-drawer .nav-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');

        // Show corresponding section
        const sectionId = item.getAttribute('data-section');
        document.querySelectorAll('.settings-card').forEach(section => section.classList.remove('active'));
        const activeSection = document.getElementById(sectionId);
        if (activeSection) {
            activeSection.classList.add('active');
        } else {
            console.warn(`Section with id "${sectionId}" not found.`);
        }
    });
});

// Event listeners for save buttons (now only for manual input fields)
document.getElementById('save-general').addEventListener('click', () => {
    const draggableList = document.getElementById('lyrics-source-order-draggable');
    const orderedSources = Array.from(draggableList.children)
        .map(item => item.dataset.source);

    const newGeneralSettings = {
        // Switches and dropdowns are auto-saved. This button only saves the source order and custom KPoe URL.
        lyricsSourceOrder: orderedSources.join(','),
        customKpoeUrl: document.getElementById('custom-kpoe-url').value, // Save custom KPoe URL
    };
    updateSettings(newGeneralSettings);
    saveSettings();
    showStatusMessage('General settings saved!', false, 'save-general');
});

document.getElementById('save-appearance').addEventListener('click', () => {
    const newAppearanceSettings = {
        // Switches are auto-saved. This button only saves the Custom CSS.
        customCSS: document.getElementById('custom-css').value,
    };
    updateSettings(newAppearanceSettings);
    saveSettings();
    showStatusMessage('Custom CSS saved!', false, 'save-appearance');
});

document.getElementById('save-translation').addEventListener('click', () => {
    const newTranslationSettings = {
        // Switches and dropdowns are auto-saved. This saves text inputs.
        geminiApiKey: document.getElementById('gemini-api-key').value,
        customTranslateTarget: document.getElementById('custom-translate-target').value,
        customGeminiPrompt: document.getElementById('custom-gemini-prompt').value,
        customGeminiRomanizePrompt: document.getElementById('custom-gemini-romanize-prompt').value // Save new romanization prompt
    };
    updateSettings(newTranslationSettings);
    saveSettings();
    showStatusMessage('Translation input fields saved!', false, 'save-translation');
});

// REMOVED: save-cache event listener is no longer needed.

// Clear cache button
document.getElementById('clear-cache').addEventListener('click', clearCache);

// Message listener for updates (e.g., from background script if settings are changed elsewhere)
setupSettingsMessageListener(updateUI);


// --- Drag and Drop Functionality for KPoe Sources ---
let draggedItem = null;

// Helper to get display name for a source
function getSourceDisplayName(sourceName) {
    switch (sourceName) {
        case 'lyricsplus': return 'Lyrics+ (User Gen.)'; // Shorter for UI
        case 'apple': return 'Apple Music';
        case 'spotify': return 'Musixmatch (Spotify)'; // Clarified
        case 'musixmatch': return 'Musixmatch (Direct)';
        case 'musixmatch-word': return 'Musixmatch (Word)'; // Shorter
        default: return sourceName.charAt(0).toUpperCase() + sourceName.slice(1).replace('-', ' ');
    }
}

function createDraggableSourceItem(sourceName) {
    const item = document.createElement('div');
    item.classList.add('draggable-source-item');
    item.setAttribute('draggable', 'true');
    item.dataset.source = sourceName;

    item.innerHTML = `
        <span class="material-symbols-outlined drag-handle">drag_indicator</span>
        <span class="source-name">${getSourceDisplayName(sourceName)}</span>
        <button class="remove-source-button btn-icon btn-icon-error" title="Remove source">
            <span class="material-symbols-outlined">delete</span>
        </button>
    `;

    const removeButton = item.querySelector('.remove-source-button');
    removeButton.addEventListener('click', (e) => {
        e.stopPropagation();
        removeSource(sourceName);
    });

    return item;
}

function populateDraggableSources() {
    const draggableContainer = document.getElementById('lyrics-source-order-draggable');
    const availableSourcesDropdown = document.getElementById('available-sources-dropdown');
    const allowedSources = ['lyricsplus', 'apple', 'spotify', 'musixmatch', 'musixmatch-word'];

    if (!draggableContainer || !availableSourcesDropdown) return;

    draggableContainer.innerHTML = '';
    availableSourcesDropdown.innerHTML = '';

    const currentActiveSources = (currentSettings.lyricsSourceOrder || '').split(',').filter(s => s && s.trim() !== '');

    currentActiveSources.forEach(source => {
        if (allowedSources.includes(source.trim())) { // Only add if it's a known allowed source
            draggableContainer.appendChild(createDraggableSourceItem(source.trim()));
        }
    });

    const sourcesToAdd = allowedSources.filter(source => !currentActiveSources.includes(source));
    const addSourceButton = document.getElementById('add-source-button');

    if (sourcesToAdd.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'All sources added';
        option.disabled = true;
        availableSourcesDropdown.appendChild(option);
        if (addSourceButton) addSourceButton.disabled = true;
    } else {
        if (addSourceButton) addSourceButton.disabled = false;
        sourcesToAdd.forEach(source => {
            const option = document.createElement('option');
            option.value = source;
            option.textContent = getSourceDisplayName(source);
            availableSourcesDropdown.appendChild(option);
        });
    }

    addDragDropListeners();
}

let statusMessageTimeout;
function showStatusMessage(message, isError = false, buttonIdToAppendAfter = null) {
    const statusElement = document.getElementById('add-source-status'); // General status for draggable list
    let targetStatusElement = statusElement;

    // If a buttonId is provided, try to find a place near that button for more specific feedback
    if (buttonIdToAppendAfter) {
        const button = document.getElementById(buttonIdToAppendAfter);
        if (button && button.parentElement && button.parentElement.classList.contains('card-actions')) {
            let specificStatus = button.parentElement.querySelector('.save-status-message');
            if (!specificStatus) {
                specificStatus = document.createElement('p');
                specificStatus.className = 'status-message save-status-message';
                button.parentElement.insertBefore(specificStatus, button); // Insert before the button
            }
            targetStatusElement = specificStatus;
        }
    }

    if (targetStatusElement) {
        clearTimeout(statusMessageTimeout); // Clear existing timeout
        targetStatusElement.textContent = message;
        targetStatusElement.style.color = isError ? 'var(--md-sys-color-error)' : 'var(--md-sys-color-primary)';
        targetStatusElement.style.opacity = '1';

        statusMessageTimeout = setTimeout(() => {
            targetStatusElement.style.opacity = '0';
            setTimeout(() => { // Ensure text is cleared after fade out
                if (targetStatusElement.classList.contains('save-status-message')) {
                    // Only clear if it's a temporary message, not the general add-source-status
                    targetStatusElement.textContent = '';
                } else if (targetStatusElement === statusElement) {
                    statusElement.textContent = ''; // Clear general add-source-status as well
                }
            }, 300);
        }, 3000);
    }
}


function addSource() {
    const availableSourcesDropdown = document.getElementById('available-sources-dropdown');
    const sourceName = availableSourcesDropdown.value;

    if (!sourceName) {
        showStatusMessage('Please select a source to add.', true);
        return;
    }

    const sources = (currentSettings.lyricsSourceOrder || '').split(',').filter(s => s && s !== '');
    if (sources.includes(sourceName)) {
        showStatusMessage(`Source "${getSourceDisplayName(sourceName)}" already exists.`, true);
        return;
    }

    sources.push(sourceName);
    currentSettings.lyricsSourceOrder = sources.join(',');
    // No saveSettings() here, will be saved with "Save General"
    populateDraggableSources();
    showStatusMessage(`"${getSourceDisplayName(sourceName)}" added. Save general settings to apply.`, false);
}

function removeSource(sourceName) {
    const sources = (currentSettings.lyricsSourceOrder || '').split(',').filter(s => s && s !== '');
    const updatedSources = sources.filter(s => s !== sourceName);
    currentSettings.lyricsSourceOrder = updatedSources.join(',');
    // No saveSettings() here
    populateDraggableSources();
    showStatusMessage(`"${getSourceDisplayName(sourceName)}" removed. Save general settings to apply.`, false);
}


function addDragDropListeners() {
    const draggableContainer = document.getElementById('lyrics-source-order-draggable');
    if (!draggableContainer) return;

    draggableContainer.addEventListener('dragstart', (e) => {
        if (e.target.classList.contains('draggable-source-item')) {
            draggedItem = e.target;
            setTimeout(() => {
                if (draggedItem) draggedItem.classList.add('dragging');
            }, 0);
        }
    });

    draggableContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        const afterElement = getDragAfterElement(draggableContainer, e.clientY);
        const currentDraggable = document.querySelector('.draggable-source-item.dragging');
        if (currentDraggable) {
            if (afterElement == null) {
                draggableContainer.appendChild(currentDraggable);
            } else {
                draggableContainer.insertBefore(currentDraggable, afterElement);
            }
        }
    });

    draggableContainer.addEventListener('dragend', () => {
        if (draggedItem) {
            draggedItem.classList.remove('dragging');
        }
        draggedItem = null;
        // Update currentSettings.lyricsSourceOrder immediately but don't save to storage yet
        const orderedSources = Array.from(draggableContainer.children)
            .map(item => item.dataset.source);
        currentSettings.lyricsSourceOrder = orderedSources.join(',');
        // User will click "Save General" to persist this
        showStatusMessage('Source order updated. Save general settings to apply.', false);
    });
}

function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.draggable-source-item:not(.dragging)')];

    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: -Infinity }).element;
}


// Event listener for Add Source button
document.getElementById('add-source-button').addEventListener('click', addSource);

// =================== LOCAL LYRICS MANAGEMENT ===================

// Import parser functions
import { parseSyncedLyrics, parseAppleMusicLRC, parseAppleTTML, v1Tov2, convertToStandardJson } from './parser.js';

// Import local lyrics functions
import { uploadLocalLyrics, getLocalLyricsList, deleteLocalLyrics, updateLocalLyrics, fetchLocalLyrics } from './settingsManager.js';

async function handleUploadLocalLyrics() {
    const title = document.getElementById('modal-upload-song-title').value.trim();
    const artist = document.getElementById('modal-upload-artist-name').value.trim();
    const album = document.getElementById('modal-upload-album-name').value.trim();
    const songwriter = document.getElementById('modal-upload-songwriter-name').value.trim();
    const format = document.getElementById('modal-upload-lyrics-format').value;
    const lyricsFile = document.getElementById('modal-upload-lyrics-file').files[0];

    if (!title || !artist || !lyricsFile) {
        showStatusMessage('Song Title, Artist Name, and a Lyrics File are required.', true, 'modal-upload-lyrics-button');
        return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
        const lyricsContent = e.target.result;
        const songInfo = { title, artist, album, songwriter };

        try {
            let parsedLyrics;
            switch (format) {
                case 'lrc': // Both LRC and ELRC will use parseSyncedLyrics
                case 'elrc':
                    parsedLyrics = parseSyncedLyrics(lyricsContent, songInfo);
                    break;
                case 'apple-lrc':
                    parsedLyrics = parseAppleMusicLRC(lyricsContent, songInfo);
                    break;
                case 'ttml':
                    parsedLyrics = parseAppleTTML(lyricsContent, 0, false, songInfo);
                    break;
                case 'json':
                    parsedLyrics = JSON.parse(lyricsContent);
                    if (parsedLyrics && parsedLyrics.KpoeTools && !parsedLyrics.KpoeTools.includes('1.31R2-LPlusBcknd')) {
                        console.log("Converting V1 JSON to V2 format.");
                        parsedLyrics = v1Tov2(parsedLyrics);
                    } else if (parsedLyrics && !parsedLyrics.KpoeTools && parsedLyrics.lyrics && parsedLyrics.lyrics.length > 0 && parsedLyrics.lyrics[0].isLineEnding !== undefined) {
                        console.log("Converting older V1 JSON (no KpoeTools) to V2 format.");
                        parsedLyrics = v1Tov2(parsedLyrics);
                    }
                    break;
                default:
                    throw new Error('Unsupported lyrics format.');
            }
            const jsonLyrics = format === 'json' ? parsedLyrics : convertToStandardJson(parsedLyrics);

            await uploadLocalLyrics(songInfo, jsonLyrics);
            showStatusMessage('Lyrics uploaded successfully!', false, 'modal-upload-lyrics-button');
            document.getElementById('modal-upload-song-title').value = '';
            document.getElementById('modal-upload-artist-name').value = '';
            document.getElementById('modal-upload-album-name').value = '';
            document.getElementById('modal-upload-songwriter-name').value = '';
            document.getElementById('modal-upload-lyrics-file').value = ''; // Clear file input
            document.getElementById('upload-lyrics-modal').classList.remove('show'); // Close modal
            populateLocalLyricsList(); // Refresh the list after upload
        } catch (error) {
            showStatusMessage(`Error uploading lyrics: ${error}`, true, 'modal-upload-lyrics-button');
        }
    };
    reader.onerror = () => {
        showStatusMessage('Error reading file.', true, 'modal-upload-lyrics-button');
    };
    reader.readAsText(lyricsFile);
}

// Global variable to store current editing item
let currentEditingItem = null;

async function openEditLyricsModal(item) {
    try {
        // Fetch the actual lyrics data
        const response = await fetchLocalLyrics(item.songId);
        if (response.success) {
            currentEditingItem = {
                songId: item.songId,
                songInfo: item.songInfo,
                lyrics: response.lyrics
            };
        } else {
            throw new Error(response.error || 'Failed to fetch lyrics data');
        }
        
        // Populate the edit modal with current data
        document.getElementById('modal-edit-song-title').value = item.songInfo.title || '';
        document.getElementById('modal-edit-artist-name').value = item.songInfo.artist || '';
        document.getElementById('modal-edit-album-name').value = item.songInfo.album || '';
        document.getElementById('modal-edit-songwriter-name').value = item.songInfo.songwriter || '';
        
        // Clear the file input
        document.getElementById('modal-edit-lyrics-file').value = '';
        
        // Show the edit modal
        const modal = document.getElementById('edit-lyrics-modal');
        if (modal) {
            modal.classList.add('show');
        }
    } catch (error) {
        console.error('Error opening edit modal:', error);
        showStatusMessage(`Error loading lyrics for editing: ${error.message || error}`, true, 'refresh-local-lyrics-list');
    }
}

async function handleEditLocalLyrics() {
    const title = document.getElementById('modal-edit-song-title').value.trim();
    const artist = document.getElementById('modal-edit-artist-name').value.trim();
    const album = document.getElementById('modal-edit-album-name').value.trim();
    const songwriter = document.getElementById('modal-edit-songwriter-name').value.trim();
    const format = document.getElementById('modal-edit-lyrics-format').value;
    const lyricsFile = document.getElementById('modal-edit-lyrics-file').files[0];

    if (!title || !artist) {
        showStatusMessage('Song Title and Artist Name are required.', true, 'modal-edit-lyrics-button');
        return;
    }

    if (!currentEditingItem) {
        showStatusMessage('No lyrics item selected for editing.', true, 'modal-edit-lyrics-button');
        return;
    }

    // If no new file is uploaded, just update the metadata
    if (!lyricsFile) {
        try {
            const updatedSongInfo = { title, artist, album, songwriter };
            
            // Update the lyrics metadata in the existing lyrics object
            const updatedLyrics = {
                ...currentEditingItem.lyrics,
                metadata: {
                    ...currentEditingItem.lyrics.metadata,
                    title: title,
                    artist: artist,
                    album: album,
                    songWriters: songwriter ? songwriter.split(',').map(name => name.trim()).filter(name => name) : []
                }
            };
            
            await updateLocalLyrics(currentEditingItem.songId, updatedSongInfo, updatedLyrics);
            
            showStatusMessage('Lyrics metadata updated successfully!', false, 'modal-edit-lyrics-button');
            console.log('Settings before closeEditModal:', currentSettings);
            closeEditModal();
            console.log('Settings after closeEditModal:', currentSettings);
            populateLocalLyricsList(); // Refresh list
            console.log('Settings after populateLocalLyricsList:', currentSettings);
            
            // Notify content script to refresh lyrics if currently playing
            try {
                if (typeof chrome !== 'undefined' && chrome.tabs) {
                    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
                        if (tabs[0]) {
                            chrome.tabs.sendMessage(tabs[0].id, {
                                type: 'REFRESH_LYRICS_AFTER_EDIT',
                                songId: currentEditingItem.songId
                            });
                        }
                    });
                }
            } catch (error) {
                console.warn('Failed to notify content script:', error);
            }
        } catch (error) {
            showStatusMessage(`Error updating lyrics: ${error}`, true, 'modal-edit-lyrics-button');
        }
        return;
    }

    // If a new file is uploaded, parse and update the lyrics
    const reader = new FileReader();
    reader.onload = async (e) => {
        const lyricsContent = e.target.result;
        const songInfo = { title, artist, album, songwriter };

        try {
            let parsedLyrics;
            switch (format) {
                case 'lrc': // Both LRC and ELRC will use parseSyncedLyrics
                case 'elrc':
                    parsedLyrics = parseSyncedLyrics(lyricsContent, songInfo);
                    break;
                case 'apple-lrc':
                    parsedLyrics = parseAppleMusicLRC(lyricsContent, songInfo);
                    break;
                case 'ttml':
                    parsedLyrics = parseAppleTTML(lyricsContent, 0, false, songInfo);
                    break;
                case 'json':
                    parsedLyrics = JSON.parse(lyricsContent);
                    if (parsedLyrics && parsedLyrics.KpoeTools && !parsedLyrics.KpoeTools.includes('1.31R2-LPlusBcknd')) {
                        console.log("Converting V1 JSON to V2 format.");
                        parsedLyrics = v1Tov2(parsedLyrics);
                    } else if (parsedLyrics && !parsedLyrics.KpoeTools && parsedLyrics.lyrics && parsedLyrics.lyrics.length > 0 && parsedLyrics.lyrics[0].isLineEnding !== undefined) {
                        console.log("Converting older V1 JSON (no KpoeTools) to V2 format.");
                        parsedLyrics = v1Tov2(parsedLyrics);
                    }
                    break;
                default:
                    throw new Error('Unsupported lyrics format.');
            }
            const jsonLyrics = format === 'json' ? parsedLyrics : convertToStandardJson(parsedLyrics);

            await updateLocalLyrics(currentEditingItem.songId, songInfo, jsonLyrics);
            
            showStatusMessage('Lyrics updated successfully!', false, 'modal-edit-lyrics-button');
            console.log('Settings before closeEditModal (file upload):', currentSettings);
            closeEditModal();
            console.log('Settings after closeEditModal (file upload):', currentSettings);
            populateLocalLyricsList(); // Refresh list
            console.log('Settings after populateLocalLyricsList (file upload):', currentSettings);
            
            // Notify content script to refresh lyrics if currently playing
            try {
                if (typeof chrome !== 'undefined' && chrome.tabs) {
                    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
                        if (tabs[0]) {
                            chrome.tabs.sendMessage(tabs[0].id, {
                                type: 'REFRESH_LYRICS_AFTER_EDIT',
                                songId: currentEditingItem.songId
                            });
                        }
                    });
                }
            } catch (error) {
                console.warn('Failed to notify content script:', error);
            }
        } catch (error) {
            console.error("Error updating lyrics:", error);
            showStatusMessage(`Error updating lyrics: ${error.message || error}`, true, 'modal-edit-lyrics-button');
        }
    };
    reader.onerror = () => {
        showStatusMessage('Error reading file.', true, 'modal-edit-lyrics-button');
    };
    reader.readAsText(lyricsFile);
}

function closeEditModal() {
    const modal = document.getElementById('edit-lyrics-modal');
    if (modal) {
        modal.classList.remove('show');
    }
    currentEditingItem = null;
    
    // Clear form fields
    document.getElementById('modal-edit-song-title').value = '';
    document.getElementById('modal-edit-artist-name').value = '';
    document.getElementById('modal-edit-album-name').value = '';
    document.getElementById('modal-edit-songwriter-name').value = '';
    document.getElementById('modal-edit-lyrics-file').value = '';
}

async function populateLocalLyricsList() {
    console.log('populateLocalLyricsList called, currentSettings:', currentSettings);
    const localLyricsListContainer = document.getElementById('local-lyrics-list');
    if (!localLyricsListContainer) {
        console.error('local-lyrics-list container not found');
        return;
    }

    // Clear existing content
    localLyricsListContainer.innerHTML = '';

    try {
        const lyricsList = await getLocalLyricsList();
        console.log('Retrieved lyrics list:', lyricsList);
        
        if (lyricsList.length === 0) {
            localLyricsListContainer.innerHTML = '<p class="helper-text" id="no-local-lyrics-message">No local lyrics uploaded yet.</p>';
            return;
        }

        lyricsList.forEach(item => {
            const listItem = document.createElement('div');
            listItem.className = 'draggable-source-item';
            listItem.dataset.songId = item.songId;
            listItem.innerHTML = `
                <span class="material-symbols-outlined drag-handle">music_note</span>
                <span class="source-name">${item.songInfo.title} - ${item.songInfo.artist}</span>
                <div class="source-actions">
                    <button class="edit-source-button btn-icon btn-icon-primary" title="Edit local lyrics">
                        <span class="material-symbols-outlined">edit</span>
                    </button>
                    <button class="remove-source-button btn-icon btn-icon-error" title="Delete local lyrics">
                        <span class="material-symbols-outlined">delete</span>
                    </button>
                </div>
            `;
            
            // Add event listener for edit button
            const editBtn = listItem.querySelector('.edit-source-button');
            if (editBtn) {
                editBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    try {
                        await openEditLyricsModal(item);
                    } catch (error) {
                        showStatusMessage(`Error loading lyrics for editing: ${error}`, true, 'refresh-local-lyrics-list');
                    }
                });
            }
            
            // Add event listener for delete button
            const deleteBtn = listItem.querySelector('.remove-source-button');
            if (deleteBtn) {
                deleteBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (confirm(`Are you sure you want to delete "${item.songInfo.title} - ${item.songInfo.artist}"?`)) {
                        try {
                            await deleteLocalLyrics(item.songId);
                            showStatusMessage('Local lyrics deleted.', false, 'refresh-local-lyrics-list');
                            populateLocalLyricsList(); // Refresh list after deletion
                        } catch (error) {
                            showStatusMessage(`Error deleting lyrics: ${error}`, true, 'refresh-local-lyrics-list');
                        }
                    }
                });
            }
            
            localLyricsListContainer.appendChild(listItem);
        });
    } catch (error) {
        console.error("Failed to load local lyrics list:", error);
        localLyricsListContainer.innerHTML = `<p class="error-text">Error loading local lyrics: ${error.message || error}</p>`;
    }
}


// Event listeners for local lyrics
document.addEventListener('DOMContentLoaded', () => {
    console.log('Setting up local lyrics event listeners');
    
    // Load local lyrics list on page load
    setTimeout(() => {
        populateLocalLyricsList();
    }, 100);

    // FAB button
    const addLyricsFab = document.getElementById('add-lyrics-fab');
    if (addLyricsFab) {
        console.log('FAB button found, adding event listener');
        addLyricsFab.addEventListener('click', (e) => {
            e.preventDefault();
            console.log('FAB clicked, opening modal');
            const modal = document.getElementById('upload-lyrics-modal');
            if (modal) {
                modal.classList.add('show');
                console.log('Modal should be visible now');
            } else {
                console.error('Modal not found');
            }
        });
    } else {
        console.error('FAB button not found');
    }

    // Modal close button
    const closeButton = document.querySelector('#upload-lyrics-modal .close-button');
    if (closeButton) {
        closeButton.addEventListener('click', (e) => {
            e.preventDefault();
            const modal = document.getElementById('upload-lyrics-modal');
            if (modal) {
                modal.classList.remove('show');
            }
        });
    } else {
        console.error('Close button not found');
    }

    // Modal close on outside click
    window.addEventListener('click', (event) => {
        const modal = document.getElementById('upload-lyrics-modal');
        if (event.target === modal) {
            modal.classList.remove('show');
        }
    });

    // Upload button
    const uploadButton = document.getElementById('modal-upload-lyrics-button');
    if (uploadButton) {
        uploadButton.addEventListener('click', handleUploadLocalLyrics);
    } else {
        console.error('Upload button not found');
    }

    // Edit modal close button
    const editCloseButton = document.querySelector('#edit-lyrics-modal .close-button');
    if (editCloseButton) {
        editCloseButton.addEventListener('click', (e) => {
            e.preventDefault();
            closeEditModal();
        });
    } else {
        console.error('Edit modal close button not found');
    }

    // Edit modal close on outside click
    window.addEventListener('click', (event) => {
        const editModal = document.getElementById('edit-lyrics-modal');
        if (event.target === editModal) {
            closeEditModal();
        }
    });

    // Edit button
    const editButton = document.getElementById('modal-edit-lyrics-button');
    if (editButton) {
        editButton.addEventListener('click', handleEditLocalLyrics);
    } else {
        console.error('Edit button not found');
    }

    // Refresh button
    const refreshButton = document.getElementById('refresh-local-lyrics-list');
    if (refreshButton) {
        refreshButton.addEventListener('click', populateLocalLyricsList);
    } else {
        console.error('Refresh button not found');
    }
});

// Function to toggle KPoe sources visibility
function toggleKpoeSourcesVisibility() {
    const kpoeSourcesGroup = document.getElementById('kpoe-sources-group');
    if (kpoeSourcesGroup) {
        if (currentSettings.lyricsProvider === 'kpoe' || currentSettings.lyricsProvider === 'customKpoe') {
            kpoeSourcesGroup.style.display = 'block';
        } else {
            kpoeSourcesGroup.style.display = 'none';
        }
    }
}

// Event listener for default-provider change is now handled in setupAutoSaveListeners

// Function to toggle Custom KPoe URL visibility
function toggleCustomKpoeUrlVisibility() {
    const customKpoeUrlGroup = document.getElementById('custom-kpoe-url-group');
    if (customKpoeUrlGroup) {
        if (currentSettings.lyricsProvider === 'customKpoe') {
            customKpoeUrlGroup.style.display = 'block';
        } else {
            customKpoeUrlGroup.style.display = 'none';
        }
    }
}

// Function to toggle Local Lyrics visibility
function toggleLocalLyricsVisibility() {
    const localLyricsSection = document.getElementById('local-lyrics');
    if (localLyricsSection) {
        // Only show if this section is currently active, otherwise let CSS handle visibility
        if (localLyricsSection.classList.contains('active')) {
            localLyricsSection.style.display = 'block';
        }
        // If not active, don't force display - let the tab switching logic handle it
    }
}

// Event listener for override-translate-target change is now handled in setupAutoSaveListeners

// Event listener for override-gemini-prompt change is now handled in setupAutoSaveListeners

// Event listener for override-gemini-romanize-prompt change is now handled in setupAutoSaveListeners

// Function to toggle Gemini settings visibility (API key, model, prompt override)
function toggleGeminiSettingsVisibility() {
    const translationProvider = document.getElementById('translation-provider').value;
    const geminiApiKeyGroup = document.getElementById('gemini-api-key-group');
    const geminiModelGroup = document.getElementById('gemini-model-group');
    const overrideGeminiPromptGroup = document.getElementById('override-gemini-prompt-group');
    const overrideGeminiRomanizePromptGroup = document.getElementById('override-gemini-romanize-prompt-group'); // Get the new romanize prompt group

    if (geminiApiKeyGroup && geminiModelGroup && overrideGeminiPromptGroup && overrideGeminiRomanizePromptGroup) {
        if (translationProvider === 'gemini') {
            geminiApiKeyGroup.style.display = 'block';
            geminiModelGroup.style.display = 'block'; // Show the model group
            overrideGeminiPromptGroup.style.display = 'block';
            overrideGeminiRomanizePromptGroup.style.display = 'block'; // Show the romanize prompt group
        } else {
            geminiApiKeyGroup.style.display = 'none';
            geminiModelGroup.style.display = 'none'; // Hide the model group
            overrideGeminiPromptGroup.style.display = 'none';
            overrideGeminiRomanizePromptGroup.style.display = 'none'; // Hide the romanize prompt group
        }
    }
    toggleGeminiPromptVisibility(); // Re-evaluate prompt visibility based on new provider
    toggleGeminiRomanizePromptVisibility(); // Re-evaluate romanize prompt visibility
}

// Function to toggle custom translate target visibility
function toggleTranslateTargetVisibility() {
    const overrideTranslateTarget = document.getElementById('override-translate-target').checked;
    const customTranslateTargetGroup = document.getElementById('custom-translate-target-group');
    if (customTranslateTargetGroup) {
        if (overrideTranslateTarget) {
            customTranslateTargetGroup.style.display = 'block';
        } else {
            customTranslateTargetGroup.style.display = 'none';
        }
    }
}

// Function to toggle custom Gemini translation prompt visibility
function toggleGeminiPromptVisibility() {
    const translationProvider = document.getElementById('translation-provider').value;
    const overrideGeminiPrompt = document.getElementById('override-gemini-prompt').checked;
    const customGeminiPromptGroup = document.getElementById('custom-gemini-prompt-group');
    if (customGeminiPromptGroup) {
        if (translationProvider === 'gemini' && overrideGeminiPrompt) {
            customGeminiPromptGroup.style.display = 'block';
        } else {
            customGeminiPromptGroup.style.display = 'none';
        }
    }
}

// Function to toggle Gemini Romanization Model visibility
function toggleRomanizationModelVisibility() {
    const romanizationProvider = document.getElementById('romanization-provider').value;
    const geminiRomanizationModelGroup = document.getElementById('gemini-romanization-model-group');
    if (geminiRomanizationModelGroup) {
        if (romanizationProvider === 'gemini') {
            geminiRomanizationModelGroup.style.display = 'block';
        } else {
            geminiRomanizationModelGroup.style.display = 'none';
        }
    }
}

// Function to toggle custom Gemini romanization prompt visibility
function toggleGeminiRomanizePromptVisibility() {
    const translationProvider = document.getElementById('translation-provider').value;
    const overrideGeminiRomanizePrompt = document.getElementById('override-gemini-romanize-prompt').checked;
    const customGeminiRomanizePromptGroup = document.getElementById('custom-gemini-romanize-prompt-group');
    if (customGeminiRomanizePromptGroup) {
        if (translationProvider === 'gemini' && overrideGeminiRomanizePrompt) {
            customGeminiRomanizePromptGroup.style.display = 'block';
        } else {
            customGeminiRomanizePromptGroup.style.display = 'none';
        }
    }
}

document.getElementById('toggle-gemini-api-key-visibility').addEventListener('click', () => {
    const apiKeyInput = document.getElementById('gemini-api-key');
    const toggleButtonIcon = document.querySelector('#toggle-gemini-api-key-visibility .material-symbols-outlined');
    if (apiKeyInput.type === 'password') {
        apiKeyInput.type = 'text';
        toggleButtonIcon.textContent = 'visibility_off';
    } else {
        apiKeyInput.type = 'password';
        toggleButtonIcon.textContent = 'visibility';
    }
});
function setAppVersion() {
    try {
        // Use pBrowser for better compatibility
        const browser = window.chrome || window.browser;
        if (browser && browser.runtime && browser.runtime.getManifest) {
            const manifest = browser.runtime.getManifest();
            const version = manifest.version;
            const versionElement = document.querySelector('.version');
            if (versionElement) {
                versionElement.textContent = `Version ${version}`;
            }
        } else {
            console.warn("Browser runtime API not available");
            const versionElement = document.querySelector('.version');
            if (versionElement) {
                versionElement.textContent = 'Version unavailable';
            }
        }
    } catch (e) {
        console.error("Could not retrieve extension version from manifest:", e);
        const versionElement = document.querySelector('.version');
        if (versionElement) {
            versionElement.textContent = 'Version unavailable';
        }
    }
}

// Initial load
document.addEventListener('DOMContentLoaded', () => {
    // Setup auto-save listeners first, but don't trigger them
    setupAutoSaveListeners();

    loadSettings((settings) => {
        // Update both local and global settings
        currentSettings = { ...settings };
        updateUI(currentSettings);

        const firstNavItem = document.querySelector('.navigation-drawer .nav-item');
        const activeSectionId = firstNavItem ? firstNavItem.getAttribute('data-section') : 'general';

        document.querySelectorAll('.navigation-drawer .nav-item').forEach(i => i.classList.remove('active'));
        document.querySelector(`.navigation-drawer .nav-item[data-section="${activeSectionId}"]`)?.classList.add('active');

        document.querySelectorAll('.settings-card').forEach(section => section.classList.remove('active'));
        document.getElementById(activeSectionId)?.classList.add('active');
    });

    setAppVersion();
    
    // Add event listener for the new reload button
    const reloadButton = document.getElementById('reload-button');
    if (reloadButton) {
        reloadButton.addEventListener('click', () => {
            try {
                // Use pBrowser for better compatibility
                const browser = window.chrome || window.browser;
                if (browser && browser.tabs && browser.tabs.query) {
                    // Find the YouTube Music tab and reload it
                    browser.tabs.query({ url: "*://music.youtube.com/*" }, (tabs) => {
                        if (browser.runtime.lastError) {
                            console.error("Error querying tabs:", browser.runtime.lastError);
                            alert("Error finding YouTube Music tab: " + browser.runtime.lastError.message);
                            return;
                        }
                        if (tabs && tabs.length > 0) {
                            const ytmTab = tabs[0];
                            browser.tabs.reload(ytmTab.id, () => {
                                if (browser.runtime.lastError) {
                                    console.error("Error reloading tab:", browser.runtime.lastError);
                                    alert("Error reloading tab: " + browser.runtime.lastError.message);
                                } else {
                                    // After reloading, hide the notification and show success message
                                    hideReloadNotification();
                                    showStatusMessage('YouTube Music tab reloaded!', false, 'save-general');
                                }
                            });
                        } else {
                            // Handle case where no YTM tab is open
                            alert("No YouTube Music tab found. Please open one and try again.");
                        }
                    });
                } else {
                    console.warn("Browser tabs API not available");
                    alert("Tab reload feature is not available in this context.");
                }
            } catch (error) {
                console.error("Exception while reloading tab:", error);
                alert("Error reloading tab: " + error.message);
            }
        });
    }
});
