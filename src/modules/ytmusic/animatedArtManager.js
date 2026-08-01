// src/modules/ytmusic/animatedArtManager.js

(function () {
    const API_ENDPOINT = "https://artwork.boidu.dev";
    const VIDEO_ELEMENT_ID = "bls-video";
    const NOT_FOUND_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days cache expiry for non-existent art
    const ALLOWED_VIDEO_HOSTS = new Set(["mvod.itunes.apple.com"]);

    let pendingFetch = null;
    let lastProcessedVideoId = null;

    function abortPendingFetch() {
        if (pendingFetch) {
            pendingFetch.abort();
            pendingFetch = null;
        }
    }

    function getCacheKey(artist, album) {
        return `bls_${artist}|${album}`;
    }

    function isNotFoundEntry(value) {
        return typeof value === "object" && value !== null && "notFoundAt" in value;
    }

    function getStorage(key) {
        return new Promise((resolve) => {
            if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
                chrome.storage.local.get([key], (result) => {
                    resolve(result ? result[key] : undefined);
                });
            } else if (typeof browser !== "undefined" && browser.storage && browser.storage.local) {
                browser.storage.local.get(key).then((result) => {
                    resolve(result ? result[key] : undefined);
                }).catch(() => resolve(undefined));
            } else {
                resolve(undefined);
            }
        });
    }

    function setStorage(key, value) {
        return new Promise((resolve) => {
            const data = { [key]: value };
            if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
                chrome.storage.local.set(data, () => resolve());
            } else if (typeof browser !== "undefined" && browser.storage && browser.storage.local) {
                browser.storage.local.set(data).then(() => resolve()).catch(() => resolve());
            } else {
                resolve();
            }
        });
    }

    async function fetchArtworkUrl(song, artist, duration, album, signal) {
        const cacheKey = getCacheKey(artist, album);

        try {
            const cached = await getStorage(cacheKey);
            if (cached !== undefined) {
                if (typeof cached === "string") {
                    console.log(`Animated art: Cache hit for "${artist} - ${album}"`);
                    return cached;
                }
                if (isNotFoundEntry(cached)) {
                    const isExpired = Date.now() - cached.notFoundAt >= NOT_FOUND_EXPIRY_MS;
                    if (!isExpired) {
                        console.log(`Animated art: Cache hit (not found) for "${artist} - ${album}"`);
                        return null;
                    }
                }
            }
        } catch (e) {
            console.error("Animated art: Cache read error", e);
        }

        console.log(`Animated art: Fetching artwork for "${artist} - ${album}"`);

        const params = new URLSearchParams({
            s: song,
            a: artist,
            d: Math.round(duration || 0).toString(),
            al: album || "",
        });

        const url = `${API_ENDPOINT}?${params.toString()}`;

        try {
            const response = await fetch(url, { signal });
            if (!response.ok) {
                console.warn("Animated art: API returned status", response.status);
                return null;
            }

            const data = await response.json();

            if (data && data.videoUrl) {
                await setStorage(cacheKey, data.videoUrl);
                console.log(`Animated art: Cached video URL for "${artist} - ${album}"`);
                return data.videoUrl;
            } else {
                await setStorage(cacheKey, { notFoundAt: Date.now() });
                console.log(`Animated art: Cached not-found for "${artist} - ${album}"`);
                return null;
            }
        } catch (error) {
            if (error.name !== "AbortError") {
                console.error("Animated art: Fetch error", error);
            }
            return null;
        }
    }

    const blobCache = new Map();

    async function getOrFetchVideoBlob(videoUrl, signal) {
        if (blobCache.has(videoUrl)) {
            return blobCache.get(videoUrl);
        }
        try {
            const response = await fetch(videoUrl, { signal });
            if (!response.ok) return videoUrl; // Fallback to direct URL if blob fetch fails
            const blob = await response.blob();
            const objectUrl = URL.createObjectURL(blob);

            // Keep cache size bounded to last 10 videos in memory
            if (blobCache.size > 10) {
                const firstKey = blobCache.keys().next().value;
                const oldUrl = blobCache.get(firstKey);
                if (oldUrl.startsWith("blob:")) URL.revokeObjectURL(oldUrl);
                blobCache.delete(firstKey);
            }

            blobCache.set(videoUrl, objectUrl);
            return objectUrl;
        } catch {
            return videoUrl; // Fallback
        }
    }

    function createVideoElement(videoUrl) {
        const video = document.createElement("video");
        video.id = VIDEO_ELEMENT_ID;
        video.muted = true;
        video.defaultMuted = true;
        video.autoplay = true;
        video.loop = true;
        video.playsInline = true;
        video.preload = "auto";
        video.disablePictureInPicture = true;
        video.disableRemotePlayback = true;
        video.src = videoUrl;
        video.style.cssText =
            "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:2;" +
            "opacity:0;transition:opacity 300ms ease-in;pointer-events:none;border-radius:inherit;" +
            "will-change:transform;transform:translateZ(0);backface-visibility:hidden;";

        const tryPlay = () => {
            video.style.opacity = "1";
            const playPromise = video.play();
            if (playPromise !== undefined) {
                playPromise.catch(() => {
                    video.muted = true;
                    video.play().catch(() => {});
                });
            }
        };

        video.addEventListener("canplaythrough", tryPlay, { once: true });
        video.addEventListener("canplay", tryPlay, { once: true });

        if (video.readyState >= 3) {
            tryPlay();
        }

        return video;
    }

    function getArtworkContainers() {
        const containers = [];
        const selectors = [
            "#thumbnail",
            "ytmusic-player-bar .image.ytmusic-player-bar",
            "ytmusic-player-page #thumbnail",
            "ytmusic-player-page #song-image",
            "ytmusic-player-page .image"
        ];

        for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            elements.forEach(el => {
                if (el && !containers.includes(el)) {
                    containers.push(el);
                }
            });
        }
        return containers;
    }

    function extractAlbumFromDOM() {
        const byline = document.querySelector("ytmusic-player-bar .byline") ||
                       document.querySelector(".subtitle.ytmusic-player-bar");
        if (!byline) return "";

        const links = byline.querySelectorAll("a");
        if (links.length >= 2) {
            return links[links.length - 1].textContent?.trim() || "";
        }
        return "";
    }

    function injectAnimatedArt(videoUrl) {
        if (typeof currentSettings !== 'undefined' && currentSettings.animatedAlbumArt === false) {
            removeAnimatedArt();
            return;
        }

        const thumbnail = document.querySelector("#thumbnail") || document.querySelector("ytmusic-player-bar .image.ytmusic-player-bar");
        if (!thumbnail) return;

        let existingVideo = thumbnail.querySelector(`#${VIDEO_ELEMENT_ID}`);
        if (existingVideo) {
            if (existingVideo.src === videoUrl) {
                if (existingVideo.paused && document.visibilityState === "visible") {
                    existingVideo.play().catch(() => {});
                }
                return;
            }
            existingVideo.remove();
        }

        thumbnail.style.isolation = "isolate";
        thumbnail.style.overflow = "hidden";

        // Read computed border-radius from inner img if present (e.g. on fullscreen player page)
        const img = thumbnail.querySelector("img");
        if (img) {
            const imgRadius = window.getComputedStyle(img).borderRadius;
            if (imgRadius && imgRadius !== "0px") {
                thumbnail.style.borderRadius = imgRadius;
            }
        }

        const video = createVideoElement(videoUrl);

        // Auto pause video when thumbnail is hidden or tab is in background to save GPU/CPU
        if ("IntersectionObserver" in window) {
            const observer = new IntersectionObserver((entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting && document.visibilityState === "visible") {
                        video.play().catch(() => {});
                    } else {
                        video.pause();
                    }
                });
            }, { threshold: 0.1 });
            observer.observe(thumbnail);
        }

        thumbnail.appendChild(video);
    }

    // Auto pause video when browser tab is inactive
    document.addEventListener("visibilitychange", () => {
        const video = document.querySelector(`#${VIDEO_ELEMENT_ID}`);
        if (!video) return;
        if (document.visibilityState === "hidden") {
            video.pause();
        } else {
            video.play().catch(() => {});
        }
    });

    function removeAnimatedArt() {
        const videos = document.querySelectorAll(`#${VIDEO_ELEMENT_ID}`);
        videos.forEach(video => {
            const container = video.parentElement;
            video.remove();
            if (container) {
                container.style.isolation = "";
            }
        });
    }

    let playerPageObserver = null;
    let cachedVideoUrl = null;

    function setupPlayerPageObserver() {
        if (playerPageObserver) return;

        const playerPage = document.querySelector("ytmusic-player-page");
        if (playerPage) {
            let debounceTimer = null;
            playerPageObserver = new MutationObserver(() => {
                if (typeof currentSettings !== 'undefined' && currentSettings.animatedAlbumArt === false) {
                    removeAnimatedArt();
                    return;
                }
                if (cachedVideoUrl) {
                    clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(async () => {
                        const blobUrl = await getOrFetchVideoBlob(cachedVideoUrl);
                        injectAnimatedArt(blobUrl);
                    }, 50);
                }
            });
            playerPageObserver.observe(playerPage, {
                attributes: true,
                attributeFilter: ["player-fullscreened", "video-mode"]
            });
        }
    }

    let lastProcessedAlbumKey = null;

    async function handleSongChange(songInfo) {
        if (!songInfo || !songInfo.videoId) return;

        if (typeof currentSettings !== 'undefined' && currentSettings.animatedAlbumArt === false) {
            removeAnimatedArt();
            lastProcessedAlbumKey = null;
            return;
        }

        const { videoId, title, artist, duration } = songInfo;

        if (videoId === lastProcessedVideoId && cachedVideoUrl) return;

        const album = songInfo.album || extractAlbumFromDOM();
        const currentAlbumKey = `${artist}|${album}`;

        // If playing another song from the EXACT SAME ALBUM and video is already playing, reuse seamlessly
        if (currentAlbumKey && currentAlbumKey === lastProcessedAlbumKey && cachedVideoUrl) {
            lastProcessedVideoId = videoId;
            const existingVideo = document.querySelector(`#${VIDEO_ELEMENT_ID}`);
            if (existingVideo) {
                if (existingVideo.paused && document.visibilityState === "visible") {
                    existingVideo.play().catch(() => {});
                }
                return;
            }
        }

        abortPendingFetch();

        // Only clear video if moving to a different album
        if (currentAlbumKey !== lastProcessedAlbumKey) {
            removeAnimatedArt();
            cachedVideoUrl = null;
        }

        lastProcessedVideoId = videoId;
        pendingFetch = new AbortController();

        const videoUrl = await fetchArtworkUrl(
            title,
            artist,
            duration,
            album,
            pendingFetch.signal
        );

        if (!videoUrl || videoId !== lastProcessedVideoId) {
            if (videoUrl === null && currentAlbumKey !== lastProcessedAlbumKey) {
                removeAnimatedArt();
            }
            return;
        }

        const blobUrl = await getOrFetchVideoBlob(videoUrl, pendingFetch.signal);

        if (videoId !== lastProcessedVideoId) {
            return;
        }

        pendingFetch = null;

        if (typeof currentSettings !== 'undefined' && currentSettings.animatedAlbumArt === false) {
            removeAnimatedArt();
            return;
        }

        cachedVideoUrl = videoUrl;
        lastProcessedAlbumKey = currentAlbumKey;
        injectAnimatedArt(blobUrl);
        setupPlayerPageObserver();
    }

    window.addEventListener('YOUPLUS_SETTINGS_UPDATED', (event) => {
        const changedKeys = event.detail?.changedKeys || [];
        if (changedKeys.includes('animatedAlbumArt')) {
            if (currentSettings.animatedAlbumArt === false) {
                removeAnimatedArt();
            } else if (cachedVideoUrl) {
                injectAnimatedArt(cachedVideoUrl);
            }
        }
    });

    window.AnimatedArtManager = {
        handleSongChange,
        removeAnimatedArt,
        reinject: () => { if (cachedVideoUrl) injectAnimatedArt(cachedVideoUrl); }
    };
})();
