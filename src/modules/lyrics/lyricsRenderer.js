class LyricsPlusRenderer {
  /**
   * Constructor for the LyricsPlusRenderer.
   * Initializes state variables and sets up the initial environment for the lyrics display.
   * @param {object} uiConfig - Configuration for UI element selectors.
   */
  constructor(uiConfig) {
    this.lyricsAnimationFrameId = null;
    this.currentPrimaryActiveLine = null;
    this.lastPrimaryActiveLine = null;
    this.currentFullscreenFocusedLine = null;
    this.lastTime = 0;
    this.lastProcessedTime = 0;

    this.uiConfig = uiConfig;
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
    this._cachedContainerRect = null;
    this._debouncedResizeHandler = this._debounce(
      this._handleContainerResize,
      1,
      { leading: true, trailing: true }
    );

    this.translationButton = null;
    this.reloadButton = null;
    this.dropdownMenu = null;

    this.isProgrammaticScrolling = false;
    this.endProgrammaticScrollTimer = null;
    this.scrollEventHandlerAttached = false;
    this.currentScrollOffset = 0;
    this.touchStartY = 0;
    this.isTouching = false;
    this.userScrollIdleTimer = null;
    this.isUserControllingScroll = false;
    this.userScrollRevertTimer = null;

    this._getContainer();
  }

  /**
   * Generic debounce utility.
   * @param {Function} func - The function to debounce.
   * @param {number} delay - The debounce delay in milliseconds.
   * @returns {Function} - The debounced function.
   */
  _debounce(func, delay, { leading = false, trailing = true } = {}) {
    let timeout = null;
    let lastArgs = null;
    let lastThis = null;
    let result;

    const invoke = () => {
      timeout = null;
      if (trailing && lastArgs) {
        result = func.apply(lastThis, lastArgs);
        lastArgs = lastThis = null;
      }
    };

    function debounced(...args) {
      lastArgs = args;
      lastThis = this;

      if (timeout) clearTimeout(timeout);

      const callNow = leading && !timeout;
      timeout = setTimeout(invoke, delay);

      if (callNow) {
        result = func.apply(lastThis, lastArgs);
        lastArgs = lastThis = null;
      }

      return result;
    }

    debounced.cancel = () => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      lastArgs = lastThis = null;
    };

    debounced.flush = () => {
      if (timeout) {
        clearTimeout(timeout);
        invoke();
      }
      return result;
    };

    return debounced;
  }

  _getDataText(normal, isOriginal = true) {
    if (!normal) return "";

    if (this.largerTextMode === "romanization") {
      if (isOriginal) {
        // Main/background container in romanization mode: show romanized
        return normal.romanizedText || normal.text || "";
      } else {
        // Romanization container in romanization mode: show original
        return normal.text || "";
      }
    } else {
      if (isOriginal) {
        // Main/background container in normal mode: show original
        return normal.text || "";
      } else {
        // Romanization container in normal mode: show romanized (if available)
        return normal.romanizedText || normal.text || "";
      }
    }
  }

  /**
   * Handles the actual logic for container resize, debounced by _debouncedResizeHandler.
   * @param {HTMLElement} container - The lyrics container element.
   * @private
   */
  _handleContainerResize(container, rect) {
    if (!container) return;

    const containerTop =
      rect && typeof rect.top === "number"
        ? rect.top
        : container.getBoundingClientRect().top;

    this._cachedContainerRect = {
      containerTop: containerTop - 50,
      scrollContainerTop: containerTop - 50,
    };

    if (!this.isUserControllingScroll && this.currentPrimaryActiveLine) {
      this._scrollToActiveLine(this.currentPrimaryActiveLine, false);
    }
  }

  /**
   * A helper method to determine if a text string contains Right-to-Left characters.
   * @param {string} text - The text to check.
   * @returns {boolean} - True if the text contains RTL characters.
   */
  _isRTL(text) {
    return /[\u0600-\u06FF\u0750-\u077F\u0590-\u05FF\u08A0-\u08FF\uFB50-\uFDCF\uFDF0-\uFDFF\uFE70-\uFEFF]/.test(
      text
    );
  }

  /**
   * A helper method to determine if a text string contains CJK characters.
   * @param {string} text - The text to check.
   * @returns {boolean} - True if the text contains CJK characters.
   */
  _isCJK(text) {
    return /[\u4E00-\u9FFF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/.test(
      text
    );
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
    return /^[\p{Script=Latin}\p{N}\p{P}\p{S}\s]*$/u.test(text);
  }

  /**
   * Gets a reference to the lyrics container, creating it if it doesn't exist.
   * This method ensures the container and its scroll listeners are always ready.
   * @returns {HTMLElement | null} - The lyrics container element.
   */
  _getContainer() {
    if (!this.lyricsContainer) {
      this.lyricsContainer = document.getElementById("lyrics-plus-container");
      if (!this.lyricsContainer) {
        this._createLyricsContainer();
      }
    }
    if (
      this.lyricsContainer &&
      this.lyricsContainer.parentElement &&
      !this.scrollEventHandlerAttached
    ) {
      this._setupUserScrollListener();
    }
    return this.lyricsContainer;
  }

  /**
   * Creates the main container for the lyrics and appends it to the DOM.
   * @returns {HTMLElement | null} - The newly created container element.
   */
  _createLyricsContainer() {
    const originalLyricsSection = document.querySelector(
      this.uiConfig.patchParent
    );
    if (!originalLyricsSection) {
      console.log("Unable to find " + this.uiConfig.patchParent);
      this.lyricsContainer = null;
      return null;
    }
    const container = document.createElement("div");
    container.id = "lyrics-plus-container";
    container.classList.add("lyrics-plus-integrated", "blur-inactive-enabled");
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

    this.touchState = {
      isActive: false,
      startY: 0,
      lastY: 0,
      velocity: 0,
      lastTime: 0,
      momentum: null,
      samples: [],
      maxSamples: 5,
    };

    if (parentScrollElement) {
      parentScrollElement.addEventListener(
        "scroll",
        () => {
          if (this.isProgrammaticScrolling) {
            clearTimeout(this.endProgrammaticScrollTimer);
            this.endProgrammaticScrollTimer = setTimeout(() => {
              this.isProgrammaticScrolling = false;
              this.endProgrammaticScrollTimer = null;
            }, 250);
            return;
          }
          if (this.lyricsContainer) {
            this.lyricsContainer.classList.add("not-focused");
          }
        },
        { passive: true }
      );
    }

    scrollListeningElement.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.isProgrammaticScrolling = false;
        if (this.lyricsContainer) {
          this.lyricsContainer.classList.add(
            "not-focused",
            "user-scrolling",
            "wheel-scrolling"
          );
          this.lyricsContainer.classList.remove("touch-scrolling");
        }
        const scrollAmount = event.deltaY;
        this._handleUserScroll(scrollAmount);
        clearTimeout(this.userScrollIdleTimer);
        this.userScrollIdleTimer = setTimeout(() => {
          if (this.lyricsContainer) {
            this.lyricsContainer.classList.remove(
              "user-scrolling",
              "wheel-scrolling"
            );
          }
        }, 200);
      },
      { passive: false }
    );

    scrollListeningElement.addEventListener(
      "touchstart",
      (event) => {
        const touch = event.touches[0];
        const now = performance.now();

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
          this.lyricsContainer.classList.add(
            "not-focused",
            "user-scrolling",
            "touch-scrolling"
          );
          this.lyricsContainer.classList.remove("wheel-scrolling");
        }
        clearTimeout(this.userScrollIdleTimer);
      },
      { passive: true }
    );

    scrollListeningElement.addEventListener(
      "touchmove",
      (event) => {
        if (!this.touchState.isActive) return;

        event.preventDefault();
        const touch = event.touches[0];
        const now = performance.now();
        const currentY = touch.clientY;
        const deltaY = this.touchState.lastY - currentY;

        this.touchState.lastY = currentY;

        this.touchState.samples.push({ y: currentY, time: now });
        if (this.touchState.samples.length > this.touchState.maxSamples) {
          this.touchState.samples.shift();
        }

        // Apply immediate scroll with reduced sensitivity for smoother feel
        this._handleUserScroll(deltaY * 0.8);
      },
      { passive: false }
    );

    scrollListeningElement.addEventListener(
      "touchend",
      (event) => {
        if (!this.touchState.isActive) return;

        this.touchState.isActive = false;

        const now = performance.now();
        const samples = this.touchState.samples;

        if (samples.length >= 2) {
          // Use samples from last 100ms for velocity calculation
          const recentSamples = samples.filter(
            (sample) => now - sample.time <= 100
          );

          if (recentSamples.length >= 2) {
            const newest = recentSamples[recentSamples.length - 1];
            const oldest = recentSamples[0];
            const timeDelta = newest.time - oldest.time;
            const yDelta = oldest.y - newest.y;

            if (timeDelta > 0) {
              this.touchState.velocity = yDelta / timeDelta;
            }
          }
        }

        const minVelocity = 0.1;
        if (Math.abs(this.touchState.velocity) > minVelocity) {
          this._startMomentumScroll();
        } else {
          this._endTouchScrolling();
        }
      },
      { passive: true }
    );

    scrollListeningElement.addEventListener(
      "touchcancel",
      () => {
        this.touchState.isActive = false;
        if (this.touchState.momentum) {
          cancelAnimationFrame(this.touchState.momentum);
          this.touchState.momentum = null;
        }
        this._endTouchScrolling();
      },
      { passive: true }
    );

    this.scrollEventHandlerAttached = true;
  }

  /**
   * Starts momentum scrolling after touch end.
   * @private
   */
  _startMomentumScroll() {
    const deceleration = 0.95;
    const minVelocity = 0.01;

    const animate = () => {
      const scrollDelta = this.touchState.velocity * 16;
      this._handleUserScroll(scrollDelta);

      this.touchState.velocity *= deceleration;

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
   * Cleans up touch scrolling state.
   * @private
   */
  _endTouchScrolling() {
    if (this.lyricsContainer) {
      this.lyricsContainer.classList.remove(
        "user-scrolling",
        "touch-scrolling"
      );
    }

    this.touchState.velocity = 0;
    this.touchState.samples = [];
  }

  /**
   * Handles the logic for manual user scrolling, calculating and clamping the new scroll position.
   * Also sets a timer to automatically resume player-controlled scrolling after a period of user inactivity.
   * @param {number} delta - The amount to scroll by.
   */
  _handleUserScroll(delta) {
    this.isUserControllingScroll = true;
    clearTimeout(this.userScrollRevertTimer);

    this.userScrollRevertTimer = setTimeout(() => {
      this.isUserControllingScroll = false;
      if (this.currentPrimaryActiveLine) {
        this._scrollToActiveLine(this.currentPrimaryActiveLine, true);
      }
    }, 4000);

    const scrollSensitivity = 0.7;
    let newScrollOffset = this.currentScrollOffset - delta * scrollSensitivity;

    const container = this._getContainer();
    if (!container) {
      this._animateScroll(newScrollOffset);
      return;
    }

    const allScrollableElements = Array.from(
      container.querySelectorAll(
        ".lyrics-line, .lyrics-plus-metadata, .lyrics-plus-empty"
      )
    );
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
      const contentTotalHeight =
        lastElement.offsetTop +
        lastElement.offsetHeight -
        firstElement.offsetTop;
      if (contentTotalHeight > containerHeight) {
        maxAllowedScroll =
          containerHeight - (lastElement.offsetTop + lastElement.offsetHeight);
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
        if (overlap >= 0.1) {
          currentLine.newEndTime = nextLine.newEndTime;
        } else {
          currentLine.newEndTime = currentLine.originalEndTime;
        }
      } else {
        const gap = nextLine.startTime - currentLine.originalEndTime;
        const nextElement = currentLine.element.nextElementSibling;
        const isFollowedByManualGap =
          nextElement && nextElement.classList.contains("lyrics-gap");
        if (gap > 0 && !isFollowedByManualGap) {
          const extension = Math.min(1.3, gap);
          currentLine.newEndTime = currentLine.originalEndTime + extension;
        }
      }
    }

    linesData.forEach((lineData) => {
      lineData.element.dataset.actualEndTime =
        lineData.originalEndTime.toFixed(3);
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
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    
    const time = parseFloat(e.currentTarget.dataset.startTime);
    if (isNaN(time)) {
      console.warn('LyricsPlus: Invalid startTime in lyric click', e.currentTarget.dataset);
      return;
    }
    
    const seekTime = time - 0.05;
    console.log('LyricsPlus: Seeking to', seekTime, 'from lyric click');
    this._seekPlayerTo(seekTime);
    this._scrollToActiveLine(e.currentTarget, true);
  }

  /**
   * Internal helper to render word-by-word lyrics.
   * @private
   */
  _renderWordByWordLyrics(
    lyrics,
    displayMode,
    singerClassMap,
    lightweight,
    elementPool,
    fragment
  ) {
    const getComputedFont = (element) => {
      if (!element) return "400 16px sans-serif";
      const cacheKey = element.tagName + (element.className || "");
      if (this.fontCache[cacheKey]) return this.fontCache[cacheKey];
      const style = getComputedStyle(element);
      const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      this.fontCache[cacheKey] = font;
      return font;
    };

    /**
     * Calculate pre-highlight delay based on exact wipe effect positioning.
     * @param {HTMLElement} syllable - The current syllable element.
     * @param {string} font - The computed font string.
     * @param {number} currentDuration - Duration of current syllable in ms.
     * @returns {number} Delay in milliseconds (negative for early start).
     */
    const calculatePreHighlightDelay = (syllable, font, currentDuration) => {
      const syllableWidthPx = this._getTextWidth(syllable.textContent, font);
      const emWidthPx = this._getTextWidth("M", font);
      const syllableWidthEm = syllableWidthPx / emWidthPx;

      const gradientWidth = 0.75;
      const gradientHalfWidth = gradientWidth / 2;
      const initialGradientPosition = -gradientHalfWidth;
      const finalGradientPosition = syllableWidthEm + gradientHalfWidth;
      const totalAnimationDistance =
        finalGradientPosition - initialGradientPosition;

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

      return Math.round(rawDelayMs);
    };

    lyrics.data.forEach((line) => {
      let currentLine =
        elementPool.lines.pop() || document.createElement("div");
      currentLine.innerHTML = "";
      currentLine.className = "lyrics-line";
      currentLine.dataset.startTime = line.startTime;
      currentLine.dataset.endTime = line.endTime;
      const singerClass = line.element?.singer
        ? singerClassMap[line.element.singer] || "singer-left"
        : "singer-left";
      currentLine.classList.add(singerClass);
      if (!currentLine.hasClickListener) {
        currentLine.addEventListener("click", this._onLyricClick.bind(this));
        currentLine.hasClickListener = true;
      }

      const mainContainer = document.createElement("div");
      mainContainer.classList.add("main-vocal-container");
      currentLine.appendChild(mainContainer);

      this._renderTranslationContainer(currentLine, line, displayMode);

      let backgroundContainer = null;
      let wordBuffer = [];
      let currentWordStartTime = null;
      let currentWordEndTime = null;

      // Variables to hold the last syllable of the previous word to link across words
      let pendingSyllable = null;
      let pendingSyllableFont = null;

      const flushWordBuffer = () => {
        if (!wordBuffer.length) return;

        const wordSpan =
          elementPool.syllables.pop() || document.createElement("span");
        wordSpan.innerHTML = "";
        wordSpan.className = "lyrics-word";
        let referenceFont = mainContainer.firstChild
          ? getComputedFont(mainContainer.firstChild)
          : "400 16px sans-serif";
        const combinedText = wordBuffer.map((s) => this._getDataText(s)).join("");
        const totalDuration = currentWordEndTime - currentWordStartTime;
        const shouldEmphasize =
          !lightweight &&
          !this._isRTL(combinedText) &&
          !this._isCJK(combinedText) &&
          combinedText.trim().length <= 7 &&
          totalDuration >= 1000;

        let easedProgress = 0;
        let actualDecayRate = 0;
        let penaltyFactor = 1.0;
        if (shouldEmphasize) {
          const minDuration = 1000;
          const maxDuration = 2000;
          const easingPower = 3.0;

          const progress = Math.min(
            1,
            Math.max(
              0,
              (totalDuration - minDuration) / (maxDuration - minDuration)
            )
          );
          easedProgress = Math.pow(progress, easingPower);

          const durationProgressForDecay = Math.min(1, Math.max(0, (totalDuration - minDuration) / (maxDuration - minDuration)));
          const decayStrength = 1 - durationProgressForDecay;
          const maxDecayRate = 0.75;
          actualDecayRate = maxDecayRate * decayStrength;

          if (wordBuffer.length > 1) {
            const firstSyllableDuration = wordBuffer[0].duration;
            const imbalanceRatio = firstSyllableDuration / totalDuration;

            const penaltyThreshold = 0.25;

            if (imbalanceRatio < penaltyThreshold) {
              const minPenaltyFactor = 0.4;

              const penaltyProgress = imbalanceRatio / penaltyThreshold;
              penaltyFactor = minPenaltyFactor + (1.0 - minPenaltyFactor) * penaltyProgress;
            }
          }
        }

        wordSpan.style.setProperty(
          "--min-scale",
          Math.max(1.0, Math.min(1.06, 1.02))
        );
        wordSpan.dataset.totalDuration = totalDuration;

        let isCurrentWordBackground = wordBuffer[0].isBackground || false;
        const characterData = [];

        const syllableElements = [];

        wordBuffer.forEach((s, syllableIndex) => {
          const sylSpan =
            elementPool.syllables.pop() || document.createElement("span");
          sylSpan.innerHTML = "";
          sylSpan.className = "lyrics-syllable";

          sylSpan.dataset.startTime = s.time;
          sylSpan.dataset.duration = s.duration;
          sylSpan.dataset.endTime = s.time + s.duration;
          sylSpan.dataset.wordDuration = totalDuration;
          sylSpan.dataset.syllableIndex = syllableIndex;

          sylSpan._startTimeMs = s.time;
          sylSpan._durationMs = s.duration;
          sylSpan._endTimeMs = s.time + s.duration;
          sylSpan._wordDurationMs = totalDuration;

          if (this._isRTL(this._getDataText(s, true)))
            sylSpan.classList.add("rtl-text");

          syllableElements.push(sylSpan);

          const charSpansForSyllable = [];

          if (s.isBackground) {
            sylSpan.textContent = this._getDataText(s).replace(/[()]/g, "");
          } else {
            if (shouldEmphasize) {
              wordSpan.classList.add("growable");
              const syllableText = this._getDataText(s);
              const totalSyllableWidth = this._getTextWidth(
                syllableText,
                referenceFont
              );
              let cumulativeCharWidth = 0;
              let charIndex = 0;

              syllableText.split("").forEach((char) => {
                if (char === " ") {
                  sylSpan.appendChild(document.createTextNode(" "));
                } else {
                  const charSpan =
                    elementPool.chars.pop() || document.createElement("span");
                  charSpan.textContent = char;
                  charSpan.className = "char";

                  const charWidth = this._getTextWidth(char, referenceFont);
                  if (totalSyllableWidth > 0) {
                    const startPercent =
                      cumulativeCharWidth / totalSyllableWidth;
                    const durationPercent = charWidth / totalSyllableWidth;
                    charSpan.dataset.wipeStart = startPercent.toFixed(4);
                    charSpan.dataset.wipeDuration = durationPercent.toFixed(4);
                  }
                  cumulativeCharWidth += charWidth;

                  charSpan.dataset.charIndex = charIndex++;
                  charSpan.dataset.syllableCharIndex = characterData.length;
                  characterData.push({
                    charSpan,
                    syllableSpan: sylSpan,
                    isBackground: s.isBackground,
                  });
                  charSpansForSyllable.push(charSpan);
                  sylSpan.appendChild(charSpan);
                }
              });
            } else {
              sylSpan.textContent = this._getDataText(s);
            }
          }
          if (charSpansForSyllable.length > 0) {
            sylSpan._cachedCharSpans = charSpansForSyllable;
          }
          wordSpan.appendChild(sylSpan);
        });

        // Handle pending syllable from previous word (cross-word linking)
        if (pendingSyllable && syllableElements.length > 0) {
          const nextSyllable = syllableElements[0];
          const currentDuration = pendingSyllable._durationMs;

          const delayMs = calculatePreHighlightDelay(
            pendingSyllable,
            pendingSyllableFont,
            currentDuration
          ) * 1.03;

          pendingSyllable._nextSyllableInWord = nextSyllable;
          //avoid bleeding lmao
          pendingSyllable._preHighlightDurationMs = currentDuration - delayMs;
          pendingSyllable._preHighlightDelayMs = delayMs;
        }

        if (shouldEmphasize) {
          wordSpan._cachedChars = characterData.map((cd) => cd.charSpan);
        }

        // Handle syllables within the same word (intra-word linking)
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
            syllable._preHighlightDurationMs = currentDuration - delayMs;
            syllable._preHighlightDelayMs = delayMs;
          }
        });

        if (shouldEmphasize && wordSpan._cachedChars?.length > 0) {
          const wordWidth = this._getTextWidth(
            wordSpan.textContent,
            referenceFont
          );
          let cumulativeWidth = 0;

          const numChars = wordSpan._cachedChars.length;
          wordSpan._cachedChars.forEach((span, index) => {
            const powerDecayFactor = 1.0 - (index / (numChars > 1 ? numChars - 1 : 1)) * actualDecayRate;

            const charProgress = easedProgress * powerDecayFactor * penaltyFactor;

            const charMaxScale = 1.0 + 0.05 + charProgress * 0.1;
            const charShadowIntensity = 0.4 + charProgress * 0.4;
            const normalizedGrowth = (charMaxScale - 1.0) / 0.13;
            const charTranslateYPeak = -normalizedGrowth * 2.5;

            span.style.setProperty("--max-scale", charMaxScale.toFixed(3));
            span.style.setProperty("--shadow-intensity", charShadowIntensity.toFixed(3));
            span.style.setProperty("--translate-y-peak", charTranslateYPeak.toFixed(3));

            const charWidth = this._getTextWidth(span.textContent, referenceFont);
            const position = (cumulativeWidth + charWidth / 2) / wordWidth;
            const horizontalOffset = (position - 0.5) * 2 * ((charMaxScale - 1.0) * 25);

            span.dataset.horizontalOffset = horizontalOffset;
            span.dataset.position = position;
            cumulativeWidth += charWidth;
          });
        }

        const targetContainer = isCurrentWordBackground
          ? backgroundContainer ||
          ((backgroundContainer = document.createElement("div")),
            (backgroundContainer.className = "background-vocal-container"),
            currentLine.appendChild(backgroundContainer))
          : mainContainer;
        targetContainer.appendChild(wordSpan);
        const trailText = combinedText.match(/\s+$/)
        if (trailText) targetContainer.appendChild(document.createTextNode(trailText));

        pendingSyllable =
          syllableElements.length > 0
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
          const isLastSyllableInLine =
            syllableIndex === line.syllabus.length - 1;
          const nextSyllable = line.syllabus[syllableIndex + 1];
          const endsWithExplicitDelimiter =
            s.isLineEnding || /\s$/.test(this._getDataText(s));
          const isBackgroundStatusChanging =
            nextSyllable &&
            s.isBackground !== nextSyllable.isBackground &&
            !endsWithExplicitDelimiter;
          if (
            endsWithExplicitDelimiter ||
            isLastSyllableInLine ||
            isBackgroundStatusChanging
          ) {
            flushWordBuffer();
          }
        });
      } else {
        mainContainer.textContent = line.text;
      }
      if (this._isRTL(mainContainer.textContent))
        mainContainer.classList.add("rtl-text");
      if (this._isRTL(mainContainer.textContent))
        currentLine.classList.add("rtl-text");
      fragment.appendChild(currentLine);
    });
  }

  /**
   * Internal helper to render line-by-line lyrics.
   * @private
   */
  _renderLineByLineLyrics(
    lyrics,
    displayMode,
    singerClassMap,
    elementPool,
    fragment
  ) {
    const lineFragment = document.createDocumentFragment();
    lyrics.data.forEach((line) => {
      const lineDiv = elementPool.lines.pop() || document.createElement("div");
      lineDiv.innerHTML = "";
      lineDiv.className = "lyrics-line";
      lineDiv.dataset.startTime = line.startTime;
      lineDiv.dataset.endTime = line.endTime;
      const singerClass = line.element?.singer
        ? singerClassMap[line.element.singer] || "singer-left"
        : "singer-left";
      lineDiv.classList.add(singerClass);
      if (this._isRTL(this._getDataText(line, true)))
        lineDiv.classList.add("rtl-text");
      if (!lineDiv.hasClickListener) {
        lineDiv.addEventListener("click", this._onLyricClick.bind(this));
        lineDiv.hasClickListener = true;
      }
      const mainContainer = document.createElement("div");
      mainContainer.className = "main-vocal-container";
      mainContainer.textContent = this._getDataText(line);
      if (this._isRTL(this._getDataText(line, true)))
        mainContainer.classList.add("rtl-text");
      lineDiv.appendChild(mainContainer);
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
    container.classList.remove(
      "lyrics-translated",
      "lyrics-romanized",
      "lyrics-both-modes"
    );
    if (displayMode === "translate")
      container.classList.add("lyrics-translated");
    else if (displayMode === "romanize")
      container.classList.add("lyrics-romanized");
    else if (displayMode === "both")
      container.classList.add("lyrics-both-modes");
  }

  /**
   * Renders the translation/romanization container for a given lyric line.
   * @param {HTMLElement} lineElement - The DOM element for the lyric line.
   * @param {object} lineData - The data object for the lyric line (from lyrics.data).
   * @param {string} displayMode - The current display mode ('none', 'translate', 'romanize', 'both').
   * @private
   */
  _renderTranslationContainer(lineElement, lineData, displayMode) {
    if (displayMode === "romanize" || displayMode === "both") {
      if (!this._isPurelyLatinScript(lineData.text)) {
        if (
          lineData.syllabus &&
          lineData.syllabus.length > 0 &&
          lineData.syllabus.some((s) => s.romanizedText)
        ) {
          const romanizationContainer = document.createElement("div");
          romanizationContainer.classList.add("lyrics-romanization-container");
          lineData.syllabus.forEach((syllable) => {
            const romanizedText = this._getDataText(syllable, false);
            if (romanizedText) {
              const sylSpan = document.createElement("span");
              sylSpan.className = "lyrics-syllable";
              sylSpan.textContent = romanizedText;
              if (this._isRTL(romanizedText)) sylSpan.classList.add("rtl-text");
              sylSpan.dataset.startTime = syllable.time;
              sylSpan.dataset.duration = syllable.duration;
              sylSpan.dataset.endTime = syllable.time + syllable.duration;
              sylSpan._startTimeMs = syllable.time;
              sylSpan._durationMs = syllable.duration;
              sylSpan._endTimeMs = syllable.time + syllable.duration;
              romanizationContainer.appendChild(sylSpan);
              const trailText = romanizedText.match(/\s+$/)
              if (trailText) romanizationContainer.appendChild(document.createTextNode(trailText));
            }
          });

          if (this._isRTL(romanizationContainer.textContent))
            romanizationContainer.classList.add("rtl-text");
          if (romanizationContainer.children.length > 0) {
            lineElement.appendChild(romanizationContainer);
          }
        } else if (
          lineData.romanizedText &&
          lineData.text.trim() !== lineData.romanizedText.trim()
        ) {
          const romanizationContainer = document.createElement("div");
          romanizationContainer.classList.add("lyrics-romanization-container");
          const romanizedText = this._getDataText(lineData, false);
          romanizationContainer.textContent = romanizedText;
          if (this._isRTL(romanizationContainer.textContent))
            romanizationContainer.classList.add("rtl-text");
          lineElement.appendChild(romanizationContainer);
        }
      }
    }
    if (displayMode === "translate" || displayMode === "both") {
      if (
        lineData.translatedText &&
        lineData.text.trim() !== lineData.translatedText.trim()
      ) {
        const translationContainer = document.createElement("div");
        translationContainer.classList.add("lyrics-translation-container");
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

    container.innerHTML = "";

    this._applyDisplayModeClasses(container, displayMode);

    container.classList.toggle(
      "use-song-palette-fullscreen",
      !!currentSettings.useSongPaletteFullscreen
    );
    container.classList.toggle(
      "use-song-palette-all-modes",
      !!currentSettings.useSongPaletteAllModes
    );

    if (currentSettings.overridePaletteColor) {
      container.classList.add("override-palette-color");
      container.style.setProperty(
        "--lyplus-override-pallete",
        currentSettings.overridePaletteColor
      );
      container.style.setProperty(
        "--lyplus-override-pallete-white",
        `${currentSettings.overridePaletteColor}85`
      );
      container.classList.remove(
        "use-song-palette-fullscreen",
        "use-song-palette-all-modes"
      );
    } else {
      container.classList.remove("override-palette-color");
      if (
        currentSettings.useSongPaletteFullscreen ||
        currentSettings.useSongPaletteAllModes
      ) {
        if (typeof LYPLUS_getSongPalette === "function") {
          const songPalette = LYPLUS_getSongPalette();
          if (songPalette) {
            const { r, g, b } = songPalette;
            container.style.setProperty(
              "--lyplus-song-pallete",
              `rgb(${r}, ${g}, ${b})`
            );
            const alpha = 133 / 255;
            const r_blend = Math.round(alpha * 255 + (1 - alpha) * r);
            const g_blend = Math.round(alpha * 255 + (1 - alpha) * b);
            const b_blend = Math.round(alpha * 255 + (1 - alpha) * b);
            container.style.setProperty(
              "--lyplus-song-white-pallete",
              `rgb(${r_blend}, ${g_blend}, ${b_blend})`
            );
          }
        }
      }
    }

    container.classList.toggle(
      "fullscreen",
      document.body.hasAttribute("player-fullscreened_")
    );
    const isWordByWordMode =
      lyrics.type === "Word" && currentSettings.wordByWord;
    container.classList.toggle("word-by-word-mode", isWordByWordMode);
    container.classList.toggle("line-by-line-mode", !isWordByWordMode);

    // Re-determine text direction and dual-side layout
    let hasRTL = false,
      hasLTR = false;
    if (lyrics && lyrics.data && lyrics.data.length > 0) {
      for (const line of lyrics.data) {
        if (this._isRTL(line.text)) hasRTL = true;
        else hasLTR = true;
        if (hasRTL && hasLTR) break;
      }
    }
    container.classList.remove("mixed-direction-lyrics", "dual-side-lyrics");
    if (hasRTL && hasLTR) container.classList.add("mixed-direction-lyrics");

    const singerClassMap = {};
    let isDualSide = false;
    if (lyrics && lyrics.data && lyrics.data.length > 0) {
      const allSingers = [
        ...new Set(
          lyrics.data.map((line) => line.element?.singer).filter(Boolean)
        ),
      ];
      const leftCandidates = [];
      const rightCandidates = [];

      allSingers.forEach((s) => {
        if (!s.startsWith("v")) return;

        const numericPart = s.substring(1);
        if (numericPart.length === 0) return;

        let processedNumericPart = numericPart.replaceAll("0", "");
        if (processedNumericPart === "" && numericPart.length > 0) {
          processedNumericPart = "0";
        }

        const num = parseInt(processedNumericPart, 10);
        if (isNaN(num)) return;

        if (num % 2 !== 0) {
          leftCandidates.push(s);
        } else {
          rightCandidates.push(s);
        }
      });

      const sortByOriginalNumber = (a, b) =>
        parseInt(a.substring(1)) - parseInt(b.substring(1));
      leftCandidates.sort(sortByOriginalNumber);
      rightCandidates.sort(sortByOriginalNumber);

      if (leftCandidates.length > 0 || rightCandidates.length > 0) {
        leftCandidates.forEach((s) => (singerClassMap[s] = "singer-left"));
        rightCandidates.forEach((s) => (singerClassMap[s] = "singer-right"));
        isDualSide = leftCandidates.length > 0 && rightCandidates.length > 0;
      }
    }
    if (isDualSide) container.classList.add("dual-side-lyrics");

    const elementPool = { lines: [], syllables: [], chars: [] };

    const createGapLine = (gapStart, gapEnd, classesToInherit = null) => {
      const gapDuration = gapEnd - gapStart;
      const gapLine = elementPool.lines.pop() || document.createElement("div");
      gapLine.className = "lyrics-line lyrics-gap";
      gapLine.dataset.startTime = gapStart;
      gapLine.dataset.endTime = gapEnd;
      if (!gapLine.hasClickListener) {
        gapLine.addEventListener("click", this._onLyricClick.bind(this));
        gapLine.hasClickListener = true;
      }
      if (classesToInherit) {
        if (classesToInherit.includes("rtl-text"))
          gapLine.classList.add("rtl-text");
        if (classesToInherit.includes("singer-left"))
          gapLine.classList.add("singer-left");
        if (classesToInherit.includes("singer-right"))
          gapLine.classList.add("singer-right");
      }
      const existingMainContainer = gapLine.querySelector(
        ".main-vocal-container"
      );
      if (existingMainContainer) existingMainContainer.remove();
      const mainContainer = document.createElement("div");
      mainContainer.className = "main-vocal-container";
      const lyricsWord = document.createElement("div");
      lyricsWord.className = "lyrics-word";
      for (let i = 0; i < 3; i++) {
        const syllableSpan =
          elementPool.syllables.pop() || document.createElement("span");
        syllableSpan.className = "lyrics-syllable";
        const syllableStart = (gapStart + (i * gapDuration) / 3) * 1000;
        const syllableDuration = (gapDuration / 3 / 0.9) * 1000;
        syllableSpan.dataset.startTime = syllableStart;
        syllableSpan.dataset.duration = syllableDuration;
        syllableSpan.dataset.endTime = syllableStart + syllableDuration;
        syllableSpan.textContent = "•";
        lyricsWord.appendChild(syllableSpan);
      }
      mainContainer.appendChild(lyricsWord);
      gapLine.appendChild(mainContainer);
      return gapLine;
    };

    const fragment = document.createDocumentFragment();

    // Validate lyrics data before rendering
    if (!lyrics || !lyrics.data || !Array.isArray(lyrics.data) || lyrics.data.length === 0) {
      console.warn('updateDisplayMode: Invalid lyrics data', lyrics);
      return;
    }

    if (isWordByWordMode) {
      this._renderWordByWordLyrics(
        lyrics,
        displayMode,
        singerClassMap,
        currentSettings.lightweight,
        elementPool,
        fragment
      );
    } else {
      this._renderLineByLineLyrics(
        lyrics,
        displayMode,
        singerClassMap,
        elementPool,
        fragment
      );
    }

    container.appendChild(fragment);

    const originalLines = Array.from(
      container.querySelectorAll(".lyrics-line:not(.lyrics-gap)")
    );
    if (originalLines.length > 0) {
      const firstLine = originalLines[0];
      const firstStartTime = parseFloat(firstLine.dataset.startTime);
      if (firstStartTime >= 7.0) {
        const classesToInherit = [...firstLine.classList].filter((c) =>
          ["rtl-text", "singer-left", "singer-right"].includes(c)
        );
        container.insertBefore(
          createGapLine(0, firstStartTime - 0.66, classesToInherit),
          firstLine
        );
      }
    }
    const gapLinesToInsert = [];
    originalLines.forEach((line, index) => {
      if (index < originalLines.length - 1) {
        const nextLine = originalLines[index + 1];
        if (
          parseFloat(nextLine.dataset.startTime) -
          parseFloat(line.dataset.endTime) >=
          7.0
        ) {
          const classesToInherit = [...nextLine.classList].filter((c) =>
            ["rtl-text", "singer-left", "singer-right"].includes(c)
          );
          gapLinesToInsert.push({
            gapLine: createGapLine(
              parseFloat(line.dataset.endTime) + 0.31,
              parseFloat(nextLine.dataset.startTime) - 0.66,
              classesToInherit
            ),
            nextLine,
          });
        }
      }
    });
    gapLinesToInsert.forEach(({ gapLine, nextLine }) =>
      container.insertBefore(gapLine, nextLine)
    );
    this._retimingActiveTimings(originalLines);

    const metadataContainer = document.createElement("div");
    metadataContainer.className = "lyrics-plus-metadata";
    if (lyrics.data[lyrics.data.length - 1]?.endTime != 0) {
      // musixmatch sometimes returning plainText duh
      metadataContainer.dataset.startTime =
        (lyrics.data[lyrics.data.length - 1]?.endTime || 0) + 0.8;
      metadataContainer.dataset.endTime =
        (lyrics.data[lyrics.data.length - 1]?.endTime || 0) + 10;
    }

    // Note: songWriters and source may not be available on subsequent updates.
    // They should ideally be part of the main 'lyrics' object if they can change.
    if (lyrics.metadata.songWriters && lyrics.metadata.songWriters.length > 0) {
      const songWritersDiv = document.createElement("span");
      songWritersDiv.className = "lyrics-song-writters";
      songWritersDiv.innerText = `${t(
        "writtenBy"
      )} ${lyrics.metadata.songWriters.join(", ")}`;
      metadataContainer.appendChild(songWritersDiv);
    }
    const sourceDiv = document.createElement("span");
    sourceDiv.className = "lyrics-source-provider";
    sourceDiv.innerText = `${t("source")} ${lyrics.metadata.source}`;
    metadataContainer.appendChild(sourceDiv);
    container.appendChild(metadataContainer);

    const emptyDiv = document.createElement("div");
    emptyDiv.className = "lyrics-plus-empty";
    container.appendChild(emptyDiv);

    // This fixed div prevents the resize observer from firing due to the main empty div changing size.
    const emptyFixedDiv = document.createElement("div");
    emptyFixedDiv.className = "lyrics-plus-empty-fixed";
    container.appendChild(emptyFixedDiv);

    this.cachedLyricsLines = Array.from(
      container.querySelectorAll(
        ".lyrics-line, .lyrics-plus-metadata, .lyrics-plus-empty"
      )
    )
      .map((line) => {
        if (line) {
          line._startTimeMs = parseFloat(line.dataset.startTime) * 1000;
          line._endTimeMs = parseFloat(line.dataset.endTime) * 1000;
        }
        return line;
      })
      .filter(Boolean);

    this.cachedSyllables = Array.from(
      container.getElementsByClassName("lyrics-syllable")
    )
      .map((syllable) => {
        if (syllable) {
          syllable._startTimeMs = parseFloat(syllable.dataset.startTime);
          syllable._durationMs = parseFloat(syllable.dataset.duration);
          syllable._endTimeMs = syllable._startTimeMs + syllable._durationMs;
          const wordDuration = parseFloat(syllable.dataset.wordDuration);
          syllable._wordDurationMs = isNaN(wordDuration) ? null : wordDuration;
        }
        return syllable;
      })
      .filter(Boolean);

    this._ensureElementIds();
    this.activeLineIds.clear();
    this.highlightedSyllableIds.clear();
    this.visibleLineIds.clear();
    this.currentPrimaryActiveLine = null;

    if (this.cachedLyricsLines.length > 0)
      this._scrollToActiveLine(this.cachedLyricsLines[0], true);

    this._startLyricsSync(currentSettings);
    container.classList.toggle(
      "blur-inactive-enabled",
      !!currentSettings.blurInactive
    );
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
   */
  displayLyrics(
    lyrics,
    source = "Unknown",
    type = "Line",
    lightweight = false,
    songWriters,
    songInfo,
    displayMode = "none",
    currentSettings = {},
    fetchAndDisplayLyricsFn,
    setCurrentDisplayModeAndRefetchFn,
    largerTextMode = "lyrics"
  ) {
    this.lastKnownSongInfo = songInfo;
    this.fetchAndDisplayLyricsFn = fetchAndDisplayLyricsFn;
    this.setCurrentDisplayModeAndRefetchFn = setCurrentDisplayModeAndRefetchFn;
    this.largerTextMode = largerTextMode;

    const container = this._getContainer();
    if (!container) return;

    container.classList.remove("lyrics-plus-message");

    container.classList.toggle(
      "use-song-palette-fullscreen",
      !!currentSettings.useSongPaletteFullscreen
    );
    container.classList.toggle(
      "use-song-palette-all-modes",
      !!currentSettings.useSongPaletteAllModes
    );
    container.classList.toggle(
      "lightweight-mode",
      lightweight
    );

    if (currentSettings.overridePaletteColor) {
      container.classList.add("override-palette-color");
      container.style.setProperty(
        "--lyplus-override-pallete",
        currentSettings.overridePaletteColor
      );
      container.style.setProperty(
        "--lyplus-override-pallete-white",
        `${currentSettings.overridePaletteColor}85`
      );
      container.classList.remove(
        "use-song-palette-fullscreen",
        "use-song-palette-all-modes"
      );
    } else {
      container.classList.remove("override-palette-color");
      if (
        currentSettings.useSongPaletteFullscreen ||
        currentSettings.useSongPaletteAllModes
      ) {
        if (typeof LYPLUS_getSongPalette === "function") {
          const songPalette = LYPLUS_getSongPalette();
          if (songPalette) {
            const { r, g, b } = songPalette;
            container.style.setProperty(
              "--lyplus-song-pallete",
              `rgb(${r}, ${g}, ${b})`
            );
            const alpha = 133 / 255;
            const r_blend = Math.round(alpha * 255 + (1 - alpha) * r);
            const g_blend = Math.round(alpha * 255 + (1 - alpha) * b);
            const b_blend = Math.round(alpha * 255 + (1 - alpha) * b);
            container.style.setProperty(
              "--lyplus-song-white-pallete",
              `rgb(${r_blend}, ${g_blend}, ${b_blend})`
            );
          }
        }
      }
    }

    container.classList.toggle(
      "fullscreen",
      document.body.hasAttribute("player-fullscreened_")
    );
    const isWordByWordMode = type === "Word" && currentSettings.wordByWord;
    container.classList.toggle("word-by-word-mode", isWordByWordMode);
    container.classList.toggle("line-by-line-mode", !isWordByWordMode);

    container.classList.toggle(
      "romanized-big-mode",
      largerTextMode != "lyrics"
    );


    const buttonsWrapper = document.getElementById("lyrics-plus-buttons-wrapper");
    if (buttonsWrapper) {
      buttonsWrapper.style.removeProperty("display");
      buttonsWrapper.style.removeProperty("opacity");
      buttonsWrapper.style.removeProperty("pointer-events");
    }

    // Validate lyrics data before attempting to render
    if (!lyrics || !lyrics.data || !Array.isArray(lyrics.data) || lyrics.data.length === 0) {
      console.warn('displayLyrics: Invalid or empty lyrics data', lyrics);
      // Don't render if data is invalid
      return;
    }

    this.updateDisplayMode(lyrics, displayMode, currentSettings);

    // Control buttons are created once to avoid re-rendering them.
    this._createControlButtons();
    container.classList.toggle(
      "blur-inactive-enabled",
      !!currentSettings.blurInactive
    );
    container.classList.toggle(
      "hide-offscreen",
      !!currentSettings.hideOffscreen
    );
    this._injectCustomCSS(currentSettings.customCSS);
  }

  /**
   * Displays a "not found" message in the lyrics container.
   */
  displaySongNotFound() {
    const container = this._getContainer();
    if (container) {
      container.innerHTML = `<span class="text-not-found">${t(
        "notFound"
      )}</span>`;
      container.classList.add("lyrics-plus-message");

      const buttonsWrapper = document.getElementById("lyrics-plus-buttons-wrapper");
      if (buttonsWrapper) {
        buttonsWrapper.style.display = "none";
        buttonsWrapper.style.opacity = "0";
        buttonsWrapper.style.pointerEvents = "none";
      }
      
      // Song info in fullscreen - NewSync specific feature
      // Removed to prevent lag during fullscreen transitions
    }
  }

  /**
   * Displays an error message in the lyrics container.
   */
  displaySongError() {
    const container = this._getContainer();
    if (container) {
      container.innerHTML = `<span class="text-not-found">${t(
        "notFoundError"
      )}</span>`;
      container.classList.add("lyrics-plus-message");

      const buttonsWrapper = document.getElementById("lyrics-plus-buttons-wrapper");
      if (buttonsWrapper) {
        buttonsWrapper.style.display = "none";
        buttonsWrapper.style.opacity = "0";
        buttonsWrapper.style.pointerEvents = "none";
      }
      
      // Song info in fullscreen - NewSync specific feature
      // Removed to prevent lag during fullscreen transitions
    }
  }

  /**
   * Gets a reference to the player element, caching it for performance.
   * @returns {HTMLVideoElement | null} - The player element.
   * @private
   */
  _getPlayerElement() {
    if (this._playerElement === undefined) {
      this._playerElement =
        document.querySelector(this.uiConfig.player) || null;
    }
    return this._playerElement;
  }

  /**
   * Gets the current playback time, using a custom function from uiConfig if provided, otherwise falling back to the player element.
   * @returns {number} - The current time in seconds.
   * @private
   */
  _getCurrentPlayerTime() {
    if (typeof this.uiConfig.getCurrentTime === "function") {
      return this.uiConfig.getCurrentTime();
    }
    const player = this._getPlayerElement();
    return player ? player.currentTime : 0;
  }

  /**
   * Seeks the player to a specific time, using a custom function from uiConfig if provided.
   * @param {number} time - The time to seek to in seconds.
   * @private
   */
  _seekPlayerTo(time) {
    if (typeof this.uiConfig.seekTo === "function") {
      console.log('LyricsPlus: Using uiConfig.seekTo to seek to', time);
      try {
        this.uiConfig.seekTo(time);
      } catch (error) {
        console.error('LyricsPlus: Error in uiConfig.seekTo', error);
      }
      return;
    }
    const player = this._getPlayerElement();
    if (player) {
      console.log('LyricsPlus: Using player.currentTime to seek to', time);
      try {
        player.currentTime = time;
      } catch (error) {
        console.error('LyricsPlus: Error setting player.currentTime', error);
      }
    } else {
      console.warn('LyricsPlus: No player element found for seek');
    }
  }

  _getTextWidth(text, font) {
    const canvas =
      this.textWidthCanvas ||
      (this.textWidthCanvas = document.createElement("canvas"));
    const context = canvas.getContext("2d");
    context.font = font;
    return context.measureText(text).width;
  }

  _ensureElementIds() {
    if (!this.cachedLyricsLines || !this.cachedSyllables) return;
    this.cachedLyricsLines.forEach((line, i) => {
      if (line && !line.id) line.id = `line-${i}`;
    });
    this.cachedSyllables.forEach((syllable, i) => {
      if (syllable && !syllable.id) syllable.id = `syllable-${i}`;
    });
  }

  /**
   * Starts the synchronization loop for highlighting lyrics based on video time.
   * @param {object} currentSettings - The current user settings.
   * @returns {Function} - A cleanup function to stop the sync.
   */
  _startLyricsSync(currentSettings = {}) {
    const canGetTime =
      typeof this.uiConfig.getCurrentTime === "function" ||
      this._getPlayerElement();
    if (!canGetTime) {
      console.warn(
        "LyricsPlusRenderer: Cannot start sync. No player element found and no custom getCurrentTime function provided in uiConfig."
      );
      return () => { };
    }

    this._ensureElementIds();
    if (this.visibilityObserver) this.visibilityObserver.disconnect();
    this.visibilityObserver = this._setupVisibilityTracking();

    if (this.lyricsAnimationFrameId) {
      if (!this.uiConfig.disableNativeTick)
        cancelAnimationFrame(this.lyricsAnimationFrameId);
    }
    this.lastTime = this._getCurrentPlayerTime() * 1000;
    if (!this.uiConfig.disableNativeTick) {
      const sync = () => {
        const currentTime = this._getCurrentPlayerTime() * 1000;
        const isForceScroll = Math.abs(currentTime - this.lastTime) > 1000;
        this._updateLyricsHighlight(
          currentTime,
          isForceScroll,
          currentSettings
        );
        this.lastTime = currentTime;
        this.lyricsAnimationFrameId = requestAnimationFrame(sync);
      };
      this.lyricsAnimationFrameId = requestAnimationFrame(sync);
    }

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
   * Updates the current time
   * @param {number} currentTime - The current video time in seconds.
   */
  updateCurrentTick(currentTime) {
    currentTime = currentTime * 1000;
    const isForceScroll = Math.abs(currentTime - this.lastTime) > 1000;
    this._updateLyricsHighlight(currentTime, isForceScroll, currentSettings);
    this.lastTime = currentTime;
  }

  /**
   * Updates the highlighted lyrics and syllables based on the current time.
   * @param {number} currentTime - The current video time in milliseconds.
   * @param {boolean} isForceScroll - Whether to force a scroll update.
   * @param {object} currentSettings - The current user settings.
   */
  _updateLyricsHighlight(
    currentTime,
    isForceScroll = false,
    currentSettings = {}
  ) {
    if (!this.cachedLyricsLines || this.cachedLyricsLines.length === 0) {
      return;
    }

    const scrollLookAheadMs = 300;
    const highlightLookAheadMs = 190;
    const predictiveTime = currentTime + scrollLookAheadMs;

    let visibleLines = this._cachedVisibleLines;
    const currentVisibilityHash =
      this.visibleLineIds.size > 0
        ? Array.from(this.visibleLineIds).sort().join(",")
        : "";

    if (!visibleLines || this._lastVisibilityHash !== currentVisibilityHash) {
      visibleLines = this.cachedLyricsLines.filter((line) =>
        this.visibleLineIds.has(line.id)
      );
      this._cachedVisibleLines = visibleLines;
      this._lastVisibilityHash = currentVisibilityHash;
    }

    const activeLinesForHighlighting = [];

    for (let i = 0; i < visibleLines.length; i++) {
      const line = visibleLines[i];
      if (
        line &&
        currentTime >= line._startTimeMs - highlightLookAheadMs &&
        currentTime <= line._endTimeMs - highlightLookAheadMs
      ) {
        activeLinesForHighlighting.push(line);
      }
    }

    if (activeLinesForHighlighting.length > 3) {
      activeLinesForHighlighting.splice(
        0,
        activeLinesForHighlighting.length - 3
      );
    }

    if (activeLinesForHighlighting.length > 1) {
      activeLinesForHighlighting.sort(
        (a, b) => a._startTimeMs - b._startTimeMs
      );
    }

    const newActiveLineIds = new Set(
      activeLinesForHighlighting.map((line) => line.id)
    );

    const activeLineIdsChanged =
      this.activeLineIds.size !== newActiveLineIds.size ||
      [...this.activeLineIds].some((id) => !newActiveLineIds.has(id));

    if (activeLineIdsChanged) {
      const toDeactivate = [];
      for (const lineId of this.activeLineIds) {
        if (!newActiveLineIds.has(lineId)) {
          toDeactivate.push(lineId);
        }
      }

      const toActivate = [];
      for (const lineId of newActiveLineIds) {
        if (!this.activeLineIds.has(lineId)) {
          toActivate.push(lineId);
        }
      }

      if (toDeactivate.length > 0) {
        this._batchDeactivateLines(toDeactivate);
      }
      if (toActivate.length > 0) {
        this._batchActivateLines(toActivate);
      }

      this.activeLineIds = newActiveLineIds;
    }

    let candidates = this._findActiveLine(
      predictiveTime,
      currentTime - scrollLookAheadMs
    );

    if (candidates.length > 3) {
      candidates = candidates.slice(-3);
    }

    let lineToScroll = candidates[0];

    if (
      lineToScroll &&
      (lineToScroll !== this.currentPrimaryActiveLine || isForceScroll)
    ) {
      if (!this.isUserControllingScroll || isForceScroll) {
        this._updatePositionClassesAndScroll(lineToScroll, isForceScroll);
        this.lastPrimaryActiveLine = this.currentPrimaryActiveLine;
        this.currentPrimaryActiveLine = lineToScroll;
      }
    }

    const mostRecentActiveLine =
      activeLinesForHighlighting.length > 0
        ? activeLinesForHighlighting[activeLinesForHighlighting.length - 1]
        : null;
    if (this.currentFullscreenFocusedLine !== mostRecentActiveLine) {
      if (this.currentFullscreenFocusedLine) {
        this.currentFullscreenFocusedLine.classList.remove(
          "fullscreen-focused"
        );
      }
      if (mostRecentActiveLine) {
        mostRecentActiveLine.classList.add("fullscreen-focused");
      }
      this.currentFullscreenFocusedLine = mostRecentActiveLine;
    }

    this._updateSyllables(currentTime);

    if (
      this.lyricsContainer &&
      this.lyricsContainer.classList.contains("hide-offscreen")
    ) {
      if (this._lastVisibilityUpdateSize !== this.visibleLineIds.size) {
        this._batchUpdateViewportVisibility();
        this._lastVisibilityUpdateSize = this.visibleLineIds.size;
      }
    }
  }

  _findActiveLine(predictiveTime, lookAheadTime) {
    const lines = this.cachedLyricsLines;
    const currentlyActiveAndPredictiveLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (
        line &&
        predictiveTime >= line._startTimeMs &&
        predictiveTime < line._endTimeMs
      ) {
        currentlyActiveAndPredictiveLines.push(line);
      }
    }

    if (currentlyActiveAndPredictiveLines.length > 0) {
      return currentlyActiveAndPredictiveLines;
    }

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line && lookAheadTime >= line._startTimeMs) {
        return [line];
      }
    }

    return lines.length > 0 ? [lines[0]] : [];
  }

  /**
   * Batch deactivate lines to reduce DOM thrashing
   */
  _batchDeactivateLines(lineIds) {
    for (const lineId of lineIds) {
      const line = document.getElementById(lineId);
      if (line) {
        line.classList.remove("active");
        this._resetSyllables(line);
      }
    }
  }

  /**
   * Batch activate lines to reduce DOM thrashing
   */
  _batchActivateLines(lineIds) {
    for (const lineId of lineIds) {
      const line = document.getElementById(lineId);
      if (line) {
        line.classList.add("active");
      }
    }
  }

  /**
   * Batch update viewport visibility
   */
  _batchUpdateViewportVisibility() {
    const lines = this.cachedLyricsLines;
    const visibleIds = this.visibleLineIds;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line) {
        const isOutOfView = !visibleIds.has(line.id);
        line.classList.toggle("viewport-hidden", isOutOfView);
      }
    }
  }

  _updateSyllables(currentTime) {
    if (!this.activeLineIds.size) return;

    // Cache syllable queries to avoid repeated DOM lookups
    const activeSyllables = [];

    for (const lineId of this.activeLineIds) {
      const parentLine = document.getElementById(lineId);
      if (!parentLine) continue;

      let syllables = parentLine._cachedSyllableElements;
      if (!syllables) {
        syllables = parentLine.querySelectorAll(".lyrics-syllable");
        parentLine._cachedSyllableElements = syllables;
      }

      for (let j = 0; j < syllables.length; j++) {
        const syllable = syllables[j];
        if (syllable && typeof syllable._startTimeMs === "number") {
          activeSyllables.push(syllable);
        }
      }
    }

    // Process all syllables in batches
    const toHighlight = [];
    const toFinish = [];
    const toReset = [];

    for (const syllable of activeSyllables) {
      const startTime = syllable._startTimeMs;
      const endTime = syllable._endTimeMs;
      const classList = syllable.classList;
      const hasHighlight = classList.contains("highlight");
      const hasFinished = classList.contains("finished");

      if (currentTime >= startTime && currentTime <= endTime) {
        if (!hasHighlight) {
          toHighlight.push(syllable);
        }
        if (hasFinished) {
          classList.remove("finished");
        }
      } else if (currentTime > endTime) {
        if (!hasFinished) {
          if (!hasHighlight) {
            toHighlight.push(syllable);
          }
          toFinish.push(syllable);
        }
      } else {
        if (hasHighlight || hasFinished) {
          toReset.push(syllable);
        }
      }
    }

    // Batch apply changes
    for (const syllable of toHighlight) {
      this._updateSyllableAnimation(syllable);
    }
    for (const syllable of toFinish) {
      syllable.classList.add("finished");
    }
    for (const syllable of toReset) {
      this._resetSyllable(syllable);
    }
  }

  _updateSyllableAnimation(syllable) {
    // --- READ PHASE ---
    if (syllable.classList.contains("highlight")) return;

    const classList = syllable.classList;
    const isRTL = classList.contains("rtl-text");
    const charSpans = syllable._cachedCharSpans;
    const wordElement = syllable.parentElement;
    const allWordCharSpans = wordElement?._cachedChars;
    const isGrowable = wordElement?.classList.contains("growable");
    const isFirstSyllable = syllable.dataset.syllableIndex === "0";
    const isGap =
      syllable.parentElement?.parentElement?.parentElement?.classList.contains(
        "lyrics-gap"
      );
    const nextSyllable = syllable._nextSyllableInWord;

    // --- CALCULATION PHASE ---
    const pendingStyleUpdates = [];
    const charAnimationsMap = new Map();
    const wipeAnimation = isRTL ? "wipe-rtl" : "wipe";

    // Step 1: Grow Pass.
    if (isGrowable && isFirstSyllable && allWordCharSpans) {
      const finalDuration = syllable._wordDurationMs ?? syllable._durationMs;
      const baseDelayPerChar = finalDuration * 0.09;
      const growDurationMs = finalDuration * 1.5;

      allWordCharSpans.forEach((span) => {
        const horizontalOffset = parseFloat(span.dataset.horizontalOffset) || 0;
        const growDelay =
          baseDelayPerChar * (parseFloat(span.dataset.syllableCharIndex) || 0);
        charAnimationsMap.set(
          span,
          `grow-dynamic ${growDurationMs}ms ease-in-out ${growDelay}ms forwards`
        );
        pendingStyleUpdates.push({
          element: span,
          property: "--char-offset-x",
          value: `${horizontalOffset}`,
        });
      });
    }

    // Step 2: Wipe Pass.
    if (charSpans && charSpans.length > 0) {
      const syllableDuration = syllable._durationMs;

      charSpans.forEach((span, charIndex) => {
        const wipeDelay =
          syllableDuration * (parseFloat(span.dataset.wipeStart) || 0);
        const wipeDuration =
          syllableDuration * (parseFloat(span.dataset.wipeDuration) || 0);

        const existingAnimation =
          charAnimationsMap.get(span) || span.style.animation;
        const animationParts = [];

        if (existingAnimation && existingAnimation.includes("grow-dynamic")) {
          animationParts.push(existingAnimation.split(",")[0].trim());
        }

        if (charIndex > 0) {
          const prevChar = charSpans[charIndex - 1];
          const prevWipeDelay =
            syllableDuration * (parseFloat(prevChar.dataset.wipeStart) || 0);
          const prevWipeDuration =
            syllableDuration * (parseFloat(prevChar.dataset.wipeDuration) || 0);

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

        charAnimationsMap.set(span, animationParts.join(", "));
      });
    } else {
      const currentWipeAnimation = isGap ? "fade-gap" : wipeAnimation;
      const syllableAnimation = `${currentWipeAnimation} ${syllable._durationMs}ms linear forwards`;
      pendingStyleUpdates.push({
        element: syllable,
        property: "animation",
        value: syllableAnimation,
      });
    }

    // Step 3: Pre-Wipe Pass.
    if (nextSyllable) {
      const preHighlightDuration = syllable._preHighlightDurationMs;
      const preHighlightDelay = syllable._preHighlightDelayMs;

      pendingStyleUpdates.push({
        element: nextSyllable,
        property: "class",
        action: "add",
        value: "pre-highlight",
      });
      pendingStyleUpdates.push({
        element: nextSyllable,
        property: "--pre-wipe-duration",
        value: `${preHighlightDuration}ms`,
      });
      pendingStyleUpdates.push({
        element: nextSyllable,
        property: "--pre-wipe-delay",
        value: `${preHighlightDelay}ms`,
      });

      const nextCharSpan = nextSyllable._cachedCharSpans?.[0];
      if (nextCharSpan) {
        const preWipeAnim = `pre-wipe-char ${preHighlightDuration}ms ${preHighlightDelay}ms forwards`;
        const existingAnimation =
          charAnimationsMap.get(nextCharSpan) ||
          nextCharSpan.style.animation ||
          "";
        const combinedAnimation =
          existingAnimation && !existingAnimation.includes("pre-wipe-char")
            ? `${existingAnimation}, ${preWipeAnim}`
            : preWipeAnim;
        charAnimationsMap.set(nextCharSpan, combinedAnimation);
      }
    }

    // --- WRITE PHASE ---
    classList.remove("pre-highlight");
    classList.add("highlight");

    for (const [span, animationString] of charAnimationsMap.entries()) {
      span.style.animation = animationString;
    }

    for (const update of pendingStyleUpdates) {
      if (update.action === "add") {
        update.element.classList.add(update.value);
      } else if (update.property === "animation") {
        update.element.style.animation = update.value;
      } else {
        update.element.style.setProperty(update.property, update.value);
      }
    }
  }

  _resetSyllable(syllable) {
    if (!syllable) return;
    syllable.style.animation = "";
    if (!syllable.classList.contains("finished")) {
      syllable.classList.add("finished");
      syllable.offsetHeight;
    }
    syllable.classList.remove("highlight", "finished", "pre-highlight");
    syllable.style.removeProperty("--pre-wipe-duration");
    syllable.style.removeProperty("--pre-wipe-delay");
    syllable.querySelectorAll("span.char").forEach((span) => {
      span.style.animation = "";
    });
  }

  _resetSyllables(line) {
    if (!line) return;
    Array.from(line.getElementsByClassName("lyrics-syllable")).forEach(
      this._resetSyllable
    );
  }

  _getScrollPaddingTop() {
    const selectors = this.uiConfig.selectors;
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        const style = window.getComputedStyle(element);
        const paddingTopValue =
          style.getPropertyValue("--lyrics-scroll-padding-top") || "25%";
        return paddingTopValue.includes("%")
          ? element.getBoundingClientRect().height *
          (parseFloat(paddingTopValue) / 100)
          : parseFloat(paddingTopValue) || 0;
      }
    }
    const container = document.querySelector(
      "#lyrics-plus-container"
    )?.parentElement;
    return container
      ? parseFloat(
        window
          .getComputedStyle(container)
          .getPropertyValue("scroll-padding-top")
      ) || 0
      : 0;
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

    if (
      !forceScroll &&
      Math.abs(this.currentScrollOffset - newTranslateY) < 0.1
    )
      return;

    this.currentScrollOffset = newTranslateY;

    this.lyricsContainer.style.setProperty(
      "--lyrics-scroll-offset",
      `${newTranslateY}px`
    );

    const isUserScrolling =
      this.lyricsContainer.classList.contains("user-scrolling");

    if (forceScroll || isUserScrolling) {
      // Batch clear delays
      const elements = this.cachedLyricsLines;
      for (let i = 0; i < elements.length; i++) {
        if (elements[i]) {
          elements[i].style.setProperty("--lyrics-line-delay", "0ms");
        }
      }
      return;
    }

    const referenceLine =
      this.currentPrimaryActiveLine ||
      this.lastPrimaryActiveLine ||
      (this.cachedLyricsLines.length > 0 ? this.cachedLyricsLines[0] : null);

    if (!referenceLine) return;

    const referenceLineIndex = this.cachedLyricsLines.indexOf(referenceLine);
    if (referenceLineIndex === -1) return;

    const delayIncrement = 30;
    let delayCounter = 0;
    const elements = this.cachedLyricsLines;
    const visibleIds = this.visibleLineIds;

    // Batch style updates
    const styleUpdates = [];

    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      if (!element) continue;

      if (visibleIds.has(element.id)) {
        const delay =
          i >= referenceLineIndex ? delayCounter * delayIncrement : 0;
        styleUpdates.push({ element, delay: `${delay}ms` });
        if (i >= referenceLineIndex) {
          delayCounter++;
        }
      } else {
        styleUpdates.push({ element, delay: "0ms" });
      }
    }

    for (const update of styleUpdates) {
      update.element.style.setProperty("--lyrics-line-delay", update.delay);
    }
  }

  _updatePositionClassesAndScroll(lineToScroll, forceScroll = false) {
    if (
      !this.lyricsContainer ||
      !this.cachedLyricsLines ||
      this.cachedLyricsLines.length === 0
    )
      return;
    const scrollLineIndex = this.cachedLyricsLines.indexOf(lineToScroll);
    if (scrollLineIndex === -1) return;

    const positionClasses = [
      "lyrics-activest",
      "pre-active-line",
      "next-active-line",
      "prev-1",
      "prev-2",
      "prev-3",
      "prev-4",
      "next-1",
      "next-2",
      "next-3",
      "next-4",
    ];
    this.lyricsContainer
      .querySelectorAll("." + positionClasses.join(", ."))
      .forEach((el) => el.classList.remove(...positionClasses));

    lineToScroll.classList.add("lyrics-activest");
    const elements = this.cachedLyricsLines;
    for (
      let i = Math.max(0, scrollLineIndex - 4);
      i <= Math.min(elements.length - 1, scrollLineIndex + 4);
      i++
    ) {
      const position = i - scrollLineIndex;
      if (position === 0) continue;
      const element = elements[i];
      if (position === -1) element.classList.add("pre-active-line");
      else if (position === 1) element.classList.add("next-active-line");
      else if (position < 0)
        element.classList.add(`prev-${Math.abs(position)}`);
      else element.classList.add(`next-${position}`);
    }

    this._scrollToActiveLine(lineToScroll, forceScroll);
  }

  _scrollToActiveLine(activeLine, forceScroll = false) {
    if (
      !activeLine ||
      !this.lyricsContainer ||
      getComputedStyle(this.lyricsContainer).display !== "block"
    )
      return;
    const scrollContainer = this.lyricsContainer.parentElement;
    if (!scrollContainer) return;

    const paddingTop = this._getScrollPaddingTop();
    const targetTranslateY = paddingTop - activeLine.offsetTop;

    const containerTop = this._cachedContainerRect
      ? this._cachedContainerRect.containerTop
      : this.lyricsContainer.getBoundingClientRect().top;
    const scrollContainerTop = this._cachedContainerRect
      ? this._cachedContainerRect.scrollContainerTop
      : scrollContainer.getBoundingClientRect().top;

    if (
      !forceScroll &&
      Math.abs(
        activeLine.getBoundingClientRect().top - scrollContainerTop - paddingTop
      ) < 1
    ) {
      return;
    }
    this._cachedContainerRect = null;

    this.lyricsContainer.classList.remove("not-focused", "user-scrolling");
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

  _setupVisibilityTracking() {
    const container = this._getContainer();
    if (!container || !container.parentElement) return null;
    if (this.visibilityObserver) this.visibilityObserver.disconnect();
    this.visibilityObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const id = entry.target.id;
          if (entry.isIntersecting) this.visibleLineIds.add(id);
          else this.visibleLineIds.delete(id);
        });
      },
      { root: container.parentElement, rootMargin: "200px 0px", threshold: 0.1 }
    );
    if (this.cachedLyricsLines) {
      this.cachedLyricsLines.forEach((line) => {
        if (line) this.visibilityObserver.observe(line);
      });
    }
    return this.visibilityObserver;
  }

  _setupResizeObserver() {
    const container = this._getContainer();
    if (!container) return null;
    if (this.resizeObserver) this.resizeObserver.disconnect();

    this._lastResizeContentRect = null;

    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target !== container) continue;
        this._lastResizeContentRect = entry.contentRect || null;
        this._debouncedResizeHandler(container);
      }
    });

    this.resizeObserver.observe(container);
    return this.resizeObserver;
  }

  _createControlButtons() {
    let buttonsWrapper = document.getElementById("lyrics-plus-buttons-wrapper");
    if (!buttonsWrapper) {
      buttonsWrapper = document.createElement("div");
      buttonsWrapper.id = "lyrics-plus-buttons-wrapper";
      const originalLyricsSection = document.querySelector(
        this.uiConfig.patchParent
      );
      if (originalLyricsSection) {
        originalLyricsSection.appendChild(buttonsWrapper);
      }
    }

    if (this.setCurrentDisplayModeAndRefetchFn) {
      if (!this.translationButton) {
        this.translationButton = document.createElement("button");
        this.translationButton.id = "lyrics-plus-translate-button";
        buttonsWrapper.appendChild(this.translationButton);
        this._updateTranslationButtonText();
        this.translationButton.addEventListener("click", (event) => {
          event.stopPropagation();
          this._createDropdownMenu(buttonsWrapper);
          if (this.dropdownMenu) this.dropdownMenu.classList.toggle("hidden");
        });
        document.addEventListener("click", (event) => {
          if (
            this.dropdownMenu &&
            !this.dropdownMenu.classList.contains("hidden") &&
            !this.dropdownMenu.contains(event.target) &&
            event.target !== this.translationButton
          ) {
            this.dropdownMenu.classList.add("hidden");
          }
        });
      }
    }

    if (!this.reloadButton) {
      this.reloadButton = document.createElement("button");
      this.reloadButton.id = "lyrics-plus-reload-button";
      this.reloadButton.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" fill="currentColor"/>
      </svg>`;
      this.reloadButton.title = t("RefreshLyrics") || "Refresh Lyrics";
      buttonsWrapper.appendChild(this.reloadButton);
      this.reloadButton.addEventListener("click", () => {
        if (this.lastKnownSongInfo && this.fetchAndDisplayLyricsFn) {
          this.fetchAndDisplayLyricsFn(this.lastKnownSongInfo, true, true);
        }
      });
    }
  }

  _createDropdownMenu(parentWrapper) {
    if (this.dropdownMenu) {
      this.dropdownMenu.innerHTML = "";
    } else {
      this.dropdownMenu = document.createElement("div");
      this.dropdownMenu.id = "lyrics-plus-translation-dropdown";
      this.dropdownMenu.classList.add("hidden");
      parentWrapper?.appendChild(this.dropdownMenu);
    }

    if (typeof this.currentDisplayMode === "undefined") return;

    const hasTranslation =
      this.currentDisplayMode === "translate" ||
      this.currentDisplayMode === "both";
    const hasRomanization =
      this.currentDisplayMode === "romanize" ||
      this.currentDisplayMode === "both";

    const translationIconSVG = `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4.42071 14.8679C4.77605 14.8679 5.02011 14.6817 5.44699 14.2961L7.9329 12.0903H12.5463C14.6844 12.0903 15.838 10.9031 15.838 8.79859V3.29169C15.838 1.18717 14.6844 0 12.5463 0H3.29169C1.15361 0 0 1.18408 0 3.29169V8.79859C0 10.9062 1.15361 12.0903 3.29169 12.0903H3.63069V13.9574C3.63069 14.5141 3.91596 14.8679 4.42071 14.8679ZM4.71496 13.5548V11.4742C4.71496 11.0808 4.5685 10.9343 4.17503 10.9343H3.29478C1.83838 10.9343 1.15596 10.197 1.15596 8.79549V3.29478C1.15596 1.89932 1.83838 1.16362 3.29478 1.16362H12.5432C13.9933 1.16362 14.6819 1.89932 14.6819 3.29478V8.79549C14.6819 10.197 13.9933 10.9343 12.5432 10.9343H7.88595C7.49071 10.9343 7.28478 10.9938 7.01305 11.2761L4.71496 13.5548ZM5.55209 9.4314C5.81293 9.4314 5.99443 9.30481 6.1088 8.97081L6.63077 7.4439H9.19956L9.72756 8.97081C9.83443 9.30333 10.0174 9.4314 10.2799 9.4314C10.6016 9.4314 10.8121 9.23003 10.8121 8.93268C10.8121 8.82582 10.7877 8.71763 10.7313 8.56365L8.71733 3.13404C8.58014 2.76339 8.30105 2.57276 7.90758 2.57276C7.52163 2.57276 7.25784 2.76339 7.113 3.13404L5.09754 8.56365C5.04867 8.71763 5.02423 8.82582 5.02423 8.93107C5.02423 9.23165 5.23473 9.4314 5.55209 9.4314ZM6.91914 6.57587L7.87402 3.79805H7.95483L8.90957 6.57587H6.91914Z" fill="currentColor"/>
    </svg>`;

    const textIconSVG = `<svg width="17" height="16" viewBox="0 0 17 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M3.95003 15.45C4.11003 15.64 4.33003 15.73 4.61003 15.73C4.81003 15.73 5.01003 15.68 5.18003 15.57C5.35003 15.47 5.56003 15.31 5.80003 15.09L8.23003 12.86H12.63C13.2542 12.8807 13.8734 12.7431 14.43 12.46C14.93 12.18 15.31 11.79 15.57 11.27C15.83 10.77 15.97 10.14 15.97 9.41004V3.71004C15.97 2.99004 15.83 2.37004 15.57 1.86004C15.31 1.35004 14.93 0.960036 14.43 0.680036C13.8743 0.393476 13.255 0.252419 12.63 0.270036H3.37003C2.73917 0.245916 2.11264 0.383616 1.55003 0.670036C1.06003 0.960036 0.700029 1.36004 0.430029 1.87004C0.170029 2.37004 0.0300293 3.00004 0.0300293 3.73004V9.43004C0.0300293 10.15 0.170029 10.77 0.430029 11.28C0.700029 11.8 1.07003 12.18 1.56003 12.46C2.06003 12.73 2.64003 12.87 3.33003 12.87H3.71003V14.67C3.71003 15.01 3.79003 15.27 3.95003 15.46V15.45ZM7.22003 11.93L5.00003 14.26V12.15C5.00003 11.92 4.95003 11.77 4.86003 11.68C4.76003 11.58 4.62003 11.54 4.42003 11.54H3.46003C2.79003 11.54 2.30003 11.37 1.98003 11.02C1.66003 10.67 1.50003 10.15 1.50003 9.46004V3.81004C1.50003 3.13004 1.66003 2.61004 1.98003 2.26004C2.30003 1.92004 2.79003 1.74004 3.46003 1.74004H12.56C13.22 1.74004 13.72 1.92004 14.04 2.26004C14.36 2.61004 14.52 3.13004 14.52 3.81004V9.46004C14.52 10.16 14.36 10.66 14.04 11.02C13.72 11.37 13.22 11.54 12.56 11.54H8.16003C7.94003 11.54 7.77003 11.57 7.64003 11.62C7.51003 11.67 7.37003 11.77 7.22003 11.93ZM2.93003 5.43004C2.93003 5.02004 3.25003 4.69004 3.63003 4.69004H8.02003C8.41003 4.69004 8.72003 5.02004 8.72003 5.42004C8.72003 5.82004 8.41003 6.16004 8.02003 6.16004H3.64003C3.54547 6.15745 3.45234 6.13625 3.36597 6.09765C3.27961 6.05905 3.20169 6.00381 3.13669 5.93509C3.07168 5.86637 3.02085 5.78551 2.98711 5.69713C2.95336 5.60876 2.93737 5.5146 2.94003 5.42004L2.93003 5.43004ZM3.63003 6.89004C3.25003 6.89004 2.93003 7.23004 2.93003 7.63004C2.93003 8.03004 3.25003 8.37004 3.63003 8.37004H5.13003C5.51003 8.37004 5.83003 8.04004 5.83003 7.63004C5.83003 7.23004 5.51003 6.89004 5.13003 6.89004H3.63003ZM10.17 5.42004C10.17 5.02004 10.49 4.69004 10.87 4.69004H12.37C12.75 4.69004 13.07 5.02004 13.07 5.42004C13.07 5.82004 12.75 6.16004 12.37 6.16004H10.87C10.7755 6.15745 10.6823 6.13625 10.596 6.09765C10.5096 6.05905 10.4317 6.00381 10.3667 5.93509C10.3017 5.86637 10.2509 5.78551 10.2171 5.69713C10.1834 5.60876 10.1674 5.5146 10.17 5.42004ZM7.98003 6.90004C7.59003 6.90004 7.28003 7.24004 7.28003 7.64004C7.28003 8.04004 7.59003 8.38004 7.98003 8.38004H10.19C10.58 8.38004 10.89 8.05004 10.89 7.64004C10.89 7.24004 10.58 6.90004 10.19 6.90004H8.00003H7.98003Z" fill="currentColor"/>
    </svg>`;

    const hideTranslationIconSVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M5.73545 7.3191L4.82381 9.77516C4.77484 9.92914 4.75042 10.0374 4.75042 10.1427C4.75042 10.4432 4.96095 10.643 5.2783 10.643C5.53912 10.643 5.72065 10.5163 5.83505 10.1824L6.35704 8.65552H7.07512L5.73545 7.3191ZM6.76558 4.54388L6.83921 4.34562C6.98405 3.97498 7.24787 3.7843 7.63379 3.7843C8.0273 3.7843 8.30639 3.97498 8.44354 4.34562L9.5479 7.32295L7.9159 5.69287L7.68107 5.00968H7.60023L7.50615 5.28349L6.76558 4.54388ZM1.40642 1.83338L0.491296 0.920541C0.388078 0.818647 0.332378 0.677895 0.337912 0.532932C0.337912 0.379429 0.386393 0.258406 0.491296 0.161444C0.596318 0.0565414 0.725521 0 0.870844 0H0.878905C1.02423 0 1.15343 0.0565414 1.25845 0.161444L2.56312 1.46454C2.76113 1.43699 2.96167 1.42592 3.16281 1.4317H11.9172C12.5899 1.4317 13.1574 1.56138 13.6275 1.81269C14.1057 2.05582 14.4624 2.42069 14.7056 2.89083C14.9488 3.36096 15.0785 3.9283 15.0785 4.59296V9.82123C15.0785 10.486 14.9569 11.0534 14.7056 11.5235C14.472 11.975 14.1264 12.3218 13.683 12.5712L14.7594 13.6463C14.8645 13.7594 14.9209 13.8886 14.9209 14.0339C14.9209 14.1792 14.8645 14.3004 14.7594 14.4053C14.6653 14.5108 14.5294 14.5699 14.388 14.5669C14.2447 14.5681 14.1071 14.5095 14.0085 14.4053L12.5412 12.9416C12.3443 12.9688 12.1363 12.9826 11.9172 12.9826H7.7589L5.45683 15.0171C5.22982 15.2197 5.02724 15.3657 4.86507 15.463C4.7029 15.5602 4.52462 15.6089 4.33009 15.6089C4.0937 15.6208 3.86417 15.5254 3.70597 15.3495C3.54561 15.1475 3.46477 14.8936 3.47896 14.6362V12.9826H3.11421C2.46579 12.9826 1.90639 12.8529 1.44444 12.6016C0.987656 12.3579 0.614724 11.9821 0.374483 11.5235C0.112228 10.9954 -0.0157722 10.4107 0.00155112 9.82123V4.59296C0.00155112 3.9283 0.123175 3.36096 0.366303 2.89083C0.602935 2.43332 0.954574 2.08337 1.40642 1.83338ZM2.43512 2.85955C2.16997 2.93811 1.95319 3.06286 1.78489 3.23128C1.4768 3.55549 1.32281 4.01744 1.32281 4.6335V9.77263C1.32281 10.3968 1.48498 10.8669 1.78489 11.183C2.09286 11.4992 2.56299 11.6532 3.1953 11.6532H4.11933C4.30579 11.6532 4.44354 11.6937 4.52462 11.7748C4.62194 11.8559 4.66248 12.0018 4.66248 12.2044V14.1175L4.6543 14.1255H4.66248V14.1175L6.79433 12.0179C6.94014 11.8639 7.06982 11.7748 7.19963 11.7262C7.32113 11.6775 7.4833 11.6532 7.68588 11.6532H11.2498L2.43512 2.85955ZM3.86116 2.76114L12.6596 11.5489C12.9182 11.4701 13.1309 11.3474 13.2951 11.183C13.5951 10.8588 13.7492 10.3968 13.7492 9.77263V4.6335C13.7492 4.01744 13.5951 3.54731 13.2951 3.23128C12.9872 2.91513 12.5089 2.76114 11.8767 2.76114H3.86116Z" fill="currentColor"/>
    </svg>`;

    const hideTextIconSVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M0.760587 2.36684L1.73181 3.33805L1.71548 3.36254C1.46248 3.67267 1.33189 4.1134 1.33189 4.66838V9.84277C1.33189 10.4712 1.49512 10.9446 1.7971 11.2629C2.10723 11.5812 2.5806 11.7362 3.2172 11.7362H4.14761C4.33532 11.7362 4.47407 11.777 4.56385 11.8587C4.64546 11.9403 4.69443 12.0872 4.69443 12.2912V14.2255L6.8409 12.1035C6.98781 11.9484 7.12656 11.8587 7.24898 11.8097C7.3714 11.7607 7.53463 11.7362 7.73867 11.7362H10.1382L11.4766 13.0747H7.81212L5.49426 15.1233C5.26573 15.3273 5.06986 15.4742 4.89847 15.5721C4.73524 15.6701 4.55568 15.719 4.36797 15.719C4.09048 15.719 3.87828 15.6374 3.73137 15.4579C3.56987 15.2545 3.48856 14.999 3.50285 14.7397V13.0747H3.13558C2.48266 13.0747 1.91952 12.9441 1.45431 12.6911C0.994029 12.4461 0.618513 12.0678 0.376996 11.6057C0.113028 11.0738 -0.0159119 10.4852 0.00156743 9.89174V4.62757C0.00156743 3.95833 0.12399 3.38702 0.376996 2.91366C0.483096 2.70962 0.605518 2.53007 0.760587 2.36684ZM0.850363 0C1.00543 0 1.12785 0.0571305 1.24212 0.16323L14.8881 13.7929C14.9942 13.9072 15.0514 14.0378 15.0514 14.1847C15.0514 14.3316 14.9942 14.454 14.8881 14.5601C14.8402 14.6139 14.7809 14.6564 14.7146 14.6846C14.6483 14.7128 14.5766 14.726 14.5046 14.7233C14.4328 14.7239 14.3618 14.7097 14.2958 14.6817C14.2298 14.6536 14.1703 14.6122 14.121 14.5601L0.466773 0.930411C0.414092 0.878525 0.373028 0.816046 0.346296 0.747106C0.319564 0.678165 0.307773 0.604335 0.311704 0.530497C0.311704 0.38359 0.368835 0.261168 0.474934 0.16323C0.572872 0.0571305 0.695295 0 0.842202 0H0.850363ZM11.999 1.44459C12.6764 1.44459 13.2558 1.57517 13.7292 1.82818C14.2026 2.07302 14.5617 2.44029 14.8147 2.91366C15.0595 3.38702 15.182 3.95833 15.182 4.62757V9.89174C15.182 10.561 15.0595 11.1323 14.8147 11.6057C14.7004 11.8179 14.5698 12.0056 14.4066 12.177L13.4354 11.1976L13.4762 11.1568C13.721 10.8466 13.8516 10.4059 13.8516 9.84277V4.66838C13.8516 4.0481 13.6884 3.57474 13.3864 3.25644C13.0763 2.93814 12.6029 2.78307 11.9582 2.78307H5.02089L3.67424 1.44459H11.999ZM5.19228 7.41064C5.37194 7.41064 5.54424 7.48201 5.67128 7.60905C5.79832 7.73609 5.86969 7.90839 5.86969 8.08805C5.86969 8.2677 5.79832 8.44001 5.67128 8.56704C5.54424 8.69408 5.37194 8.76545 5.19228 8.76545H3.84563C3.66598 8.76545 3.49367 8.69408 3.36664 8.56704C3.2396 8.44001 3.16823 8.2677 3.16823 8.08805C3.16823 7.90839 3.2396 7.73609 3.36664 7.60905C3.49367 7.48201 3.66598 7.41064 3.84563 7.41064H5.19228ZM9.70559 7.41064C10.081 7.41064 10.383 7.71262 10.383 8.08805V8.14518L9.64846 7.41064H9.70559ZM3.59263 5.20704L4.89847 6.50472H3.83747C3.68084 6.50289 3.52969 6.44683 3.40973 6.34609C3.28978 6.24535 3.20845 6.10615 3.17959 5.9522C3.15072 5.79824 3.1761 5.63903 3.25141 5.50168C3.32672 5.36433 3.4473 5.25732 3.59263 5.19888V5.20704ZM11.5093 5.15807C11.5982 5.15807 11.6863 5.17559 11.7685 5.20963C11.8507 5.24368 11.9254 5.29357 11.9883 5.35648C12.0512 5.41938 12.1011 5.49405 12.1351 5.57624C12.1692 5.65843 12.1867 5.74651 12.1867 5.83547C12.1867 5.92443 12.1692 6.01252 12.1351 6.0947C12.1011 6.17689 12.0512 6.25157 11.9883 6.31447C11.9254 6.37737 11.8507 6.42727 11.7685 6.46131C11.6863 6.49536 11.5982 6.51288 11.5093 6.51288H10.1545C10.0655 6.51288 9.97743 6.49536 9.89524 6.46131C9.81306 6.42727 9.73838 6.37737 9.67548 6.31447C9.61257 6.25157 9.56268 6.17689 9.52863 6.0947C9.49459 6.01252 9.47707 5.92443 9.47707 5.83547C9.47707 5.74651 9.49459 5.65843 9.52863 5.57624C9.56268 5.49405 9.61257 5.41938 9.67548 5.35648C9.73838 5.29357 9.81306 5.24368 9.89524 5.20963C9.97743 5.17559 10.0655 5.15807 10.1545 5.15807H11.5093ZM7.9019 5.15807C8.02503 5.15868 8.14566 5.19283 8.25083 5.25686C8.356 5.3209 8.44173 5.41238 8.4988 5.52149C8.55587 5.63059 8.58213 5.75319 8.57474 5.8761C8.56735 5.99901 8.52661 6.11758 8.45688 6.21906L7.39589 5.15807H7.9019Z" fill="currentColor"/>
    </svg>`;

    if (!hasTranslation) {
      const optionDiv = document.createElement("div");
      optionDiv.className = "dropdown-option";
      const textSpan = document.createElement("span");
      textSpan.textContent = t("showTranslation");
      const iconDiv = document.createElement("div");
      iconDiv.className = "dropdown-icon";
      iconDiv.innerHTML = translationIconSVG;
      optionDiv.appendChild(textSpan);
      optionDiv.appendChild(iconDiv);
      optionDiv.addEventListener("click", () => {
        this.dropdownMenu.classList.add("hidden");
        let newMode = "translate";
        if (this.currentDisplayMode === "romanize") {
          newMode = "both";
        }
        if (this.setCurrentDisplayModeAndRefetchFn && this.lastKnownSongInfo) {
          this.setCurrentDisplayModeAndRefetchFn(
            newMode,
            this.lastKnownSongInfo
          );
        }
      });
      this.dropdownMenu.appendChild(optionDiv);
    }

    if (hasTranslation) {
      const optionDiv = document.createElement("div");
      optionDiv.className = "dropdown-option";
      const textSpan = document.createElement("span");
      textSpan.textContent = t("hideTranslation");
      const iconDiv = document.createElement("div");
      iconDiv.className = "dropdown-icon";
      iconDiv.innerHTML = hideTranslationIconSVG;
      optionDiv.appendChild(textSpan);
      optionDiv.appendChild(iconDiv);
      optionDiv.addEventListener("click", () => {
        this.dropdownMenu.classList.add("hidden");
        let newMode = "none";
        if (this.currentDisplayMode === "both") {
          newMode = "romanize";
        }
        if (this.setCurrentDisplayModeAndRefetchFn && this.lastKnownSongInfo) {
          this.setCurrentDisplayModeAndRefetchFn(
            newMode,
            this.lastKnownSongInfo
          );
        }
      });
      this.dropdownMenu.appendChild(optionDiv);
    }

    if (!hasRomanization) {
      const optionDiv = document.createElement("div");
      optionDiv.className = "dropdown-option";
      const textSpan = document.createElement("span");
      textSpan.textContent =
        this.largerTextMode == "romanization"
          ? t("showOriginal")
          : t("showPronunciation");
      const iconDiv = document.createElement("div");
      iconDiv.className = "dropdown-icon";
      iconDiv.innerHTML = textIconSVG;
      optionDiv.appendChild(textSpan);
      optionDiv.appendChild(iconDiv);
      optionDiv.addEventListener("click", () => {
        this.dropdownMenu.classList.add("hidden");
        let newMode = "romanize";
        if (this.currentDisplayMode === "translate") {
          newMode = "both";
        }
        if (this.setCurrentDisplayModeAndRefetchFn && this.lastKnownSongInfo) {
          this.setCurrentDisplayModeAndRefetchFn(
            newMode,
            this.lastKnownSongInfo
          );
        }
      });
      this.dropdownMenu.appendChild(optionDiv);
    }

    if (hasRomanization) {
      const optionDiv = document.createElement("div");
      optionDiv.className = "dropdown-option";
      const textSpan = document.createElement("span");
      textSpan.textContent =
        this.largerTextMode == "romanization"
          ? t("hideOriginal")
          : t("hidePronunciation");
      const iconDiv = document.createElement("div");
      iconDiv.className = "dropdown-icon";
      iconDiv.innerHTML = hideTextIconSVG;
      optionDiv.appendChild(textSpan);
      optionDiv.appendChild(iconDiv);
      optionDiv.addEventListener("click", () => {
        this.dropdownMenu.classList.add("hidden");
        let newMode = "none";
        if (this.currentDisplayMode === "both") {
          newMode = "translate";
        }
        if (this.setCurrentDisplayModeAndRefetchFn && this.lastKnownSongInfo) {
          this.setCurrentDisplayModeAndRefetchFn(
            newMode,
            this.lastKnownSongInfo
          );
        }
      });
      this.dropdownMenu.appendChild(optionDiv);
    }
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
    this.translationButton.title = t("showTranslationOptions") || "Translation";
  }

  /**
   * Cleans up the lyrics container and resets the state for the next song.
   */
  cleanupLyrics() {
    // --- Animation Frame Cleanup ---
    if (this.lyricsAnimationFrameId) {
      cancelAnimationFrame(this.lyricsAnimationFrameId);
      this.lyricsAnimationFrameId = null;
    }

    // --- Touch State Cleanup ---
    if (this.touchState) {
      if (this.touchState.momentum) {
        cancelAnimationFrame(this.touchState.momentum);
        this.touchState.momentum = null;
      }
      this.touchState.isActive = false;
      this.touchState.startY = 0;
      this.touchState.lastY = 0;
      this.touchState.velocity = 0;
      this.touchState.lastTime = 0;
      this.touchState.samples = [];
    }

    // --- Timer Cleanup ---
    if (this.endProgrammaticScrollTimer)
      clearTimeout(this.endProgrammaticScrollTimer);
    if (this.userScrollIdleTimer) clearTimeout(this.userScrollIdleTimer);
    if (this.userScrollRevertTimer) clearTimeout(this.userScrollRevertTimer);
    this.endProgrammaticScrollTimer = null;
    this.userScrollIdleTimer = null;
    this.userScrollRevertTimer = null;

    // --- Observer Cleanup ---
    if (this.visibilityObserver) this.visibilityObserver.disconnect();
    if (this.resizeObserver) this.resizeObserver.disconnect();
    this.visibilityObserver = null;
    this.resizeObserver = null;

    // --- DOM Elements Cleanup ---
    const container = this._getContainer();
    if (container) {
      if (this.cachedLyricsLines) {
        this.cachedLyricsLines.forEach((line) => {
          if (line && line._cachedSyllableElements) {
            line._cachedSyllableElements = null;
          }
        });
      }

      if (this.cachedSyllables) {
        this.cachedSyllables.forEach((syllable) => {
          if (syllable) {
            syllable._cachedCharSpans = null;
            syllable.style.animation = "";
            syllable.style.removeProperty("--pre-wipe-duration");
            syllable.style.removeProperty("--pre-wipe-delay");
          }
        });
      }

      container.innerHTML = `<span class="text-loading">${t("loading")}</span>`;
      container.classList.add("lyrics-plus-message");

      const buttonsWrapper = document.getElementById("lyrics-plus-buttons-wrapper");
      if (buttonsWrapper) {
        buttonsWrapper.style.display = "none";
        buttonsWrapper.style.opacity = "0";
        buttonsWrapper.style.pointerEvents = "none";
      }

      const classesToRemove = [
        "user-scrolling",
        "wheel-scrolling",
        "touch-scrolling",
        "not-focused",
        "lyrics-translated",
        "lyrics-romanized",
        "lyrics-both-modes",
        "word-by-word-mode",
        "line-by-line-mode",
        "mixed-direction-lyrics",
        "dual-side-lyrics",
        "fullscreen",
        "blur-inactive-enabled",
        "use-song-palette-fullscreen",
        "use-song-palette-all-modes",
        "override-palette-color",
        "hide-offscreen",
        "romanized-big-mode",
      ];
      container.classList.remove(...classesToRemove);

      container.style.removeProperty("--lyrics-scroll-offset");
      container.style.removeProperty("--lyplus-override-pallete");
      container.style.removeProperty("--lyplus-override-pallete-white");
      container.style.removeProperty("--lyplus-song-pallete");
      container.style.removeProperty("--lyplus-song-white-pallete");
    }

    // --- State Variables Reset ---
    this.currentPrimaryActiveLine = null;
    this.lastPrimaryActiveLine = null;
    this.currentFullscreenFocusedLine = null;
    this.lastTime = 0;
    this.lastProcessedTime = 0;

    this.activeLineIds.clear();
    this.highlightedSyllableIds.clear();
    this.visibleLineIds.clear();
    this.cachedLyricsLines = [];
    this.cachedSyllables = [];

    this._cachedContainerRect = null;
    this._cachedVisibleLines = null;
    this._lastVisibilityHash = null;
    this._lastVisibilityUpdateSize = null;

    this.currentScrollOffset = 0;
    this.isProgrammaticScrolling = false;
    this.isUserControllingScroll = false;

    this.currentDisplayMode = undefined;
    this.largerTextMode = "lyrics";

    this.lastKnownSongInfo = null;
    this.fetchAndDisplayLyricsFn = null;
    this.setCurrentDisplayModeAndRefetchFn = null;

    this.fontCache = {};

    this._playerElement = undefined;
    this._customCssStyleTag = null;
  }

  /**
   * Injects custom CSS from settings into the document.
   * @param {string} customCSS - The custom CSS string to inject.
   * @private
   */
  _injectCustomCSS(customCSS) {
    if (!this._customCssStyleTag) {
      this._customCssStyleTag = document.createElement('style');
      this._customCssStyleTag.id = 'lyrics-plus-custom-css';
      document.head.appendChild(this._customCssStyleTag);
    }
    this._customCssStyleTag.textContent = customCSS || '';
  }

  /**
   * Extracts song information directly from YouTube Music DOM
   * @private
   */
  _getSongInfoFromDOM() {
    try {
      const titleElement = document.querySelector('.title.style-scope.ytmusic-player-bar');
      const byline = document.querySelector('.byline.style-scope.ytmusic-player-bar');
      
      if (!titleElement || !byline) {
        return null;
      }
      
      const title = titleElement.textContent.trim();
      if (!title) {
        return null;
      }
      
      let artists = [];
      let artistUrls = [];
      let album = "";
      let albumUrl = "";
      
      let links = byline.querySelectorAll('a');
      
      if (links.length === 0) {
        const bylineWrapper = document.querySelector('.byline-wrapper');
        if (bylineWrapper) {
          links = bylineWrapper.querySelectorAll('a');
        }
      }
      
      for (const link of links) {
        const href = link.getAttribute('href');
        const text = link.textContent?.trim();
        
        if (href) {
          if (href.startsWith('channel/')) {
            artists.push(text);
            artistUrls.push(href);
          } else if (href.startsWith('browse/')) {
            album = text;
            albumUrl = href;
          }
        }
      }
      
      let artist = "";
      if (artists.length === 1) {
        artist = artists[0];
      } else if (artists.length === 2) {
        artist = artists.join(" & ");
      } else if (artists.length > 2) {
        artist = artists.slice(0, -1).join(", ") + ", & " + artists[artists.length - 1];
      }
      
      if (!artist && byline.textContent) {
        const bylineText = byline.textContent.trim();
        const parts = bylineText.split(/[•·–—]/);
        if (parts.length > 0) {
          artist = parts[0].trim();
        }
      }
      
      const isVideo = album === '' && artist === '';
      
      return {
        title: title,
        artist: artist,
        album: album,
        isVideo: isVideo,
        videoId: null,
        artistUrl: artistUrls.length > 0 ? artistUrls[0] : null,
        albumUrl: albumUrl || null
      };
    } catch (error) {
      try {
        if (typeof LYPLUS_getDOMSongInfo === 'function') {
          const fallbackInfo = LYPLUS_getDOMSongInfo();
          if (fallbackInfo) {
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
      }
      
      return null;
    }
  }

  /**
   * Adds song information display from DOM scraping when lyrics are not found
   * @private
   */
  _addSongInfoFromDOM() {
    const playerPage = document.querySelector('ytmusic-player-page');
    const isFullscreen = playerPage && playerPage.hasAttribute('player-fullscreened');
    const isVideoMode = playerPage && playerPage.hasAttribute('video-mode');
    
    if (!isFullscreen) {
      return;
    }
    
    if (isVideoMode) {
      return;
    }
    
    const existingSongInfo = document.querySelector('.lyrics-song-info');
    if (existingSongInfo) {
      existingSongInfo.remove();
    }
    
    const songInfo = this._getSongInfoFromDOM();
    if (!songInfo) {
      return;
    }
    
    if (songInfo.isVideo) {
      return;
    }
    
    const songInfoContainer = document.createElement('div');
    songInfoContainer.className = 'lyrics-song-info';
    songInfoContainer.style.display = 'block';
    
    const titleElement = document.createElement('p');
    titleElement.id = 'lyrics-song-title';
    titleElement.textContent = songInfo.title;
    
    const artistElement = document.createElement('p');
    artistElement.id = 'lyrics-song-artist';
    
    if (songInfo.artistUrl && songInfo.artist) {
      const artistLink = document.createElement('a');
      artistLink.href = `/${songInfo.artistUrl}`;
      artistLink.textContent = songInfo.artist;
      artistLink.className = 'lyrics-clickable-artist';
      artistLink.style.cursor = 'pointer';
      artistLink.style.textDecoration = 'none';
      artistLink.style.color = 'inherit';
      
      artistLink.addEventListener('click', (e) => {
        e.preventDefault();
        window.open(`/${songInfo.artistUrl}`, '_blank');
      });
      
      artistElement.appendChild(artistLink);
    } else if (songInfo.artist) {
      artistElement.textContent = songInfo.artist;
    }
    
    if (songInfo.album && songInfo.album.trim() !== '') {
      if (songInfo.artist) {
        const separator = document.createTextNode(' — ');
        artistElement.appendChild(separator);
      }
      
      if (songInfo.albumUrl) {
        const albumLink = document.createElement('a');
        albumLink.href = `/${songInfo.albumUrl}`;
        albumLink.textContent = songInfo.album;
        albumLink.className = 'lyrics-clickable-album';
        albumLink.style.cursor = 'pointer';
        albumLink.style.textDecoration = 'none';
        albumLink.style.color = 'inherit';
        
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
    
    document.body.appendChild(songInfoContainer);
    this._positionSongInfoRelativeToArtwork(songInfoContainer);
    this._setupArtworkObservers(songInfoContainer);
  }

  /**
   * Adds song information display below the album art in fullscreen mode
   * @private
   */
  _addSongInfoDisplay(container) {
    const playerPage = document.querySelector('ytmusic-player-page');
    const isFullscreen = playerPage && playerPage.hasAttribute('player-fullscreened');
    const isVideoMode = playerPage && playerPage.hasAttribute('video-mode');
    
    if (!isFullscreen) {
      return;
    }
    if (isVideoMode) {
      return;
    }
    
    const existingSongInfo = document.querySelector('.lyrics-song-info');
    if (existingSongInfo) {
      existingSongInfo.remove();
    }

    let songInfo = this.lastKnownSongInfo;
    if (!songInfo) {
      return;
    }
    if (songInfo.isVideo) {
      return;
    }

    if (!songInfo.artistUrl || !songInfo.albumUrl) {
      const domInfo = this._getSongInfoFromDOM();
      if (domInfo && domInfo.artistUrl) {
        songInfo.artistUrl = domInfo.artistUrl;
      }
      if (domInfo && domInfo.albumUrl) {
        songInfo.albumUrl = domInfo.albumUrl;
      }
    }

    const songInfoContainer = document.createElement('div');
    songInfoContainer.className = 'lyrics-song-info';
    songInfoContainer.style.display = 'block';
    
    const titleElement = document.createElement('p');
    titleElement.id = 'lyrics-song-title';
    titleElement.textContent = songInfo.title;
    
    const artistElement = document.createElement('p');
    artistElement.id = 'lyrics-song-artist';
    
    if (songInfo.artistUrl && songInfo.artist) {
      const artistLink = document.createElement('a');
      artistLink.href = `/${songInfo.artistUrl}`;
      artistLink.textContent = songInfo.artist;
      artistLink.className = 'lyrics-clickable-artist';
      artistLink.style.cursor = 'pointer';
      artistLink.style.textDecoration = 'none';
      artistLink.style.color = 'inherit';
      
      artistLink.addEventListener('click', (e) => {
        e.preventDefault();
        window.open(`/${songInfo.artistUrl}`, '_blank');
      });
      
      artistElement.appendChild(artistLink);
    } else if (songInfo.artist) {
      artistElement.textContent = songInfo.artist;
    }
    
    if (songInfo.album && songInfo.album.trim() !== '') {
      if (songInfo.artist) {
        const separator = document.createTextNode(' — ');
        artistElement.appendChild(separator);
      }
      
      if (songInfo.albumUrl) {
        const albumLink = document.createElement('a');
        albumLink.href = `/${songInfo.albumUrl}`;
        albumLink.textContent = songInfo.album;
        albumLink.className = 'lyrics-clickable-album';
        albumLink.style.cursor = 'pointer';
        albumLink.style.textDecoration = 'none';
        albumLink.style.color = 'inherit';
        
        albumLink.addEventListener('click', (e) => {
          e.preventDefault();
          window.open(`/${songInfo.albumUrl}`, '_blank');
        });
        
        artistElement.appendChild(albumLink);
      } else {
        artistElement.appendChild(document.createTextNode(songInfo.album));
      }
    }
    
    artistElement.style.fontFamily = 'SF Pro Display, sans-serif';
    
    songInfoContainer.appendChild(titleElement);
    songInfoContainer.appendChild(artistElement);
    
    document.body.appendChild(songInfoContainer);
    this._positionSongInfoRelativeToArtwork(songInfoContainer);
    this._setupArtworkObservers(songInfoContainer);
  }

  /**
   * Finds the album artwork element in YT Music fullscreen layout.
   */
  _findArtworkElement() {
    const candidates = [
      'ytmusic-player-page[player-fullscreened] img.image',
      'ytmusic-player-page[player-fullscreened] #thumbnail img',
      'ytmusic-player-page[player-fullscreened] .image',
      'ytmusic-player-page[player-fullscreened] #player img',
      'ytmusic-player-page[player-fullscreened] .player-image',
      'ytmusic-player-page[player-fullscreened] ytmusic-player img',
      'ytmusic-player-page[player-fullscreened] #thumbnail',
      '.image.ytmusic-player-bar'
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.getBoundingClientRect) {
        const rect = el.getBoundingClientRect();
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
      songInfoContainer.style.position = '';
      songInfoContainer.style.left = '';
      songInfoContainer.style.top = '';
      songInfoContainer.style.transform = '';
      songInfoContainer.style.maxWidth = '';
      songInfoContainer.style.textAlign = '';
      return;
    }
    
    const rect = artworkEl.getBoundingClientRect();

    const leftX = rect.left;
    const topY = rect.bottom + 20;

    songInfoContainer.style.position = 'fixed';
    songInfoContainer.style.left = `${leftX}px`;
    songInfoContainer.style.top = `${topY}px`;
    songInfoContainer.style.transform = 'none';
    songInfoContainer.style.maxWidth = `${Math.max(300, Math.floor(rect.width))}px`;
    songInfoContainer.style.textAlign = 'left';
    songInfoContainer.style.zIndex = '1000';
  }

  /**
   * Observes layout changes to keep song info aligned with artwork when zooming/resizing.
   */
  _setupArtworkObservers(songInfoContainer) {
    const reposition = () => {
      this._positionSongInfoRelativeToArtwork(songInfoContainer);
    };
    this._artworkRepositionHandler = reposition;

    window.addEventListener('resize', reposition, { passive: true });
    window.addEventListener('scroll', reposition, { passive: true });
    
    // Removed continuous requestAnimationFrame loop to prevent lag during fullscreen transitions
    // Use event-driven repositioning instead

    const playerPage = document.querySelector('ytmusic-player-page');
    if (playerPage) {
      if (this._artworkMutationObserver) this._artworkMutationObserver.disconnect();
      this._artworkMutationObserver = new MutationObserver(() => {
        reposition();
      });
      this._artworkMutationObserver.observe(playerPage, { 
        attributes: true, 
        childList: true, 
        subtree: true,
        attributeFilter: ['player-fullscreened', 'video-mode', 'style']
      });
    }

    const container = this._getContainer();

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
