class LyricsPlusRenderer {

  /**
   * Constructor for the LyricsPlusRenderer.
   * Initializes state variables and sets up the initial environment for the lyrics display.
   */
  constructor(uiConfig = {}) {
    // --- State Variables ---
    this.lyricsAnimationFrameId = null;
    this.currentPrimaryActiveLine = null;
    this.lastPrimaryActiveLine = null; // New: To store the last active line for delay calculation
    this.currentFullscreenFocusedLine = null;
    this.lastTime = 0;
    this.lastProcessedTime = 0;

    // --- DOM & Cache ---
    this.lyricsContainer = null;
    this.cachedLyricsLines = [];
    this.cachedSyllables = [];
    this.activeLineIds = new Set();
    this.highlightedSyllableIds = new Set();
    this.visibleLineIds = new Set();
    this.fontCache = {};
    this.textWidthCanvas = null;
    this.visibilityObserver = null;
    this.resizeObserver = null;
    this._cachedContainerRect = null; // New: Cache for container and parent dimensions
    this._debouncedResizeHandler = this._debounce(this._handleContainerResize, 1); // Initialize debounced handler

    // --- UI Elements ---
    this.translationButton = null;
    this.reloadButton = null;
    this.dropdownMenu = null;

    // --- Scrolling & Interaction State ---
    this.isProgrammaticScrolling = false;
    this.endProgrammaticScrollTimer = null;
    this.scrollEventHandlerAttached = false;
    this.currentScrollOffset = 0;
    this.touchStartY = 0;
    this.isTouching = false;
    this.userScrollIdleTimer = null;
    this.isUserControllingScroll = false;
    this.userScrollRevertTimer = null; // Timer to revert control to the player

    // --- Settings ---
    this.largerTextMode = "lyrics"; // Initialize to default

    // --- Initial Setup ---
    // This call ensures the container is found or created and listeners are attached.
    this._getContainer();
  }

  /**
   * Generic debounce utility.
   * @param {Function} func - The function to debounce.
   * @param {number} delay - The debounce delay in milliseconds.
   * @returns {Function} - The debounced function.
   */
  _debounce(func, delay) {
    let timeout;
    return function (...args) {
      const context = this;
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(context, args), delay);
    };
  }

  /**
   * Handles the actual logic for container resize, debounced by _debouncedResizeHandler.
   * @param {HTMLElement} container - The lyrics container element.
   * @private
   */
  _handleContainerResize(container) {
    // Update cached dimensions when the parent container resizes
    this._cachedContainerRect = {
      containerTop: container.getBoundingClientRect().top,
      scrollContainerTop: container.getBoundingClientRect().top
    };

    // Re-evaluate scroll position if not user-controlled
    if (!this.isUserControllingScroll && this.currentPrimaryActiveLine) {
      this._scrollToActiveLine(this.currentPrimaryActiveLine, false);
    }
  }

  // --- Core DOM Manipulation & Setup ---

  /**
   * A helper method to determine if a text string contains Right-to-Left characters.
   * @param {string} text - The text to check.
   * @returns {boolean} - True if the text contains RTL characters.
   */
  _isRTL(text) {
    return /[\u0600-\u06FF\u0750-\u077F\u0590-\u05FF\u08A0-\u08FF\uFB50-\uFDCF\uFDF0-\uFDFF\uFE70-\uFEFF]/.test(text);
  }

  /**
   * A helper method to determine if a text string contains CJK characters.
   * @param {string} text - The text to check.
   * @returns {boolean} - True if the text contains CJK characters.
   */
  _isCJK(text) {
    return /[\u4E00-\u9FFF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/.test(text);
  }

  /**
   * Helper function to determine if a string is purely Latin script (no non-Latin characters).
   * This is used to prevent rendering romanization for lines already in Latin script.
   * @param {string} text - The text to check.
   * @returns {boolean} - True if the text contains only Latin letters, numbers, punctuation, symbols, or whitespace.
   */
  _isPurelyLatinScript(text) {
    // This regex checks if the entire string consists ONLY of characters from the Latin Unicode script,
    // numbers, common punctuation, and whitespace.
    // If any character outside of these categories is found, it means the text is NOT purely Latin script.
    // \p{Script=Latin} or \p{sc=Latn} matches Latin letters.
    // \p{N} matches any kind of numeric character.
    // \p{P} matches any kind of punctuation character.
    // \p{S} matches any kind of symbol character.
    // \s matches any whitespace character.
    // The `u` flag is for Unicode support.
    return /^[\p{Script=Latin}\p{N}\p{P}\p{S}\s]*$/u.test(text);
  }

  /**
   * Gets the text content for a lyrics object based on the larger text mode setting.
   * In romanization mode, it swaps what appears in main container vs romanization container.
   * @param {object} normal - The lyrics object (line or syllable).
   * @param {boolean} isOriginal - Whether this is for the original/main container (true) or translation/romanization container (false).
   * @returns {string} - The appropriate text content.
   */
  _getDataText(normal, isOriginal = true) {
    if (!normal) return ''; // Handle null/undefined 'normal' object

    if (this.largerTextMode === "romanization") {
      if (isOriginal) {
        // Main/background container in romanization mode: show romanized
        return normal.romanizedText || normal.text || '';
      } else {
        // Translation/romanization container in romanization mode: show original
        return normal.text || '';
      }
    } else {
      if (isOriginal) {
        // Main/background container in lyrics mode: show original
        return normal.text || '';
      } else {
        // Translation/romanization container in lyrics mode: show romanized
        return normal.romanizedText || normal.text || '';
      }
    }
  }

  /**
   * Gets a reference to the lyrics container, creating it if it doesn't exist.
   * This method ensures the container and its scroll listeners are always ready.
   * @returns {HTMLElement | null} - The lyrics container element.
   */
  _getContainer() {
    if (!this.lyricsContainer) {
      this.lyricsContainer = document.getElementById('lyrics-plus-container');
      if (!this.lyricsContainer) {
        this._createLyricsContainer();
      }
    }
    if (this.lyricsContainer && this.lyricsContainer.parentElement && !this.scrollEventHandlerAttached) {
      this._setupUserScrollListener();
    }
    return this.lyricsContainer;
  }

  /**
   * Creates the main container for the lyrics and appends it to the DOM.
   * @returns {HTMLElement | null} - The newly created container element.
   */
  _createLyricsContainer() {
    const originalLyricsSection = document.querySelector('#tab-renderer');
    if (!originalLyricsSection) {
      this.lyricsContainer = null;
      return null;
    }
    const container = document.createElement('div');
    container.id = 'lyrics-plus-container';
    container.classList.add('lyrics-plus-integrated', 'blur-inactive-enabled');
    originalLyricsSection.appendChild(container);
    this.lyricsContainer = container;
    this._setupUserScrollListener();
    return container;
  }

  /**
   * Sets up custom event listeners for user scrolling (wheel and touch).
   * This allows for custom scroll behavior instead of native browser scrolling.
   */
  _setupUserScrollListener() {
    if (this.scrollEventHandlerAttached || !this.lyricsContainer) {
      return;
    }

    const scrollListeningElement = this.lyricsContainer;
    const parentScrollElement = this.lyricsContainer.parentElement;

    // Touch scroll state
    this.touchState = {
      isActive: false,
      startY: 0,
      lastY: 0,
      velocity: 0,
      lastTime: 0,
      momentum: null,
      samples: [], // For velocity calculation
      maxSamples: 5
    };

    if (parentScrollElement) {
      parentScrollElement.addEventListener('scroll', () => {
        if (this.isProgrammaticScrolling) {
          clearTimeout(this.endProgrammaticScrollTimer);
          this.endProgrammaticScrollTimer = setTimeout(() => {
            this.isProgrammaticScrolling = false;
            this.endProgrammaticScrollTimer = null;
          }, 250);
          return;
        }
        if (this.lyricsContainer) {
          this.lyricsContainer.classList.add('not-focused');
        }
      }, { passive: true });
    }

    // Wheel scrolling (keep existing logic)
    scrollListeningElement.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.isProgrammaticScrolling = false;
      if (this.lyricsContainer) {
        this.lyricsContainer.classList.add('not-focused', 'user-scrolling', 'wheel-scrolling');
        this.lyricsContainer.classList.remove('touch-scrolling');
        // Remove 'past' class from all lines when user scrolls to prevent fade out
        this._removePastClassFromAllLines();
      }
      const scrollAmount = event.deltaY;
      this._handleUserScroll(scrollAmount);
      clearTimeout(this.userScrollIdleTimer);
      this.userScrollIdleTimer = setTimeout(() => {
        if (this.lyricsContainer) {
          this.lyricsContainer.classList.remove('user-scrolling', 'wheel-scrolling');
        }
      }, 200);
    }, { passive: false });

    // Improved touch handling
    scrollListeningElement.addEventListener('touchstart', (event) => {
      const touch = event.touches[0];
      const now = performance.now();

      // Cancel any ongoing momentum
      if (this.touchState.momentum) {
        cancelAnimationFrame(this.touchState.momentum);
        this.touchState.momentum = null;
      }

      this.touchState.isActive = true;
      this.touchState.startY = touch.clientY;
      this.touchState.lastY = touch.clientY;
      this.touchState.lastTime = now;
      this.touchState.velocity = 0;
      this.touchState.samples = [{ y: touch.clientY, time: now }];

      this.isProgrammaticScrolling = false;
      if (this.lyricsContainer) {
        this.lyricsContainer.classList.add('not-focused', 'user-scrolling', 'touch-scrolling');
        this.lyricsContainer.classList.remove('wheel-scrolling');
        // Remove 'past' class from all lines when user scrolls to prevent fade out
        this._removePastClassFromAllLines();
      }
      clearTimeout(this.userScrollIdleTimer);
    }, { passive: true });

    scrollListeningElement.addEventListener('touchmove', (event) => {
      if (!this.touchState.isActive) return;

      event.preventDefault();
      const touch = event.touches[0];
      const now = performance.now();
      const currentY = touch.clientY;
      const deltaY = this.touchState.lastY - currentY;

      // Update position
      this.touchState.lastY = currentY;

      // Add sample for velocity calculation
      this.touchState.samples.push({ y: currentY, time: now });
      if (this.touchState.samples.length > this.touchState.maxSamples) {
        this.touchState.samples.shift();
      }

      // Apply immediate scroll with reduced sensitivity for smoother feel
      this._handleUserScroll(deltaY * 0.8); // Reduced from default sensitivity

    }, { passive: false });

    scrollListeningElement.addEventListener('touchend', (event) => {
      if (!this.touchState.isActive) return;

      this.touchState.isActive = false;

      // Calculate final velocity from recent samples
      const now = performance.now();
      const samples = this.touchState.samples;

      if (samples.length >= 2) {
        // Use samples from last 100ms for velocity calculation
        const recentSamples = samples.filter(sample => now - sample.time <= 100);

        if (recentSamples.length >= 2) {
          const newest = recentSamples[recentSamples.length - 1];
          const oldest = recentSamples[0];
          const timeDelta = newest.time - oldest.time;
          const yDelta = oldest.y - newest.y; // Inverted for scroll direction

          if (timeDelta > 0) {
            this.touchState.velocity = yDelta / timeDelta; // pixels per ms
          }
        }
      }

      // Start momentum scrolling if velocity is significant
      const minVelocity = 0.1; // pixels per ms
      if (Math.abs(this.touchState.velocity) > minVelocity) {
        this._startMomentumScroll();
      } else {
        // No momentum, just clean up
        this._endTouchScrolling();
      }
    }, { passive: true });

    // Handle touch cancel
    scrollListeningElement.addEventListener('touchcancel', () => {
      this.touchState.isActive = false;
      if (this.touchState.momentum) {
        cancelAnimationFrame(this.touchState.momentum);
        this.touchState.momentum = null;
      }
      this._endTouchScrolling();
    }, { passive: true });

    this.scrollEventHandlerAttached = true;
  }

  /**
   * Starts momentum scrolling after touch end
   * @private
   */
  _startMomentumScroll() {
    const deceleration = 0.95; // Deceleration factor per frame
    const minVelocity = 0.01; // Stop when velocity gets too small

    const animate = () => {
      // Apply velocity to scroll
      const scrollDelta = this.touchState.velocity * 16; // Convert to per-frame (assuming 60fps)
      this._handleUserScroll(scrollDelta);

      // Reduce velocity
      this.touchState.velocity *= deceleration;

      // Continue if velocity is still significant
      if (Math.abs(this.touchState.velocity) > minVelocity) {
        this.touchState.momentum = requestAnimationFrame(animate);
      } else {
        this.touchState.momentum = null;
        this._endTouchScrolling();
      }
    };

    this.touchState.momentum = requestAnimationFrame(animate);
  }

  /**
   * Cleans up touch scrolling state
   * @private
   */
  _endTouchScrolling() {
    if (this.lyricsContainer) {
      this.lyricsContainer.classList.remove('user-scrolling', 'touch-scrolling');
    }

    // Reset touch state
    this.touchState.velocity = 0;
    this.touchState.samples = [];
  }

  /**
   * Handles the logic for manual user scrolling, calculating and clamping the new scroll position.
   * Also sets a timer to automatically resume player-controlled scrolling after a period of user inactivity.
   * @param {number} delta - The amount to scroll by.
   */
  _handleUserScroll(delta) {
    // 1. Set the flag to indicate user is in control.
    this.isUserControllingScroll = true;

    // 2. Clear any existing timer. This ensures the timer resets every time the user scrolls.
    clearTimeout(this.userScrollRevertTimer);

    // 3. Set a new timer. After 4 seconds of inactivity, control will be given back to the player.
    this.userScrollRevertTimer = setTimeout(() => {
      this.isUserControllingScroll = false;
      // When reverting, force a scroll to the currently active line to re-sync the view.
      if (this.currentPrimaryActiveLine) {
        this._scrollToActiveLine(this.currentPrimaryActiveLine, true);
      }
    }, 4000); // 4-second delay before reverting. Adjust as needed.

    // --- The rest of the original function's logic remains the same ---
    const scrollSensitivity = 0.7;
    let newScrollOffset = this.currentScrollOffset - (delta * scrollSensitivity);

    const container = this._getContainer();
    if (!container) {
      this._animateScroll(newScrollOffset);
      return;
    }

    const allScrollableElements = Array.from(container.querySelectorAll('.lyrics-line, .lyrics-plus-metadata, .lyrics-plus-empty'));
    if (allScrollableElements.length === 0) {
      this._animateScroll(newScrollOffset);
      return;
    }

    const scrollContainer = container.parentElement;
    if (!scrollContainer) {
      this._animateScroll(newScrollOffset);
      return;
    }

    const containerHeight = scrollContainer.clientHeight;
    let minAllowedScroll = 0;
    let maxAllowedScroll = 0;

    const firstElement = allScrollableElements[0];
    const lastElement = allScrollableElements[allScrollableElements.length - 1];

    if (firstElement && lastElement) {
      const contentTotalHeight = lastElement.offsetTop + lastElement.offsetHeight - firstElement.offsetTop;
      if (contentTotalHeight > containerHeight) {
        maxAllowedScroll = containerHeight - (lastElement.offsetTop + lastElement.offsetHeight);
      }
    }

    newScrollOffset = Math.max(newScrollOffset, maxAllowedScroll);
    newScrollOffset = Math.min(newScrollOffset, minAllowedScroll);

    this._animateScroll(newScrollOffset);
  }

  /**
   * Fixes lyric timings by analyzing overlaps and gaps in a multi-pass process.
   * @param {NodeListOf<HTMLElement> | Array<HTMLElement>} originalLines - A list of lyric elements.
   */
  _retimingActiveTimings(originalLines) {
    if (!originalLines || originalLines.length < 2) {
      return;
    }

    const linesData = Array.from(originalLines).map((line) => ({
      element: line,
      startTime: parseFloat(line.dataset.startTime),
      originalEndTime: parseFloat(line.dataset.endTime),
      newEndTime: parseFloat(line.dataset.endTime),
      isHandledByPrecursorPass: false,
    }));

    for (let i = 0; i <= linesData.length - 3; i++) {
      const lineA = linesData[i];
      const lineB = linesData[i + 1];
      const lineC = linesData[i + 2];
      const aOverlapsB = lineB.startTime < lineA.originalEndTime;
      const bOverlapsC = lineC.startTime < lineB.originalEndTime;
      const aDoesNotOverlapC = lineC.startTime >= lineA.originalEndTime;
      if (aOverlapsB && bOverlapsC && aDoesNotOverlapC) {
        lineA.newEndTime = lineC.startTime;
        lineA.isHandledByPrecursorPass = true;
      }
    }

    for (let i = linesData.length - 2; i >= 0; i--) {
      const currentLine = linesData[i];
      const nextLine = linesData[i + 1];
      if (currentLine.isHandledByPrecursorPass) continue;

      if (nextLine.startTime < currentLine.originalEndTime) {
        const overlap = currentLine.originalEndTime - nextLine.startTime;
        // Only extend if overlap is >= 5ms (0.005 seconds), otherwise don't overlap
        if (overlap >= 0.005) {
          currentLine.newEndTime = nextLine.newEndTime;
        } else {
          // Overlap is less than 5ms, don't extend - keep original end time
          currentLine.newEndTime = currentLine.originalEndTime;
        }
      } else {
        const gap = nextLine.startTime - currentLine.originalEndTime;
        const nextElement = currentLine.element.nextElementSibling;
        const isFollowedByManualGap = nextElement && nextElement.classList.contains('lyrics-gap');
        if (gap > 0 && !isFollowedByManualGap) {
          const extension = Math.min(0.5, gap);
          currentLine.newEndTime = currentLine.originalEndTime + extension;
        }
      }
    }

    linesData.forEach(lineData => {
      lineData.element.dataset.actualEndTime = lineData.originalEndTime.toFixed(3);
      if (Math.abs(lineData.newEndTime - lineData.originalEndTime) > 0.001) {
        lineData.element.dataset.endTime = lineData.newEndTime.toFixed(3);
      }
    });
  }

  /**
   * An internal handler for click events on lyric lines.
   * Seeks the video to the line's start time.
   * @param {Event} e - The click event.
   */
  _onLyricClick(e) {
    const time = parseFloat(e.currentTarget.dataset.startTime);
    const player = document.querySelector("video");
    if (player) player.currentTime = time - 0.05;
    this._scrollToActiveLine(e.currentTarget, true);
  }

  // --- Lyrics Display & Rendering Logic ---

  /**
 * Internal helper to render word-by-word lyrics.
 * @private
 */
  _renderWordByWordLyrics(lyrics, displayMode, singerClassMap, lightweight, elementPool, fragment) {
    const getComputedFont = (element) => {
      if (!element) return '400 16px sans-serif';
      const cacheKey = element.tagName + (element.className || '');
      if (this.fontCache[cacheKey]) return this.fontCache[cacheKey];
      const style = getComputedStyle(element);
      const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      this.fontCache[cacheKey] = font;
      return font;
    };

    const calculatePreHighlightDelay = (syllable, font, currentDuration) => {
      const syllableWidthPx = this._getTextWidth(syllable.textContent, font);
      const emWidthPx = this._getTextWidth('M', font);
      const syllableWidthEm = emWidthPx > 0 ? (syllableWidthPx / emWidthPx) : 0;

      const gradientWidth = 0.75;
      const gradientHalfWidth = gradientWidth / 2;
      const initialGradientPosition = -gradientHalfWidth;
      const finalGradientPosition = syllableWidthEm + gradientHalfWidth;
      const totalAnimationDistance = finalGradientPosition - initialGradientPosition;

      const triggerPointFromTextEnd = gradientHalfWidth;
      let triggerPosition;
      if (syllableWidthEm <= gradientWidth) {
        triggerPosition = -gradientHalfWidth * 0.5;
      } else {
        triggerPosition = syllableWidthEm - triggerPointFromTextEnd;
      }

      const distanceToTrigger = triggerPosition - initialGradientPosition;
      let triggerTimingFraction = 0;
      if (totalAnimationDistance > 0) {
        triggerTimingFraction = distanceToTrigger / totalAnimationDistance;
      }

      const rawDelayMs = triggerTimingFraction * currentDuration;
      return Math.max(0, Math.round(rawDelayMs));
    };

    lyrics.data.forEach((line) => {
      let currentLine = elementPool.lines.pop() || document.createElement('div');
      currentLine.innerHTML = '';
      currentLine.className = 'lyrics-line';
      currentLine.dataset.startTime = line.startTime;
      currentLine.dataset.endTime = line.endTime;
      const singerClass = line.element?.singer ? (singerClassMap[line.element.singer] || 'singer-left') : 'singer-left';
      currentLine.classList.add(singerClass);
      if (this._isRTL(this._getDataText(line, true))) currentLine.classList.add('rtl-text');
      if (!currentLine.hasClickListener) {
        currentLine.addEventListener('click', this._onLyricClick.bind(this));
        currentLine.hasClickListener = true;
      }

      const mainContainer = document.createElement('div');
      mainContainer.classList.add('main-vocal-container');
      currentLine.appendChild(mainContainer);

      // Use the new helper for translation container
      this._renderTranslationContainer(currentLine, line, displayMode);

      let backgroundContainer = null;
      let wordBuffer = [];
      let currentWordStartTime = null;
      let currentWordEndTime = null;

      let pendingSyllable = null;
      let pendingSyllableFont = null;

      const flushWordBuffer = () => {
        if (!wordBuffer.length) return;
        const wordSpan = elementPool.syllables.pop() || document.createElement('span');
        wordSpan.innerHTML = '';
        wordSpan.className = 'lyrics-word';
        let referenceFont = mainContainer.firstChild ? getComputedFont(mainContainer.firstChild) : '400 16px sans-serif';
        const combinedText = wordBuffer.map(s => s.text).join('');
        const totalDuration = currentWordEndTime - currentWordStartTime;
        const shouldEmphasize = !lightweight && !this._isRTL(combinedText) && !this._isCJK(combinedText) && combinedText.trim().length <= 15 && totalDuration >= 800;

        let maxScale = 1.05; // Subtle but noticeable scale

        if (shouldEmphasize) {
          const minDuration = 800;
          const maxDuration = 3000; 
          const easingPower = 3.0; // AGGRESSIVE easing - more dramatic curve

          const progress = Math.min(1, Math.max(0, (totalDuration - minDuration) / (maxDuration - minDuration)));
          const easedProgress = Math.pow(progress, easingPower);

          // Length-based scaling - longer text gets less dramatic emphasis
          const textLength = combinedText.trim().length;
          const lengthFactor = Math.max(0.5, 1.0 - ((textLength - 3) * 0.05));
          
          maxScale = 1.0 + (0.05 + easedProgress * 0.08) * lengthFactor; // Subtle scaling range

          const shadowIntensity = (0.8 + easedProgress * 0.6) * lengthFactor; // AGGRESSIVE shadow (0.8-1.4 range)
          const normalizedGrowth = (maxScale - 1.0) / 0.08;
          const translateYPeak = -normalizedGrowth * 3.0 * lengthFactor; // AGGRESSIVE vertical movement (doubled)

          wordSpan.style.setProperty('--max-scale', maxScale.toFixed(3));
          wordSpan.style.setProperty('--shadow-intensity', shadowIntensity.toFixed(3));
          wordSpan.style.setProperty('--translate-y-peak', translateYPeak.toFixed(3));
        }
        wordSpan.style.setProperty('--min-scale', Math.max(1.0, Math.min(1.02, 1.01))); // Subtle min-scale
        wordSpan.dataset.totalDuration = totalDuration;

        let isCurrentWordBackground = wordBuffer[0].isBackground || false;
        const characterData = [];

        // Store syllable elements for pre-highlight calculation
        const syllableElements = [];

        wordBuffer.forEach((s, syllableIndex) => {
          const sylSpan = elementPool.syllables.pop() || document.createElement('span');
          sylSpan.innerHTML = '';
          sylSpan.className = 'lyrics-syllable';

          sylSpan.dataset.startTime = s.time;
          sylSpan.dataset.duration = s.duration;
          sylSpan.dataset.endTime = s.time + s.duration;
          sylSpan.dataset.wordDuration = totalDuration;
          sylSpan.dataset.syllableIndex = syllableIndex;

          sylSpan._startTimeMs = s.time;
          sylSpan._durationMs = s.duration;
          sylSpan._endTimeMs = s.time + s.duration;
          sylSpan._wordDurationMs = totalDuration;

          if (!sylSpan.hasClickListener) {
            sylSpan.addEventListener('click', this._onLyricClick.bind(this));
            sylSpan.hasClickListener = true;
          }
          if (this._isRTL(this._getDataText(s))) sylSpan.classList.add('rtl-text');

          // Store syllable for pre-highlight calculation
          syllableElements.push(sylSpan);

          const charSpansForSyllable = [];

          if (s.isBackground) {
            sylSpan.textContent = this._getDataText(s).replace(/[()]/g, '');
          } else {
            if (shouldEmphasize) {
              wordSpan.classList.add('growable');
<<<<<<< HEAD
              const syllableText = this._getDataText(s).trimEnd();
=======
              const syllableText = this._getDataText(s);
>>>>>>> 17eac0ce00dffda4820a6974af9a1a91a3e4d913
              const totalSyllableWidth = this._getTextWidth(syllableText, referenceFont);
              let cumulativeCharWidth = 0;
              let charIndex = 0;

              syllableText.split('').forEach(char => {
                if (char === ' ') {
                  sylSpan.appendChild(document.createTextNode(' '));
                } else {
                  const charSpan = elementPool.chars.pop() || document.createElement('span');
                  charSpan.textContent = char;
                  charSpan.className = 'char';

                  const charWidth = this._getTextWidth(char, referenceFont);
                  if (totalSyllableWidth > 0) {
                    const startPercent = cumulativeCharWidth / totalSyllableWidth;
                    const durationPercent = charWidth / totalSyllableWidth;
                    charSpan.dataset.wipeStart = startPercent.toFixed(4);
                    charSpan.dataset.wipeDuration = durationPercent.toFixed(4);
                  }
                  cumulativeCharWidth += charWidth;

                  charSpan.dataset.charIndex = charIndex++;
                  charSpan.dataset.syllableCharIndex = characterData.length;
                  characterData.push({ charSpan, syllableSpan: sylSpan, isBackground: s.isBackground });
                  charSpansForSyllable.push(charSpan);
                  sylSpan.appendChild(charSpan);
                }
              });
            } else {
              sylSpan.textContent = this._getDataText(s).trimEnd();
            }
          }
          if (charSpansForSyllable.length > 0) {
            sylSpan._cachedCharSpans = charSpansForSyllable;
          }
          wordSpan.appendChild(sylSpan);
        });



        if (shouldEmphasize) {
          wordSpan._cachedChars = characterData.map(cd => cd.charSpan);
        }

        if (pendingSyllable && syllableElements.length > 0) {
          const nextSyllable = syllableElements[0];
          const currentDuration = pendingSyllable._durationMs;

          const delayMs = calculatePreHighlightDelay(
            pendingSyllable,
            pendingSyllableFont,
            currentDuration
          );

          pendingSyllable._nextSyllableInWord = nextSyllable;
          pendingSyllable._preHighlightDurationMs = Math.max(0, currentDuration - delayMs);
          pendingSyllable._preHighlightDelayMs = delayMs;
        }

        syllableElements.forEach((syllable, index) => {
          if (index < syllableElements.length - 1) {
            const nextSyllable = syllableElements[index + 1];
            const currentDuration = syllable._durationMs;

            const delayMs = calculatePreHighlightDelay(
              syllable,
              referenceFont,
              currentDuration
            );

            syllable._nextSyllableInWord = nextSyllable;
            syllable._preHighlightDurationMs = Math.max(0, currentDuration - delayMs);
            syllable._preHighlightDelayMs = delayMs;
          }
        });

        if (shouldEmphasize && wordSpan._cachedChars?.length > 0) {
          const wordWidth = this._getTextWidth(wordSpan.textContent, referenceFont);
          let cumulativeWidth = 0;
          wordSpan._cachedChars.forEach(span => {
            const charWidth = this._getTextWidth(span.textContent, referenceFont);
            const position = (cumulativeWidth + (charWidth / 2)) / wordWidth;
            const horizontalOffset = Math.sign((position - 0.5) * 2) * Math.pow(Math.abs((position - 0.5) * 2), 1.3) * ((maxScale - 1.0) * 40);
            span.dataset.horizontalOffset = horizontalOffset;
            span.dataset.position = position;
            cumulativeWidth += charWidth;
          });
        }

        const targetContainer = isCurrentWordBackground ? (backgroundContainer || (backgroundContainer = document.createElement('div'), backgroundContainer.className = 'background-vocal-container', currentLine.appendChild(backgroundContainer))) : mainContainer;
        targetContainer.appendChild(wordSpan);
        const trailText = combinedText.match(/\s+$/);
        if (trailText) targetContainer.appendChild(document.createTextNode(trailText));

        pendingSyllable = syllableElements.length > 0
          ? syllableElements[syllableElements.length - 1]
          : null;
        pendingSyllableFont = referenceFont;

        wordBuffer = [];
        currentWordStartTime = null;
        currentWordEndTime = null;
      };

      if (line.syllabus && line.syllabus.length > 0) {
        line.syllabus.forEach((s, syllableIndex) => {
          if (wordBuffer.length === 0) currentWordStartTime = s.time;
          wordBuffer.push(s);
          currentWordEndTime = s.time + s.duration;
          const isLastSyllableInLine = syllableIndex === line.syllabus.length - 1;
          const nextSyllable = line.syllabus[syllableIndex + 1];
          const endsWithExplicitDelimiter = s.isLineEnding || /\s$/.test(s.text);
          const isBackgroundStatusChanging = nextSyllable && (s.isBackground !== nextSyllable.isBackground) && !endsWithExplicitDelimiter;
          if (endsWithExplicitDelimiter || isLastSyllableInLine || isBackgroundStatusChanging) {
            flushWordBuffer();
          }
        });
      } else {
        mainContainer.textContent = this._getDataText(line);
      }
      fragment.appendChild(currentLine);
    });
  }

  /**
   * Internal helper to render line-by-line lyrics.
   * @private
   */
  _renderLineByLineLyrics(lyrics, displayMode, singerClassMap, elementPool, fragment) {
    const lineFragment = document.createDocumentFragment();
    lyrics.data.forEach(line => {
      const lineDiv = elementPool.lines.pop() || document.createElement('div');
      lineDiv.innerHTML = '';
      lineDiv.className = 'lyrics-line';
      lineDiv.dataset.startTime = line.startTime;
      lineDiv.dataset.endTime = line.endTime;
      const singerClass = line.element?.singer ? (singerClassMap[line.element.singer] || 'singer-left') : 'singer-left';
      lineDiv.classList.add(singerClass);
      // Apply rtl-text to the line itself based on the "big" text direction for overall flex-direction control.
      if (this._isRTL(this._getDataText(line, true))) lineDiv.classList.add('rtl-text');
      if (!lineDiv.hasClickListener) {
        lineDiv.addEventListener('click', this._onLyricClick.bind(this));
        lineDiv.hasClickListener = true;
      }
      const mainContainer = document.createElement('div');
      mainContainer.className = 'main-vocal-container';
      mainContainer.textContent = this._getDataText(line);
      // Apply rtl-text to mainContainer for its internal text alignment.
      if (this._isRTL(this._getDataText(line, true))) mainContainer.classList.add('rtl-text');
      lineDiv.appendChild(mainContainer);
      // Use the new helper for translation container
      this._renderTranslationContainer(lineDiv, line, displayMode);
      lineFragment.appendChild(lineDiv);
    });
    fragment.appendChild(lineFragment);
  }

  /**
   * Applies the appropriate CSS classes to the container based on the display mode.
   * @param {HTMLElement} container - The lyrics container element.
   * @param {string} displayMode - The current display mode ('none', 'translate', 'romanize').
   * @private
   */
  _applyDisplayModeClasses(container, displayMode) {
    container.classList.remove('lyrics-translated', 'lyrics-romanized', 'lyrics-both-modes');
    if (displayMode === 'translate') container.classList.add('lyrics-translated');
    else if (displayMode === 'romanize') container.classList.add('lyrics-romanized');
    else if (displayMode === 'both') container.classList.add('lyrics-both-modes');
  }

  /**
   * Renders the translation/romanization container for a given lyric line.
   * @param {HTMLElement} lineElement - The DOM element for the lyric line.
   * @param {object} lineData - The data object for the lyric line (from lyrics.data).
   * @param {string} displayMode - The current display mode ('none', 'translate', 'romanize', 'both').
   * @private
   */
  _renderTranslationContainer(lineElement, lineData, displayMode) {
    if (displayMode === 'romanize' || displayMode === 'both') {
      // Only render romanization if the original text is NOT purely Latin script
      if (!this._isPurelyLatinScript(lineData.text)) {
        // Render romanization syllable by syllable if available, otherwise line by line
        if (lineData.syllabus && lineData.syllabus.length > 0 && lineData.syllabus.some(s => s.romanizedText)) {
          const romanizationContainer = document.createElement('div');
          romanizationContainer.classList.add('lyrics-romanization-container');
          // Apply rtl-text to the container itself based on the original text direction (lineData.text)
          // This ensures the container's overall directionality is correct.
          if (this._isRTL(lineData.text)) romanizationContainer.classList.add('rtl-text');
          lineData.syllabus.forEach(syllable => {
            const romanizedText = this._getDataText(syllable, false); // This is syllable.text (original text of syllable)
            if (romanizedText) {
              const sylSpan = document.createElement('span');
              sylSpan.className = 'lyrics-syllable'; // Use lyrics-syllable class for highlighting
              sylSpan.textContent = romanizedText;
              // Apply rtl-text to individual syllable spans for their internal text alignment.
              if (this._isRTL(romanizedText)) sylSpan.classList.add('rtl-text');
              // Copy timing data for highlighting
              sylSpan.dataset.startTime = syllable.time;
              sylSpan.dataset.duration = syllable.duration;
              sylSpan.dataset.endTime = syllable.time + syllable.duration;
              sylSpan._startTimeMs = syllable.time;
              sylSpan._durationMs = syllable.duration;
              sylSpan._endTimeMs = syllable.time + syllable.duration;
              romanizationContainer.appendChild(sylSpan);
            }
          });
          if (romanizationContainer.children.length > 0) {
            lineElement.appendChild(romanizationContainer);
          }
        } else if (lineData.romanizedText && lineData.text.trim() !== lineData.romanizedText.trim()) {
          // Fallback to line-level romanization if no syllable data
          const romanizationContainer = document.createElement('div');
          romanizationContainer.classList.add('lyrics-romanization-container');
          const romanizedText = this._getDataText(lineData, false); // This is lineData.text (original text of line)
          romanizationContainer.textContent = romanizedText;
          // Apply rtl-text to the container itself based on the original text direction (lineData.text)
          // This ensures the container's overall directionality is correct.
          if (this._isRTL(lineData.text)) romanizationContainer.classList.add('rtl-text');
          lineElement.appendChild(romanizationContainer);
        }
      }
    }
    if (displayMode === 'translate' || displayMode === 'both') {
      // Translation remains line-by-line
      if (lineData.translatedText && lineData.text.trim() !== lineData.translatedText.trim()) {
        const translationContainer = document.createElement('div');
        translationContainer.classList.add('lyrics-translation-container');
        translationContainer.textContent = lineData.translatedText;
        lineElement.appendChild(translationContainer);
      }
    }
  }

  /**
   * Updates the display of lyrics based on a new display mode (translation/romanization).
   * This method re-renders the lyric lines without re-fetching the entire lyrics data.
   * @param {object} lyrics - The lyrics data object.
   * @param {string} displayMode - The new display mode ('none', 'translate', 'romanize').
   * @param {object} currentSettings - The current user settings.
   */
  updateDisplayMode(lyrics, displayMode, currentSettings) {
    this.currentDisplayMode = displayMode;
    const container = this._getContainer();
    if (!container) return;

    container.innerHTML = ''; // Clear existing content

    // Re-apply display mode classes
    this._applyDisplayModeClasses(container, displayMode);

    // Re-apply settings that affect lyrics display
    // Word-by-word and lightweight settings
    const isWordByWordMode = lyrics.type === "Word" && currentSettings.wordByWord;
    container.classList.toggle('word-by-word-mode', isWordByWordMode);
    container.classList.toggle('line-by-line-mode', !isWordByWordMode);
    container.classList.toggle('lightweight-mode', !!currentSettings.lightweight);

    // Larger text mode
    this.largerTextMode = currentSettings.largerTextMode;
    container.classList.toggle('romanized-big-mode', this.largerTextMode === "romanization");

    // Blur and fade settings
    container.classList.toggle('blur-inactive-enabled', !!currentSettings.blurInactive);
    const isVideoFullscreen = this._isVideoFullscreen?.() ?? this.__detectVideoFullscreen();
    container.classList.toggle('fade-past-lines', !!currentSettings.fadePastLines && !isVideoFullscreen);
    
    // Hide offscreen disabled - causes issues in fullscreen mode
    // container.classList.toggle('hide-offscreen', !!currentSettings.hideOffscreen);
    container.classList.toggle('compability-wipe', !!currentSettings.compabilityWipe);
    
    // Font size if available
    if (currentSettings.fontSize) {
        container.style.setProperty('--lyrics-font-size', `${currentSettings.fontSize}px`);
    }
    
    // Dynamic background settings - apply immediately (but don't refresh lyrics)
    if (currentSettings.dynamicPlayerPage !== undefined || currentSettings.dynamicPlayerFullscreen !== undefined) {
        console.log('NewSync: Applying dynamic background settings...', {
            dynamicPlayerPage: currentSettings.dynamicPlayerPage,
            dynamicPlayerFullscreen: currentSettings.dynamicPlayerFullscreen,
            functionAvailable: typeof window.applyDynamicPlayerClass === 'function'
        });
        
        // Trigger dynamic background update by calling the function from settings.js
        // This only affects the visual background, not the lyrics content
        if (typeof window.applyDynamicPlayerClass === 'function') {
            window.applyDynamicPlayerClass();
        } else {
            console.warn('NewSync: applyDynamicPlayerClass function not available');
        }
    }
    
    // Note: AI translation settings are not refreshed here as they require API fetch

    if (currentSettings.overridePaletteColor) {
      container.classList.add('override-palette-color');
      container.style.setProperty('--lyplus-override-pallete', currentSettings.overridePaletteColor);
      container.style.setProperty('--lyplus-override-pallete-white', `${currentSettings.overridePaletteColor}85`);
      container.classList.remove('use-song-palette-fullscreen', 'use-song-palette-all-modes');
    } else {
      container.classList.remove('override-palette-color');
      if (currentSettings.useSongPaletteFullscreen || currentSettings.useSongPaletteAllModes) {
        if (typeof LYPLUS_getSongPalette === 'function') {
          const songPalette = LYPLUS_getSongPalette();
          if (songPalette) {
            const { r, g, b } = songPalette;
            container.style.setProperty('--lyplus-song-pallete', `rgb(${r}, ${g}, ${b})`);
            const alpha = 133 / 255;
            const r_blend = Math.round(alpha * 255 + (1 - alpha) * r);
            const g_blend = Math.round(alpha * 255 + (1 - alpha) * b);
            const b_blend = Math.round(alpha * 255 + (1 - alpha) * b);
            container.style.setProperty('--lyplus-song-white-pallete', `rgb(${r_blend}, ${g_blend}, ${b_blend})`);
          }
        }
      }
    }

    const playerPageElement = document.querySelector('ytmusic-player-page');
    container.classList.toggle('fullscreen', playerPageElement && playerPageElement.hasAttribute('player-fullscreened'));

    // Re-determine text direction and dual-side layout (copied from displayLyrics)
    let hasRTL = false, hasLTR = false;
    if (lyrics && lyrics.data && lyrics.data.length > 0) {
      for (const line of lyrics.data) {
        if (this._isRTL(line.text)) hasRTL = true;
        else hasLTR = true;
        if (hasRTL && hasLTR) break;
      }
    }
    container.classList.remove('mixed-direction-lyrics', 'dual-side-lyrics');
    if (hasRTL && hasLTR) container.classList.add('mixed-direction-lyrics');

    const singerClassMap = {};
    let isDualSide = false;
    if (lyrics && lyrics.data && lyrics.data.length > 0) {
      const allSingers = [...new Set(lyrics.data.map(line => line.element?.singer).filter(Boolean))];
      const leftCandidates = [];
      const rightCandidates = [];

      allSingers.forEach(s => {
        if (!s.startsWith('v')) return;

        const numericPart = s.substring(1);
        if (numericPart.length === 0) return;

        let processedNumericPart = numericPart.replaceAll("0", "");
        if (processedNumericPart === "" && numericPart.length > 0) {
          processedNumericPart = "0";
        }

        const num = parseInt(processedNumericPart, 10);
        if (isNaN(num)) return;

        if (num % 2 !== 0) {
          leftCandidates.push(s); // Odd numbers to the left
        } else {
          rightCandidates.push(s); // Even numbers to the right
        }
      });

      const sortByOriginalNumber = (a, b) => parseInt(a.substring(1)) - parseInt(b.substring(1));
      leftCandidates.sort(sortByOriginalNumber);
      rightCandidates.sort(sortByOriginalNumber);

      if (leftCandidates.length > 0 || rightCandidates.length > 0) {
        leftCandidates.forEach(s => singerClassMap[s] = 'singer-left');
        rightCandidates.forEach(s => singerClassMap[s] = 'singer-right');
        isDualSide = leftCandidates.length > 0 && rightCandidates.length > 0;
      }
    }
    if (isDualSide) container.classList.add('dual-side-lyrics');

    const elementPool = { lines: [], syllables: [], chars: [] };

    const createGapLine = (gapStart, gapEnd, classesToInherit = null) => {
      const gapDuration = gapEnd - gapStart;
      const gapLine = elementPool.lines.pop() || document.createElement('div');
      gapLine.className = 'lyrics-line lyrics-gap';
      gapLine.dataset.startTime = gapStart;
      gapLine.dataset.endTime = gapEnd;
      if (!gapLine.hasClickListener) {
        gapLine.addEventListener('click', this._onLyricClick.bind(this));
        gapLine.hasClickListener = true;
      }
      if (classesToInherit) {
        if (classesToInherit.includes('rtl-text')) gapLine.classList.add('rtl-text');
        if (classesToInherit.includes('singer-left')) gapLine.classList.add('singer-left');
        if (classesToInherit.includes('singer-right')) gapLine.classList.add('singer-right');
      }
      const existingMainContainer = gapLine.querySelector('.main-vocal-container');
      if (existingMainContainer) existingMainContainer.remove();
      const mainContainer = document.createElement('div');
      mainContainer.className = 'main-vocal-container';
      const lyricsWord = document.createElement('div');
      lyricsWord.className = 'lyrics-word';
      for (let i = 0; i < 3; i++) {
        const syllableSpan = elementPool.syllables.pop() || document.createElement('span');
        syllableSpan.className = 'lyrics-syllable';
        const syllableStart = (gapStart + (i * gapDuration / 3)) * 1000;
        const syllableDuration = ((gapDuration / 3) / 0.9) * 1000;
        syllableSpan.dataset.startTime = syllableStart;
        syllableSpan.dataset.duration = syllableDuration;
        syllableSpan.dataset.endTime = syllableStart + syllableDuration;
        syllableSpan.textContent = "•";
        if (!syllableSpan.hasClickListener) {
          syllableSpan.addEventListener('click', this._onLyricClick.bind(this));
          syllableSpan.hasClickListener = true;
        }
        lyricsWord.appendChild(syllableSpan);
      }
      mainContainer.appendChild(lyricsWord);
      gapLine.appendChild(mainContainer);
      return gapLine;
    };

    const fragment = document.createDocumentFragment();

    if (isWordByWordMode) {
      this._renderWordByWordLyrics(lyrics, displayMode, singerClassMap, currentSettings.lightweight, elementPool, fragment);
    } else {
      this._renderLineByLineLyrics(lyrics, displayMode, singerClassMap, elementPool, fragment);
    }

    container.appendChild(fragment);

    // Add song information display in fullscreen mode
    const playerPageForSongInfo = document.querySelector('ytmusic-player-page');
    const isFullscreen = playerPageForSongInfo && playerPageForSongInfo.hasAttribute('player-fullscreened');
    console.log('LYPLUS: Fullscreen check - playerPage:', !!playerPageForSongInfo, 'isFullscreen:', isFullscreen, 'hasSongInfo:', !!this.lastKnownSongInfo);
    if (isFullscreen && this.lastKnownSongInfo) {
      this._addSongInfoDisplay(container);
    }

    // Post-rendering logic for gaps and timing adjustments
    const originalLines = Array.from(container.querySelectorAll('.lyrics-line:not(.lyrics-gap)'));
    if (originalLines.length > 0) {
      const firstLine = originalLines[0];
      const firstStartTime = parseFloat(firstLine.dataset.startTime);
      if (firstStartTime >= 7.0) {
        const classesToInherit = [...firstLine.classList].filter(c => ['rtl-text', 'singer-left', 'singer-right'].includes(c));
        container.insertBefore(createGapLine(0, firstStartTime - 0.85, classesToInherit), firstLine);
      }
    }
    const gapLinesToInsert = [];
    originalLines.forEach((line, index) => {
      if (index < originalLines.length - 1) {
        const nextLine = originalLines[index + 1];
        if (parseFloat(nextLine.dataset.startTime) - parseFloat(line.dataset.endTime) >= 7.0) {
          const classesToInherit = [...nextLine.classList].filter(c => ['rtl-text', 'singer-left', 'singer-right'].includes(c));
          gapLinesToInsert.push({ gapLine: createGapLine(parseFloat(line.dataset.endTime) + 0.4, parseFloat(nextLine.dataset.startTime) - 0.85, classesToInherit), nextLine });
        }
      }
    });
    gapLinesToInsert.forEach(({ gapLine, nextLine }) => container.insertBefore(gapLine, nextLine));
    this._retimingActiveTimings(originalLines);

    // Render metadata (assuming metadata doesn't change with display mode)
    const metadataContainer = document.createElement('div');
    metadataContainer.className = 'lyrics-plus-metadata';
    metadataContainer.dataset.startTime = (lyrics.data[lyrics.data.length - 1]?.endTime || 0) + 0.5; // Approximate start time for metadata
    metadataContainer.dataset.endTime = (lyrics.data[lyrics.data.length - 1]?.endTime || 0) + 10; // Approximate end time for metadata

    // Note: songWriters and source are not available in updateDisplayMode,
    // so this part might need to be handled differently if they are dynamic.
    // For now, assuming they are set once by displayLyrics.
    if (lyrics.metadata.songWriters) { // Use lyrics.metadata directly
      const songWritersDiv = document.createElement('span');
      songWritersDiv.className = 'lyrics-song-writters';
      songWritersDiv.innerText = `${t("writtenBy")} ${lyrics.metadata.songWriters.join(', ')}`;
      metadataContainer.appendChild(songWritersDiv);
    }
    const sourceDiv = document.createElement('span');
    sourceDiv.className = 'lyrics-source-provider';
    sourceDiv.innerText = `${t("source")} ${lyrics.metadata.source}`; // Use lyrics.metadata directly
    metadataContainer.appendChild(sourceDiv);
    container.appendChild(metadataContainer);

    // Add an empty div at the end for bottom padding
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'lyrics-plus-empty';
    container.appendChild(emptyDiv);

    // Create the fixed empty div for avoiding detected by resizerObserver
    const emptyFixedDiv = document.createElement('div');
    emptyFixedDiv.className = 'lyrics-plus-empty-fixed';
    container.appendChild(emptyFixedDiv);

    // Cache and setup for sync
    this.cachedLyricsLines = Array.from(container.querySelectorAll('.lyrics-line, .lyrics-plus-metadata, .lyrics-plus-empty')).map(line => {
      if (line) {
        line._startTimeMs = parseFloat(line.dataset.startTime) * 1000;
        line._endTimeMs = parseFloat(line.dataset.endTime) * 1000;
      }
      return line;
    }).filter(Boolean);

    this.cachedSyllables = Array.from(container.getElementsByClassName('lyrics-syllable')).map(syllable => {
      if (syllable) {
        syllable._startTimeMs = parseFloat(syllable.dataset.startTime);
        syllable._durationMs = parseFloat(syllable.dataset.duration);
        syllable._endTimeMs = syllable._startTimeMs + syllable._durationMs;
        const wordDuration = parseFloat(syllable.dataset.wordDuration);
        syllable._wordDurationMs = isNaN(wordDuration) ? null : wordDuration;
      }
      return syllable;
    }).filter(Boolean);

    this._ensureElementIds();
    this.activeLineIds.clear();
    this.highlightedSyllableIds.clear();
    this.visibleLineIds.clear();
    this.currentPrimaryActiveLine = null;

    if (this.cachedLyricsLines.length > 0) this._scrollToActiveLine(this.cachedLyricsLines[0], true);

    this._startLyricsSync(currentSettings);
    // Control buttons are created once by displayLyrics, not re-created here.
    container.classList.toggle('blur-inactive-enabled', !!currentSettings.blurInactive);
  }

  /**
   * Renders the lyrics, metadata, and control buttons inside the container.
   * This is the main public method to update the display.
   * @param {object} lyrics - The lyrics data object.
   * @param {string} source - The source of the lyrics.
   * @param {string} type - The type of lyrics ("Line" or "Word").
   * @param {boolean} lightweight - Flag for lightweight mode.
   * @param {string[]} songWriters - Array of songwriters.
   * @param {object} songInfo - Information about the current song.
   * @param {string} displayMode - The current display mode ('none', 'translate', 'romanize').
   * @param {object} currentSettings - The current user settings.
   * @param {Function} fetchAndDisplayLyricsFn - The function to fetch and display lyrics.
   * @param {Function} setCurrentDisplayModeAndRefetchFn - The function to set display mode and refetch.
   * @param {string} largerTextMode - The larger text mode setting ("lyrics" or "romanization").
   */
  displayLyrics(lyrics, source = "Unknown", type = "Line", lightweight = false, songWriters, songInfo, displayMode = 'none', currentSettings = {}, fetchAndDisplayLyricsFn, setCurrentDisplayModeAndRefetchFn, largerTextMode = "lyrics") {
    this.lastKnownSongInfo = songInfo;
    this.fetchAndDisplayLyricsFn = fetchAndDisplayLyricsFn;
    this.setCurrentDisplayModeAndRefetchFn = setCurrentDisplayModeAndRefetchFn;
    this.largerTextMode = largerTextMode;

    const container = this._getContainer();
    if (!container) return;

    // Reset any pending/not-found animation state when real lyrics are about to be shown
    if (this._notFoundCenterTimer) {
      clearTimeout(this._notFoundCenterTimer);
      this._notFoundCenterTimer = null;
    }
    if (this._notFoundAutoHideTimer) {
      clearTimeout(this._notFoundAutoHideTimer);
      this._notFoundAutoHideTimer = null;
    }
    container.classList.remove('animate-not-found-center');

    // Ensure any previous user-scroll state does not suppress effects on new song
    container.classList.remove('not-focused', 'user-scrolling', 'touch-scrolling', 'wheel-scrolling');
    this.isUserControllingScroll = false;

    // Ensure no stale song info remains while loading
    const staleInfo = document.querySelector('.lyrics-song-info');
    if (staleInfo) staleInfo.remove();

    // Add scale-out animation to loading text before removing it
    const loadingElement = container.querySelector('.text-loading');
    if (loadingElement && container.classList.contains('lyrics-plus-message')) {
      loadingElement.classList.add('scale-out');
      // Wait for animation to complete before removing the message class and displaying lyrics
      setTimeout(() => {
        container.classList.remove('lyrics-plus-message');
        this._renderLyricsContent(lyrics, source, type, lightweight, songWriters, songInfo, displayMode, currentSettings, fetchAndDisplayLyricsFn, setCurrentDisplayModeAndRefetchFn, largerTextMode);
      }, 400); // Match the CSS transition duration
      return;
    }

    container.classList.remove('lyrics-plus-message'); // Remove the class when actual lyrics are displayed
    this._renderLyricsContent(lyrics, source, type, lightweight, songWriters, songInfo, displayMode, currentSettings, fetchAndDisplayLyricsFn, setCurrentDisplayModeAndRefetchFn, largerTextMode);

    // Re-assert visual effect classes based on current settings after render
    container.classList.toggle('blur-inactive-enabled', !!currentSettings.blurInactive);
    const isVideoFullscreenPost = this._isVideoFullscreen?.() ?? this.__detectVideoFullscreen();
    container.classList.toggle('fade-past-lines', !!currentSettings.fadePastLines && !isVideoFullscreenPost);

    // Nudge programmatic scrolling state briefly so fade/blur logic reliably activates after song change
    this.lyricsContainer && this.lyricsContainer.classList.remove('not-focused', 'user-scrolling', 'touch-scrolling', 'wheel-scrolling');
    clearTimeout(this.endProgrammaticScrollTimer);
    this.isProgrammaticScrolling = true;
    this.endProgrammaticScrollTimer = setTimeout(() => {
      this.isProgrammaticScrolling = false;
      this.endProgrammaticScrollTimer = null;
    }, 300);
  }

  /**
   * Helper method to render the actual lyrics content
   * @private
   */
  _renderLyricsContent(lyrics, source, type, lightweight, songWriters, songInfo, displayMode, currentSettings, fetchAndDisplayLyricsFn, setCurrentDisplayModeAndRefetchFn, largerTextMode) {
    const container = this._getContainer();
    if (!container) return;

    // Apply visual settings that are independent of display mode
    container.classList.toggle('use-song-palette-fullscreen', !!currentSettings.useSongPaletteFullscreen);
    container.classList.toggle('use-song-palette-all-modes', !!currentSettings.useSongPaletteAllModes);
    const isVideoFullscreen = this._isVideoFullscreen?.() ?? this.__detectVideoFullscreen();
    container.classList.toggle('fade-past-lines', !!currentSettings.fadePastLines && !isVideoFullscreen);
    this._setupPlayerStateObserver?.(currentSettings);

    if (currentSettings.overridePaletteColor) {
      container.classList.add('override-palette-color');
      container.style.setProperty('--lyplus-override-pallete', currentSettings.overridePaletteColor);
      container.style.setProperty('--lyplus-override-pallete-white', `${currentSettings.overridePaletteColor}85`);
      container.classList.remove('use-song-palette-fullscreen', 'use-song-palette-all-modes');
    } else {
      container.classList.remove('override-palette-color');
      if (currentSettings.useSongPaletteFullscreen || currentSettings.useSongPaletteAllModes) {
        if (typeof LYPLUS_getSongPalette === 'function') {
          const songPalette = LYPLUS_getSongPalette();
          if (songPalette) {
            const { r, g, b } = songPalette;
            container.style.setProperty('--lyplus-song-pallete', `rgb(${r}, ${g}, ${b})`);
            const alpha = 133 / 255;
            const r_blend = Math.round(alpha * 255 + (1 - alpha) * r);
            const g_blend = Math.round(alpha * 255 + (1 - alpha) * b);
            const b_blend = Math.round(alpha * 255 + (1 - alpha) * b);
            container.style.setProperty('--lyplus-song-white-pallete', `rgb(${r_blend}, ${g_blend}, ${b_blend})`);
          }
        }
      }
    }

    const playerPageElement = document.querySelector('ytmusic-player-page');
    container.classList.toggle('fullscreen', playerPageElement && playerPageElement.hasAttribute('player-fullscreened'));
    // Prefer word-by-word mode in video fullscreen for better karaoke-style experience
    let isWordByWordMode = (type === "Word" && currentSettings.wordByWord);
    if (this._isVideoFullscreen?.() ?? this.__detectVideoFullscreen()) {
      isWordByWordMode = true;
    }
    container.classList.toggle('word-by-word-mode', isWordByWordMode);
    container.classList.toggle('line-by-line-mode', !isWordByWordMode);
    container.classList.toggle('romanized-big-mode', this.largerTextMode === "romanization");

    // Call the new updateDisplayMode to handle the actual rendering of lyrics lines
    this.updateDisplayMode(lyrics, displayMode, currentSettings);

    // Add song information display in fullscreen mode
    const playerPageForDisplay = document.querySelector('ytmusic-player-page');
    const isFullscreen = playerPageForDisplay && playerPageForDisplay.hasAttribute('player-fullscreened');
    console.log('LYPLUS: DisplayLyrics fullscreen check - playerPage:', !!playerPageForDisplay, 'isFullscreen:', isFullscreen, 'hasSongInfo:', !!songInfo);
    if (isFullscreen && songInfo) {
      this._addSongInfoDisplay(container);
    }
    
    // Also add song info display when not in fullscreen initially (for when user goes fullscreen later)
    if (songInfo) {
      this._addSongInfoDisplay(container);
    }
    
    // Set up fullscreen change listener
    this._setupFullscreenListener();

    // Create control buttons (only once)
    this._createControlButtons();
    container.classList.toggle('blur-inactive-enabled', !!currentSettings.blurInactive);
    
    // Show refresh button and translation button when lyrics are successfully displayed
    if (this.reloadButton) {
      this.reloadButton.style.display = '';
    }
    if (this.translationButton) {
      this.translationButton.style.display = '';
    }
  }

  // Detect if YT Music is currently in video fullscreen mode
  __detectVideoFullscreen() {
    try {
      const page = document.querySelector('ytmusic-player-page');
      return !!(page && page.hasAttribute('video-mode') && page.hasAttribute('player-fullscreened'));
    } catch (_) {
      return false;
    }
  }

  _isVideoFullscreen() {
    return this.__detectVideoFullscreen();
  }

  _setupPlayerStateObserver(currentSettings) {
    const page = document.querySelector('ytmusic-player-page');
    const container = this._getContainer();
    if (!page || !container) return;

    if (this._playerStateObserver) {
      try { this._playerStateObserver.disconnect(); } catch (_) {}
    }

    this._playerStateObserver = new MutationObserver(() => {
      const isVideoFullscreen = this._isVideoFullscreen();
      const shouldEnableFade = !!currentSettings?.fadePastLines && !isVideoFullscreen;
      container.classList.toggle('fade-past-lines', shouldEnableFade);

      // Handle not-found auto-hide behavior on fullscreen transitions
      const isNotFoundState = container.classList.contains('lyrics-plus-message') && !!container.querySelector('.text-not-found');
      const notFoundMsg = container.querySelector('.text-not-found');

      // Exiting fullscreen: ensure not-found text is visible again
      if (!isVideoFullscreen) {
        if (this._notFoundAutoHideTimer) {
          clearTimeout(this._notFoundAutoHideTimer);
          this._notFoundAutoHideTimer = null;
        }
        if (notFoundMsg) notFoundMsg.classList.remove('auto-hide');
        return;
      }

      // Entering fullscreen video with not-found state: schedule fade-out if not already scheduled/applied
      if (isVideoFullscreen && isNotFoundState && notFoundMsg && !notFoundMsg.classList.contains('auto-hide') && !this._notFoundAutoHideTimer) {
        this._notFoundAutoHideTimer = setTimeout(() => {
          const c = this._getContainer();
          const msg = c?.querySelector?.('.text-not-found');
          if (c && c.classList.contains('lyrics-plus-message') && msg) {
            msg.classList.add('auto-hide');
          }
          this._notFoundAutoHideTimer = null;
        }, 2000);
      }
    });
    this._playerStateObserver.observe(page, { attributes: true });
  }

  /**
   * Removes 'past' class from all lyrics lines to prevent fade out during user scroll
   * @private
   */
  _removePastClassFromAllLines() {
    if (!this.lyricsContainer) return;
    const lines = this.lyricsContainer.querySelectorAll('.lyrics-line');
    lines.forEach(line => {
      line.classList.remove('past');
    });
  }

  /**
   * Displays a "not found" message in the lyrics container.
   */
  displaySongNotFound() {
    const container = this._getContainer();
    if (container) {
      // Clear any pending not-found center timers
      if (this._notFoundCenterTimer) {
        clearTimeout(this._notFoundCenterTimer);
        this._notFoundCenterTimer = null;
      }
      // Clear any pending auto-hide timers
      if (this._notFoundAutoHideTimer) {
        clearTimeout(this._notFoundAutoHideTimer);
        this._notFoundAutoHideTimer = null;
      }
      // Fully reset internal state to avoid any stale lyrics lingering
      this.cleanupLyrics();
      // Also remove any leftover song-info overlay tied to previous track
      const existingSongInfo = document.querySelector('.lyrics-song-info');
      if (existingSongInfo) existingSongInfo.remove();
      if (this._cleanupArtworkObservers) {
        this._cleanupArtworkObservers();
        this._cleanupArtworkObservers = null;
      }
      const refreshedContainer = this._getContainer();
      if (refreshedContainer) {
        refreshedContainer.innerHTML = `<span class="text-not-found">${t("notFound")}</span>`;
        refreshedContainer.classList.add('lyrics-plus-message');
        // Ensure the animated class is reset before scheduling
        refreshedContainer.classList.remove('animate-not-found-center');
        // Ensure player observer is active so we respond to fullscreen toggles
        try { this._setupPlayerStateObserver?.({}); } catch (_) {}
        // After a short delay, trigger the center animation and fade-out the message
        this._notFoundCenterTimer = setTimeout(() => {
          const latestContainer = this._getContainer();
          if (latestContainer && latestContainer.classList.contains('lyrics-plus-message')) {
            latestContainer.classList.add('animate-not-found-center');
          }
          this._notFoundCenterTimer = null;
        }, 2000);

        // Check initial state: if already in fullscreen video, schedule auto-hide
        try {
          const page = document.querySelector('ytmusic-player-page');
          const isFullscreenVideo = !!(page && page.hasAttribute('video-mode') && page.hasAttribute('player-fullscreened'));
          if (isFullscreenVideo && !this._notFoundAutoHideTimer) {
            this._notFoundAutoHideTimer = setTimeout(() => {
              const c = this._getContainer();
              const msg = c?.querySelector?.('.text-not-found');
              if (c && c.classList.contains('lyrics-plus-message') && msg) {
                msg.classList.add('auto-hide');
              }
              this._notFoundAutoHideTimer = null;
            }, 2000);
          }
        } catch (_) {}
      }
      
      // Try to get song info from DOM and display it even when lyrics not found
      // Add a small delay to ensure DOM is ready
      setTimeout(() => {
        this._addSongInfoFromDOM();
      }, 100);
      
      // Keep refresh button and translation button hidden when lyrics not found
      if (this.reloadButton) {
        this.reloadButton.style.display = 'none';
      }
      if (this.translationButton) {
        this.translationButton.style.display = 'none';
      }
    }
  }

  /**
   * Displays an error message in the lyrics container.
   */
  displaySongError() {
    const container = this._getContainer();
    if (container) {
      if (this._notFoundAutoHideTimer) {
        clearTimeout(this._notFoundAutoHideTimer);
        this._notFoundAutoHideTimer = null;
      }
      if (this._notFoundCenterTimer) {
        clearTimeout(this._notFoundCenterTimer);
        this._notFoundCenterTimer = null;
      }
      container.classList.remove('animate-not-found-center');
      container.innerHTML = `<span class="text-not-found">${t("notFoundError")}</span>`;
      container.classList.add('lyrics-plus-message');
      
      // Try to get song info from DOM and display it even when there's an error
      // Add a small delay to ensure DOM is ready
      setTimeout(() => {
        this._addSongInfoFromDOM();
      }, 100);
      
      // Hide refresh button and translation button when there's an error
      if (this.reloadButton) {
        this.reloadButton.style.display = 'none';
      }
      if (this.translationButton) {
        this.translationButton.style.display = 'none';
      }
    }
  }

  // --- Text, Style, and ID Utilities ---

  _getTextWidth(text, font) {
    const canvas = this.textWidthCanvas || (this.textWidthCanvas = document.createElement("canvas"));
    const context = canvas.getContext("2d");
    context.font = font;
    return context.measureText(text).width;
  }

  _ensureElementIds() {
    if (!this.cachedLyricsLines || !this.cachedSyllables) return;
    this.cachedLyricsLines.forEach((line, i) => { if (line && !line.id) line.id = `line-${i}`; });
    this.cachedSyllables.forEach((syllable, i) => { if (syllable && !syllable.id) syllable.id = `syllable-${i}`; });
  }

  // --- Lyrics Synchronization & Highlighting ---

  /**
   * Starts the synchronization loop for highlighting lyrics based on video time.
   * @param {object} currentSettings - The current user settings.
   * @returns {Function} - A cleanup function to stop the sync.
   */
  _startLyricsSync(currentSettings = {}) {
    const videoElement = document.querySelector('video');
    if (!videoElement) return () => { };
    this._ensureElementIds();
    if (this.visibilityObserver) this.visibilityObserver.disconnect();
    this.visibilityObserver = this._setupVisibilityTracking();

    if (this.lyricsAnimationFrameId) {
      cancelAnimationFrame(this.lyricsAnimationFrameId);
    }
    this.lastTime = videoElement.currentTime * 1000;

    const sync = () => {
      const currentTime = videoElement.currentTime * 1000;
      const isForceScroll = Math.abs(currentTime - this.lastTime) > 1000;
      this._updateLyricsHighlight(currentTime, isForceScroll, currentSettings);
      this.lastTime = currentTime;
      this.lyricsAnimationFrameId = requestAnimationFrame(sync);
    };
    this.lyricsAnimationFrameId = requestAnimationFrame(sync);

    this._setupResizeObserver();

    return () => {
      if (this.visibilityObserver) this.visibilityObserver.disconnect();
      if (this.resizeObserver) this.resizeObserver.disconnect();
      if (this.lyricsAnimationFrameId) {
        cancelAnimationFrame(this.lyricsAnimationFrameId);
        this.lyricsAnimationFrameId = null;
      }
    };
  }

  /**
 * Updates the highlighted lyrics and syllables based on the current time.
 * @param {number} currentTime - The current video time in milliseconds.
 * @param {boolean} isForceScroll - Whether to force a scroll update.
 * @param {object} currentSettings - The current user settings.
 */
  _updateLyricsHighlight(currentTime, isForceScroll = false, currentSettings = {}) {
    // Guard clause: Do nothing if lyrics aren't loaded.
    if (!this.cachedLyricsLines || this.cachedLyricsLines.length === 0) {
      return;
    }

    // Constants for predictive timing.
    const scrollLookAheadMs = 300;
    const highlightLookAheadMs = 190;

    // --- 1. SCROLLING LOGIC (Optimized) ---
    // Cache visible lines array, but invalidate when visibility actually changes
    let visibleLines = this._cachedVisibleLines;
    const currentVisibilityHash = Array.from(this.visibleLineIds).sort().join(',');

    if (!visibleLines || this._lastVisibilityHash !== currentVisibilityHash) {
      visibleLines = this.cachedLyricsLines.filter(line => this.visibleLineIds.has(line.id));
      this._cachedVisibleLines = visibleLines;
      this._lastVisibilityHash = currentVisibilityHash;
    }

    const predictiveTime = currentTime + scrollLookAheadMs;
    let lineToScroll = null;

    // Optimized active line finding - break early when possible
    const currentlyActiveAndPredictiveLines = [];
    for (let i = 0; i < this.cachedLyricsLines.length; i++) {
      const line = this.cachedLyricsLines[i];
      if (line && predictiveTime >= line._startTimeMs && predictiveTime < line._endTimeMs) {
        currentlyActiveAndPredictiveLines.push(line);
      }
    }

    if (currentlyActiveAndPredictiveLines.length > 0) {
      // Find earliest starting line more efficiently
      lineToScroll = currentlyActiveAndPredictiveLines[0];
      for (let i = 1; i < currentlyActiveAndPredictiveLines.length; i++) {
        if (currentlyActiveAndPredictiveLines[i]._startTimeMs < lineToScroll._startTimeMs) {
          lineToScroll = currentlyActiveAndPredictiveLines[i];
        }
      }
    } else {
      // Optimized fallback - iterate backwards for most recent
      const lookAheadTime = currentTime - scrollLookAheadMs;
      for (let i = this.cachedLyricsLines.length - 1; i >= 0; i--) {
        const line = this.cachedLyricsLines[i];
        if (line && lookAheadTime >= line._startTimeMs) {
          lineToScroll = line;
          break;
        }
      }
    }

    // Fallback: If song hasn't started, prepare to scroll to the first line.
    if (!lineToScroll && this.cachedLyricsLines.length > 0) {
      lineToScroll = this.cachedLyricsLines[0];
    }

    // --- 2. HIGHLIGHTING LOGIC (Optimized) ---
    const highlightTime = currentTime - highlightLookAheadMs;
    const activeLinesForHighlighting = [];

    // Only check visible lines and limit to 3 results
    for (let i = 0; i < visibleLines.length && activeLinesForHighlighting.length < 3; i++) {
      const line = visibleLines[i];
      if (line && currentTime >= line._startTimeMs - highlightLookAheadMs && currentTime <= line._endTimeMs - highlightLookAheadMs) {
        activeLinesForHighlighting.push(line);
      }
    }

    // Sort by start time (descending) - only if we have multiple lines
    if (activeLinesForHighlighting.length > 1) {
      activeLinesForHighlighting.sort((a, b) => b._startTimeMs - a._startTimeMs);
    }

    const newActiveLineIds = new Set();
    for (let i = 0; i < activeLinesForHighlighting.length; i++) {
      newActiveLineIds.add(activeLinesForHighlighting[i].id);
    }

    // --- 3. DOM & STATE UPDATES (Optimized) ---
    // Trigger scroll if needed
    if (lineToScroll && (lineToScroll !== this.currentPrimaryActiveLine || isForceScroll)) {
      if (!this.isUserControllingScroll || isForceScroll) {
        this._updatePositionClassesAndScroll(lineToScroll, isForceScroll);
        this.lastPrimaryActiveLine = this.currentPrimaryActiveLine;
        this.currentPrimaryActiveLine = lineToScroll;
      }
    }

    // --- OPTIMIZATION: Batch DOM updates for visible lines ---
    const activeLineIdsArray = Array.from(this.activeLineIds);
    const newActiveLineIdsArray = Array.from(newActiveLineIds);

    // Process lines that need to be deactivated
    for (let i = 0; i < activeLineIdsArray.length; i++) {
      const lineId = activeLineIdsArray[i];
      if (!newActiveLineIds.has(lineId)) {
        const line = document.getElementById(lineId);
        if (line) {
          line.classList.remove('active');
          this._resetSyllables(line);
          // Only add 'past' class during programmatic scrolling (auto scroll), not user scroll
          if (this.lyricsContainer && this.lyricsContainer.classList.contains('fade-past-lines') && this.isProgrammaticScrolling) {
            line.classList.add('past');
          }
        }
      }
    }

    // Process lines that need to be activated
    for (let i = 0; i < newActiveLineIdsArray.length; i++) {
      const lineId = newActiveLineIdsArray[i];
      if (!this.activeLineIds.has(lineId)) {
        const line = document.getElementById(lineId);
        if (line) {
          line.classList.add('active');
          // Ensure newly active line is not treated as past
          if (line.classList.contains('past')) line.classList.remove('past');
        }
      }
    }

    this.activeLineIds = newActiveLineIds;

    const mostRecentActiveLine = activeLinesForHighlighting.length > 0 ? activeLinesForHighlighting[0] : null;
    if (this.currentFullscreenFocusedLine !== mostRecentActiveLine) {
      if (this.currentFullscreenFocusedLine) {
        this.currentFullscreenFocusedLine.classList.remove('fullscreen-focused');
      }
      if (mostRecentActiveLine) {
        mostRecentActiveLine.classList.add('fullscreen-focused');
      }
      this.currentFullscreenFocusedLine = mostRecentActiveLine;
    }

    this._updateSyllables(currentTime);

    // Hide offscreen functionality removed - causes issues in fullscreen mode
    // Batch viewport-hidden class updates if needed
    // if (this.lyricsContainer && this.lyricsContainer.classList.contains('hide-offscreen')) {
    //   // Only update if visibility has changed
    //   if (this._lastVisibilityUpdateSize !== this.visibleLineIds.size) {
    //     for (let i = 0; i < this.cachedLyricsLines.length; i++) {
    //       const line = this.cachedLyricsLines[i];
    //       if (line) {
    //         const isOutOfView = !this.visibleLineIds.has(line.id);
    //         line.classList.toggle('viewport-hidden', isOutOfView);
    //       }
    //     }
    //     this._lastVisibilityUpdateSize = this.visibleLineIds.size;
    //   }
    // }

    // Apply fade-out class to past lines when enabled - ONLY during programmatic scrolling (auto scroll)
    if (this.lyricsContainer && this.lyricsContainer.classList.contains('fade-past-lines') && this.isProgrammaticScrolling) {
      const elements = this.cachedLyricsLines;
      const graceMs = 180; // small grace for smoother feel
      for (let i = 0; i < elements.length; i++) {
        const line = elements[i];
        if (!line || typeof line._endTimeMs !== 'number') continue;
        const becamePast = currentTime > line._endTimeMs; // immediate past detection to avoid collapse
        const stablePast = currentTime > (line._endTimeMs + graceMs); // for stable fade state
        const isActive = this.activeLineIds.has(line.id);

        if (isActive) {
          if (line.classList.contains('past')) line.classList.remove('past');
          continue;
        }

        // Mark as past immediately after end to prevent background vocal collapse
        if (becamePast) {
          line.classList.add('past');
          continue;
        }

        // If rewound significantly before the line start, clear past
        if (currentTime < (line._startTimeMs - 50) && line.classList.contains('past')) {
          line.classList.remove('past');
        }
      }
    }
  }

  _updateSyllables(currentTime) {
    if (!this.activeLineIds.size) return;

    const newHighlightedSyllableIds = new Set();

    // Convert Set to Array once for iteration
    const activeLineIdsArray = Array.from(this.activeLineIds);

    for (let i = 0; i < activeLineIdsArray.length; i++) {
      const lineId = activeLineIdsArray[i];
      const parentLine = document.getElementById(lineId);
      if (!parentLine) continue;

      // Cache syllables query result - use cached if available
      let syllables = parentLine._cachedSyllableElements;
      if (!syllables) {
        syllables = parentLine.querySelectorAll('.lyrics-syllable');
        parentLine._cachedSyllableElements = syllables; // Cache for next time
      }

      for (let j = 0; j < syllables.length; j++) {
        const syllable = syllables[j];
        if (!syllable || typeof syllable._startTimeMs !== 'number' || typeof syllable._endTimeMs !== 'number') continue;

        const startTime = syllable._startTimeMs;
        const endTime = syllable._endTimeMs;
        const classList = syllable.classList;
        const hasHighlight = classList.contains('highlight');
        const hasFinished = classList.contains('finished');

        if (currentTime >= startTime && currentTime <= endTime) {
          newHighlightedSyllableIds.add(syllable.id);
          if (!hasHighlight) {
            this._updateSyllableAnimation(syllable, currentTime);
          }
        } else if (currentTime < startTime && hasHighlight) {
          this._resetSyllable(syllable);
        } else if (currentTime > startTime) {
          if (!hasFinished) {
            classList.add('finished');
          } else if (!hasHighlight) {
            this._updateSyllableAnimation(syllable, startTime);
          }
        }
      }
    }

    this.highlightedSyllableIds = newHighlightedSyllableIds;
  }


  _updateSyllableAnimation(syllable, currentTime) {
    if (syllable.classList.contains('highlight')) return;

    const classList = syllable.classList;
    const isRTL = classList.contains('rtl-text');
    const charSpans = syllable._cachedCharSpans;
    const wordElement = syllable.parentElement;
    const allWordCharSpans = wordElement?._cachedChars;
    const isGrowable = wordElement?.classList.contains('growable');
    const isFirstSyllable = syllable.dataset.syllableIndex === '0';
    const isGap = syllable.parentElement?.parentElement?.parentElement?.classList.contains('lyrics-gap');
    const nextSyllable = syllable._nextSyllableInWord;

    const pendingStyleUpdates = [];
    const charAnimationsMap = new Map();
    const wipeAnimation = isRTL ? 'wipe-rtl' : 'wipe';

    if (isGrowable && isFirstSyllable && allWordCharSpans) {
      const spansToAnimate = allWordCharSpans;
      const finalDuration = syllable._wordDurationMs ?? syllable._durationMs;
      const baseDelayPerChar = finalDuration * 0.09;
      const growDurationMs = finalDuration * 1.5;

      spansToAnimate.forEach(span => {
        const horizontalOffset = parseFloat(span.dataset.horizontalOffset) || 0;
        const growDelay = baseDelayPerChar * (parseFloat(span.dataset.syllableCharIndex) || 0);
        charAnimationsMap.set(span, `grow-dynamic ${growDurationMs}ms ease-in-out ${growDelay}ms forwards`);
        pendingStyleUpdates.push({
          element: span,
          property: '--char-offset-x',
          value: `${horizontalOffset}`
        });
      });
    }

    if (charSpans && charSpans.length > 0) {
      const syllableDuration = syllable._durationMs;

      charSpans.forEach((span, charIndex) => {
        const wipeDelay = syllableDuration * (parseFloat(span.dataset.wipeStart) || 0);
        const wipeDuration = syllableDuration * (parseFloat(span.dataset.wipeDuration) || 0);

        const existingAnimation = charAnimationsMap.get(span) || span.style.animation;
        const animationParts = [];

        if (existingAnimation && existingAnimation.includes('grow-dynamic')) {
          animationParts.push(existingAnimation.split(',')[0].trim());
        }

        if (charIndex > 0) {
          const prevChar = charSpans[charIndex - 1];
          const prevWipeDelay = syllableDuration * (parseFloat(prevChar.dataset.wipeStart) || 0);
          const prevWipeDuration = syllableDuration * (parseFloat(prevChar.dataset.wipeDuration) || 0);

          if (prevWipeDuration > 0) {
            animationParts.push(
              `pre-wipe-char ${prevWipeDuration}ms linear ${prevWipeDelay}ms`
            );
          }
        }

        if (wipeDuration > 0) {
          animationParts.push(
            `${wipeAnimation} ${wipeDuration}ms linear ${wipeDelay}ms forwards`
          );
        }

        charAnimationsMap.set(span, animationParts.join(', '));
      });
    } else {
      const currentWipeAnimation = isGap ? "fade-gap" : wipeAnimation;
      const syllableAnimation = `${currentWipeAnimation} ${syllable._durationMs}ms linear forwards`;
      pendingStyleUpdates.push({
        element: syllable,
        property: 'animation',
        value: syllableAnimation
      });
    }

    if (nextSyllable) {
      const preHighlightDuration = syllable._preHighlightDurationMs;
      const preHighlightDelay = syllable._preHighlightDelayMs;

      pendingStyleUpdates.push({
        element: nextSyllable,
        property: 'class',
        action: 'add',
        value: 'pre-highlight'
      });
      pendingStyleUpdates.push({
        element: nextSyllable,
        property: '--pre-wipe-duration',
        value: `${preHighlightDuration}ms`
      });
      pendingStyleUpdates.push({
        element: nextSyllable,
        property: '--pre-wipe-delay',
        value: `${preHighlightDelay}ms`
      });

      const nextCharSpan = nextSyllable._cachedCharSpans?.[0];
      if (nextCharSpan) {
        const preWipeAnim = `pre-wipe-char ${preHighlightDuration}ms linear ${preHighlightDelay}ms forwards`;
        const existingAnimation = charAnimationsMap.get(nextCharSpan) || nextCharSpan.style.animation || '';
        const combinedAnimation = existingAnimation && !existingAnimation.includes('pre-wipe-char')
          ? `${existingAnimation}, ${preWipeAnim}`
          : preWipeAnim;
        charAnimationsMap.set(nextCharSpan, combinedAnimation);
      }
    }

    classList.remove('pre-highlight');
    classList.add('highlight');

    for (const [span, animationString] of charAnimationsMap.entries()) {
      span.style.animation = animationString;
    }

    for (const update of pendingStyleUpdates) {
      if (update.action === 'add') {
        update.element.classList.add(update.value);
      } else if (update.property === 'animation') {
        update.element.style.animation = update.value;
      } else {
        update.element.style.setProperty(update.property, update.value);
      }
    }
  }

  _resetSyllable(syllable) {
    if (!syllable) return;
    syllable.style.animation = '';
    if(!syllable.classList.contains('finished')){
      syllable.classList.add("finished")
      syllable.offsetHeight;
    }
    syllable.classList.remove('highlight', 'finished', 'pre-highlight');
    syllable.style.removeProperty('--pre-wipe-duration');
    syllable.style.removeProperty('--pre-wipe-delay');
    syllable.querySelectorAll('span.char').forEach(span => { span.style.animation = ''; });
  }

  _resetSyllables(line) {
    if (!line) return;
    Array.from(line.getElementsByClassName('lyrics-syllable')).forEach(this._resetSyllable);
  }

  // --- Scrolling Logic ---

  _getScrollPaddingTop() {
    const selectors = [
      'ytmusic-tab-renderer:has(#lyrics-plus-container[style*="display: block"])',
      'ytmusic-app-layout[is-mweb-modernization-enabled] ytmusic-tab-renderer:has(#lyrics-plus-container[style*="display: block"])',
      'ytmusic-player-page:not([is-video-truncation-fix-enabled])[player-fullscreened] ytmusic-tab-renderer:has(#lyrics-plus-container[style*="display: block"])'
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        const style = window.getComputedStyle(element);
        const paddingTopValue = style.getPropertyValue('--lyrics-scroll-padding-top') || '25%';
        return paddingTopValue.includes('%') ? element.getBoundingClientRect().height * (parseFloat(paddingTopValue) / 100) : (parseFloat(paddingTopValue) || 0);
      }
    }
    const container = document.querySelector("#lyrics-plus-container")?.parentElement;
    return container ? (parseFloat(window.getComputedStyle(container).getPropertyValue('scroll-padding-top')) || 0) : 0;
  }

  /**
   * Applies the new scroll position with a robust buffer logic.
   * Animation delay is applied to a window of approximately two screen heights
   * starting from the first visible line, guaranteeing smooth transitions for
   * lines scrolling into view.
   *
   * @param {number} newTranslateY - The target Y-axis translation value in pixels.
   * @param {boolean} forceScroll - If true, all animation delays are ignored for instant movement.
   */
  _animateScroll(newTranslateY, forceScroll = false) {
    if (!this.lyricsContainer) return;

    // Early exit if position hasn't changed and not forced
    if (!forceScroll && this.currentScrollOffset === newTranslateY) return;

    // Set the primary scroll offset for the entire container.
    this.currentScrollOffset = newTranslateY;
    this.lyricsContainer.style.setProperty('--lyrics-scroll-offset', `${newTranslateY}px`);

    // Cache container classes check
    const isUserScrolling = this.lyricsContainer.classList.contains('user-scrolling');

    // If this is a forced jump (seek/click) or a user-driven scroll,
    // make all line animations instant and exit early.
    if (forceScroll || isUserScrolling) {
      // Batch update all delays to 0ms
      const elements = this.cachedLyricsLines;
      for (let i = 0; i < elements.length; i++) {
        if (elements[i]) {
          elements[i].style.setProperty('--lyrics-line-delay', '0ms');
        }
      }
      return;
    }

    // Cache reference line calculations
    const referenceLine = this.currentPrimaryActiveLine || this.lastPrimaryActiveLine ||
      (this.cachedLyricsLines.length > 0 ? this.cachedLyricsLines[0] : null);

    if (!referenceLine) return;

    const referenceLineIndex = this.cachedLyricsLines.indexOf(referenceLine);
    if (referenceLineIndex === -1) return;

    // Constants
    const delayIncrement = 30; // 30ms stagger per line
    let delayCounter = 0;

    // Batch DOM updates for better performance
    const elements = this.cachedLyricsLines;
    const visibleIds = this.visibleLineIds; // Cache reference

    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      if (!element) continue;

      // Check visibility using cached Set
      if (visibleIds.has(element.id)) {
        // Apply staggered delay only from reference line position onwards
        const delay = (i >= referenceLineIndex) ? delayCounter * delayIncrement : 0;
        element.style.setProperty('--lyrics-line-delay', `${delay}ms`);
        if (i >= referenceLineIndex) {
          delayCounter++;
        }
      } else {
        // Elements outside viewport move instantly
        element.style.setProperty('--lyrics-line-delay', '0ms');
      }
    }
  }

  _updatePositionClassesAndScroll(lineToScroll, forceScroll = false) {
    if (!this.lyricsContainer || !this.cachedLyricsLines || this.cachedLyricsLines.length === 0) return;
    const scrollLineIndex = this.cachedLyricsLines.indexOf(lineToScroll);
    if (scrollLineIndex === -1) return;

    const positionClasses = ['lyrics-activest', 'pre-active-line', 'next-active-line', 'prev-1', 'prev-2', 'prev-3', 'prev-4', 'next-1', 'next-2', 'next-3', 'next-4'];
    this.lyricsContainer.querySelectorAll('.' + positionClasses.join(', .')).forEach(el => el.classList.remove(...positionClasses));

    lineToScroll.classList.add('lyrics-activest');
    const elements = this.cachedLyricsLines; // Renamed for clarity, as it now includes metadata/empty divs
    for (let i = Math.max(0, scrollLineIndex - 4); i <= Math.min(elements.length - 1, scrollLineIndex + 4); i++) {
      const position = i - scrollLineIndex;
      if (position === 0) continue;
      const element = elements[i];
      if (position === -1) element.classList.add('pre-active-line');
      else if (position === 1) element.classList.add('next-active-line');
      else if (position < 0) element.classList.add(`prev-${Math.abs(position)}`);
      else element.classList.add(`next-${position}`);
    }

    this._scrollToActiveLine(lineToScroll, forceScroll);
  }

  _scrollToActiveLine(activeLine, forceScroll = false) {
    if (!activeLine || !this.lyricsContainer || getComputedStyle(this.lyricsContainer).display !== 'block') return;
    const scrollContainer = this.lyricsContainer.parentElement;
    if (!scrollContainer) return;

    const paddingTop = this._getScrollPaddingTop();
    const targetTranslateY = paddingTop - activeLine.offsetTop;

    // Use cached values if available, otherwise get them
    const containerTop = this._cachedContainerRect ? this._cachedContainerRect.containerTop : this.lyricsContainer.getBoundingClientRect().top;
    const scrollContainerTop = this._cachedContainerRect ? this._cachedContainerRect.scrollContainerTop : scrollContainer.getBoundingClientRect().top;

    if (!forceScroll && Math.abs((activeLine.getBoundingClientRect().top - scrollContainerTop) - paddingTop) < 5) {
      return;
    }
    // Clear the cache after using it, so it's re-calculated on next resize or forced scroll
    this._cachedContainerRect = null;

    this.lyricsContainer.classList.remove('not-focused', 'user-scrolling');
    this.isProgrammaticScrolling = true;
    this.isUserControllingScroll = false;
    clearTimeout(this.endProgrammaticScrollTimer);
    clearTimeout(this.userScrollIdleTimer);
    this.endProgrammaticScrollTimer = setTimeout(() => {
      this.isProgrammaticScrolling = false;
      this.endProgrammaticScrollTimer = null;
    }, 250);

    this._animateScroll(targetTranslateY);
  }

  // --- Visibility Tracking ---

  _setupVisibilityTracking() {
    const container = this._getContainer();
    if (!container || !container.parentElement) return null;
    if (this.visibilityObserver) this.visibilityObserver.disconnect();
    this.visibilityObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          const id = entry.target.id;
          if (entry.isIntersecting) this.visibleLineIds.add(id);
          else this.visibleLineIds.delete(id);
        });
      }, { root: container.parentElement, rootMargin: '200px 0px', threshold: 0.1 }
    );
    if (this.cachedLyricsLines) {
      this.cachedLyricsLines.forEach(line => {
        if (line) this.visibilityObserver.observe(line);
      });
    }
    return this.visibilityObserver;
  }

  _setupResizeObserver() {
    const container = this._getContainer();
    if (!container) return null;
    if (this.resizeObserver) this.resizeObserver.disconnect();

    this.resizeObserver = new ResizeObserver(entries => {
      for (let entry of entries) {
        if (entry.target === container) {
          // Call the debounced handler
          this._debouncedResizeHandler(container);
        }
      }
    });
    this.resizeObserver.observe(container);
    return this.resizeObserver;
  }

  // --- Control Buttons & UI ---

  _createControlButtons() {
    let buttonsWrapper = document.getElementById('lyrics-plus-buttons-wrapper');
    if (!buttonsWrapper) {
      buttonsWrapper = document.createElement('div');
      buttonsWrapper.id = 'lyrics-plus-buttons-wrapper';
      const originalLyricsSection = document.querySelector('#tab-renderer');
      if (originalLyricsSection) {
        originalLyricsSection.appendChild(buttonsWrapper);
      }
    }

    if (this.setCurrentDisplayModeAndRefetchFn) {
      if (!this.translationButton) {
        this.translationButton = document.createElement('button');
        this.translationButton.id = 'lyrics-plus-translate-button';
        buttonsWrapper.appendChild(this.translationButton);
        this._updateTranslationButtonText();
        this.translationButton.addEventListener('click', (event) => {
          event.stopPropagation();
          this._createDropdownMenu(buttonsWrapper);
          if (this.dropdownMenu) this.dropdownMenu.classList.toggle('hidden');
        });
        document.addEventListener('click', (event) => {
          if (this.dropdownMenu && !this.dropdownMenu.classList.contains('hidden') && !this.dropdownMenu.contains(event.target) && event.target !== this.translationButton) {
            this.dropdownMenu.classList.add('hidden');
          }
        });
      }
    }

    if (!this.reloadButton) {
      this.reloadButton = document.createElement('button');
      this.reloadButton.id = 'lyrics-plus-reload-button';
      this.reloadButton.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" fill="currentColor"/>
      </svg>`;
      this.reloadButton.title = t('refreshLyrics');
      buttonsWrapper.appendChild(this.reloadButton);
      this.reloadButton.addEventListener('click', () => {
        if (this.lastKnownSongInfo && this.fetchAndDisplayLyricsFn) {
          this.fetchAndDisplayLyricsFn(this.lastKnownSongInfo, true, true);
        }
      });
    }
  }

  _createDropdownMenu(parentWrapper) {
    if (this.dropdownMenu) {
      this.dropdownMenu.innerHTML = '';
    } else {
      this.dropdownMenu = document.createElement('div');
      this.dropdownMenu.id = 'lyrics-plus-translation-dropdown';
      this.dropdownMenu.classList.add('hidden');
      parentWrapper?.appendChild(this.dropdownMenu);
    }

    if (typeof this.currentDisplayMode === 'undefined') return;

    // Show options that are NOT currently active
    const hasTranslation = (this.currentDisplayMode === 'translate' || this.currentDisplayMode === 'both');
    const hasRomanization = (this.currentDisplayMode === 'romanize' || this.currentDisplayMode === 'both');

    // Create array to store options in fixed order
    const options = [];

    // Always add Translation option first (Show or Hide)
    const translationOptionDiv = document.createElement('div');
    translationOptionDiv.className = 'dropdown-option';
    
    if (!hasTranslation) {
      // Show Translation option
      const showTranslationSVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:1.5em;height:1.5em;vertical-align:middle;margin-left:8px;">
        <g clip-path="url(#clip0_1_14)">
          <path d="M4.4721 15.4039C4.82744 15.4039 5.0715 15.2177 5.49838 14.832L7.98429 12.6262H12.5977C14.7358 12.6262 15.8894 11.439 15.8894 9.33452V3.82762C15.8894 1.7231 14.7358 0.535934 12.5977 0.535934H3.34308C1.205 0.535934 0.0513916 1.72001 0.0513916 3.82762V9.33452C0.0513916 11.4421 1.205 12.6262 3.34308 12.6262H3.68208V14.4933C3.68208 15.05 3.96735 15.4039 4.4721 15.4039ZM4.76635 14.0907V12.0102C4.76635 11.6167 4.61989 11.4702 4.22643 11.4702H3.34617C1.88977 11.4702 1.20735 10.7329 1.20735 9.33143V3.83071C1.20735 2.43526 1.88977 1.69955 3.34617 1.69955H12.5946C14.0447 1.69955 14.7333 2.43526 14.7333 3.83071V9.33143C14.7333 10.7329 14.0447 11.4702 12.5946 11.4702H7.93734C7.54211 11.4702 7.33617 11.5297 7.06444 11.812L4.76635 14.0907Z" fill="white"/>
          <path d="M5.60348 9.96734C5.86432 9.96734 6.04582 9.84075 6.16019 9.50675L6.68216 7.97985H9.25095L9.77896 9.50675C9.88582 9.83928 10.0688 9.96734 10.3313 9.96734C10.653 9.96734 10.8635 9.76597 10.8635 9.46863C10.8635 9.36176 10.8391 9.25357 10.7827 9.0996L8.76872 3.66998C8.63153 3.29933 8.35244 3.1087 7.95898 3.1087C7.57302 3.1087 7.30924 3.29933 7.16439 3.66998L5.14893 9.0996C5.10006 9.25357 5.07562 9.36176 5.07562 9.46701C5.07562 9.76759 5.28612 9.96734 5.60348 9.96734ZM6.97053 7.11181L7.92542 4.334H8.00623L8.96097 7.11181H6.97053Z" fill="white"/>
        </g>
        <defs>
          <clipPath id="clip0_1_14">
            <rect width="16" height="16" fill="white"/>
          </clipPath>
        </defs>
      </svg>`;
      translationOptionDiv.innerHTML = `<span>${t('showTranslation')}</span>${showTranslationSVG}`;
      translationOptionDiv.addEventListener('click', () => {
        this.dropdownMenu.classList.add('hidden');
        let newMode = 'translate';
        if (this.currentDisplayMode === 'romanize') {
          newMode = 'both';
        }
        if (this.setCurrentDisplayModeAndRefetchFn && this.lastKnownSongInfo) {
          this.setCurrentDisplayModeAndRefetchFn(newMode, this.lastKnownSongInfo);
        }
      });
    } else {
      // Hide Translation option
      const hideTranslationSVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:1.5em;height:1.5em;vertical-align:middle;margin-left:8px;">
        <g clip-path="url(#clip0_1_52)">
          <path d="M1.78454 1.99989L0.869408 1.08705C0.76619 0.985151 0.710491 0.844399 0.716025 0.699436C0.716025 0.545933 0.764506 0.42491 0.869408 0.327948C0.974431 0.223045 1.10363 0.166504 1.24896 0.166504H1.25702C1.40234 0.166504 1.53154 0.223045 1.63657 0.327948L2.94123 1.63105C3.13924 1.6035 3.33978 1.59243 3.54093 1.5982H12.2953C12.9681 1.5982 13.5355 1.72789 14.0056 1.9792C14.4838 2.22232 14.8405 2.5872 15.0837 3.05733C15.3269 3.52747 15.4566 4.0948 15.4566 4.75947V9.98774C15.4566 10.6525 15.335 11.2199 15.0837 11.69C14.8502 12.1415 14.5045 12.4883 14.0611 12.7377L15.1376 13.8128C15.2426 13.9259 15.299 14.0551 15.299 14.2004C15.299 14.3458 15.2426 14.4669 15.1376 14.5718C15.0434 14.6773 14.9075 14.7364 14.7661 14.7334C14.6228 14.7346 14.4852 14.676 14.3866 14.5718L12.9193 13.1081C12.7224 13.1353 12.5144 13.1491 12.2953 13.1491H8.13702L5.83494 15.1836C5.60793 15.3862 5.40535 15.5322 5.24318 15.6295C5.08102 15.7267 4.90273 15.7754 4.70821 15.7754C4.47181 15.7873 4.24228 15.6919 4.08409 15.516C3.92372 15.3141 3.84288 15.0601 3.85708 14.8027V13.1491H3.49233C2.8439 13.1491 2.28451 13.0194 1.82255 12.7681C1.36577 12.5244 0.992837 12.1486 0.752596 11.69C0.490341 11.1619 0.362341 10.5772 0.379664 9.98774V4.75947C0.379664 4.0948 0.501288 3.52747 0.744416 3.05733C0.981047 2.59983 1.33269 2.24987 1.78454 1.99989ZM2.81323 3.02605C2.54809 3.10461 2.3313 3.22936 2.163 3.39778C1.85491 3.72199 1.70093 4.18395 1.70093 4.80001V9.93914C1.70093 10.5633 1.86309 11.0334 2.163 11.3495C2.47097 11.6657 2.94111 11.8197 3.57341 11.8197H4.49744C4.6839 11.8197 4.82165 11.8602 4.90273 11.9413C5.00006 12.0224 5.0406 12.1683 5.0406 12.3709V14.284L5.03242 14.292H5.0406V14.284L7.17245 12.1844C7.31825 12.0304 7.44794 11.9413 7.57774 11.8927C7.69924 11.844 7.86141 11.8197 8.06399 11.8197H11.6279L2.81323 3.02605ZM4.23927 2.92765L13.0377 11.7154C13.2964 11.6366 13.509 11.5139 13.6733 11.3495C13.9732 11.0253 14.1273 10.5633 14.1273 9.93914V4.80001C14.1273 4.18395 13.9732 3.71381 13.6733 3.39778C13.3653 3.08163 12.887 2.92765 12.2548 2.92765H4.23927Z" fill="white"/>
          <path d="M6.11356 7.4856L5.20192 9.94166C5.15296 10.0956 5.12854 10.2039 5.12854 10.3092C5.12854 10.6097 5.33907 10.8095 5.65642 10.8095C5.91723 10.8095 6.09877 10.6828 6.21317 10.3489L6.73516 8.82202H7.45323L6.11356 7.4856ZM7.1437 4.71038L7.21732 4.51213C7.36216 4.14148 7.62598 3.95081 8.01191 3.95081C8.40541 3.95081 8.68451 4.14148 8.82165 4.51213L9.92601 7.48945L8.29401 5.85938L8.05919 5.17619H7.97834L7.88427 5.44999L7.1437 4.71038Z" fill="white"/>
        </g>
        <defs>
          <clipPath id="clip0_1_52">
            <rect width="16" height="16" fill="white"/>
          </clipPath>
        </defs>
      </svg>`;
      translationOptionDiv.innerHTML = `<span>${t('hideTranslation')}</span>${hideTranslationSVG}`;
      translationOptionDiv.addEventListener('click', () => {
        this.dropdownMenu.classList.add('hidden');
        let newMode = 'none';
        if (this.currentDisplayMode === 'both') {
          newMode = 'romanize';
        }
        if (this.setCurrentDisplayModeAndRefetchFn && this.lastKnownSongInfo) {
          this.setCurrentDisplayModeAndRefetchFn(newMode, this.lastKnownSongInfo);
        }
      });
    }
    
    options.push(translationOptionDiv);

    // Always add Pronunciation option second (Show or Hide)
    const pronunciationOptionDiv = document.createElement('div');
    pronunciationOptionDiv.className = 'dropdown-option';
    
    if (!hasRomanization) {
      // Show Pronunciation option
      const showPronunciationsSVG = `<svg width="16" height="15" viewBox="0 0 16 15" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:1.5em;height:1.5em;vertical-align:middle;margin-left:8px;">
        <path d="M4.42071 14.8679C4.77605 14.8679 5.02011 14.6817 5.44699 14.2961L7.9329 12.0903H12.5463C14.6844 12.0903 15.838 10.9031 15.838 8.79859V3.29169C15.838 1.18717 14.6844 0 12.5463 0H3.29169C1.15361 0 0 1.18408 0 3.29169V8.79859C0 10.9062 1.15361 12.0903 3.29169 12.0903H3.63069V13.9574C3.63069 14.5141 3.91596 14.8679 4.42071 14.8679ZM4.71496 13.5548V11.4742C4.71496 11.0808 4.5685 10.9343 4.17503 10.9343H3.29478C1.83838 10.9343 1.15596 10.197 1.15596 8.79549V3.29478C1.15596 1.89932 1.83838 1.16362 3.29478 1.16362H12.5432C13.9933 1.16362 14.6819 1.89932 14.6819 3.29478V8.79549C14.6819 10.197 13.9933 10.9343 12.5432 10.9343H7.88595C7.49071 10.9343 7.28478 10.9938 7.01305 11.2761L4.71496 13.5548Z" fill="white"/>
        <path d="M3 4.74C3 4.33 3.32 4 3.7 4H8.09C8.48 4 8.79 4.33 8.79 4.73C8.79 5.13 8.48 5.47 8.09 5.47H3.71C3.61544 5.46741 3.52231 5.44621 3.43595 5.40761C3.34958 5.36902 3.27167 5.31378 3.20666 5.24505C3.14165 5.17633 3.09082 5.09547 3.05708 5.0071C3.02333 4.91872 3.00734 4.82456 3.01 4.73L3 4.74ZM3.7 6.2C3.32 6.2 3 6.54 3 6.94C3 7.34 3.32 7.68 3.7 7.68H5.2C5.58 7.68 5.9 7.35 5.9 6.94C5.9 6.54 5.58 6.2 5.2 6.2H3.7ZM10.24 4.73C10.24 4.33 10.56 4 10.94 4H12.44C12.82 4 13.14 4.33 13.14 4.73C13.14 5.13 12.82 5.47 12.44 5.47H10.94C10.8454 5.46741 10.7523 5.44621 10.6659 5.40761C10.5796 5.36902 10.5017 5.31378 10.4367 5.24505C10.3716 5.17633 10.3208 5.09547 10.2871 5.0071C10.2533 4.91872 10.2373 4.82456 10.24 4.73ZM8.05 6.21C7.66 6.21 7.35 6.55 7.35 6.95C7.35 7.35 7.66 7.69 8.05 7.69H10.26C10.65 7.69 10.96 7.36 10.96 6.95C10.96 6.55 10.65 6.21 10.26 6.21H8.07H8.05Z" fill="white"/>
      </svg>`;
      // Determine the text to show based on larger text mode
      const showText = this.largerTextMode === "romanization" ? t('showOriginal') : t('showPronunciation');
      pronunciationOptionDiv.innerHTML = `<span>${showText}</span>${showPronunciationsSVG}`;
      pronunciationOptionDiv.addEventListener('click', () => {
        this.dropdownMenu.classList.add('hidden');
        let newMode = 'romanize';
        if (this.currentDisplayMode === 'translate') {
          newMode = 'both';
        }
        if (this.setCurrentDisplayModeAndRefetchFn && this.lastKnownSongInfo) {
          this.setCurrentDisplayModeAndRefetchFn(newMode, this.lastKnownSongInfo);
        }
      });
    } else {
      // Hide Pronunciation option
      const hidePronunciationsSVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:1.5em;height:1.5em;vertical-align:middle;margin-left:8px;">
        <g clip-path="url(#clip0_1_50)">
          <path d="M1.15902 2.50685L2.13024 3.47807L2.11392 3.50255C1.86091 3.81269 1.73033 4.25341 1.73033 4.80839V9.98278C1.73033 10.6112 1.89356 11.0846 2.19553 11.4029C2.50567 11.7212 2.97904 11.8763 3.61564 11.8763H4.54605C4.73376 11.8763 4.87251 11.9171 4.96228 11.9987C5.0439 12.0803 5.09287 12.2272 5.09287 12.4312V14.3655L7.23934 12.2435C7.38625 12.0885 7.52499 11.9987 7.64742 11.9497C7.76984 11.9007 7.93307 11.8763 8.13711 11.8763H10.5366L11.8751 13.2147H8.21056L5.89269 15.2633C5.66417 15.4673 5.4683 15.6142 5.29691 15.7122C5.13368 15.8101 4.95412 15.8591 4.76641 15.8591C4.48892 15.8591 4.27672 15.7774 4.12981 15.5979C3.96831 15.3945 3.887 15.139 3.90129 14.8797V13.2147H3.53402C2.8811 13.2147 2.31796 13.0842 1.85275 12.8311C1.39247 12.5862 1.01695 12.2078 0.775434 11.7457C0.511465 11.2139 0.382526 10.6252 0.400005 10.0318V4.76759C0.400005 4.09834 0.522427 3.52704 0.775434 3.05367C0.881533 2.84963 1.00396 2.67008 1.15902 2.50685ZM1.2488 0.140015C1.40387 0.140015 1.52629 0.197145 1.64055 0.303245L15.2866 13.9329C15.3927 14.0472 15.4498 14.1778 15.4498 14.3247C15.4498 14.4716 15.3927 14.594 15.2866 14.7001C15.2386 14.7539 15.1793 14.7964 15.113 14.8246C15.0467 14.8528 14.975 14.8661 14.903 14.8634C14.8313 14.8639 14.7602 14.8498 14.6942 14.8217C14.6282 14.7936 14.5687 14.7522 14.5194 14.7001L0.86521 1.07043C0.81253 1.01854 0.771465 0.956061 0.744733 0.88712C0.718001 0.81818 0.706211 0.744349 0.710142 0.670512C0.710142 0.523605 0.767272 0.401183 0.873372 0.303245C0.97131 0.197145 1.09373 0.140015 1.24064 0.140015H1.2488ZM12.3974 1.5846C13.0748 1.5846 13.6543 1.71518 14.1276 1.96819C14.601 2.21304 14.9601 2.5803 15.2131 3.05367C15.458 3.52704 15.5804 4.09834 15.5804 4.76759V10.0318C15.5804 10.701 15.458 11.2723 15.2131 11.7457C15.0989 11.9579 14.9683 12.1456 14.8051 12.317L13.8338 11.3376L13.8746 11.2968C14.1195 10.9866 14.2501 10.5459 14.2501 9.98278V4.80839C14.2501 4.18812 14.0868 3.71475 13.7849 3.39645C13.4747 3.07815 13.0014 2.92309 12.3566 2.92309H5.41933L4.07268 1.5846H12.3974ZM5.59072 7.55066C5.77038 7.55066 5.94268 7.62203 6.06972 7.74906C6.19675 7.8761 6.26812 8.0484 6.26812 8.22806C6.26812 8.40772 6.19675 8.58002 6.06972 8.70706C5.94268 8.8341 5.77038 8.90547 5.59072 8.90547H4.24407C4.06441 8.90547 3.89211 8.8341 3.76507 8.70706C3.63804 8.58002 3.56667 8.40772 3.56667 8.22806C3.56667 8.0484 3.63804 7.8761 3.76507 7.74906C3.89211 7.62203 4.06441 7.55066 4.24407 7.55066H5.59072ZM10.104 7.55066C10.4795 7.55066 10.7814 7.85263 10.7814 8.22806V8.28519L10.0469 7.55066H10.104ZM3.99107 5.34705L5.29691 6.64473H4.23591C4.07928 6.6429 3.92812 6.58684 3.80817 6.4861C3.68822 6.38536 3.60689 6.24617 3.57802 6.09221C3.54916 5.93825 3.57454 5.77905 3.64985 5.6417C3.72515 5.50434 3.84574 5.39734 3.99107 5.33889V5.34705ZM11.9077 5.29808C11.9967 5.29808 12.0848 5.3156 12.167 5.34965C12.2491 5.38369 12.3238 5.43359 12.3867 5.49649C12.4496 5.55939 12.4995 5.63407 12.5336 5.71626C12.5676 5.79844 12.5851 5.88653 12.5851 5.97549C12.5851 6.06445 12.5676 6.15253 12.5336 6.23472C12.4995 6.31691 12.4496 6.39158 12.3867 6.45448C12.3238 6.51739 12.2491 6.56728 12.167 6.60133C12.0848 6.63537 11.9967 6.65289 11.9077 6.65289H10.5529C10.464 6.65289 10.3759 6.63537 10.2937 6.60133C10.2115 6.56728 10.1368 6.51739 10.0739 6.45448C10.011 6.39158 9.96111 6.31691 9.92707 6.23472C9.89303 6.15253 9.87551 6.06445 9.87551 5.97549C9.87551 5.88653 9.89303 5.79844 9.92707 5.71626C9.96111 5.63407 10.011 5.55939 10.0739 5.49649C10.1368 5.43359 10.2115 5.38369 10.2937 5.34965C10.3759 5.3156 10.464 5.29808 10.5529 5.29808H11.9077ZM8.30034 5.29808C8.42347 5.29869 8.5441 5.33285 8.64927 5.39688C8.75444 5.46091 8.84017 5.5524 8.89724 5.6615C8.95431 5.77061 8.98056 5.89321 8.97318 6.01611C8.96579 6.13902 8.92504 6.25759 8.85532 6.35908L7.79432 5.29808H8.30034Z" fill="white"/>
        </g>
        <defs>
          <clipPath id="clip0_1_50">
            <rect width="16" height="16" fill="white"/>
          </clipPath>
        </defs>
      </svg>`;
      // Determine the text to show based on larger text mode
      const hideText = this.largerTextMode === "romanization" ? t('hideOriginal') : t('hidePronunciation');
      pronunciationOptionDiv.innerHTML = `<span>${hideText}</span>${hidePronunciationsSVG}`;
      pronunciationOptionDiv.addEventListener('click', () => {
        this.dropdownMenu.classList.add('hidden');
        let newMode = 'none';
        if (this.currentDisplayMode === 'both') {
          newMode = 'translate';
        }
        if (this.setCurrentDisplayModeAndRefetchFn && this.lastKnownSongInfo) {
          this.setCurrentDisplayModeAndRefetchFn(newMode, this.lastKnownSongInfo);
        }
      });
    }
    
    options.push(pronunciationOptionDiv);

    // Add all options to dropdown in fixed order
    options.forEach(option => {
      this.dropdownMenu.appendChild(option);
    });
  }

  _updateTranslationButtonText() {
    if (!this.translationButton) return;
    const translationButtonSVG = `<svg width="16" height="12" viewBox="0 0 16 12" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:1.5em;height:1.5em;vertical-align:middle;">
      <g clip-path="url(#clip0_1_38)">
        <path d="M0.248474 2.39555C0.248474 1.10679 1.0696 0.358383 2.30584 0.358383H7.09324C8.32948 0.358383 9.15364 1.10679 9.15364 2.39555V2.84702H8.91831C8.71833 2.84702 8.53148 2.8652 8.35776 2.89954V2.42484C8.35776 1.55422 7.87094 1.0977 7.04476 1.0977H2.35331C1.53218 1.09669 1.04031 1.55422 1.04031 2.42484V5.28718C1.04031 6.1578 1.53319 6.60422 2.3523 6.60422H2.87346C3.08253 6.60422 3.25322 6.72946 3.25322 7.00822V8.25254L4.83993 6.83551C5.03385 6.66381 5.15303 6.60321 5.42169 6.60321H6.85993V7.34758H5.39038L3.74408 8.7535C3.44916 9.01206 3.28655 9.14437 3.04718 9.14437C2.70277 9.14437 2.51491 8.90399 2.51491 8.5313V7.34758H2.30584C1.0696 7.34758 0.248474 6.60119 0.248474 5.30738V2.39555Z" fill="white"/>
        <path d="M2.97243 5.32052C2.86739 5.59625 3.02091 5.84673 3.30573 5.84673C3.49258 5.84673 3.60873 5.74775 3.68044 5.53868L3.9794 4.67008H5.43077L5.73478 5.53868C5.80144 5.74775 5.91658 5.84673 6.10646 5.84673C6.39633 5.84673 6.54076 5.59423 6.4438 5.32153L5.2217 2.0562C5.13282 1.8138 4.95304 1.68149 4.70054 1.68149C4.45107 1.68149 4.27129 1.81279 4.18241 2.05519L2.97243 5.32153V5.32052ZM4.1814 4.06307L4.70054 2.55312L5.22574 4.06307H4.18241H4.1814ZM12.2654 11.2432L10.6181 9.83623H8.9183C7.62853 9.83623 6.85992 9.09085 6.85992 7.8031V4.8842C6.85992 3.59443 7.62752 2.84703 8.9183 2.84703H13.7037C14.9399 2.84703 15.7611 3.59443 15.7611 4.88319V7.79502C15.7611 9.08883 14.9399 9.83522 13.7037 9.83522H13.4997V11.0189C13.4997 11.3916 13.3057 11.632 12.9684 11.632C12.727 11.632 12.5664 11.5007 12.2644 11.2432H12.2654ZM11.5685 4.56908L11.3241 4.07216C11.2302 3.88531 11.0413 3.80148 10.8615 3.90046C10.8204 3.91982 10.7835 3.9473 10.7532 3.98123C10.7229 4.01517 10.6997 4.05487 10.6851 4.09796C10.6705 4.14105 10.6647 4.18664 10.6681 4.23202C10.6716 4.27739 10.6841 4.32161 10.705 4.36203L10.9444 4.864C10.9628 4.90485 10.9891 4.94163 11.0218 4.97222C11.0546 5.00281 11.0931 5.02659 11.1351 5.04219C11.1771 5.05779 11.2217 5.06489 11.2665 5.06308C11.3113 5.06127 11.3552 5.05059 11.3958 5.03166C11.5817 4.94076 11.6514 4.74179 11.5675 4.56908H11.5685ZM9.38391 5.53565C9.38391 5.72452 9.53541 5.8639 9.73337 5.8639H10.1111C10.2475 6.35887 10.4983 6.81485 10.8434 7.19508C10.482 7.42729 10.0822 7.59349 9.66267 7.68594C9.4738 7.73139 9.35967 7.91319 9.39805 8.11216C9.4536 8.30709 9.65055 8.39496 9.86265 8.33739C10.401 8.21962 10.9083 7.98935 11.3514 7.6617C11.7759 7.98278 12.2621 8.21281 12.7795 8.33739C13.024 8.38991 13.2249 8.31719 13.2744 8.11216C13.335 7.89804 13.2371 7.73139 13.0219 7.68594C12.6032 7.59613 12.2046 7.42972 11.8463 7.19508C12.1958 6.81888 12.4458 6.36129 12.5735 5.8639H12.9512C13.1552 5.8639 13.3047 5.72452 13.3047 5.53565C13.3047 5.34678 13.1552 5.20639 12.9512 5.20639H9.73337C9.5344 5.20639 9.38391 5.34779 9.38391 5.53565ZM11.3514 6.77795C11.1079 6.51347 10.9204 6.20258 10.7999 5.8639H11.8847C11.7676 6.20016 11.5865 6.51055 11.3514 6.77795Z" fill="white"/>
      </g>
      <defs>
        <clipPath id="clip0_1_38">
          <rect width="16" height="12" fill="white"/>
        </clipPath>
      </defs>
    </svg>`;
    this.translationButton.innerHTML = translationButtonSVG;
    this.translationButton.title = t('showTranslationOptions');
  }

  // --- Cleanup ---

  /**
   * Cleans up the lyrics container and resets the state for the next song.
   */
  cleanupLyrics() {
    if (this.lyricsAnimationFrameId) {
      cancelAnimationFrame(this.lyricsAnimationFrameId);
      this.lyricsAnimationFrameId = null;
    }
    const container = this._getContainer();
    if (container) {
      container.innerHTML = `<span class="text-loading">${t("loading")}</span>`;
      container.classList.add('lyrics-plus-message');
      container.classList.remove('user-scrolling');
    }
    this.activeLineIds.clear();
    this.highlightedSyllableIds.clear();
    this.visibleLineIds.clear();
    this.currentPrimaryActiveLine = null;
    this.currentFullscreenFocusedLine = null;
    if (this.visibilityObserver) {
      this.visibilityObserver.disconnect();
      this.visibilityObserver = null;
    }
    this.cachedLyricsLines = [];
    this.cachedSyllables = [];
    this.currentScrollOffset = 0;
    this.isUserControllingScroll = false;
    clearTimeout(this.userScrollIdleTimer);
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    // Prevent stale song info overlay from re-appearing while loading next song
    this.lastKnownSongInfo = null;
    // Remove song info overlay on cleanup to prevent stale titles
    const existingSongInfo = document.querySelector('.lyrics-song-info');
    if (existingSongInfo) existingSongInfo.remove();
    if (this._cleanupArtworkObservers) {
      this._cleanupArtworkObservers();
      this._cleanupArtworkObservers = null;
    }
    
    // Hide refresh button and translation button during loading
    if (this.reloadButton) {
      this.reloadButton.style.display = 'none';
    }
    if (this.translationButton) {
      this.translationButton.style.display = 'none';
    }
  }

  /**
   * Extracts song information directly from YouTube Music DOM
   * @private
   */
  _getSongInfoFromDOM() {
    try {
      // Use the same approach as the existing songTracker
      const titleElement = document.querySelector('.title.style-scope.ytmusic-player-bar');
      const byline = document.querySelector('.byline.style-scope.ytmusic-player-bar');
      
      // Debug: Check all possible title elements
      const allTitleElements = document.querySelectorAll('[class*="title"]');
      console.log('LYPLUS: All title elements found:', Array.from(allTitleElements).map(el => ({
        className: el.className,
        textContent: el.textContent,
        tagName: el.tagName
      })));
      
      // Debug: Check if there are other title selectors
      const ytFormattedTitle = document.querySelector('yt-formatted-string.title');
      console.log('LYPLUS: yt-formatted-string.title found:', {
        exists: !!ytFormattedTitle,
        textContent: ytFormattedTitle?.textContent
      });
      
      console.log('LYPLUS: DOM elements found:', { 
        titleElement: !!titleElement, 
        byline: !!byline,
        titleText: titleElement?.textContent,
        bylineText: byline?.textContent,
        titleElementHTML: titleElement?.outerHTML,
        bylineHTML: byline?.outerHTML
      });
      
      if (!titleElement || !byline) {
        console.log('LYPLUS: Title or byline not found in DOM');
        return null;
      }
      
      const title = titleElement.textContent.trim();
      if (!title) {
        console.log('LYPLUS: Title is empty');
        return null;
      }
      
      // Extract artist and album from byline using the same logic as songTracker
      let artists = [];
      let artistUrls = [];
      let album = "";
      let albumUrl = "";
      
      // Try to find links in byline - first try the complex-string byline which has actual links
      let links = byline.querySelectorAll('a');
      console.log('LYPLUS: Found links in byline:', links.length);
      
      // If no links found in byline, try the byline-wrapper as fallback
      if (links.length === 0) {
        const bylineWrapper = document.querySelector('.byline-wrapper');
        if (bylineWrapper) {
          links = bylineWrapper.querySelectorAll('a');
          console.log('LYPLUS: Found links in byline-wrapper:', links.length);
        }
      }
      
      console.log('LYPLUS: Total links found:', links.length);
      
      for (const link of links) {
        const href = link.getAttribute('href');
        const text = link.textContent?.trim();
        console.log('LYPLUS: Link found:', { href, text });
        
        if (href) {
          if (href.startsWith('channel/')) {
            // These are artist links
            artists.push(text);
            artistUrls.push(href);
            console.log('LYPLUS: Artist link:', href);
          } else if (href.startsWith('browse/')) {
            // This one is the album
            album = text;
            albumUrl = href;
            console.log('LYPLUS: Album link:', href);
          }
        }
      }
      
      // Properly format the artist names (same as songTracker)
      let artist = "";
      if (artists.length === 1) {
        artist = artists[0];
      } else if (artists.length === 2) {
        artist = artists.join(" & ");
      } else if (artists.length > 2) {
        artist = artists.slice(0, -1).join(", ") + ", & " + artists[artists.length - 1];
      }
      
      // If no links found, try to extract artist from byline text directly
      if (!artist && byline.textContent) {
        const bylineText = byline.textContent.trim();
        console.log('LYPLUS: No links found, trying to extract from byline text:', bylineText);
        
        // Split by common separators and take the first part as artist
        const parts = bylineText.split(/[•·–—]/);
        if (parts.length > 0) {
          artist = parts[0].trim();
          console.log('LYPLUS: Extracted artist from byline text:', artist);
        }
      }
      
      // Check if this is a video (no album info)
      // But don't treat it as video if we have artist info
      const isVideo = album === '' && artist === '';
      
      console.log('LYPLUS: Extracted song info from DOM:', { title, artist, album, isVideo, artistUrl: artistUrls[0], albumUrl });
      
      return {
        title: title,
        artist: artist,
        album: album,
        isVideo: isVideo,
        videoId: null, // We don't need videoId for display purposes
        artistUrl: artistUrls.length > 0 ? artistUrls[0] : null,
        albumUrl: albumUrl || null
      };
    } catch (error) {
      console.error('LYPLUS: Error extracting song info from DOM:', error);
      
      // Fallback: try to use the existing songTracker functions if available
      try {
        if (typeof LYPLUS_getDOMSongInfo === 'function') {
          console.log('LYPLUS: Trying fallback with LYPLUS_getDOMSongInfo');
          const fallbackInfo = LYPLUS_getDOMSongInfo();
          if (fallbackInfo) {
            console.log('LYPLUS: Fallback successful:', fallbackInfo);
            
            // Try to get URLs from byline
            const byline = document.querySelector('.byline.style-scope.ytmusic-player-bar');
            let artistUrl = null;
            let albumUrl = null;
            
            if (byline) {
              const links = byline.querySelectorAll('a');
              for (const link of links) {
                const href = link.getAttribute('href');
                if (href) {
                  if (href.startsWith('channel/')) {
                    artistUrl = href;
                  } else if (href.startsWith('browse/')) {
                    albumUrl = href;
                  }
                }
              }
            }
            
            return {
              title: fallbackInfo.title,
              artist: fallbackInfo.artist,
              album: fallbackInfo.album,
              isVideo: fallbackInfo.isVideo,
              videoId: null,
              artistUrl: artistUrl,
              albumUrl: albumUrl
            };
          }
        }
      } catch (fallbackError) {
        console.error('LYPLUS: Fallback also failed:', fallbackError);
      }
      
      return null;
    }
  }

  /**
   * Adds song information display from DOM scraping when lyrics are not found
   * @private
   */
  _addSongInfoFromDOM() {
    console.log('LYPLUS: ===== _addSongInfoFromDOM CALLED =====');
    console.log('LYPLUS: Adding song info from DOM scraping');
    
    // Check if we're in YouTube Music fullscreen mode
    const playerPage = document.querySelector('ytmusic-player-page');
    const isFullscreen = playerPage && playerPage.hasAttribute('player-fullscreened');
    const isVideoMode = playerPage && playerPage.hasAttribute('video-mode');
    
    console.log('LYPLUS: Fullscreen check:', { 
      playerPage: !!playerPage, 
      isFullscreen, 
      isVideoMode 
    });
    
    if (!isFullscreen) {
      console.log('LYPLUS: Not in fullscreen mode, skipping song info from DOM');
      return;
    }
    
    // Skip in video fullscreen mode
    if (isVideoMode) {
      console.log('LYPLUS: Video mode detected, skipping song info from DOM');
      return;
    }
    
    // Remove existing song info display if it exists
    const existingSongInfo = document.querySelector('.lyrics-song-info');
    if (existingSongInfo) {
      existingSongInfo.remove();
    }
    
    // Get song info from DOM
    const songInfo = this._getSongInfoFromDOM();
    if (!songInfo) {
      console.log('LYPLUS: No song info available from DOM');
      return;
    }
    
    if (songInfo.isVideo) {
      console.log('LYPLUS: Song is video content (no artist/album info), skipping song info from DOM');
      return;
    }
    
    console.log('LYPLUS: Creating song info display with:', songInfo);
    
    // Create song info container positioned directly below album art
    const songInfoContainer = document.createElement('div');
    songInfoContainer.className = 'lyrics-song-info';
    songInfoContainer.style.display = 'block';
    
    // Create song title (styles from CSS)
    const titleElement = document.createElement('p');
    titleElement.id = 'lyrics-song-title';
    titleElement.textContent = songInfo.title;
    
    // Create artist info (styles from CSS)
    const artistElement = document.createElement('p');
    artistElement.id = 'lyrics-song-artist';
    
    console.log('LYPLUS: Song info URLs:', { artistUrl: songInfo.artistUrl, albumUrl: songInfo.albumUrl });
    
    // Create clickable artist and album elements
    if (songInfo.artistUrl && songInfo.artist) {
      const artistLink = document.createElement('a');
      // Use relative path for SPA navigation
      artistLink.href = `/${songInfo.artistUrl}`;
      artistLink.textContent = songInfo.artist;
      artistLink.className = 'lyrics-clickable-artist';
      artistLink.style.cursor = 'pointer';
      artistLink.style.textDecoration = 'none';
      artistLink.style.color = 'inherit';
      console.log('LYPLUS: Created artist link:', songInfo.artistUrl);
      
      // Add proper click handler to open in new tab
      artistLink.addEventListener('click', (e) => {
        e.preventDefault();
        window.open(`/${songInfo.artistUrl}`, '_blank');
      });
      
      artistElement.appendChild(artistLink);
    } else if (songInfo.artist) {
      artistElement.textContent = songInfo.artist;
    }
    
    // Add album if available
    if (songInfo.album && songInfo.album.trim() !== '') {
      if (songInfo.artist) {
        const separator = document.createTextNode(' — ');
        artistElement.appendChild(separator);
      }
      
      if (songInfo.albumUrl) {
        const albumLink = document.createElement('a');
        // Use relative path for SPA navigation
        albumLink.href = `/${songInfo.albumUrl}`;
        albumLink.textContent = songInfo.album;
        albumLink.className = 'lyrics-clickable-album';
        albumLink.style.cursor = 'pointer';
        albumLink.style.textDecoration = 'none';
        albumLink.style.color = 'inherit';
        console.log('LYPLUS: Created album link:', songInfo.albumUrl);
        
        // Add proper click handler to open in new tab
        albumLink.addEventListener('click', (e) => {
          e.preventDefault();
          window.open(`/${songInfo.albumUrl}`, '_blank');
        });
        
        artistElement.appendChild(albumLink);
      } else {
        artistElement.appendChild(document.createTextNode(songInfo.album));
      }
    }
    
    // Append elements to container
    songInfoContainer.appendChild(titleElement);
    songInfoContainer.appendChild(artistElement);
    
    // Add to body first
    document.body.appendChild(songInfoContainer);
    console.log('LYPLUS: Song info container added to body');
    
    // Position relative to album artwork and keep it synced
    this._positionSongInfoRelativeToArtwork(songInfoContainer);
    this._setupArtworkObservers(songInfoContainer);
    console.log('LYPLUS: ===== SONG INFO SUCCESSFULLY ADDED TO DOM =====');
    console.log('LYPLUS: Song info from DOM added and positioned relative to artwork');
  }

  /**
   * Adds song information display below the album art in fullscreen mode
   * @private
   */
  _addSongInfoDisplay(container) {
    console.log('LYPLUS: Adding song info display, songInfo:', this.lastKnownSongInfo);
    
    // Check if we're actually in YouTube Music fullscreen mode
    const playerPage = document.querySelector('ytmusic-player-page');
    const isFullscreen = playerPage && playerPage.hasAttribute('player-fullscreened');
    const isVideoMode = playerPage && playerPage.hasAttribute('video-mode');
    
    if (!isFullscreen) {
      console.log('LYPLUS: Not in fullscreen mode, skipping song info');
      return;
    }
    // Skip in video fullscreen mode
    if (isVideoMode) {
      console.log('LYPLUS: Video mode detected, skipping song info');
      return;
    }
    
    // Remove existing song info display if it exists
    const existingSongInfo = document.querySelector('.lyrics-song-info');
    if (existingSongInfo) {
      existingSongInfo.remove();
    }

    let songInfo = this.lastKnownSongInfo;
    if (!songInfo) {
      console.log('LYPLUS: No song info available');
      return;
    }
    if (songInfo.isVideo) {
      // Do not show song info overlay for video contents (only if no artist info)
      console.log('LYPLUS: Song is video content (no artist/album info), skipping song info');
      return;
    }

    // Try to get URLs from DOM if not already present in songInfo
    if (!songInfo.artistUrl || !songInfo.albumUrl) {
      const domInfo = this._getSongInfoFromDOM();
      if (domInfo && domInfo.artistUrl) {
        songInfo.artistUrl = domInfo.artistUrl;
      }
      if (domInfo && domInfo.albumUrl) {
        songInfo.albumUrl = domInfo.albumUrl;
      }
      console.log('LYPLUS: Updated songInfo with URLs from DOM:', { artistUrl: songInfo.artistUrl, albumUrl: songInfo.albumUrl });
    }

    // Create song info container positioned directly below album art
    const songInfoContainer = document.createElement('div');
    songInfoContainer.className = 'lyrics-song-info';
    songInfoContainer.style.display = 'block';
    // Don't set positioning here - let _positionSongInfoRelativeToArtwork handle it
    // This avoids conflicts between inline styles and CSS fallback
    
    // Create song title (styles from CSS)
    const titleElement = document.createElement('p');
    titleElement.id = 'lyrics-song-title';
    titleElement.textContent = songInfo.title;
    // All typography from CSS
    
    // Create artist info (styles from CSS)
    const artistElement = document.createElement('p');
    artistElement.id = 'lyrics-song-artist';
    
    console.log('LYPLUS: Song info URLs:', { artistUrl: songInfo.artistUrl, albumUrl: songInfo.albumUrl });
    
    // Create clickable artist and album elements
    if (songInfo.artistUrl && songInfo.artist) {
      const artistLink = document.createElement('a');
      // Use relative path for SPA navigation
      artistLink.href = `/${songInfo.artistUrl}`;
      artistLink.textContent = songInfo.artist;
      artistLink.className = 'lyrics-clickable-artist';
      artistLink.style.cursor = 'pointer';
      artistLink.style.textDecoration = 'none';
      artistLink.style.color = 'inherit';
      console.log('LYPLUS: Created artist link:', songInfo.artistUrl);
      
      // Add proper click handler to open in new tab
      artistLink.addEventListener('click', (e) => {
        e.preventDefault();
        window.open(`/${songInfo.artistUrl}`, '_blank');
      });
      
      artistElement.appendChild(artistLink);
    } else if (songInfo.artist) {
      artistElement.textContent = songInfo.artist;
    }
    
    // Add album if available
    if (songInfo.album && songInfo.album.trim() !== '') {
      if (songInfo.artist) {
        const separator = document.createTextNode(' — ');
        artistElement.appendChild(separator);
      }
      
      if (songInfo.albumUrl) {
        const albumLink = document.createElement('a');
        // Use relative path for SPA navigation
        albumLink.href = `/${songInfo.albumUrl}`;
        albumLink.textContent = songInfo.album;
        albumLink.className = 'lyrics-clickable-album';
        albumLink.style.cursor = 'pointer';
        albumLink.style.textDecoration = 'none';
        albumLink.style.color = 'inherit';
        console.log('LYPLUS: Created album link:', songInfo.albumUrl);
        
        // Add proper click handler to open in new tab
        albumLink.addEventListener('click', (e) => {
          e.preventDefault();
          window.open(`/${songInfo.albumUrl}`, '_blank');
        });
        
        artistElement.appendChild(albumLink);
      } else {
        artistElement.appendChild(document.createTextNode(songInfo.album));
      }
    }
    
    // All typography from CSS
    artistElement.style.fontFamily = 'SF Pro Display, sans-serif';
    
    // Append elements to container
    songInfoContainer.appendChild(titleElement);
    songInfoContainer.appendChild(artistElement);
    
    // Add to body first
    document.body.appendChild(songInfoContainer);
    // Position relative to album artwork and keep it synced
    this._positionSongInfoRelativeToArtwork(songInfoContainer);
    this._setupArtworkObservers(songInfoContainer);
    console.log('LYPLUS: Song info added and positioned relative to artwork');
  }

  _addSongInfoToContainer(container, songInfo) {
    // Fallback method to add song info to lyrics container
    const songInfoContainer = document.createElement('div');
    songInfoContainer.className = 'lyrics-song-info';
    songInfoContainer.style.display = 'block';
    songInfoContainer.style.position = 'fixed';
    songInfoContainer.style.bottom = '20px';
    songInfoContainer.style.left = '20px';
    songInfoContainer.style.right = '20px';
    songInfoContainer.style.textAlign = 'center';
    songInfoContainer.style.zIndex = '1000';
    
    const titleElement = document.createElement('p');
    titleElement.id = 'lyrics-song-title';
    titleElement.textContent = songInfo.title;
    
    const artistElement = document.createElement('p');
    artistElement.id = 'lyrics-song-artist';
    
    // Create clickable artist and album elements
    if (songInfo.artistUrl && songInfo.artist) {
      const artistLink = document.createElement('a');
      // Use relative path for SPA navigation
      artistLink.href = `/${songInfo.artistUrl}`;
      artistLink.textContent = songInfo.artist;
      artistLink.className = 'lyrics-clickable-artist';
      artistLink.style.cursor = 'pointer';
      artistLink.style.textDecoration = 'none';
      artistLink.style.color = 'inherit';
      console.log('LYPLUS: Created artist link:', songInfo.artistUrl);
      
      // Add proper click handler to open in new tab
      artistLink.addEventListener('click', (e) => {
        e.preventDefault();
        window.open(`/${songInfo.artistUrl}`, '_blank');
      });
      
      artistElement.appendChild(artistLink);
    } else if (songInfo.artist) {
      artistElement.textContent = songInfo.artist;
    }
    
    // Add album if available
    if (songInfo.album && songInfo.album.trim() !== '') {
      if (songInfo.artist) {
        const separator = document.createTextNode(' — ');
        artistElement.appendChild(separator);
      }
      
      if (songInfo.albumUrl) {
        const albumLink = document.createElement('a');
        // Use relative path for SPA navigation
        albumLink.href = `/${songInfo.albumUrl}`;
        albumLink.textContent = songInfo.album;
        albumLink.className = 'lyrics-clickable-album';
        albumLink.style.cursor = 'pointer';
        albumLink.style.textDecoration = 'none';
        albumLink.style.color = 'inherit';
        console.log('LYPLUS: Created album link:', songInfo.albumUrl);
        
        // Add proper click handler to open in new tab
        albumLink.addEventListener('click', (e) => {
          e.preventDefault();
          window.open(`/${songInfo.albumUrl}`, '_blank');
        });
        
        artistElement.appendChild(albumLink);
      } else {
        artistElement.appendChild(document.createTextNode(songInfo.album));
      }
    }
    
    songInfoContainer.appendChild(titleElement);
    songInfoContainer.appendChild(artistElement);
    
    // Add to body to ensure it's visible
    document.body.appendChild(songInfoContainer);
    console.log('LYPLUS: Song info added to body as fallback');
  }

  _setupFullscreenListener() {
    // Only set up once
    if (this.fullscreenListenerSetup) return;
    this.fullscreenListenerSetup = true;
    
    // Listen for fullscreen changes
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'player-fullscreened') {
          const playerPage = mutation.target;
          const isFullscreen = playerPage.hasAttribute('player-fullscreened');
          console.log('LYPLUS: Fullscreen changed:', isFullscreen);
          
          if (isFullscreen && !playerPage.hasAttribute('video-mode')) {
            // Add song info immediately when entering fullscreen (don't wait for lyrics)
            console.log('LYPLUS: Fullscreen detected, adding song info immediately');
            this._addSongInfoFromDOM();
          } else {
            // Remove song info when exiting fullscreen
            const existingSongInfo = document.querySelector('.lyrics-song-info');
            if (existingSongInfo) {
              existingSongInfo.remove();
            }
            if (this._cleanupArtworkObservers) {
              this._cleanupArtworkObservers();
              this._cleanupArtworkObservers = null;
            }
          }
        }
      });
    });
    
    // Observe the player page for fullscreen changes
    const playerPage = document.querySelector('ytmusic-player-page');
    if (playerPage) {
      observer.observe(playerPage, {
        attributes: true,
        attributeFilter: ['player-fullscreened']
      });
    }
  }

  /**
   * Finds the album artwork element in YT Music fullscreen layout.
   */
  _findArtworkElement() {
    // Common selectors observed in YT Music layouts
    const candidates = [
      // Fullscreen player artwork image
      'ytmusic-player-page[player-fullscreened] img.image',
      // Artwork container backgrounds
      'ytmusic-player-page[player-fullscreened] #thumbnail img',
      'ytmusic-player-page[player-fullscreened] .image',
      // Additional selectors for better compatibility
      'ytmusic-player-page[player-fullscreened] #player img',
      'ytmusic-player-page[player-fullscreened] .player-image',
      'ytmusic-player-page[player-fullscreened] ytmusic-player img',
      'ytmusic-player-page[player-fullscreened] #thumbnail',
      // Player bar image (fallback)
      '.image.ytmusic-player-bar'
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.getBoundingClientRect) {
        const rect = el.getBoundingClientRect();
        // Ensure element has valid dimensions
        if (rect.width > 0 && rect.height > 0) {
          return el;
        }
      }
    }
    return null;
  }

  /**
   * Positions the provided container just below the artwork bounding box.
   */
  _positionSongInfoRelativeToArtwork(songInfoContainer) {
    const artworkEl = this._findArtworkElement();
    if (!artworkEl) {
      // Remove inline styles to let CSS fallback positioning take over
      songInfoContainer.style.position = '';
      songInfoContainer.style.left = '';
      songInfoContainer.style.top = '';
      songInfoContainer.style.transform = '';
      songInfoContainer.style.maxWidth = '';
      songInfoContainer.style.textAlign = '';
      console.log('LYPLUS: Artwork not found, using CSS fallback positioning');
      return;
    }
    
    const rect = artworkEl.getBoundingClientRect();
    console.log('LYPLUS: Artwork position:', { left: rect.left, bottom: rect.bottom, width: rect.width });

    // Place left-aligned under the artwork with better spacing
    const leftX = rect.left;
    const topY = rect.bottom + 20; // Increased gap below artwork

    songInfoContainer.style.position = 'fixed';
    songInfoContainer.style.left = `${leftX}px`;
    songInfoContainer.style.top = `${topY}px`;
    songInfoContainer.style.transform = 'none';
    songInfoContainer.style.maxWidth = `${Math.max(300, Math.floor(rect.width))}px`;
    songInfoContainer.style.textAlign = 'left';
    songInfoContainer.style.zIndex = '1000';
    
    console.log('LYPLUS: Song info positioned at:', { left: leftX, top: topY });
  }

  /**
   * Observes layout changes to keep song info aligned with artwork when zooming/resizing.
   */
  _setupArtworkObservers(songInfoContainer) {
    // Reposition on resize/scroll to follow layout changes
    const reposition = () => {
      console.log('LYPLUS: Repositioning song info due to layout change');
      this._positionSongInfoRelativeToArtwork(songInfoContainer);
    };
    this._artworkRepositionHandler = reposition;

    // More frequent repositioning for better tracking
    window.addEventListener('resize', reposition, { passive: true });
    window.addEventListener('scroll', reposition, { passive: true });
    
    // Also reposition on animation frame for smooth tracking
    let animationFrameId = null;
    const smoothReposition = () => {
      reposition();
      animationFrameId = requestAnimationFrame(smoothReposition);
    };
    
    // Start smooth repositioning
    animationFrameId = requestAnimationFrame(smoothReposition);

    // Mutation observer to watch player layout changes
    const playerPage = document.querySelector('ytmusic-player-page');
    if (playerPage) {
      if (this._artworkMutationObserver) this._artworkMutationObserver.disconnect();
      this._artworkMutationObserver = new MutationObserver(() => {
        console.log('LYPLUS: Player layout changed, repositioning song info');
        reposition();
      });
      this._artworkMutationObserver.observe(playerPage, { 
        attributes: true, 
        childList: true, 
        subtree: true,
        attributeFilter: ['player-fullscreened', 'video-mode', 'style']
      });
    }

    // Clean-up hook when leaving fullscreen
    this._cleanupArtworkObservers = () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition);
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      if (this._artworkMutationObserver) {
        this._artworkMutationObserver.disconnect();
        this._artworkMutationObserver = null;
      }
    };
  }
}

// Create the renderer instance with default config
const lyricsRendererInstance = new LyricsPlusRenderer();

// Make it globally available for other observers
window.lyricsRendererInstance = lyricsRendererInstance;

// Track last applied settings to detect what changed between updates
let __lastAppliedSettingsSnapshot = null;

// Listen for settings updates to refresh display
window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    
    if (event.data.type === 'UPDATE_DYNAMIC_BG') {
        if (typeof window.applyDynamicPlayerClass === 'function') {
            window.applyDynamicPlayerClass();
            // Also apply with a small delay to ensure DOM is ready
            setTimeout(() => { window.applyDynamicPlayerClass(); }, 50);
        }
        return;
    }

    if (event.data.type === 'UPDATE_SETTINGS') {
        console.log('NewSync: Received settings update in lyricsRenderer', event.data.settings);

        // Determine if only dynamic background settings changed
        try {
            const previous = __lastAppliedSettingsSnapshot || {};
            const current = event.data.settings || {};
            const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);

            const dynamicOnlyKeys = new Set([
                'dynamicPlayerPage',
                'dynamicPlayerFullscreen',
                'useSongPaletteFullscreen',
                'useSongPaletteAllModes',
                'overridePaletteColor'
            ]);

            let changedKeys = [];
            keys.forEach(k => {
                if (previous[k] !== current[k]) changedKeys.push(k);
            });

            const onlyDynamicChanged = changedKeys.length > 0 && changedKeys.every(k => dynamicOnlyKeys.has(k));

            if (onlyDynamicChanged) {
                // Apply dynamic background without refreshing lyrics
                if (typeof window.applyDynamicPlayerClass === 'function') {
                    window.applyDynamicPlayerClass();
                }
                __lastAppliedSettingsSnapshot = { ...current };
                return;
            }

            // Store snapshot for next comparison
            __lastAppliedSettingsSnapshot = { ...current };
        } catch (e) {
            // If comparison fails, fall through to default behavior
            console.warn('NewSync: Failed to diff settings; proceeding with default handling', e);
        }
        
        // Check if lyrics are currently displayed
        const lyricsContainer = document.querySelector('#lyrics-plus-container');
        if (!lyricsContainer || lyricsContainer.classList.contains('lyrics-plus-message')) {
            console.log('NewSync: No lyrics currently displayed, skipping refresh');
            return; // No lyrics currently displayed
        }
        
        // Check if we have stored lyrics data
        if (typeof window.lastFetchedLyrics !== 'undefined' && window.lastFetchedLyrics) {
            console.log('NewSync: Refreshing lyrics display with new settings...', {
                wordByWord: event.data.settings.wordByWord,
                lightweight: event.data.settings.lightweight,
                largerTextMode: event.data.settings.largerTextMode,
                blurInactive: event.data.settings.blurInactive,
                fadePastLines: event.data.settings.fadePastLines,
                hideOffscreen: event.data.settings.hideOffscreen,
                compabilityWipe: event.data.settings.compabilityWipe,
                dynamicPlayerPage: event.data.settings.dynamicPlayerPage,
                dynamicPlayerFullscreen: event.data.settings.dynamicPlayerFullscreen
            });
            
            // Get current display mode
            const currentDisplayMode = window.currentDisplayMode || 'none';
            
            // Refresh the display with new settings
            lyricsRendererInstance.updateDisplayMode(
                window.lastFetchedLyrics, 
                currentDisplayMode, 
                event.data.settings
            );
        } else {
            console.log('NewSync: No stored lyrics data available for refresh');
        }
    }
});

// Create the global API for other modules to use
const LyricsPlusAPI = {
  displayLyrics: (...args) => lyricsRendererInstance.displayLyrics(...args),
  displaySongNotFound: () => lyricsRendererInstance.displaySongNotFound(),
  displaySongError: () => lyricsRendererInstance.displaySongError(),
  cleanupLyrics: () => lyricsRendererInstance.cleanupLyrics(),
  updateDisplayMode: (...args) => lyricsRendererInstance.updateDisplayMode(...args)
};

// ==========================================================================
// UP NEXT TAB BUTTONS FUNCTIONALITY
// ==========================================================================

/**
 * Creates buttons for the Up next tab that redirect to the lyrics tab
 */
function createUpNextTabButtons() {
  // Check if buttons already exist
  let buttonsWrapper = document.getElementById('upnext-buttons-wrapper');
  if (buttonsWrapper) {
    return; // Buttons already exist
  }

  // Find the tab renderer container (where all tabs are shown)
  const tabRenderer = document.querySelector('ytmusic-tab-renderer');
  if (!tabRenderer) {
    return; // Tab renderer not found
  }

  // Create buttons wrapper
  buttonsWrapper = document.createElement('div');
  buttonsWrapper.id = 'upnext-buttons-wrapper';
  buttonsWrapper.style.position = 'absolute';
  buttonsWrapper.style.bottom = '1em';
      buttonsWrapper.style.right = '-1.5em';
  buttonsWrapper.style.width = '20%';
  buttonsWrapper.style.display = 'flex';
  buttonsWrapper.style.justifyContent = 'center';
  buttonsWrapper.style.gap = '10px';
  buttonsWrapper.style.zIndex = '1000';
  tabRenderer.appendChild(buttonsWrapper);

  // Create single button (redirects to lyrics tab)
  const lyricsButton = document.createElement('button');
  lyricsButton.id = 'upnext-lyrics-button';
  lyricsButton.title = 'Lyrics';
  const lyricsButtonSVG = `<svg width="29" height="28" viewBox="0 0 29 28" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:1.5em;height:1.5em;vertical-align:middle;">
    <g clip-path="url(#clip0_1_43)">
      <mask id="mask0_1_43" style="mask-type:luminance" maskUnits="userSpaceOnUse" x="0" y="0" width="29" height="28">
        <path d="M28.5 0H0.5V28H28.5V0Z" fill="black"/>
        <g clip-path="url(#clip1_1_43)">
          <path d="M9.86969 24.5614C10.4761 24.5614 10.9405 24.2829 11.6768 23.6308L15.051 20.6615H20.7642C23.7617 20.6615 25.5 18.8905 25.5 15.9257V8.17447C25.5 5.20963 23.762 3.43863 20.7642 3.43863H8.23584C5.23834 3.43863 3.5 5.20688 3.5 8.17447V15.9257C3.5 18.8933 5.31156 20.6615 8.1255 20.6615H8.47475V22.9966C8.47475 23.9633 8.99416 24.5614 9.86934 24.5614H9.86969ZM10.4094 22.1001V19.3123C10.4094 18.6901 10.1327 18.4581 9.55481 18.4581H8.3345C6.55903 18.4581 5.70344 17.5633 5.70344 15.827V8.27313C5.70344 6.54304 6.55903 5.64963 8.3345 5.64963H20.6655C22.4355 5.64963 23.2966 6.54304 23.2966 8.27313V15.827C23.2966 17.5633 22.4355 18.4581 20.6655 18.4581H14.9084C14.2776 18.4581 13.9796 18.5715 13.5293 19.0253L10.4094 22.1001ZM9.649 11.0393C9.649 12.2073 10.3901 13.0798 11.5011 13.0798C11.969 13.0798 12.3921 12.976 12.6603 12.6456H12.7926C12.4942 13.4125 11.7613 13.9673 10.9697 14.1581C10.6431 14.2417 10.5135 14.4115 10.5135 14.648C10.5135 14.923 10.7397 15.1155 11.0326 15.1155C12.1237 15.1155 14.0576 13.8178 14.0576 11.4717C14.0576 10.0493 13.1632 8.94997 11.793 8.94997C10.5637 8.94997 9.649 9.81554 9.649 11.0393ZM15.0332 11.0393C15.0332 12.2073 15.7667 13.0798 16.8849 13.0798C17.3456 13.0798 17.7763 12.976 18.0444 12.6456H18.1785C17.8811 13.4125 17.1393 13.9673 16.3538 14.1581C16.0283 14.2417 15.8977 14.4115 15.8977 14.648C15.8977 14.923 16.1163 15.1155 16.4168 15.1155C17.5092 15.1155 19.4345 13.8178 19.4345 11.4717C19.4345 10.0493 18.5487 8.94997 17.1771 8.94997C15.9475 8.94997 15.0332 9.81554 15.0332 11.0393Z" fill="white"/>
        </g>
      </mask>
      <g mask="url(#mask0_1_43)">
        <path d="M28.5 0H0.5V28H28.5V0Z" fill="white"/>
      </g>
    </g>
    <defs>
      <clipPath id="clip0_1_43">
        <rect width="28" height="28" fill="white" transform="translate(0.5)"/>
      </clipPath>
      <clipPath id="clip1_1_43">
        <rect width="22" height="22" fill="white" transform="translate(3.5 3)"/>
      </clipPath>
    </defs>
  </svg>`;
  lyricsButton.innerHTML = lyricsButtonSVG;

  // Add click event listener to redirect to lyrics tab
  lyricsButton.addEventListener('click', () => {
    redirectToLyricsTab();
  });

  // Append button to wrapper
  buttonsWrapper.appendChild(lyricsButton);
}

/**
 * Redirects to the lyrics tab by clicking the middle tab
 */
function redirectToLyricsTab() {
  // Find all tabs
  const tabs = document.querySelectorAll('tp-yt-paper-tab.tab-header.style-scope.ytmusic-player-page');
  
  if (tabs.length >= 3) {
    // Click the middle tab (index 1 for 3 tabs, or middle for more tabs)
    const middleIndex = Math.floor(tabs.length / 2);
    const lyricsTab = tabs[middleIndex];
    
    if (lyricsTab) {
      lyricsTab.click();
    }
  }
}

/**
 * Initialize Up next tab buttons when DOM is ready
 */
function initUpNextTabButtons() {
  // Wait for tabs to be available
  const checkForTabs = () => {
    const tabs = document.querySelectorAll('tp-yt-paper-tab.tab-header.style-scope.ytmusic-player-page');
    
    if (tabs.length >= 3) {
      createUpNextTabButtons();
    } else {
      // Check again after a short delay
      setTimeout(checkForTabs, 500);
    }
  };

  // Start checking for tabs
  checkForTabs();
}

// Initialize the Up next tab buttons when the page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initUpNextTabButtons);
} else {
  // DOM is already loaded
  initUpNextTabButtons();
}

/**
 * Check which tab is currently active and show/hide buttons accordingly
 */
function manageUpNextButtons() {
  const buttonsWrapper = document.getElementById('upnext-buttons-wrapper');
  if (!buttonsWrapper) return;

  // Check if we're currently on the lyrics tab
  const lyricsContainer = document.getElementById('lyrics-plus-container');
  const isOnLyricsTab = lyricsContainer && 
                       lyricsContainer.style.display === 'block' && 
                       lyricsContainer.offsetParent !== null;

  // Also check if lyrics buttons wrapper exists (indicates we're on lyrics tab)
  const lyricsButtonsWrapper = document.getElementById('lyrics-plus-buttons-wrapper');
  const lyricsButtonsVisible = lyricsButtonsWrapper && 
                              lyricsButtonsWrapper.style.display !== 'none' && 
                              lyricsButtonsWrapper.offsetParent !== null;

  // Show buttons only when NOT on lyrics tab
  if (isOnLyricsTab || lyricsButtonsVisible) {
    buttonsWrapper.style.display = 'none';
    buttonsWrapper.style.visibility = 'hidden';
  } else {
    buttonsWrapper.style.display = 'flex';
    buttonsWrapper.style.visibility = 'visible';
  }
}

/**
 * Auto-redirect to lyrics tab when entering fullscreen mode
 */
function autoRedirectToLyricsInFullscreen() {
  const playerPage = document.querySelector('ytmusic-player-page');
  if (!playerPage) {
    return;
  }
  
  const isFullscreen = playerPage.hasAttribute('player-fullscreened');
  if (!isFullscreen) return;
  
  // Check if we're already on lyrics tab
  const tabs = document.querySelectorAll('tp-yt-paper-tab.tab-header.style-scope.ytmusic-player-page');
  if (tabs.length < 2) {
    return;
  }
  
  // Find the active tab
  const activeTab = document.querySelector('tp-yt-paper-tab.tab-header.style-scope.ytmusic-player-page.iron-selected');
  if (!activeTab) {
    return;
  }
  
  // Get tab index and all tab texts for debugging
  const allTabs = Array.from(activeTab.parentElement.children);
  const tabIndex = allTabs.indexOf(activeTab);
  
  // Find lyrics tab by text content (more reliable)
  let lyricsTabIndex = -1;
  allTabs.forEach((tab, index) => {
    const tabText = tab.textContent.trim().toLowerCase();
    if (tabText.includes('lyrics') || tabText.includes('lirik')) {
      lyricsTabIndex = index;
    }
  });
  
  // If not on lyrics tab, auto-redirect
  if (tabIndex !== lyricsTabIndex && lyricsTabIndex !== -1) {
    // Use the correctly found lyrics tab
    const lyricsTab = allTabs[lyricsTabIndex];
    
    // Method 1: Direct click
    lyricsTab.click();
    
    // Method 2: Dispatch click event (immediate fallback)
    lyricsTab.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window
    }));
  }
}

// Also initialize when navigating between pages (for SPA behavior)
const observer = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    if (mutation.type === 'childList') {
      // Check if tabs were added/removed
      const tabs = document.querySelectorAll('tp-yt-paper-tab.tab-header.style-scope.ytmusic-player-page');
      if (tabs.length >= 3 && !document.getElementById('upnext-buttons-wrapper')) {
        createUpNextTabButtons();
      }
      
      // Manage button visibility based on current tab
      manageUpNextButtons();
    }
    
    // Watch for changes in the lyrics container display
    if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
      manageUpNextButtons();
    }
    
    // Watch for fullscreen changes and auto-redirect to lyrics
    if (mutation.type === 'attributes' && mutation.attributeName === 'player-fullscreened') {
      // Instant redirect - no delay
      autoRedirectToLyricsInFullscreen();
      
      // Also show song info immediately when entering fullscreen
      const playerPage = mutation.target;
      const isFullscreen = playerPage.hasAttribute('player-fullscreened');
      const isVideoMode = playerPage.hasAttribute('video-mode');
      
      if (isFullscreen && !isVideoMode) {
        console.log('LYPLUS: Global observer detected fullscreen, adding song info immediately');
        // Use the renderer instance to add song info
        if (window.lyricsRendererInstance) {
          window.lyricsRendererInstance._addSongInfoFromDOM();
        }
      } else if (!isFullscreen) {
        // Remove song info when exiting fullscreen
        const existingSongInfo = document.querySelector('.lyrics-song-info');
        if (existingSongInfo) {
          existingSongInfo.remove();
        }
      }
    }
  });
});

// Start observing for tab changes
observer.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['style', 'player-fullscreened']
});

// Also check tab changes when tabs are clicked
document.addEventListener('click', (event) => {
  if (event.target.matches('tp-yt-paper-tab.tab-header.style-scope.ytmusic-player-page')) {
    setTimeout(manageUpNextButtons, 100); // Small delay to allow tab switch
    setTimeout(manageUpNextButtons, 500); // Double check after longer delay
  }
});

// Observe ytmusic-player-page specifically for fullscreen changes
function setupPlayerPageObserver() {
  const playerPage = document.querySelector('ytmusic-player-page');
  if (playerPage) {
    const playerObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'player-fullscreened') {
          // Instant redirect - no delay
          autoRedirectToLyricsInFullscreen();
        }
      });
    });
    
    playerObserver.observe(playerPage, {
      attributes: true,
      attributeFilter: ['player-fullscreened']
    });
  }
}

// Setup player page observer when available
setupPlayerPageObserver();

// Additional immediate fullscreen observer for song info
function setupImmediateSongInfoObserver() {
  const playerPage = document.querySelector('ytmusic-player-page');
  if (playerPage) {
    console.log('LYPLUS: Setting up immediate song info observer on player page');
    
    const immediateObserver = new MutationObserver((mutations) => {
      console.log('LYPLUS: Mutation detected:', mutations.length, 'mutations');
      mutations.forEach((mutation) => {
        console.log('LYPLUS: Mutation details:', {
          type: mutation.type,
          attributeName: mutation.attributeName,
          target: mutation.target.tagName
        });
        
        if (mutation.type === 'attributes' && mutation.attributeName === 'player-fullscreened') {
          const isFullscreen = mutation.target.hasAttribute('player-fullscreened');
          const isVideoMode = mutation.target.hasAttribute('video-mode');
          
          console.log('LYPLUS: Immediate observer detected fullscreen change:', { isFullscreen, isVideoMode });
          
          if (isFullscreen && !isVideoMode) {
            console.log('LYPLUS: FULLSCREEN DETECTED - Adding song info NOW!');
            // Add song info immediately - no waiting
            if (window.lyricsRendererInstance) {
              console.log('LYPLUS: Calling _addSongInfoFromDOM immediately');
              window.lyricsRendererInstance._addSongInfoFromDOM();
            } else {
              console.error('LYPLUS: lyricsRendererInstance not available!');
            }
          } else if (!isFullscreen) {
            console.log('LYPLUS: Exiting fullscreen - removing song info');
            // Remove song info immediately when exiting fullscreen
            const existingSongInfo = document.querySelector('.lyrics-song-info');
            if (existingSongInfo) {
              existingSongInfo.remove();
            }
          }
        }
      });
    });
    
    immediateObserver.observe(playerPage, {
      attributes: true,
      attributeFilter: ['player-fullscreened', 'video-mode']
    });
    
    console.log('LYPLUS: Immediate song info observer setup complete');
  } else {
    console.log('LYPLUS: Player page not found, retrying in 500ms');
    // Retry if player page not ready yet
    setTimeout(setupImmediateSongInfoObserver, 500);
  }
}

// Setup immediate observer
setupImmediateSongInfoObserver();
setTimeout(setupPlayerPageObserver, 1000); // Retry after delay

// Aggressive fallback: Check for fullscreen every 100ms
let fullscreenCheckInterval = null;
function startFullscreenCheck() {
  if (fullscreenCheckInterval) return; // Already running
  
  console.log('LYPLUS: Starting aggressive fullscreen check');
  fullscreenCheckInterval = setInterval(() => {
    const playerPage = document.querySelector('ytmusic-player-page');
    if (playerPage) {
      const isFullscreen = playerPage.hasAttribute('player-fullscreened');
      const isVideoMode = playerPage.hasAttribute('video-mode');
      
      // Check if we should show song info but it's not there
      if (isFullscreen && !isVideoMode) {
        const existingSongInfo = document.querySelector('.lyrics-song-info');
        if (!existingSongInfo && window.lyricsRendererInstance) {
          console.log('LYPLUS: AGGRESSIVE CHECK - Fullscreen detected but no song info, adding now!');
          window.lyricsRendererInstance._addSongInfoFromDOM();
        }
      }
    }
  }, 100); // Check every 100ms
}

// Start aggressive check after a delay
setTimeout(startFullscreenCheck, 2000);

// Additional fallback: Listen for fullscreen events
document.addEventListener('fullscreenchange', () => {
  autoRedirectToLyricsInFullscreen();
});

// Additional fallback: Listen for keyboard shortcuts (F key for fullscreen)
document.addEventListener('keydown', (event) => {
  if (event.key === 'f' || event.key === 'F') {
    autoRedirectToLyricsInFullscreen();
  }
});

// Additional fallback: Periodic check when in fullscreen
setInterval(() => {
  const playerPage = document.querySelector('ytmusic-player-page');
  if (playerPage && playerPage.hasAttribute('player-fullscreened')) {
    // Only auto-redirect if we're not on lyrics tab
    const activeTab = document.querySelector('tp-yt-paper-tab.tab-header.style-scope.ytmusic-player-page.iron-selected');
    if (activeTab) {
      const tabText = activeTab.textContent.trim().toLowerCase();
      // Check if current tab is NOT lyrics
      if (!tabText.includes('lyrics') && !tabText.includes('lirik')) {
        autoRedirectToLyricsInFullscreen();
      }
    }
  }
}, 2000); // Check every 2 seconds

// Periodic check to ensure buttons are managed correctly
setInterval(() => {
  if (document.getElementById('upnext-buttons-wrapper')) {
    manageUpNextButtons();
  }
}, 1000); // Check every second


