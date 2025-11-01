document.addEventListener('DOMContentLoaded', () => {
    const pBrowser = (typeof browser !== "undefined") ? browser : chrome;
    
    const versionElement = document.getElementById('version');
    if (versionElement && pBrowser.runtime && pBrowser.runtime.getManifest) {
        const manifest = pBrowser.runtime.getManifest();
        versionElement.textContent = `v${manifest.version}`;
    }
    
    const lyricsProviderSelect = document.getElementById('lyricsProvider');
    const wordByWordSwitchInput = document.getElementById('wordByWord');
    const lightweightSwitchInput = document.getElementById('lightweight');
    const lyEnabledSwitchInput = document.getElementById('lyEnabled');
    const sponsorBlockSwitchInput = document.getElementById('sponsorblock');
    const largerTextModeSelect = document.getElementById('largerTextMode');
    const dynamicPlayerSwitchInput = document.getElementById('dynamicPlayer');
    
    const clearCacheButton = document.getElementById('clearCache');
    const refreshCacheButton = document.getElementById('refreshCache');
    const reloadExtensionButton = document.getElementById('reloadExtension');
    const cacheSizeElement = document.querySelector('.cache-size-value');
    const cacheCountElement = document.querySelector('.cache-count-value');
    
    const status = document.getElementById('status');
    
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
    
    let currentSettings = {};
    
    const storageLocalGet = (keys) => {
        return new Promise((resolve, reject) => {
            if (typeof pBrowser === 'undefined' || !pBrowser.storage) {
                console.warn("pBrowser.storage not available. Using mock storage.");
                const mockStorage = JSON.parse(localStorage.getItem('youly_mock_storage') || '{}');
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
    
    function loadSettingsUI() {
        lyricsProviderSelect.value = currentSettings.lyricsProvider;
        wordByWordSwitchInput.checked = currentSettings.wordByWord;
        lightweightSwitchInput.checked = currentSettings.lightweight;
        lyEnabledSwitchInput.checked = currentSettings.isEnabled;
        sponsorBlockSwitchInput.checked = currentSettings.useSponsorBlock;
        largerTextModeSelect.value = currentSettings.largerTextMode || 'lyrics';
        dynamicPlayerSwitchInput.checked = currentSettings.dynamicPlayer || false;
    }
    
    async function fetchAndLoadSettings() {
        try {
            const items = await storageLocalGet(defaultSettings);
            currentSettings = items;
            loadSettingsUI();
        } catch (error) {
            console.error("YouLy+: Error loading settings:", error);
            currentSettings = { ...defaultSettings };
            loadSettingsUI();
        }
    }
    
    async function saveAndApplySettings() {
        const newSettings = {
            lyricsProvider: lyricsProviderSelect.value,
            wordByWord: wordByWordSwitchInput.checked,
            lightweight: lightweightSwitchInput.checked,
            isEnabled: lyEnabledSwitchInput.checked,
            useSponsorBlock: sponsorBlockSwitchInput.checked,
            largerTextMode: largerTextModeSelect.value,
            dynamicPlayer: dynamicPlayerSwitchInput.checked,
        };
        currentSettings = { ...currentSettings, ...newSettings };
        
        try {
            await storageLocalSet(currentSettings);
            showStatus('Settings saved! Reload YouTube pages for changes.');
            notifyContentScripts(currentSettings);
        } catch (error) {
            console.error("YouLy+: Error saving settings:", error);
            showStatus('Error saving settings.', true);
        }
    }
    
    lyricsProviderSelect.addEventListener('change', saveAndApplySettings);
    largerTextModeSelect.addEventListener('change', saveAndApplySettings);
    [wordByWordSwitchInput, lightweightSwitchInput, lyEnabledSwitchInput, sponsorBlockSwitchInput, dynamicPlayerSwitchInput].forEach(input => {
        input.addEventListener('change', saveAndApplySettings);
    });
    
    function showStatus(message, isError = false) {
        if (!status) return;
        status.textContent = message;
        status.style.backgroundColor = isError ? 'rgba(239, 68, 68, 0.9)' : 'rgba(62, 62, 65, 0.95)';
        status.classList.add('active');
        
        setTimeout(() => {
            status.classList.remove('active');
        }, 3000);
    }
    
    function notifyContentScripts(settings) {
        if (typeof pBrowser !== 'undefined' && pBrowser.tabs && pBrowser.tabs.query) {
            pBrowser.tabs.query({ url: "*://*.youtube.com/*" }, (tabs) => {
                if (pBrowser.runtime.lastError) {
                    console.warn("YouLy+: Error querying tabs:", pBrowser.runtime.lastError.message);
                    return;
                }
                tabs.forEach(tab => {
                    if (tab.id) {
                        pBrowser.tabs.sendMessage(tab.id, {
                            type: 'YOUPLUS_SETTINGS_UPDATED',
                            settings: settings
                        }).catch(err => console.warn(`YouLy+: Could not send message to tab ${tab.id}: ${err.message}.`));
                    }
                });
            });
        } else {
            console.warn("YouLy+: pBrowser.tabs.query not available. Skipping content script notification.");
        }
    }
    
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
            showStatus('Cannot clear cache: Extension API not available.', true);
            return;
        }
        try {
            const response = await pBrowser.runtime.sendMessage({ type: 'RESET_CACHE' });
            if (response && response.success) {
                showStatus('Cache cleared successfully!');
                updateCacheDisplay();
            } else {
                showStatus('Failed to clear cache.', true);
                console.error("YouLy+: Error resetting cache:", response ? response.error : "No response");
            }
        } catch (error) {
            showStatus('Error communicating to clear cache.', true);
            console.error("YouLy+: Failed to send RESET_CACHE message:", error);
        }
    });
    
    refreshCacheButton.addEventListener('click', () => {
        updateCacheDisplay();
        showStatus('Cache info refreshed.');
    });
    
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
                        pBrowser.tabs.query({ url: ["*://*.youtube.com/*"] }, (tabs) => {
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
                    console.warn('YouLy+: Error reloading tabs:', tabError);
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
    
    fetchAndLoadSettings();
    updateCacheDisplay();
});
