const pBrowser = (typeof browser !== "undefined") ? browser : chrome;

document.addEventListener('DOMContentLoaded', () => {
    // Set version from manifest
    const versionElement = document.getElementById('version');
    if (versionElement && pBrowser.runtime && pBrowser.runtime.getManifest) {
        const manifest = pBrowser.runtime.getManifest();
        versionElement.textContent = `v${manifest.version}`;
    }
    
    // DOM Elements
    const lyricsProviderSelect = document.getElementById('lyricsProvider');
    const wordByWordSwitchInput = document.getElementById('wordByWord');
    const lightweightSwitchInput = document.getElementById('lightweight');
    const lyEnabledSwitchInput = document.getElementById('lyEnabled');
    const sponsorBlockSwitchInput = document.getElementById('sponsorblock');
    const largerTextModeSelect = document.getElementById('largerTextMode');
    const dynamicPlayerPageSwitchInput = document.getElementById('dynamicPlayerPage');
    const dynamicPlayerFullscreenSwitchInput = document.getElementById('dynamicPlayerFullscreen');
    const overrideGeminiPromptSwitchInput = document.getElementById('overrideGeminiPrompt');
    const customGeminiPromptTextarea = document.getElementById('customGeminiPrompt');
    const customGeminiPromptGroup = document.getElementById('customGeminiPromptGroup');
    
    const clearCacheButton = document.getElementById('clearCache');
    const refreshCacheButton = document.getElementById('refreshCache');
    const reloadExtensionButton = document.getElementById('reloadExtension');
    const cacheSizeElement = document.querySelector('.cache-size-value');
    const cacheCountElement = document.querySelector('.cache-count-value');

    const status = document.getElementById('status');

    // --- Tabs ---
    const tabs = document.querySelectorAll('.tab');
    const tabContents = document.querySelectorAll('.tab-content');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(tc => tc.classList.remove('active'));
            tab.classList.add('active');
            const targetContentId = tab.dataset.target.replace('#', '');
            document.getElementById(targetContentId)?.classList.add('active');
        });
    });

    // --- Settings Object ---
    let currentSettings = {
        lyricsProvider: 'kpoe',
        wordByWord: true,
        lightweight: false,
        isEnabled: true,
        useSponsorBlock: true,
        largerTextMode: 'lyrics',
        dynamicPlayerPage: true,
        dynamicPlayerFullscreen: true,
        overrideGeminiPrompt: false,
        customGeminiPrompt: '',
    };

    // --- Storage Functions ---
    const storageLocalGet = (keys) => {
        return new Promise((resolve, reject) => {
            if (typeof pBrowser === 'undefined' || !pBrowser.storage) {
                const mockStorage = JSON.parse(localStorage.getItem('newsync_mock_storage') || '{}');
                const result = {};
                Object.keys(keys).forEach(key => {
                    if (mockStorage.hasOwnProperty(key)) result[key] = mockStorage[key];
                    else result[key] = keys[key];
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
                let mockStorage = JSON.parse(localStorage.getItem('newsync_mock_storage') || '{}');
                mockStorage = {...mockStorage, ...items};
                localStorage.setItem('newsync_mock_storage', JSON.stringify(mockStorage));
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
        
        if (largerTextModeSelect) {
            largerTextModeSelect.value = currentSettings.largerTextMode;
        }
        if (dynamicPlayerPageSwitchInput) {
            dynamicPlayerPageSwitchInput.checked = currentSettings.dynamicPlayerPage;
        }
        if (dynamicPlayerFullscreenSwitchInput) {
            dynamicPlayerFullscreenSwitchInput.checked = currentSettings.dynamicPlayerFullscreen;
        }
        if (overrideGeminiPromptSwitchInput) {
            overrideGeminiPromptSwitchInput.checked = currentSettings.overrideGeminiPrompt;
        }
        if (customGeminiPromptTextarea) {
            customGeminiPromptTextarea.value = currentSettings.customGeminiPrompt || '';
        }
        
        toggleCustomGeminiPromptVisibility();
    }

    async function fetchAndLoadSettings() {
        try {
            const defaultSettings = {
                lyricsProvider: 'kpoe',
                wordByWord: true,
                lightweight: false,
                isEnabled: true,
                useSponsorBlock: true,
                largerTextMode: 'lyrics',
                dynamicPlayerPage: true,
                dynamicPlayerFullscreen: true,
                overrideGeminiPrompt: false,
                customGeminiPrompt: '',
            };
            
            const items = await storageLocalGet(defaultSettings);
            currentSettings = { ...defaultSettings, ...items };
            loadSettingsUI();
        } catch (error) {
            console.error("NewSync: Error loading settings:", error);
            loadSettingsUI();
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
            largerTextMode: largerTextModeSelect ? largerTextModeSelect.value : 'lyrics',
            dynamicPlayerPage: dynamicPlayerPageSwitchInput ? dynamicPlayerPageSwitchInput.checked : false,
            dynamicPlayerFullscreen: dynamicPlayerFullscreenSwitchInput ? dynamicPlayerFullscreenSwitchInput.checked : false,
            overrideGeminiPrompt: overrideGeminiPromptSwitchInput ? overrideGeminiPromptSwitchInput.checked : false,
            customGeminiPrompt: customGeminiPromptTextarea ? customGeminiPromptTextarea.value : '',
        };
        
        // Check if any setting that requires reload has changed
        const settingsRequiringReload = [
            'lyricsProvider', 'useSponsorBlock', 'isEnabled'
        ];
        
        // Check if any prompt settings have changed
        const promptSettings = [
            'translationProvider', 'geminiModel', 'overrideGeminiPrompt', 'customGeminiPrompt'
        ];
        
        const requiresReload = settingsRequiringReload.some(key => {
            return currentSettings[key] !== newSettings[key];
        });
        
        const promptChanged = promptSettings.some(key => {
            return currentSettings[key] !== newSettings[key];
        });
        
        currentSettings = { ...currentSettings, ...newSettings };

        try {
            await storageLocalSet(currentSettings);
            
            // Clear translation cache if prompt settings changed
            if (promptChanged) {
                try {
                    const response = await pBrowser.runtime.sendMessage({ type: 'CLEAR_TRANSLATION_CACHE' });
                    if (response && response.success) {
                        console.log('Translation cache cleared due to prompt change');
                    }
                } catch (error) {
                    console.warn('Failed to clear translation cache:', error);
                }
            }
            
            if (requiresReload) {
                showStatus('Settings saved! Please reload YouTube Music tab.');
            } else {
                showStatus('Settings saved!');
            }
            
            notifyContentScripts(currentSettings);
        } catch (error) {
            console.error("NewSync: Error saving settings:", error);
            showStatus('Error saving settings.', true);
        }
    }

    // --- Toggle Custom Gemini Prompt Visibility ---
    function toggleCustomGeminiPromptVisibility() {
        if (customGeminiPromptGroup && overrideGeminiPromptSwitchInput) {
            if (overrideGeminiPromptSwitchInput.checked) {
                customGeminiPromptGroup.style.display = 'flex';
            } else {
                customGeminiPromptGroup.style.display = 'none';
            }
        }
    }

    // --- Event Listeners ---
    lyricsProviderSelect.addEventListener('change', saveAndApplySettings);
    if (largerTextModeSelect) {
        largerTextModeSelect.addEventListener('change', saveAndApplySettings);
    }
    
    if (customGeminiPromptTextarea) {
        customGeminiPromptTextarea.addEventListener('input', saveAndApplySettings);
    }
    
    const switchInputs = [
        wordByWordSwitchInput, 
        lightweightSwitchInput, 
        lyEnabledSwitchInput, 
        sponsorBlockSwitchInput, 
        dynamicPlayerPageSwitchInput, 
        dynamicPlayerFullscreenSwitchInput, 
        overrideGeminiPromptSwitchInput
    ];
    
    switchInputs.forEach(input => {
        if (input) {
            input.addEventListener('change', (e) => {
                if (input === overrideGeminiPromptSwitchInput) {
                    toggleCustomGeminiPromptVisibility();
                }
                saveAndApplySettings();
            });
        }
    });

    // --- Status Display ---
    function showStatus(message, isError = false) {
        if (!status) return;
        status.textContent = message;
        status.style.backgroundColor = isError ? 'rgba(239, 68, 68, 0.9)' : 'rgba(62, 62, 65, 0.95)';
        status.classList.add('active');
        
        setTimeout(() => {
            status.classList.remove('active');
        }, 3000);
    }

    // --- Notify Content Scripts ---
    function notifyContentScripts(settings) {
        try {
            if (typeof pBrowser !== 'undefined' && pBrowser.tabs && pBrowser.tabs.query) {
                pBrowser.tabs.query({ url: ["*://*.music.youtube.com/*"] }, (tabs) => {
                    if (pBrowser.runtime.lastError) return;
                    if (tabs.length === 0) return;
                    
                    tabs.forEach(tab => {
                        if (tab.id && pBrowser.tabs.sendMessage) {
                            pBrowser.tabs.sendMessage(tab.id, {
                                type: 'NEWSYNC_SETTINGS_UPDATED',
                                settings: settings
                            }).catch(() => {});
                        }
                    });
                });
            }
        } catch (error) {
            console.warn("NewSync: Error in notifyContentScripts:", error);
        }
    }

    // --- Cache Management ---
    async function updateCacheDisplay() {
        if (typeof pBrowser === 'undefined' || !pBrowser.runtime || !pBrowser.runtime.sendMessage) {
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
            }
        } catch (error) {
            cacheSizeElement.textContent = 'Error';
            cacheCountElement.textContent = 'Error';
            console.error("NewSync: Failed to get cache size:", error);
        }
    }

    clearCacheButton.addEventListener('click', async () => {
        if (typeof pBrowser === 'undefined' || !pBrowser.runtime || !pBrowser.runtime.sendMessage) {
            showStatus('Cannot clear cache.', true);
            return;
        }
        try {
            const response = await pBrowser.runtime.sendMessage({ type: 'RESET_CACHE' });
            if (response && response.success) {
                showStatus('Cache cleared!');
                updateCacheDisplay();
            } else {
                showStatus('Failed to clear cache.', true);
            }
        } catch (error) {
            showStatus('Error clearing cache.', true);
        }
    });

    refreshCacheButton.addEventListener('click', () => {
        updateCacheDisplay();
        showStatus('Cache refreshed.');
    });

    // --- Reload Extension ---
    reloadExtensionButton.addEventListener('click', async () => {
        if (typeof pBrowser === 'undefined' || !pBrowser.runtime || !pBrowser.runtime.reload) {
            showStatus('Cannot reload extension.', true);
            return;
        }
        
        try {
            showStatus('Reloading extension...');
            
            if (pBrowser.tabs && pBrowser.tabs.query) {
                try {
                    const youtubeTabs = await new Promise((resolve, reject) => {
                        pBrowser.tabs.query({ url: ["*://*.music.youtube.com/*"] }, (tabs) => {
                            if (pBrowser.runtime.lastError) {
                                reject(pBrowser.runtime.lastError);
                            } else {
                                resolve(tabs);
                            }
                        });
                    });
                    
                    const reloadPromises = youtubeTabs.map(tab => {
                        return new Promise((resolve) => {
                            if (tab.id) {
                                pBrowser.tabs.reload(tab.id, () => resolve());
                            } else {
                                resolve();
                            }
                        });
                    });
                    
                    await Promise.all(reloadPromises);
                    
                    if (youtubeTabs.length > 0) {
                        showStatus(`Reloading ${youtubeTabs.length} tab(s)...`);
                    }
                } catch (tabError) {
                    console.warn('NewSync: Error reloading tabs:', tabError);
                }
            }
            
            setTimeout(() => {
                pBrowser.runtime.reload();
            }, 300);
            
        } catch (error) {
            console.error('Error reloading extension:', error);
            showStatus('Error reloading.', true);
        }
    });

    // --- Storage Change Listener ---
    if (typeof pBrowser !== 'undefined' && pBrowser.storage && pBrowser.storage.onChanged) {
        pBrowser.storage.onChanged.addListener((changes, namespace) => {
            if (namespace === 'local') {
                Object.keys(changes).forEach(key => {
                    if (currentSettings.hasOwnProperty(key)) {
                        const newValue = changes[key].newValue;
                        if (currentSettings[key] !== newValue) {
                            currentSettings[key] = newValue;
                        }
                    }
                });
                loadSettingsUI();
            }
        });
    }

    // --- Initial Load ---
    fetchAndLoadSettings();
    updateCacheDisplay();
});
