document.addEventListener('DOMContentLoaded', () => {
    const pBrowser = (typeof browser !== "undefined") ? browser : chrome;
    const RELOAD_MUSIC_TABS_AFTER_EXTENSION_RELOAD = 'reloadMusicTabsAfterExtensionReload';

    const versionElement = document.getElementById('version');
    if (versionElement && pBrowser?.runtime?.getManifest) {
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
    const animatedAlbumArtSwitchInput = document.getElementById('animatedAlbumArt');

    const clearCacheButton = document.getElementById('clearCache');
    const refreshCacheButton = document.getElementById('refreshCache');
    const reloadExtensionButton = document.getElementById('reloadExtension');
    const cacheSizeElement = document.querySelector('.cache-size-value');
    const cacheCountElement = document.querySelector('.cache-count-value');
    const artCacheSizeElement = document.querySelector('.art-cache-size-value');
    const artCacheCountElement = document.querySelector('.art-cache-count-value');

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
                mockStorage = { ...mockStorage, ...items };
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

    const providerNameMap = {
        'kpoe': 'Lyrics+ (KPoe)',
        'customKpoe': 'Custom KPoe Server',
        'lrclib': 'LRCLIB'
    };

    function updateCurrentProviderDisplay() {
        const currentProvider = lyricsProviderSelect.value;
        const displayName = providerNameMap[currentProvider] || currentProvider;
        const displayElement = document.getElementById('currentProviderDisplay');
        if (displayElement) {
            displayElement.textContent = displayName;
        }
    }

    function loadSettingsUI() {
        lyricsProviderSelect.value = currentSettings.lyricsProvider;
        updateCurrentProviderDisplay();
        wordByWordSwitchInput.checked = currentSettings.wordByWord;
        lightweightSwitchInput.checked = currentSettings.lightweight;
        lyEnabledSwitchInput.checked = currentSettings.isEnabled;
        sponsorBlockSwitchInput.checked = currentSettings.useSponsorBlock;
        largerTextModeSelect.value = currentSettings.largerTextMode || 'lyrics';
        dynamicPlayerSwitchInput.checked = currentSettings.dynamicPlayer || false;
        if (animatedAlbumArtSwitchInput) {
            animatedAlbumArtSwitchInput.checked = currentSettings.animatedAlbumArt !== false;
        }
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
            animatedAlbumArt: animatedAlbumArtSwitchInput ? animatedAlbumArtSwitchInput.checked : true,
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

    lyricsProviderSelect.addEventListener('change', () => {
        updateCurrentProviderDisplay();
        saveAndApplySettings();
    });
    largerTextModeSelect.addEventListener('change', saveAndApplySettings);
    [wordByWordSwitchInput, lightweightSwitchInput, lyEnabledSwitchInput, sponsorBlockSwitchInput, dynamicPlayerSwitchInput, animatedAlbumArtSwitchInput].forEach(input => {
        if (input) input.addEventListener('change', saveAndApplySettings);
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

    async function openIndexedDB(dbName, storeName) {
        return new Promise((resolve) => {
            const request = indexedDB.open(dbName);
            request.onsuccess = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(storeName)) {
                    db.close();
                    resolve({ count: 0, sizeKB: 0 });
                    return;
                }
                const tx = db.transaction([storeName], "readonly");
                const store = tx.objectStore(storeName);
                const getAll = store.getAll();
                getAll.onsuccess = () => {
                    const items = getAll.result || [];
                    const bytes = items.reduce((acc, item) => acc + new TextEncoder().encode(JSON.stringify(item)).length, 0);
                    db.close();
                    resolve({ count: items.length, sizeKB: bytes / 1024 });
                };
                getAll.onerror = () => {
                    db.close();
                    resolve({ count: 0, sizeKB: 0 });
                };
            };
            request.onerror = () => resolve({ count: 0, sizeKB: 0 });
        });
    }

    async function updateCacheDisplay() {
        let sizeKB = 0;
        let cacheCount = 0;
        let artSizeKB = 0;
        let artCacheCount = 0;
        let fetched = false;

        if (typeof pBrowser !== 'undefined' && pBrowser.runtime && pBrowser.runtime.sendMessage) {
            try {
                const response = await pBrowser.runtime.sendMessage({ type: 'GET_CACHED_SIZE' });
                if (response && response.success) {
                    sizeKB = response.sizeKB || 0;
                    cacheCount = response.cacheCount || 0;
                    artSizeKB = response.artSizeKB || 0;
                    artCacheCount = response.artCacheCount || 0;
                    fetched = true;
                }
            } catch (error) {
                console.warn("YouLy+: GET_CACHED_SIZE message fallback:", error);
            }
        }

        if (!fetched) {
            try {
                const [lyricsStats, translationsStats] = await Promise.all([
                    openIndexedDB("LyricsCacheDB", "lyrics"),
                    openIndexedDB("TranslationsCacheDB", "translations")
                ]);
                sizeKB = lyricsStats.sizeKB + translationsStats.sizeKB;
                cacheCount = lyricsStats.count + translationsStats.count;
                fetched = true;
            } catch (e) {
                console.error("YouLy+: IndexedDB direct read error:", e);
            }
        }

        // Always check storage.local for animated album art cache (bls_ keys)
        if (typeof pBrowser !== 'undefined' && pBrowser.storage && pBrowser.storage.local) {
            try {
                const all = await new Promise((resolve) => pBrowser.storage.local.get(null, resolve));
                if (all) {
                    let localArtCount = 0;
                    let localArtBytes = 0;
                    for (const [key, value] of Object.entries(all)) {
                        if (key.startsWith("bls_")) {
                            localArtCount += 1;
                            localArtBytes += key.length + JSON.stringify(value).length;
                        }
                    }
                    if (localArtCount > 0 || !fetched) {
                        artCacheCount = localArtCount;
                        artSizeKB = localArtBytes / 1024;
                    }
                }
            } catch (e) {
                console.error("YouLy+: Direct storage.local read error:", e);
            }
        }

        const lSizeMB = (sizeKB / 1024).toFixed(2);

        if (cacheSizeElement) cacheSizeElement.textContent = `${lSizeMB} MB`;
        if (cacheCountElement) cacheCountElement.textContent = cacheCount.toString();
        if (artCacheCountElement) artCacheCountElement.textContent = artCacheCount.toString();
    }

    clearCacheButton.addEventListener('click', async () => {
        let success = false;
        if (typeof pBrowser !== 'undefined' && pBrowser.runtime && pBrowser.runtime.sendMessage) {
            try {
                const response = await pBrowser.runtime.sendMessage({ type: 'RESET_CACHE' });
                if (response && response.success) {
                    success = true;
                }
            } catch (error) {
                console.warn("YouLy+: RESET_CACHE message error, executing fallback:", error);
            }
        }

        // Direct clear fallback for IndexedDB & Chrome Storage
        try {
            const clearDB = (dbName, storeName) => new Promise((resolve) => {
                const req = indexedDB.open(dbName);
                req.onsuccess = (e) => {
                    const db = e.target.result;
                    if (db.objectStoreNames.contains(storeName)) {
                        const tx = db.transaction([storeName], "readwrite");
                        tx.objectStore(storeName).clear();
                        tx.oncomplete = () => { db.close(); resolve(); };
                        tx.onerror = () => { db.close(); resolve(); };
                    } else { db.close(); resolve(); }
                };
                req.onerror = () => resolve();
            });

            await Promise.all([
                clearDB("LyricsCacheDB", "lyrics"),
                clearDB("TranslationsCacheDB", "translations")
            ]);

            if (typeof pBrowser !== 'undefined' && pBrowser.storage && pBrowser.storage.local) {
                const all = await new Promise((resolve) => pBrowser.storage.local.get(null, resolve));
                if (all) {
                    const keysToRemove = Object.keys(all).filter(key => key.startsWith("bls_"));
                    if (keysToRemove.length > 0) {
                        await new Promise((resolve) => pBrowser.storage.local.remove(keysToRemove, resolve));
                    }
                }
            }
            success = true;
        } catch (e) {
            console.error("YouLy+: Direct cache clear error:", e);
        }

        if (success) {
            showStatus('Cache cleared successfully!');
            updateCacheDisplay();
        } else {
            showStatus('Failed to clear cache.', true);
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
            await storageLocalSet({
                [RELOAD_MUSIC_TABS_AFTER_EXTENSION_RELOAD]: {
                    createdAt: Date.now(),
                },
            });
            showStatus('Reloading extension, then music tabs...');
        } catch (error) {
            console.error('YouLy+: Error scheduling music tabs reload:', error);
            showStatus('Reloading extension only...');
        }

        setTimeout(() => {
            pBrowser.runtime.reload();
        }, 150);
    });

    fetchAndLoadSettings();
    updateCacheDisplay();
});
