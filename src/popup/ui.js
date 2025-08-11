const pBrowser = (typeof browser !== "undefined") ? browser : chrome;

document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const lyricsProviderSelect = document.getElementById('lyricsProvider');
    const wordByWordSwitchInput = document.getElementById('wordByWord');
    const lightweightSwitchInput = document.getElementById('lightweight');
    const lyEnabledSwitchInput = document.getElementById('lyEnabled');
    const sponsorBlockSwitchInput = document.getElementById('sponsorblock');
    const blurInactiveSwitchInput = document.getElementById('blurInactive');
    const dynamicBackgroundSwitchInput = document.getElementById('dynamicBackground');
    const overrideGeminiPromptSwitchInput = document.getElementById('overrideGeminiPrompt');
    const customGeminiPromptTextarea = document.getElementById('customGeminiPrompt');
    const customGeminiPromptGroup = document.getElementById('customGeminiPromptGroup');
    
    // Verify critical elements exist (only warn for missing elements)
    if (!blurInactiveSwitchInput) console.warn('YouLy+: blurInactiveSwitchInput not found');
    if (!dynamicBackgroundSwitchInput) console.warn('YouLy+: dynamicBackgroundSwitchInput not found');
    if (!overrideGeminiPromptSwitchInput) console.warn('YouLy+: overrideGeminiPromptSwitchInput not found');

    const clearCacheButton = document.getElementById('clearCache');
    const refreshCacheButton = document.getElementById('refreshCache');
    const reloadExtensionButton = document.getElementById('reloadExtension');
    const cacheSizeElement = document.querySelector('.cache-size-value');
    const cacheCountElement = document.querySelector('.cache-count-value');

    const snackbar = document.getElementById('statusSnackbar');
    const snackbarText = snackbar.querySelector('.snackbar-text');
    let snackbarTimeout;

    // --- Tabs ---
    const tabs = document.querySelectorAll('.tab');
    const tabContents = document.querySelectorAll('.tab-content');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(tc => tc.classList.remove('active'));
            tab.classList.add('active');
            const targetContentId = tab.dataset.tab;
            document.getElementById(targetContentId)?.classList.add('active');
        });
    });

    // --- M3 Switch Click Handling ---
    document.querySelectorAll('.m3-switch').forEach(switchContainer => {
        switchContainer.addEventListener('click', function() {
            const checkbox = this.querySelector('.m3-switch-input');
            if (checkbox) {
                checkbox.checked = !checkbox.checked;
                // Manually dispatch a 'change' event to trigger settings save
                checkbox.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
        // Add keyboard support for switches
        switchContainer.addEventListener('keydown', function(event) {
            if (event.key === ' ' || event.key === 'Enter') {
                event.preventDefault(); // Prevent page scroll on space
                const checkbox = this.querySelector('.m3-switch-input');
                if (checkbox) {
                    checkbox.checked = !checkbox.checked;
                    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        });
        // Set tabindex to make the div focusable for keyboard interaction
        switchContainer.setAttribute('tabindex', '0');

        // Prevent double toggle if label is also clicked (since label also toggles the input)
        // This is only needed if clicks on children of m3-switch are not desired to bubble up
        // to THIS specific listener (they should bubble to the document).
        // This setup should be fine, as the label is a sibling, not a child of .m3-switch
    });


    // --- Settings Object ---
    let currentSettings = {
        lyricsProvider: 'kpoe',
        wordByWord: true,
        lightweight: false,
        isEnabled: true,
        useSponsorBlock: true,
        blurInactive: false,
        dynamicPlayer: false,  // Changed from dynamicBackground to dynamicPlayer to match settings
        overrideGeminiPrompt: false,
        customGeminiPrompt: '',
    };

    // --- Storage Functions (ensure polyfill.js or similar provides these) ---
    const storageLocalGet = (keys) => {
        return new Promise((resolve, reject) => {
            if (typeof pBrowser === 'undefined' || !pBrowser.storage) {
                console.warn("pBrowser.storage not available. Using mock storage.");
                // Mock for environments without extension APIs
                const mockStorage = JSON.parse(localStorage.getItem('youly_mock_storage') || '{}');
                const result = {};
                Object.keys(keys).forEach(key => {
                    if (mockStorage.hasOwnProperty(key)) result[key] = mockStorage[key];
                    else result[key] = keys[key]; // Return default if not found
                });
                resolve(result);
                return;
            }
            pBrowser.storage.local.get(keys, (result) => {
                if (pBrowser.runtime.lastError) {
                    reject(pBrowser.runtime.lastError);
                } else {
                    resolve(result);
                }
            });
        });
    };
    const storageLocalSet = (items) => {
        return new Promise((resolve, reject) => {
             if (typeof pBrowser === 'undefined' || !pBrowser.storage) {
                console.warn("pBrowser.storage not available. Using mock storage.");
                let mockStorage = JSON.parse(localStorage.getItem('youly_mock_storage') || '{}');
                mockStorage = {...mockStorage, ...items};
                localStorage.setItem('youly_mock_storage', JSON.stringify(mockStorage));
                resolve();
                return;
            }
            pBrowser.storage.local.set(items, () => {
                if (pBrowser.runtime.lastError) {
                    reject(pBrowser.runtime.lastError);
                } else {
                    resolve();
                }
            });
        });
    };

    // --- Load Settings ---
    function loadSettingsUI() {
        lyricsProviderSelect.value = currentSettings.lyricsProvider;
        wordByWordSwitchInput.checked = currentSettings.wordByWord;
        lightweightSwitchInput.checked = currentSettings.lightweight;
        lyEnabledSwitchInput.checked = currentSettings.isEnabled;
        sponsorBlockSwitchInput.checked = currentSettings.useSponsorBlock;
        if (blurInactiveSwitchInput) {
            blurInactiveSwitchInput.checked = currentSettings.blurInactive;
        }
        if (dynamicBackgroundSwitchInput) {
            dynamicBackgroundSwitchInput.checked = currentSettings.dynamicPlayer;
        }
        if (overrideGeminiPromptSwitchInput) {
            overrideGeminiPromptSwitchInput.checked = currentSettings.overrideGeminiPrompt;
        }
        if (customGeminiPromptTextarea) {
            customGeminiPromptTextarea.value = currentSettings.customGeminiPrompt || '';
        }
        
        // Update textbox visibility based on switch state
        toggleCustomGeminiPromptVisibility();
    }

    async function fetchAndLoadSettings() {
        try {
            // Provide defaults to storage.local.get if items might not exist
            const defaults = { ...currentSettings };
            const items = await storageLocalGet(defaults);
            currentSettings = items; // items will contain fetched values or defaults if not found
            loadSettingsUI();
        } catch (error) {
            console.error("YouLy+: Error loading settings:", error);
            loadSettingsUI(); // Load UI with defaults if error
        }
    }

    // --- Save Settings ---
    async function saveAndApplySettings() {
        const newSettings = {
            lyricsProvider: lyricsProviderSelect.value,
            wordByWord: wordByWordSwitchInput.checked,
            lightweight: lightweightSwitchInput.checked,
            isEnabled: lyEnabledSwitchInput.checked,
            useSponsorBlock: sponsorBlockSwitchInput.checked,
            blurInactive: blurInactiveSwitchInput ? blurInactiveSwitchInput.checked : false,
            dynamicPlayer: dynamicBackgroundSwitchInput ? dynamicBackgroundSwitchInput.checked : false,
            overrideGeminiPrompt: overrideGeminiPromptSwitchInput ? overrideGeminiPromptSwitchInput.checked : false,
            customGeminiPrompt: customGeminiPromptTextarea ? customGeminiPromptTextarea.value : '',
        };
        
        currentSettings = { ...currentSettings, ...newSettings };

        try {
            await storageLocalSet(currentSettings);
            showSnackbar('Settings saved! Reload YouTube pages for changes.');
            notifyContentScripts(currentSettings);
        } catch (error) {
            console.error("YouLy+: Error saving settings:", error);
            showSnackbar('Error saving settings.', true);
        }
    }

    // --- Toggle Custom Gemini Prompt Visibility ---
    function toggleCustomGeminiPromptVisibility() {
        if (customGeminiPromptGroup && overrideGeminiPromptSwitchInput) {
            if (overrideGeminiPromptSwitchInput.checked) {
                customGeminiPromptGroup.style.display = 'block';
            } else {
                customGeminiPromptGroup.style.display = 'none';
            }
        }
    }

    // --- Event Listeners for Settings (now on inputs) ---
    lyricsProviderSelect.addEventListener('change', saveAndApplySettings);
    
    // Textbox event listener
    if (customGeminiPromptTextarea) {
        customGeminiPromptTextarea.addEventListener('input', saveAndApplySettings);
    }
    
    // For switches, the 'change' event is dispatched manually by the .m3-switch click handler
    [wordByWordSwitchInput, lightweightSwitchInput, lyEnabledSwitchInput, sponsorBlockSwitchInput, blurInactiveSwitchInput, dynamicBackgroundSwitchInput, overrideGeminiPromptSwitchInput].forEach(input => {
        if (input) {
            input.addEventListener('change', (e) => {
                // Handle special case for overrideGeminiPrompt to toggle textbox visibility
                if (input === overrideGeminiPromptSwitchInput) {
                    toggleCustomGeminiPromptVisibility();
                }
                saveAndApplySettings();
            });
        } else {
            console.warn(`YouLy+: Switch input not found`);
        }
    });


    // --- Snackbar ---
    function showSnackbar(message, isError = false) {
        if (snackbarTimeout) clearTimeout(snackbarTimeout);
        snackbarText.textContent = message;
        // Basic error indication - you might add a specific class for styling
        snackbar.style.backgroundColor = isError ? 'var(--md-sys-color-error-container)' : 'var(--md-sys-color-inverse-surface)';
        snackbar.style.color = isError ? 'var(--md-sys-color-on-error-container)' : 'var(--md-sys-color-inverse-on-surface)';

        snackbar.classList.add('show');
        snackbarTimeout = setTimeout(() => {
            snackbar.classList.remove('show');
        }, 3500);
    }

    // --- Notify Content Scripts ---
    function notifyContentScripts(settings) {
        // Make this non-blocking and optional
        try {
            if (typeof pBrowser !== 'undefined' && pBrowser.tabs && pBrowser.tabs.query) {
                pBrowser.tabs.query({ url: ["*://*.music.youtube.com/*"] }, (tabs) => {
                    if (pBrowser.runtime.lastError) {
                        console.warn("YouLy+: Error querying tabs (this is normal if no YouTube Music tabs are open):", pBrowser.runtime.lastError.message);
                        return;
                    }
                    if (tabs.length === 0) {
                        console.log("YouLy+: No YouTube Music tabs found to notify");
                        return;
                    }
                    tabs.forEach(tab => {
                        if (tab.id) {
                            // Use Promise-based approach with better error handling
                            const sendMessage = () => {
                                if (pBrowser.tabs.sendMessage) {
                                    return pBrowser.tabs.sendMessage(tab.id, {
                                        type: 'YOUPLUS_SETTINGS_UPDATED',
                                        settings: settings
                                    });
                                }
                                return Promise.reject(new Error('sendMessage not available'));
                            };
                            
                            sendMessage()
                                .then(() => {
                                    // Successfully notified tab
                                })
                                .catch(err => {
                                    // This is normal if content script isn't injected yet - ignore silently
                                });
                        }
                    });
                });
            }
        } catch (error) {
            console.warn("YouLy+: Error in notifyContentScripts (non-critical):", error);
        }
    }

    // --- Cache Management ---
    async function updateCacheDisplay() {
        if (typeof pBrowser === 'undefined' || !pBrowser.runtime || !pBrowser.runtime.sendMessage) {
            console.warn("YouLy+: pBrowser.runtime.sendMessage not available for cache display.");
            cacheSizeElement.textContent = 'N/A';
            cacheCountElement.textContent = 'N/A';
            return;
        }
        try {
            const response = await pBrowser.runtime.sendMessage({ type: 'GET_CACHED_SIZE' });
            if (response && response.success) {
                const sizeMB = (response.sizeKB / 1024).toFixed(2);
                cacheSizeElement.textContent = `${sizeMB} MB`;
                cacheCountElement.textContent = response.cacheCount.toString();
            } else {
                cacheSizeElement.textContent = 'N/A';
                cacheCountElement.textContent = 'N/A';
                console.error("YouLy+: Error getting cache size:", response ? response.error : "No response");
            }
        } catch (error) {
            cacheSizeElement.textContent = 'Error';
            cacheCountElement.textContent = 'Error';
            console.error("YouLy+: Failed to send GET_CACHED_SIZE message:", error);
        }
    }

    clearCacheButton.addEventListener('click', async () => {
        if (typeof pBrowser === 'undefined' || !pBrowser.runtime || !pBrowser.runtime.sendMessage) {
            showSnackbar('Cannot clear cache: Extension API not available.', true);
            return;
        }
        try {
            const response = await pBrowser.runtime.sendMessage({ type: 'RESET_CACHE' });
            if (response && response.success) {
                showSnackbar('Cache cleared successfully!');
                updateCacheDisplay();
            } else {
                showSnackbar('Failed to clear cache.', true);
                console.error("YouLy+: Error resetting cache:", response ? response.error : "No response");
            }
        } catch (error) {
            showSnackbar('Error communicating to clear cache.', true);
            console.error("YouLy+: Failed to send RESET_CACHE message:", error);
        }
    });

    refreshCacheButton.addEventListener('click', () => {
        updateCacheDisplay();
        showSnackbar('Cache info refreshed.');
    });

    // --- Reload Extension ---
    reloadExtensionButton.addEventListener('click', async () => {
        if (typeof pBrowser === 'undefined' || !pBrowser.runtime || !pBrowser.runtime.reload) {
            showSnackbar('Cannot reload extension: Runtime API not available.', true);
            return;
        }
        
        try {
            showSnackbar('Reloading extension and YouTube Music tabs...');
            
            // First, reload all YouTube Music tabs
            if (pBrowser.tabs && pBrowser.tabs.query) {
                try {
                    const youtubeTabs = await new Promise((resolve, reject) => {
                        pBrowser.tabs.query(
                            { url: ["*://*.music.youtube.com/*"] }, 
                            (tabs) => {
                                if (pBrowser.runtime.lastError) {
                                    reject(pBrowser.runtime.lastError);
                                } else {
                                    resolve(tabs);
                                }
                            }
                        );
                    });
                    
                    // Reload each YouTube Music tab
                    const reloadPromises = youtubeTabs.map(tab => {
                        return new Promise((resolve) => {
                            if (tab.id) {
                                pBrowser.tabs.reload(tab.id, () => {
                                    // Ignore errors (tab might be closed, etc.)
                                    resolve();
                                });
                            } else {
                                resolve();
                            }
                        });
                    });
                    
                    await Promise.all(reloadPromises);
                                                // Successfully reloaded YouTube tabs
                    
                    // Update snackbar with count info
                    if (youtubeTabs.length > 0) {
                        showSnackbar(`Reloading extension + ${youtubeTabs.length} YouTube Music tab(s)...`);
                    }
                    
                } catch (tabError) {
                    console.warn('YouLy+: Error reloading YouTube Music tabs:', tabError);
                    // Continue with extension reload even if tab reload fails
                }
            }
            
            // Small delay to let tabs start reloading, then reload extension
            setTimeout(() => {
                pBrowser.runtime.reload();
            }, 300);
            
        } catch (error) {
            console.error('Error reloading extension:', error);
            showSnackbar('Error reloading extension.', true);
        }
    });

    // --- Storage Change Listener for Real-time Sync ---
    if (typeof pBrowser !== 'undefined' && pBrowser.storage && pBrowser.storage.onChanged) {
        pBrowser.storage.onChanged.addListener((changes, namespace) => {
            if (namespace === 'local') {
                // Update currentSettings with new values
                Object.keys(changes).forEach(key => {
                    if (currentSettings.hasOwnProperty(key)) {
                        const newValue = changes[key].newValue;
                        if (currentSettings[key] !== newValue) {
                            currentSettings[key] = newValue;
                        }
                    }
                });
                
                // Update UI to reflect changes
                loadSettingsUI();
            }
        });
    }

    // --- Initial Load ---
    fetchAndLoadSettings();
    updateCacheDisplay();
});
