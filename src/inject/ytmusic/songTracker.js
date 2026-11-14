// inject/ytmusic/songTracker.js

(function () {
    let currentSong = {};
    let timeUpdateFrame = null;
    let debounceTimer = null;
    let playerInstance = null;
    const videoMetaDataMap = new Map();

    const timeUpdateMsg = { type: 'LYPLUS_TIME_UPDATE', currentTime: 0 };
    let lastSentTime = -1;

    console.log('LYPLUS: Tracker injected.');

    function init() {
        setupNextResponseSniffer();
        setupMutationObserver();
        setupPlayerListeners();
        setupSeekListener();
        checkForSongChange();
    }

    function parseDurationTextToSec(text) {
        if (!text || typeof text !== 'string') return 0;
        const parts = text.trim().split(':').map(n => parseInt(n, 10));
        if (parts.some(Number.isNaN)) return 0;
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        return 0;
    }

    function extractByLineInfoFromNext(longByLineText) {
        const artists = [];
        let album = "";
        const runs = longByLineText?.runs;
        if (!runs) return ["", ""];
        for (const run of runs) {
            const browse = run.navigationEndpoint?.browseEndpoint;
            const pageType = browse?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
            if (pageType === "MUSIC_PAGE_TYPE_ALBUM") {
                album = run.text || "";
            } else if (browse) {
                if (run.text) artists.push(run.text);
            }
        }
        if (artists.length === 0) {
            const bulletIndex = runs.findIndex(r => (r.text || "").trim() === "•");
            const namedRuns = bulletIndex === -1 ? runs : runs.slice(0, bulletIndex);
            return [namedRuns.map(r => r.text || "").join("").trim(), album];
        }
        return [artists.join(", "), album];
    }

    function extractQueueMetadataFromNext(nextResponse) {
        if (!nextResponse || typeof nextResponse !== 'object') return;
        try {
            const tabs = nextResponse?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs;
            let contents = tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents;
            if (!contents) {
                contents = nextResponse?.onResponseReceivedEndpoints?.[0]?.queueUpdateCommand?.inlineContents?.playlistPanelRenderer?.contents;
            }
            if (!Array.isArray(contents) || contents.length === 0) return;

            const videoPairs = contents.map(content => {
                const wrapper = content?.playlistPanelVideoWrapperRenderer;
                const primaryRenderer = content?.playlistPanelVideoRenderer || wrapper?.primaryRenderer?.playlistPanelVideoRenderer;
                if (!primaryRenderer?.videoId) return null;

                const counterpartItem = wrapper?.counterpart?.[0];
                const counterpartRenderer = counterpartItem?.counterpartRenderer?.playlistPanelVideoRenderer;
                const [primaryArtist, primaryAlbum] = extractByLineInfoFromNext(primaryRenderer.longBylineText);
                const pThumbs = primaryRenderer.thumbnail?.thumbnails || [];
                const pThumb = pThumbs[pThumbs.length - 1];
                const primaryIsVideo = pThumb ? (pThumb.height !== pThumb.width) : !primaryAlbum;

                const primary = {
                    videoId: primaryRenderer.videoId,
                    title: primaryRenderer.title?.runs?.[0]?.text || "",
                    artist: primaryArtist,
                    album: primaryAlbum,
                    duration: parseDurationTextToSec(primaryRenderer.lengthText?.runs?.[0]?.text),
                    isVideo: primaryIsVideo
                };

                if (counterpartRenderer?.videoId && counterpartItem?.segmentMap) {
                    const [cArtist, cAlbum] = extractByLineInfoFromNext(counterpartRenderer.longBylineText);
                    const cThumbs = counterpartRenderer.thumbnail?.thumbnails || [];
                    const cThumb = cThumbs[cThumbs.length - 1];
                    const counterpartIsVideo = cThumb ? (cThumb.height !== cThumb.width) : !cAlbum;
                    return {
                        primary,
                        counterpart: {
                            videoId: counterpartRenderer.videoId,
                            title: counterpartRenderer.title?.runs?.[0]?.text || primary.title,
                            artist: cArtist || primaryArtist,
                            album: cAlbum,
                            duration: parseDurationTextToSec(counterpartRenderer.lengthText?.runs?.[0]?.text),
                            isVideo: counterpartIsVideo,
                            segmentMap: counterpartItem.segmentMap
                        }
                    };
                }
                return { primary, counterpart: null };
            }).filter(Boolean);

            for (let i = 0; i < videoPairs.length; i++) {
                const pair = videoPairs[i];
                const nextPair = i + 1 < videoPairs.length ? videoPairs[i + 1] : null;
                const nextPrimarySong = nextPair ? {
                    videoId: nextPair.primary.videoId,
                    title: nextPair.primary.title,
                    artist: nextPair.primary.artist,
                    album: nextPair.primary.album,
                    duration: nextPair.primary.duration,
                    isVideo: nextPair.primary.isVideo
                } : null;

                if (pair.counterpart && pair.counterpart.segmentMap?.segment?.length) {
                    const forwardSegments = pair.counterpart.segmentMap.segment.map(s => ({
                        primaryVideoStartTimeMilliseconds: Number(s.primaryVideoStartTimeMilliseconds) || 0,
                        counterpartVideoStartTimeMilliseconds: Number(s.counterpartVideoStartTimeMilliseconds) || 0,
                        durationMilliseconds: Number(s.durationMilliseconds) || 0
                    }));
                    const reversedSegments = forwardSegments.map(s => ({
                        primaryVideoStartTimeMilliseconds: s.counterpartVideoStartTimeMilliseconds,
                        counterpartVideoStartTimeMilliseconds: s.primaryVideoStartTimeMilliseconds,
                        durationMilliseconds: s.durationMilliseconds
                    }));

                    videoMetaDataMap.set(pair.primary.videoId, {
                        ...pair.primary,
                        counterpartVideoId: pair.counterpart.videoId,
                        counterpartDuration: pair.counterpart.duration,
                        segmentMap: { segment: forwardSegments, reversed: false },
                        nextSong: nextPrimarySong
                    });

                    videoMetaDataMap.set(pair.counterpart.videoId, {
                        ...pair.counterpart,
                        counterpartVideoId: pair.primary.videoId,
                        counterpartDuration: pair.primary.duration,
                        segmentMap: { segment: reversedSegments, reversed: true },
                        nextSong: nextPair?.counterpart ? {
                            videoId: nextPair.counterpart.videoId,
                            title: nextPair.counterpart.title,
                            artist: nextPair.counterpart.artist,
                            album: nextPair.counterpart.album,
                            duration: nextPair.counterpart.duration,
                            isVideo: nextPair.counterpart.isVideo
                        } : nextPrimarySong
                    });
                } else {
                    videoMetaDataMap.set(pair.primary.videoId, {
                        ...pair.primary,
                        counterpartVideoId: null,
                        counterpartDuration: 0,
                        segmentMap: null,
                        nextSong: nextPrimarySong
                    });
                }
            }

            if (videoMetaDataMap.size > 150) {
                const excess = videoMetaDataMap.size - 100;
                const keys = videoMetaDataMap.keys();
                for (let k = 0; k < excess; k++) {
                    const nextKey = keys.next();
                    if (nextKey.done) break;
                    videoMetaDataMap.delete(nextKey.value);
                }
            }
        } catch (err) {
            // Non-fatal queue parsing error
        }
    }

    function setupNextResponseSniffer() {
        if (window.__lyplusFetchSnifferInstalled || typeof window.fetch !== 'function') return;
        window.__lyplusFetchSnifferInstalled = true;
        const origFetch = window.fetch;
        window.fetch = function (...args) {
            const promise = origFetch.apply(this, args);
            try {
                const reqUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
                if (reqUrl && reqUrl.includes('/youtubei/v1/next')) {
                    promise.then(res => {
                        if (res && res.ok) {
                            res.clone().json().then(data => {
                                extractQueueMetadataFromNext(data);
                                scheduleSongCheck(50);
                            }).catch(() => {});
                        }
                    }).catch(() => {});
                }
            } catch (e) {}
            return promise;
        };
    }

    function getPlayer() {
        if (playerInstance && playerInstance.isConnected) {
            return playerInstance;
        }
        playerInstance = document.getElementById("movie_player");
        return playerInstance;
    }

    function setupMutationObserver() {
        const metadataContainer = document.querySelector('ytmusic-player-bar .content-info-wrapper')
            || document.querySelector('ytmusic-player-bar .left-controls')
            || document.querySelector('ytmusic-miniplayer .ytmusicTrackInfoContentInfoWrapper')
            || document.querySelector('ytmusic-miniplayer ytmusic-track-info')
            || document.querySelector('ytmusic-miniplayer .ytMusicMiniPlayerLeftSection')
            || document.querySelector('[slot="player-bar"] .ytmusicTrackInfoContentInfoWrapper')
            || document.querySelector('[slot="player-bar"] .content-info-wrapper')
            || document.querySelector('[slot="player-bar"]');

        if (metadataContainer) {
            const observer = new MutationObserver(handleMutations);
            observer.observe(metadataContainer, {
                childList: true,
                subtree: true,
                characterData: true
            });
        } else {
            setTimeout(setupMutationObserver, 1000);
        }
    }

    let observedPlayer = null;
    let observedVideo = null;

    function scheduleSongCheck(delayMs = 80) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(checkForSongChange, delayMs);
    }

    function handleMutations() {
        scheduleSongCheck(120);
    }

    function setupPlayerListeners() {
        window.addEventListener('yt-navigate-finish', () => scheduleSongCheck(50));
        window.addEventListener('yt-page-data-updated', () => scheduleSongCheck(50));

        const attach = () => {
            const player = getPlayer();
            if (player && player !== observedPlayer) {
                observedPlayer = player;
                if (typeof player.addEventListener === 'function') {
                    try {
                        player.addEventListener('onStateChange', () => scheduleSongCheck(40));
                    } catch (e) {}
                }
            }
            const video = player?.querySelector?.('video') || document.querySelector('video');
            if (video && video !== observedVideo) {
                observedVideo = video;
                const onVideoChange = () => scheduleSongCheck(40);
                video.addEventListener('loadedmetadata', onVideoChange);
                video.addEventListener('durationchange', onVideoChange);
                video.addEventListener('play', onVideoChange);
                video.addEventListener('emptied', onVideoChange);
            }
        };

        attach();
        setInterval(() => {
            attach();
            const player = getPlayer();
            if (player && typeof player.getVideoData === 'function') {
                try {
                    const vid = player.getVideoData()?.video_id;
                    if (vid && vid !== currentSong.videoId && vid !== activeFetchVideoId) {
                        scheduleSongCheck(20);
                    }
                } catch (e) {}
            }
        }, 500);
    }

    function setupSeekListener() {
        window.addEventListener('message', (event) => {
            if (!event.data || event.data.type !== 'LYPLUS_SEEK_TO') return;

            const player = getPlayer();
            if (player && typeof event.data.time === 'number') {
                player.seekTo(event.data.time, true);
                timeUpdateMsg.currentTime = event.data.time;
                window.postMessage(timeUpdateMsg, '*');
                lastSentTime = event.data.time;
            }
        });
    }

    let frameCount = 0;

    function startTimeUpdater() {
        stopTimeUpdater();

        function loop() {
            const player = getPlayer();

            if (player) {
                try {
                    if ((++frameCount & 15) === 0 && typeof player.getVideoData === 'function') {
                        const liveVid = player.getVideoData()?.video_id;
                        if (liveVid && liveVid !== currentSong.videoId && liveVid !== activeFetchVideoId) {
                            scheduleSongCheck(10);
                        }
                    }

                    const state = player.getPlayerState();

                    if (state === 1) {
                        const rawTime = player.getCurrentTime();

                        if (Math.abs(rawTime - lastSentTime) > 0.001) {
                            timeUpdateMsg.currentTime = rawTime;
                            window.postMessage(timeUpdateMsg, '*');
                            lastSentTime = rawTime;
                        }
                    }
                } catch (e) { }
            }

            timeUpdateFrame = requestAnimationFrame(loop);
        }

        timeUpdateFrame = requestAnimationFrame(loop);
    }

    function stopTimeUpdater() {
        if (timeUpdateFrame) {
            cancelAnimationFrame(timeUpdateFrame);
            timeUpdateFrame = null;
        }
    }

    function getMetadataFromDOM() {
        const bar = document.querySelector('ytmusic-player-bar, ytmusic-miniplayer, [slot="player-bar"]');
        if (!bar) return null;

        const titleEl = bar.querySelector('.ytmusicTrackInfoTitle') || bar.querySelector('.title');
        const bylineEl = bar.querySelector('.ytmusicTrackInfoByline') || bar.querySelector('.subtitle') || bar.querySelector('.byline');

        if (!titleEl || !bylineEl) return null;

        const title = titleEl.textContent.trim();
        const bylineText = bylineEl.textContent.trim();
        const allLinks = Array.from(bylineEl.querySelectorAll('a'));

        let artistNames = [];
        let albumName = "";

        allLinks.forEach((link, idx) => {
            const href = link.getAttribute('href');
            const text = link.textContent.trim();
            if (!text) return;

            if (href) {
                const isArtist = href.includes('channel/') ||
                    href.includes('browse/UC') ||
                    href.includes('artist_detail');

                if (isArtist) {
                    artistNames.push(text);
                } else {
                    if (!albumName) albumName = text;
                }
            } else {
                // For new miniplayer buttons or links without href
                if (idx === 0) {
                    artistNames.push(text);
                } else if (!albumName && !text.toLowerCase().includes('view') && !text.toLowerCase().includes('like')) {
                    albumName = text;
                }
            }
        });

        const artist = artistNames.length > 0
            ? artistNames.join(", ")
            : (bylineText.split('•')[0]?.trim() || "");

        return { title, artist, album: albumName, isVideo: albumName === "" };
    }

    function getMediaSession() {
        return navigator.mediaSession?.metadata || null;
    }

    function extractAlbumFromDescription(description, title) {
        if (!description) return null;

        const lines = description.split('\n')
                                 .map(l => l.trim())
                                 .filter(l => l.length > 0);

        const providedIndex = lines.findIndex(line => line.startsWith('Provided to YouTube'));

        if (providedIndex !== -1 && lines.length > providedIndex + 2) {
            const potentialAlbum = lines[providedIndex + 2];
            if (!isMetadataLine(potentialAlbum)) return potentialAlbum;
        }

        if (title) {
            const titleIndex = lines.findIndex(line =>
                line.includes(' · ') && (line.startsWith(title) || line.includes(title))
            );

            if (titleIndex !== -1 && lines.length > titleIndex + 1) {
                const potentialAlbum = lines[titleIndex + 1];
                if (!isMetadataLine(potentialAlbum)) return potentialAlbum;
            }
        }

        return null;
    }

    function isMetadataLine(line) {
        return line.startsWith('℗') ||
               line.startsWith('Released on') ||
               line.startsWith('Auto-generated') ||
               line.match(/^Composer:/);
    }

    async function fetchFromYouTube(videoId, clientName, clientVersion) {
        try {
            const response = await fetch("https://www.youtube.com/youtubei/v1/player", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "accept-language": "en-US,en;q=0.9"
                },
                body: JSON.stringify({
                    context: { client: { clientName, clientVersion } },
                    videoId
                })
            });
            if (!response.ok) return null;
            return await response.json();
        } catch (e) {
            console.error(`LYPLUS: Fetch failed for ${clientName}`, e);
            return null;
        }
    }

    let activeFetchVideoId = null;

    async function fetchMetadataDual(videoId) {

        const [remixData, legacyData] = await Promise.all([
            fetchFromYouTube(videoId, "WEB_REMIX", getWebClientVersion()),
            fetchFromYouTube(videoId, "WEB", "2.20230327.07.00")
        ]);

        if (!remixData && !legacyData) return null;

        const rDetails = remixData?.videoDetails || {};
        const rMicro = remixData?.microformat?.microformatDataRenderer || {};
        const lDetails = legacyData?.videoDetails || {};
        const lMicro = legacyData?.microformat?.playerMicroformatRenderer || {};

        const title = rDetails.title || rMicro.title || "";
        const artist = rDetails.author || "";
        const thumbnails = rDetails.thumbnail?.thumbnails || rMicro.thumbnail?.thumbnails || [];
        const artwork = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : "";
        const duration = parseInt(rDetails.lengthSeconds || 0);
        const fullDescription = lDetails.shortDescription || lMicro.description?.simpleText || "";
        const album = extractAlbumFromDescription(fullDescription, title);
        const captions = remixData?.captions?.playerCaptionsTracklistRenderer ||
                         legacyData?.captions?.playerCaptionsTracklistRenderer || null;

        return { title, artist, album, artwork, duration, videoId, captions };
    }

    function getWebClientVersion() {
        const fromCfg = window.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION') ||
                        window.ytcfg?.data_?.INNERTUBE_CLIENT_VERSION ||
                        window.ytcfg?.data_?.INNERTUBE_CONTEXT?.client?.clientVersion;
        if (fromCfg) return fromCfg;

        const d = new Date();
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return `1.${y}${m}${day}.01.00`;
    }

    const YT_CLIENTS = {
        web: {
            clientName: "WEB_REMIX",
            get clientVersion() { return getWebClientVersion(); }
        },
        android: { clientName: "ANDROID_MUSIC", clientVersion: "7.21.50", androidSdkVersion: 30 }
    };

    function ytCtx(c, hl = "en", gl = "US") {
        const client = c === "web"
            ? { clientName: "WEB_REMIX", clientVersion: getWebClientVersion(), hl, gl }
            : { ...YT_CLIENTS[c], hl, gl };
        return { context: { client } };
    }

    async function ytRequest(path, body) {
        try {
            const clientVer = getWebClientVersion();
            const res = await fetch(`/youtubei/v1/${path}?prettyPrint=false`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Accept-Language": "en-US,en;q=0.9",
                    "X-YouTube-Client-Name": "67",
                    "X-YouTube-Client-Version": clientVer
                },
                body: JSON.stringify(body)
            });
            if (res.ok) return await res.json();
            return null;
        } catch (e) {
            return null;
        }
    }

    function findLyricsBrowseId(next) {
        const tabs = next?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs;
        if (Array.isArray(tabs)) {
            for (const tab of tabs) {
                const tr = tab?.tabRenderer;
                if (!tr) continue;
                if (tr.unselectable) return null;
                const browseId = tr.endpoint?.browseEndpoint?.browseId;
                if (typeof browseId === "string" && browseId.startsWith("MPLYt")) {
                    return browseId;
                }
            }
        }
        let found = null;
        let isUnselectable = false;
        (function walk(o) {
            if (!o || typeof o !== "object" || found) return;
            if (o.tabRenderer && o.tabRenderer.unselectable) {
                const bId = o.tabRenderer.endpoint?.browseEndpoint?.browseId;
                if (typeof bId === "string" && bId.startsWith("MPLYt")) {
                    isUnselectable = true;
                    return;
                }
            }
            if (typeof o.browseId === "string" && o.browseId.startsWith("MPLYt")) {
                found = o.browseId;
                return;
            }
            for (const v of Object.values(o)) walk(v);
        })(next);
        return isUnselectable ? null : found;
    }

    function decodeB64(b64) {
        if (!b64) return null;
        try {
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            return new TextDecoder().decode(bytes).replace(/[\x00-\x1f]/g, " ").trim();
        } catch {
            return null;
        }
    }

    function cleanProviderName(value) {
        if (typeof value !== "string") return null;
        const providerName = value.split('\n')[0]
            .replace(/^(source|lyrics provided by|lyrics)\s*:\s*/i, '')
            .trim();
        return providerName && !providerName.toLowerCase().includes("youtube")
            ? providerName
            : null;
    }

    function extractFooterAndProvider(r) {
        let provider = null;
        let trackId = null;
        (function walk(o) {
            if (!o || typeof o !== "object") return;
            const footerText = (
                o.footer?.runs ? o.footer.runs.map(r => r.text || '').join('').trim() :
                o.footer?.simpleText ? o.footer.simpleText.trim() : null
            );
            const providerName = cleanProviderName(o.sourceMessage) || cleanProviderName(footerText);
            if (providerName) provider = providerName;
            if (o.logLyricEventCommand?.serializedLyricInfo) {
                trackId = decodeB64(o.logLyricEventCommand.serializedLyricInfo);
            }
            for (const v of Object.values(o)) walk(v);
        })(r);
        return { provider, trackId };
    }

    function extractPlain(r) {
        let plain = "";
        (function walk(o) {
            if (!o || typeof o !== "object" || plain) return;
            if (o.musicDescriptionShelfRenderer?.description) {
                const desc = o.musicDescriptionShelfRenderer.description;
                if (Array.isArray(desc.runs)) {
                    plain = desc.runs.map(x => x.text || "").join("").trim();
                } else if (desc.simpleText) {
                    plain = desc.simpleText.trim();
                }
            }
            if (!plain) {
                for (const v of Object.values(o)) walk(v);
            }
        })(r);
        return plain;
    }

    function extractTimed(r) {
        const lines = [];
        (function walk(o, parentKey) {
            if (!o || typeof o !== "object") return;
            if (typeof o.lyricLine === "string") {
                if (o.cueRange) {
                    lines.push({
                        text: o.lyricLine,
                        start: parseInt(o.cueRange.startTimeMilliseconds) || 0,
                        end: parseInt(o.cueRange.endTimeMilliseconds) || 0,
                        id: parseInt(o.cueRange.metadata?.id || "0"),
                    });
                } else if (parentKey === "timedLyricsData") {
                    lines.push({
                        text: o.lyricLine,
                        start: 0,
                        end: 0,
                        id: lines.length,
                    });
                }
            }
            if (Array.isArray(o)) {
                for (const v of o) walk(v, parentKey);
                return;
            }
            for (const [k, v] of Object.entries(o)) walk(v, k);
        })(r, undefined);
        return lines;
    }

    async function getLyrics(videoId) {
        if (!videoId) return null;

        try {
            const next = await ytRequest("next", { ...ytCtx("web"), videoId });
            if (!next) return null;

            extractQueueMetadataFromNext(next);

            const browseId = findLyricsBrowseId(next);
            if (!browseId) {
                return null;
            }

            // Fetch web (for plain text and provider footer) and android (for synced timed lyrics)
            const [web, android] = await Promise.all([
                ytRequest("browse", { ...ytCtx("web"), browseId }),
                ytRequest("browse", { ...ytCtx("android"), browseId }),
            ]);

            const metaWeb = extractFooterAndProvider(web);
            const metaAndroid = extractFooterAndProvider(android);
            const provider = metaWeb.provider || metaAndroid.provider || null;
            const trackId = metaWeb.trackId || metaAndroid.trackId || null;

            const webPlain = extractPlain(web);
            const plain = webPlain || extractPlain(android) || "";

            const androidTimed = extractTimed(android);
            const webTimed = extractTimed(web);
            let timed = [];
            let synced = false;

            const hasAndroidSync = androidTimed.some((l) => l.start > 0 || l.end > 0);
            const hasWebSync = webTimed.some((l) => l.start > 0 || l.end > 0);

            if (hasAndroidSync) {
                timed = androidTimed;
                synced = true;
            } else if (hasWebSync) {
                timed = webTimed;
                synced = true;
            } else {
                // For plain text, prefer web remix
                timed = [];
                synced = false;
            }

            const noLyrics = !plain && !timed.length;
            return noLyrics ? null : {
                videoId,
                browseId,
                provider,
                trackId,
                plain: plain || null,
                timed: timed || [],
                synced
            };
        } catch (e) {
            console.error('LYPLUS: getLyrics failed', e);
            return null;
        }
    }

    async function getSongCredits(videoId) {
        if (!videoId) return null;

        try {
            const r = await ytRequest("browse", { ...ytCtx("web"), browseId: "MPTC" + videoId });
            if (!r) {
                return null;
            }
            let writers = [];
            (function walk(o) {
                if (!o || typeof o !== "object") return;
                if (o.dismissableDialogContentSectionRenderer) {
                    const section = o.dismissableDialogContentSectionRenderer;
                    const sectionTitle = section.title?.runs?.map(x => x.text || "").join("").trim().toLowerCase() || "";
                    if (sectionTitle.includes("written by") || sectionTitle.includes("songwriter") || sectionTitle.includes("composer")) {
                        const text = section.subtitle?.runs?.map(x => x.text || "").join("") || section.subtitle?.simpleText || "";
                        if (text) {
                            const list = text.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
                            writers.push(...list);
                        }
                    }
                }
                for (const v of Object.values(o)) walk(v);
            })(r);
            return writers.length > 0 ? Array.from(new Set(writers)) : null;
        } catch (e) {
            return null;
        }
    }

    let transitionRetryCount = 0;

    async function checkForSongChange() {
        const player = getPlayer();
        const domInfo = getMetadataFromDOM();

        if (!player) return;

        let videoId = "";
        let duration = 0;
        let audioTrackData = null;
        let playerTitle = "";
        let playerArtist = "";

        try {
            if (player.getVideoData) {
                const vData = player.getVideoData() || {};
                videoId = vData.video_id || "";
                playerTitle = vData.title || "";
                playerArtist = vData.author || "";
            }
            if (player.getDuration) duration = player.getDuration();
            if (player.getAudioTrack && typeof player.getAudioTrack === 'function') {
                audioTrackData = player.getAudioTrack();
            }
        } catch (e) { return; }

        if (!videoId) {
            scheduleSongCheck(200);
            return;
        }

        const isVideoIdChanged = videoId !== currentSong.videoId;
        const isDomTitleChanged = !!(domInfo?.title && currentSong.title && domInfo.title !== currentSong.title);

        // If the DOM title already changed to the next song, but movie_player.getVideoData().video_id
        // is still the previous song's videoId, wait briefly for movie_player to update so we don't
        // fetch metadata for the OLD videoId!
        if (!isVideoIdChanged && isDomTitleChanged) {
            if (transitionRetryCount < 15) {
                transitionRetryCount++;
                scheduleSongCheck(100);
                return;
            }
        }
        transitionRetryCount = 0;

        if (isVideoIdChanged || isDomTitleChanged) {
            if (activeFetchVideoId === videoId) return;
            activeFetchVideoId = videoId;

            const prevQueueMeta = videoMetaDataMap.get(videoId) || null;
            const isCounterpartSwitch = !!(
                currentSong.videoId &&
                (currentSong.counterpartVideoId === videoId || prevQueueMeta?.counterpartVideoId === currentSong.videoId)
            );
            if (!isCounterpartSwitch && currentSong.videoId) {
                window.postMessage({ type: 'LYPLUS_SONG_CHANGING', videoId }, '*');
            }

            let apiData = null;
            let directLyrics = null;
            let songCredits = null;

            try {
                [apiData, directLyrics, songCredits] = await Promise.all([
                    fetchMetadataDual(videoId),
                    getLyrics(videoId),
                    getSongCredits(videoId)
                ]);
            } finally {
                if (activeFetchVideoId === videoId) {
                    activeFetchVideoId = null;
                }
            }

            // Verify that movie_player is still on the same videoId after the async network calls!
            try {
                const currentLiveId = player.getVideoData?.()?.video_id;
                if (currentLiveId && currentLiveId !== videoId) {
                    scheduleSongCheck(20);
                    return;
                }
            } catch (e) {}

            const freshDomInfo = getMetadataFromDOM() || domInfo;
            const queueMeta = videoMetaDataMap.get(videoId) || null;

            const rawTitle =
                queueMeta?.title ||
                apiData?.title ||
                playerTitle ||
                freshDomInfo?.title ||
                getMediaSession()?.title;

            const finalTitle = rawTitle;
            const finalArtist =
                queueMeta?.artist ||
                apiData?.artist ||
                freshDomInfo?.artist ||
                playerArtist ||
                getMediaSession()?.artist ||
                "Unknown Artist";

            const finalArtwork = apiData?.artwork || "";
            const finalDuration = apiData?.duration || queueMeta?.duration || duration || player.getDuration?.() || 0;

            if (!finalDuration || !finalTitle) {
                scheduleSongCheck(200);
                return;
            }

            const finalAlbum = queueMeta?.album || apiData?.album || freshDomInfo?.album || "";

            let captionData = apiData?.captions ||
                              player?.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer;

            if (!captionData?.captionTracks?.length && player?.getOption && typeof player.getOption === 'function') {
                try {
                    const trackList = player.getOption('captions', 'tracklist');
                    if (trackList?.length) {
                        captionData = { captionTracks: trackList };
                    }
                } catch (optErr) {}
            }

            const ytLyrics = directLyrics;
            if (ytLyrics && songCredits?.length) {
                ytLyrics.songWriters = songCredits;
            }

            currentSong = {
                title: finalTitle,
                artist: finalArtist,
                album: finalAlbum,
                duration: finalDuration,
                videoId,
                artwork: finalArtwork,
                isVideo: queueMeta ? !!queueMeta.isVideo : !finalAlbum,
                counterpartVideoId: queueMeta?.counterpartVideoId || null,
                counterpartDuration: queueMeta?.counterpartDuration || 0,
                segmentMap: queueMeta?.segmentMap || null,
                nextSong: queueMeta?.nextSong || null,
                subtitle: captionData || audioTrackData,
                ytMusicLyrics: ytLyrics,
                songWriters: songCredits || []
            };

            startTimeUpdater();

            window.postMessage({ type: 'LYPLUS_SONG_CHANGED', songInfo: currentSong }, '*');
            if (currentSong.nextSong && currentSong.nextSong.videoId && currentSong.nextSong.title) {
                window.postMessage({ type: 'LYPLUS_PREFETCH_NEXT', nextSong: currentSong.nextSong }, '*');
            }
            window.postMessage({ type: 'LYPLUS_updateFullScreenAnimatedBg', artworkUrl: finalArtwork }, '*');
        }
    }

    init();

})();