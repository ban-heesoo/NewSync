// inject/songTracker.js

// Holds the current song information
let LYPLUS_currentSong = {};
let LYPLUS_timeUpdateInterval = null;

// Initialize when the script is loaded
(function() {
    console.log('LYPLUS: DOM script injected successfully');
    LYPLUS_setupMutationObserver();
    LYPLUS_setupSeekListener();
    // Check for initial song immediately (in case a song is already playing)
    setTimeout(() => {
        LYPLUS_checkForSongChange();
    }, 500);
})();

// Initialize the observer to watch for changes in the player state
function LYPLUS_setupMutationObserver() {
    const titleElement = document.querySelector('.title.style-scope.ytmusic-player-bar');
    const subtitleElement = document.querySelector('.subtitle.style-scope.ytmusic-player-bar');

    if (titleElement || subtitleElement) {
        const observer = new MutationObserver(LYPLUS_handleMutations);
        const observerOptions = { characterData: true, childList: true, subtree: true };

        if (titleElement) observer.observe(titleElement, observerOptions);
        if (subtitleElement) observer.observe(subtitleElement, observerOptions);
    }

    setInterval(LYPLUS_checkForSongChange, 2000);
}

function LYPLUS_setupSeekListener() {
    // Remove existing listeners if any to avoid duplicates
    window.removeEventListener('LYPLUS_SEEK_TO', LYPLUS_handleSeekEvent);
    window.removeEventListener('message', LYPLUS_handlePostMessage);
    
    // Add both CustomEvent and postMessage listeners
    window.addEventListener('LYPLUS_SEEK_TO', LYPLUS_handleSeekEvent, true);
    window.addEventListener('message', LYPLUS_handlePostMessage, true);
}

function LYPLUS_handlePostMessage(event) {
    // Only handle our own messages
    if (!event.data || event.data.type !== 'LYPLUS_SEEK_TO') {
        return;
    }
    
    // Verify origin for security (optional but recommended)
    // For same-origin, we can be more lenient
    const time = event.data.time;
    if (typeof time !== 'number') {
        console.warn('LYPLUS: Invalid time in postMessage', event.data);
        return;
    }
    
    console.log('LYPLUS: Received LYPLUS_SEEK_TO via postMessage', time);
    LYPLUS_performSeek(time);
}

function LYPLUS_handleSeekEvent(event) {
    try {
        // Safe access to event detail for Firefox compatibility
        let seekTime;
        try {
            if (event.detail && typeof event.detail.time === 'number') {
                seekTime = event.detail.time;
            } else {
                console.warn('LYPLUS: event.detail.time is not accessible or invalid');
                return;
            }
        } catch (e) {
            // Firefox security context issue - event.detail access blocked
            console.warn('LYPLUS: Cannot access event.detail (Firefox security restriction)', e);
            return;
        }
        
        console.log('LYPLUS: Received LYPLUS_SEEK_TO event', seekTime);
        LYPLUS_performSeek(seekTime);
    } catch (error) {
        console.error('LYPLUS: Error handling seek event', error);
    }
}

function LYPLUS_performSeek(seekTime) {
    try {
        const player = LYPLUS_getPlayer();
        if (!player) {
            console.warn('LYPLUS: Player not found for seek operation');
            return;
        }
        
        if (typeof player.seekTo !== 'function') {
            console.warn('LYPLUS: player.seekTo is not a function', player);
            return;
        }
        
        console.log('LYPLUS: Seeking player to', seekTime);
        player.seekTo(seekTime, true);
        console.log('LYPLUS: Seek command sent successfully');
    } catch (error) {
        console.error('LYPLUS: Error performing seek', error);
    }
}

function stopTimeUpdater() {
    clearInterval(LYPLUS_timeUpdateInterval);
    LYPLUS_timeUpdateInterval = null;
}

function startTimeUpdater() {
    stopTimeUpdater();

    LYPLUS_timeUpdateInterval = setInterval(() => {
        const player = LYPLUS_getPlayer();
        if (player) {
            try {
                const currentTime = player.getCurrentTime();
                window.postMessage({ type: 'LYPLUS_TIME_UPDATE', currentTime: currentTime }, '*');
            } catch (e) {
                console.error("LYPLUS: Error getting current time.", e);
                stopTimeUpdater();
            }
        }
    }, 16); //60FPS timing
}

// Callback for MutationObserver
function LYPLUS_handleMutations(mutations) {
    let songChanged = false;
    mutations.forEach((mutation) => {
        if (mutation.target.nodeType === Node.TEXT_NODE) {
            const parent = mutation.target.parentNode;
            if (parent && (parent.classList.contains('title') || parent.classList.contains('subtitle'))) {
                songChanged = true;
            }
        } else if (mutation.target.classList && (mutation.target.classList.contains('title') || mutation.target.classList.contains('subtitle'))) {
            songChanged = true;
        }
    });

    if (songChanged) {
        LYPLUS_debounceCheckForSongChange();
    }
}

let LYPLUS_debounceTimer = null;
function LYPLUS_debounceCheckForSongChange() {
    clearTimeout(LYPLUS_debounceTimer);
    LYPLUS_debounceTimer = setTimeout(LYPLUS_checkForSongChange, 500);
}

function LYPLUS_getPlayer() {
    let player = document.getElementById("movie_player");
    if (!player) {
        player = document.querySelector('ytmusic-player');
        if (player && !player.getCurrentTime) {
            if (player.playerApi) player = player.playerApi;
            else if (window.ytmusic && ytmusic.player) player = ytmusic.player;
        }
    }
    return player;
}

function LYPLUS_checkForSongChange() {
    const newSongInfo = LYPLUS_getSongInfo();
    if (!newSongInfo || !newSongInfo.title.trim() || !newSongInfo.artist.trim()) {
        return;
    }

    // Check if this is the first song (LYPLUS_currentSong is empty)
    const isFirstSong = !LYPLUS_currentSong || !LYPLUS_currentSong.title;
    
    const hasChanged = isFirstSong || 
                       ((newSongInfo.title !== LYPLUS_currentSong.title || 
                         newSongInfo.artist !== LYPLUS_currentSong.artist || 
                         Math.round(newSongInfo.duration) !== Math.round(LYPLUS_currentSong.duration)) && 
                        newSongInfo.videoId !== LYPLUS_currentSong.videoId);

    if (hasChanged) {
        LYPLUS_currentSong = newSongInfo;
        
        // Start sending high-frequency time updates for the new song
        startTimeUpdater();
        
        window.postMessage({ type: 'LYPLUS_SONG_CHANGED', songInfo: LYPLUS_currentSong }, '*');
        window.postMessage({ type: 'LYPLUS_updateFullScreenAnimatedBg' }, '*');
    }
}

function LYPLUS_getSongInfo() {
    const player = LYPLUS_getPlayer();
    if (player) {
        try {
            if (!player.getDuration || typeof player.getDuration !== 'function' || player.getDuration() === 0) {
                return null;
            }
            const videoData = player.getVideoData();
            if (!videoData || !videoData.title || !videoData.author) {
                return null;
            }
            const { video_id, title, author } = videoData;
            let audioTrackData = null;
            if (player.getAudioTrack && typeof player.getAudioTrack === 'function') {
                audioTrackData = player.getAudioTrack();
            }
            const artistCurrent = LYPLUS_getArtistFromDOM() || author;
            return {
                title: title,
                artist: artistCurrent,
                album: LYPLUS_getAlbumFromDOM(),
                duration: player.getDuration(),
                videoId: video_id,
                isVideo: LYPLUS_getAlbumFromDOM() === "",
                subtitle: audioTrackData
            };
        } catch (error) {
            console.error('LYPLUS: Error retrieving song info from player API', error);
        }
    }
    return LYPLUS_getDOMSongInfo();
}

function LYPLUS_getAlbumFromDOM() {
    const byline = document.querySelector('.byline.style-scope.ytmusic-player-bar');
    if (!byline) return "";
    const links = byline.querySelectorAll('a');
    for (const link of links) {
        const href = link.getAttribute('href');
        if (href && href.startsWith("browse/")) {
            return link.textContent.trim();
        }
    }
    return "";
}

function LYPLUS_getArtistFromDOM() {
    const byline = document.querySelector('.byline.style-scope.ytmusic-player-bar');
    if (!byline) return "";
    let artists = [];
    const links = byline.querySelectorAll('a');
    for (const link of links) {
        const href = link.getAttribute('href');
        if (href && href.startsWith("channel/")) {
            artists.push(link.textContent.trim());
        }
    }
    if (artists.length === 0) return "";
    if (artists.length === 1) return artists[0];
    if (artists.length === 2) return artists.join(" & ");
    return artists.slice(0, -1).join(", ") + ", & " + artists[artists.length - 1];
}

function LYPLUS_getDOMSongInfo() {
    const titleElement = document.querySelector('.title.style-scope.ytmusic-player-bar');
    const byline = document.querySelector('.byline.style-scope.ytmusic-player-bar');
    const videoElement = document.querySelector('video');
    const playerBar = document.querySelector('ytmusic-player-bar');

    if (!titleElement || !byline || !videoElement || !videoElement.duration) {
        return null;
    }
    
    const artist = LYPLUS_getArtistFromDOM();
    const album = LYPLUS_getAlbumFromDOM();
    let videoId = new URLSearchParams(window.location.search).get('v') || playerBar?.getAttribute('video-id') || "";

    return {
        title: titleElement.textContent.trim(),
        artist,
        album,
        duration: videoElement.duration,
        isVideo: album === "",
        videoId
    };
}