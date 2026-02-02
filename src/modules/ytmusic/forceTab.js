(async function () {
  async function waitForDOMReady() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') return;
    await new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }

  await waitForDOMReady();

  let tabContainerObserver = null;
  let middleTabObserver = null;
  let sidePanelObserver = null;
  let currentMiddleTab = null;
  let isUpdating = false;

  const SELECTORS = {
    TAB_CONTAINER: 'ytmusic-player-page .tab-header-container, #tabs-content, tp-yt-paper-tabs',
    TAB: 'tp-yt-paper-tab.tab-header, tp-yt-paper-tab',
    SIDE_PANEL: '#side-panel',
    LYRICS: '.lyrics-plus-integrated',
    SCROLL_CONTAINER: '#tab-renderer',
    VIDEO: 'video'
  };

  function ensureTabEnabled(tab) {
    if (!tab || isUpdating) return;

    const needsUpdate = 
      tab.hasAttribute('disabled') ||
      tab.getAttribute('aria-disabled') === 'true' ||
      tab.style.pointerEvents !== 'auto';

    if (!needsUpdate) return;

    isUpdating = true;
    requestAnimationFrame(() => {
      tab.removeAttribute('disabled');
      tab.setAttribute('aria-disabled', 'false');
      tab.style.pointerEvents = 'auto';
      
      setTimeout(() => { isUpdating = false; }, 50);
    });
  }

  function handleTabInteraction(clickedIndex, middleIndex) {
    const lyricsElement = document.querySelector(SELECTORS.LYRICS);
    if (!lyricsElement) return;

    const shouldShow = clickedIndex === middleIndex;
    
    if (shouldShow && lyricsElement.style.display === 'block') return;
    if (!shouldShow && lyricsElement.style.display === 'none') return;

    lyricsElement.style.display = shouldShow ? 'block' : 'none';

    if (shouldShow) {
      const scrollContainer = document.querySelector(SELECTORS.SCROLL_CONTAINER);
      if (scrollContainer) scrollContainer.scrollTop = 0;
      
      const videoElement = document.querySelector(SELECTORS.VIDEO);
      if (videoElement && typeof window.scrollActiveLine === 'function') {
        try { window.scrollActiveLine(videoElement.currentTime, true); } catch (e) {}
      }
    }
  }

  function attachTouchLogic(tab, index, middleIndex) {
    if (tab.dataset.forceTabEnhanced === 'true') return;

    const MOVE_THRESHOLD = 10;
    let startX = 0, startY = 0;

    tab.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
    }, { passive: true });

    tab.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0];
      if (Math.abs(t.clientX - startX) < MOVE_THRESHOLD &&
          Math.abs(t.clientY - startY) < MOVE_THRESHOLD) {
        handleTabInteraction(index, middleIndex);
      }
    }, { passive: true });

    tab.addEventListener('click', () => {
      handleTabInteraction(index, middleIndex);
    }, { passive: true });

    tab.dataset.forceTabEnhanced = 'true';
  }

  function processTabs(container) {
    const tabs = Array.from(container.querySelectorAll(SELECTORS.TAB));
    if (tabs.length < 3) return;

    const middleIndex = Math.floor(tabs.length / 2);
    const middleTab = tabs[middleIndex];

    ensureTabEnabled(middleTab);

    if (currentMiddleTab !== middleTab) {
      if (middleTabObserver) middleTabObserver.disconnect();
      
      currentMiddleTab = middleTab;
      middleTabObserver = new MutationObserver(() => {
         if (!isUpdating) ensureTabEnabled(middleTab);
      });
      
      middleTabObserver.observe(middleTab, { 
        attributes: true, 
        attributeFilter: ['class', 'aria-selected', 'disabled'] 
      });
    }

    tabs.forEach((tab, index) => {
      attachTouchLogic(tab, index, middleIndex);
    });
  }

  function initSidePanelObserver() {
    const sidePanel = document.querySelector(SELECTORS.SIDE_PANEL);
    if (!sidePanel || sidePanelObserver) return;

    const ensureActive = () => {
      if (sidePanel.hasAttribute('inert')) sidePanel.removeAttribute('inert');
    };
    ensureActive();

    sidePanelObserver = new MutationObserver((mutations) => {
      if (mutations.some(m => m.attributeName === 'inert')) ensureActive();
    });
    sidePanelObserver.observe(sidePanel, { attributes: true, attributeFilter: ['inert'] });
  }

  const mainObserver = new MutationObserver(() => {
    const tabContainer = document.querySelector(SELECTORS.TAB_CONTAINER);

    if (tabContainer) {
      processTabs(tabContainer);

      if (!tabContainerObserver) {
        tabContainerObserver = new MutationObserver(() => {
          processTabs(tabContainer);
        });
        tabContainerObserver.observe(tabContainer, { childList: true, subtree: false });
      }
    }

    initSidePanelObserver();
  });

  mainObserver.observe(document.body, { childList: true, subtree: true });

  // Fullscreen auto-redirect to Lyrics tab
  let tabChangeObserver = null;

  function autoRedirectToLyricsInFullscreen() {
    const playerPage = document.querySelector('ytmusic-player-page');
    if (!playerPage || !playerPage.hasAttribute('player-fullscreened')) return;

    const tabs = document.querySelectorAll(
      'tp-yt-paper-tab.tab-header.style-scope.ytmusic-player-page'
    );
    if (tabs.length < 2) return;

    const activeTab = document.querySelector(
      'tp-yt-paper-tab.tab-header.style-scope.ytmusic-player-page.iron-selected'
    );
    if (!activeTab) return;

    const allTabs = Array.from(activeTab.parentElement.children);
    const activeIndex = allTabs.indexOf(activeTab);
    let lyricsTabIndex = -1;

    allTabs.forEach((tab, index) => {
      const tabText = tab.textContent.trim().toLowerCase();
      if (tabText.includes('lyrics') || tabText.includes('lirik')) {
        lyricsTabIndex = index;
      }
    });

    if (activeIndex !== lyricsTabIndex && lyricsTabIndex !== -1) {
      allTabs[lyricsTabIndex].click();
    }
  }

  function setupTabChangeObserver() {
    if (tabChangeObserver) {
      tabChangeObserver.disconnect();
    }

    const tabs = document.querySelectorAll(
      'tp-yt-paper-tab.tab-header.style-scope.ytmusic-player-page'
    );
    if (tabs.length === 0) return;

    tabChangeObserver = new MutationObserver(() => {
      const playerPage = document.querySelector('ytmusic-player-page');
      if (playerPage && playerPage.hasAttribute('player-fullscreened')) {
        requestAnimationFrame(() => {
          autoRedirectToLyricsInFullscreen();
        });
      }
    });

    tabs.forEach((tab) => {
      tabChangeObserver.observe(tab, {
        attributes: true,
        attributeFilter: ['aria-selected', 'class'],
      });
    });
  }

  function setupFullscreenObserver() {
    const playerPage = document.querySelector('ytmusic-player-page');
    if (!playerPage) {
      setTimeout(setupFullscreenObserver, 100);
      return;
    }

    const fullscreenObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'player-fullscreened') {
          const isFullscreen = mutation.target.hasAttribute('player-fullscreened');
          if (isFullscreen) {
            requestAnimationFrame(() => {
              autoRedirectToLyricsInFullscreen();
              setupTabChangeObserver();
            });
          } else if (tabChangeObserver) {
            tabChangeObserver.disconnect();
            tabChangeObserver = null;
          }
        }
      });
    });

    fullscreenObserver.observe(playerPage, {
      attributes: true,
      attributeFilter: ['player-fullscreened'],
    });
  }

  setupFullscreenObserver();

  window.addEventListener('beforeunload', () => {
    mainObserver.disconnect();
    if (tabContainerObserver) tabContainerObserver.disconnect();
    if (middleTabObserver) middleTabObserver.disconnect();
    if (sidePanelObserver) sidePanelObserver.disconnect();
    if (tabChangeObserver) tabChangeObserver.disconnect();
  }, { once: true });

})();
