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
    this.offsetLatency = 0;

    this.uiConfig = uiConfig;
    this.lyricsContainer = null;
    this.cachedLyricsLines = [];
    this.cachedSyllables = [];
    this.activeLineIds = new Set();
    this.visibleLineIds = new Set();
    this.fontCache = {};

    this.textWidthCanvas = null;
    this.visibilityObserver = null;
    this.resizeObserver = null;
    this._cachedContainerRect = null;
    this._artworkMutationObserver = null;
    this._artworkRepositionHandler = null;
    this._cleanupArtworkObservers = null;
    this._debouncedResizeHandler = this._debounce(
      this._handleContainerResize,
      1,
      { leading: true, trailing: true },
    );

    this.translationButton = null;
    this.reloadButton = null;
    this.dropdownMenu = null;
    this.buttonsWrapper = null;
    this._boundLyricClickHandler = this._onLyricClick.bind(this);

    this.isProgrammaticScrolling = false;
    this.endProgrammaticScrollTimer = null;
    this.scrollEventHandlerAttached = false;
    this.currentScrollOffset = 0;
    this.userScrollIdleTimer = null;
    this.isUserControllingScroll = false;
    this.userScrollRevertTimer = null;

    this._boundParentScrollHandler = this._onParentScroll.bind(this);
    this._boundUserInteractionHandler = this._onUserInteraction.bind(this);
    this._boundTouchStartHandler = this._onTouchStart.bind(this);
    this._boundTouchMoveHandler = this._onTouchMove.bind(this);

    this._touchStartY = 0;
    this._touchStartX = 0;

    this._lastActiveIndex = 0;
    this._tempActiveLines = [];

    this.wakeLock = null;
    this._isContainerVisible = false;

    this._getContainer();
  }

  async _requestWakeLock() {
    if ("wakeLock" in navigator) {
      try {
        this.wakeLock = await navigator.wakeLock.request("screen");
      } catch (err) {
        console.warn(`LYPLUS: Wakelock error: ${err.name}, ${err.message}`);
      }
    }
  }

  _releaseWakeLock() {
    if (this.wakeLock !== null) {
      this.wakeLock
        .release()
        .then(() => {
          this.wakeLock = null;
        })
        .catch((err) => {
          console.warn(
            `LYPLUS: Wakelock release error: ${err.name}, ${err.message}`,
          );
        });
    }
  }

  _setupContainerObserver() {
    if (!this.lyricsContainer) return;

    if (!this.containerObserver) {
      this.containerObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            this._isContainerVisible = entry.isIntersecting;
            if (entry.isIntersecting) {
              this._requestWakeLock();
            } else {
              this._releaseWakeLock();
            }
          });
        },
        { threshold: 0.01 },
      );
      this.containerObserver.observe(this.lyricsContainer);
    }
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

    const isRomanizationMode = this.largerTextMode === "romanization";

    // In romanization mode the main/background container shows romanized text
    // and the secondary container shows original text — the roles are swapped.
    if (isOriginal) {
      return isRomanizationMode
        ? normal.romanizedText || normal.text || "" // Main: prefer romanized
        : normal.text || ""; // Main: prefer original
    } else {
      return isRomanizationMode
        ? normal.text || "" // Secondary: show original
        : normal.romanizedText || normal.text || ""; // Secondary: prefer romanized
    }
  }

  /**
   * Handles the actual logic for container resize, debounced by _debouncedResizeHandler.
   * @param {HTMLElement} container - The lyrics container element.
   * @private
   */
  _handleContainerResize(container, rect) {
    if (!container) return;

    this._scrollPaddingTopCache = undefined;
    this._containerDisplayCache = undefined;
    this._positionClassedLines = [];

    const containerTop =
      rect && typeof rect.top === "number"
        ? rect.top
        : container.getBoundingClientRect().top;

    this._cachedContainerRect = {
      containerTop: containerTop - 50,
      scrollContainerTop: containerTop - 50,
    };

    if (!this.isUserControllingScroll && this.currentPrimaryActiveLine) {
      this._scrollToActiveLine(this.currentPrimaryActiveLine, false, true);
    }
  }

  static _RTL_RE =
    /[\u0600-\u06FF\u0750-\u077F\u0590-\u05FF\u08A0-\u08FF\uFB50-\uFDCF\uFDF0-\uFDFF\uFE70-\uFEFF]/;
  static _CJK_RE =
    /[\u4E00-\u9FFF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/;
  static _LATIN_RE = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\s]*$/u;

  /**
   * A helper method to determine if a text string contains Right-to-Left characters.
   * @param {string} text - The text to check.
   * @returns {boolean} - True if the text contains RTL characters.
   */
  _isRTL(text) {
    return LyricsPlusRenderer._RTL_RE.test(text);
  }

  /**
   * A helper method to determine if a text string contains CJK characters.
   * @param {string} text - The text to check.
   * @returns {boolean} - True if the text contains CJK characters.
   */
  _isCJK(text) {
    return LyricsPlusRenderer._CJK_RE.test(text);
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
    return LyricsPlusRenderer._LATIN_RE.test(text);
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
    if (this.lyricsContainer) {
      this._attachScrollListeners();
      this._setupContainerObserver();
    }
    return this.lyricsContainer;
  }

  /**
   * Creates the main container for the lyrics and appends it to the DOM.
   * @returns {HTMLElement | null} - The newly created container element.
   */
  _createLyricsContainer() {
    const originalLyricsSection = document.querySelector(
      this.uiConfig.patchParent,
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
    return container;
  }

  _attachScrollListeners() {
    const scrollContainer = this.lyricsContainer?.parentElement;
    if (!scrollContainer || this.scrollEventHandlerAttached) return;

    scrollContainer.addEventListener(
      "wheel",
      this._boundUserInteractionHandler,
      { passive: true },
    );
    scrollContainer.addEventListener(
      "keydown",
      this._boundUserInteractionHandler,
      { passive: true },
    );

    scrollContainer.addEventListener(
      "touchstart",
      this._boundTouchStartHandler,
      { passive: true },
    );
    scrollContainer.addEventListener("touchmove", this._boundTouchMoveHandler, {
      passive: true,
    });

    this.scrollEventHandlerAttached = true;
  }

  /**
   * Fired on wheel, touch, or keydown.
   * Immediately flags user control.
   */
  _onUserInteraction() {
    this._setUserScrolled(true);
  }

  /**
   * Fired on any scroll movement.
   */
  _onParentScroll() {
    if (!this.isProgrammaticScrolling) {
      this._setUserScrolled(true);
    }
  }

  /**
   * Records the starting position of a touch.
   */
  _onTouchStart(e) {
    if (e.touches.length > 0) {
      this._touchStartX = e.touches[0].clientX;
      this._touchStartY = e.touches[0].clientY;
    }
  }

  /**
   * checks if the user moved their finger enough to be considered a scroll.
   */
  _onTouchMove(e) {
    if (e.touches.length > 0) {
      const currentX = e.touches[0].clientX;
      const currentY = e.touches[0].clientY;

      const diffX = Math.abs(currentX - this._touchStartX);
      const diffY = Math.abs(currentY - this._touchStartY);

      // Threshold of 10px prevents micro-jitters or taps from locking auto-scroll
      if (diffY > 10 || diffX > 10) {
        this._setUserScrolled(true);
      }
    }
  }

  /**
   * Updates state and manages the "revert to auto-scroll" timer
   */
  _setUserScrolled(isUserScrolling) {
    if (isUserScrolling) {
      this.isUserControllingScroll = true;
      this.lyricsContainer?.classList.add("user-scrolling", "not-focused");

      clearTimeout(this.userScrollIdleTimer);
      this.userScrollIdleTimer = setTimeout(() => {
        this.isUserControllingScroll = false;
        this.lyricsContainer?.classList.remove("user-scrolling", "not-focused");

        if (this.currentPrimaryActiveLine) {
          this._scrollToActiveLine(this.currentPrimaryActiveLine, true);
        }
      }, 5000);
    }
  }

  /**
   * Fixes lyric timings by analyzing overlaps and gaps in a multi-pass process.
   * @param {NodeListOf<HTMLElement> | Array<HTMLElement>} originalLines - A list of lyric elements.
   */
  _retimingActiveTimings(originalLines) {
    if (!originalLines || originalLines.length < 1) return;

    const OVERLAP_THRESHOLD = 0.005;
    const GAP_THRESHOLD = 0.001;
    const MAX_EXTENSION = 1.3;

    const lines = Array.from(originalLines).map((el) => ({
      element: el,
      startTime: parseFloat(el.dataset.startTime),
      originalEndTime: parseFloat(el.dataset.endTime),
      newEndTime: parseFloat(el.dataset.endTime),
    }));

    let i = 0;
    while (i < lines.length) {
      let clusterEnd = i;
      let maxEndInRange = lines[i].originalEndTime;

      while (clusterEnd < lines.length - 1) {
        const next = lines[clusterEnd + 1];
        const overlap = maxEndInRange - next.startTime; // positive → overlap

        if (overlap > OVERLAP_THRESHOLD) {
          clusterEnd = clusterEnd + 1;
          maxEndInRange = Math.max(maxEndInRange, next.originalEndTime);
        } else {
          break;
        }
      }

      const cluster = lines.slice(i, clusterEnd + 1);

      const clusterBaseEnd = cluster.reduce(
        (max, l) => Math.max(max, l.originalEndTime),
        cluster[0].originalEndTime,
      );

      let clusterFinalEnd = clusterBaseEnd;
      const lineAfter = lines[clusterEnd + 1];

      if (lineAfter) {
        const gap = lineAfter.startTime - clusterBaseEnd;
        const nextEl = lines[clusterEnd].element.nextElementSibling;
        const hasManualGapMark = nextEl?.classList.contains("lyrics-gap");

        if (gap > GAP_THRESHOLD && !hasManualGapMark) {
          clusterFinalEnd += Math.min(MAX_EXTENSION, gap);
        }
      }

      for (let j = i; j <= clusterEnd; j++) {
        let cutoff = null;

        for (let k = j + 1; k <= clusterEnd; k++) {
          const jClearsK =
            lines[j].originalEndTime - lines[k].startTime <= OVERLAP_THRESHOLD;
          const chainBrokenAtK =
            lines[k - 1].originalEndTime - lines[k].startTime <=
            OVERLAP_THRESHOLD;

          if (jClearsK || chainBrokenAtK) {
            cutoff = lines[k].startTime;
            break;
          }
        }

        lines[j].newEndTime = cutoff ?? clusterFinalEnd;
      }

      i = clusterEnd + 1;
    }

    for (const { element: el, originalEndTime, newEndTime } of lines) {
      el.dataset.actualEndTime = originalEndTime.toFixed(3);
      el._actualEndTimeMs = originalEndTime * 1000;

      if (Math.abs(newEndTime - originalEndTime) > GAP_THRESHOLD) {
        el.dataset.endTime = newEndTime.toFixed(3);
      }
    }
  }

  /**
   * An internal handler for click events on lyric lines.
   * Seeks the video to the line's start time.
   * @param {Event} e - The click event.
   */
  _onLyricClick(e) {
    const time = parseFloat(e.currentTarget.dataset.startTime);
    this._seekPlayerTo(time - 0.05);
    this._scrollToActiveLine(e.currentTarget, true);
  }

  /**
   * Internal helper to render word-by-word lyrics.
   * @private
   */
  _renderWordByWordLyrics(lyrics, displayMode, singerClassMap, fragment) {
    // --- Helper Functions ---

    const getComputedFont = (element) => {
      if (!element) return "400 16px sans-serif";
      const cacheKey = element.tagName + (element.className || "");
      if (this.fontCache[cacheKey]) return this.fontCache[cacheKey];
      const style = getComputedStyle(element);
      const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      this.fontCache[cacheKey] = font;
      return font;
    };

    const getFontSizePx = (font) => {
      const match = font.match(/(\d+(?:\.\d+)?)px/);
      return match ? parseFloat(match[1]) : 16;
    };

    const calculatePhysicsPreHighlightDelay = (
      syllable,
      font,
      currentDuration,
    ) => {
      const textWidthPx = this._getTextWidth(syllable.textContent, font);
      if (textWidthPx <= 0.1 || currentDuration <= 0)
        return { delay: 0, duration: 0 };

      const fontSizePx = getFontSizePx(font);
      const velocityPxPerMs = textWidthPx / currentDuration;
      const gradientDistancePx = 0.375 * fontSizePx;
      const gradientDurationMs = gradientDistancePx / velocityPxPerMs;

      return {
        delay: currentDuration - gradientDurationMs,
        duration: gradientDurationMs,
      };
    };

    // --- Main Line Loop ---

    lyrics.data.forEach((line) => {
      // 1. Line & Container Setup
      let currentLine = document.createElement("div");
      currentLine.className = "lyrics-line";
      currentLine.dataset.startTime = line.startTime;
      currentLine.dataset.endTime = line.endTime;

      let currentLineContainer = document.createElement("div");
      currentLineContainer.className = "lyrics-line-container";
      currentLine.appendChild(currentLineContainer);

      const singerClass = line.element?.singer
        ? singerClassMap[line.element.singer] || "singer-left"
        : "singer-left";
      currentLine.classList.add(singerClass);

      if (!currentLine._hasSharedListener) {
        currentLine.addEventListener("click", this._boundLyricClickHandler);
        currentLine._hasSharedListener = true;
      }

      const mainContainer = document.createElement("p");
      mainContainer.classList.add("main-vocal-container");
      currentLineContainer.appendChild(mainContainer);

      let backgroundContainer = null;
      let isFirstSyllableInMain = true;
      let isFirstSyllableInBg = true;
      let pendingSyllable = null;
      let pendingSyllableFont = null;

      // Check if line has both RTL characters and standard LTR script characters
      const isLineBiDi =
        line.text &&
        this._isRTL(line.text) &&
        /[\p{Script=Latin}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}]/u.test(
          line.text,
        );

      // --- Inner Logic Helpers ---

      const linkSyllables = (prevSyllable, nextSyllable, font) => {
        const physicsData = calculatePhysicsPreHighlightDelay(
          prevSyllable,
          font,
          prevSyllable._durationMs,
        );
        prevSyllable._nextSyllableInWord = nextSyllable;
        prevSyllable._preHighlightDurationMs = physicsData.duration;
        prevSyllable._preHighlightDelayMs = physicsData.delay;
      };

      const segmentGraphemes = (text) => {
        if (typeof Intl?.Segmenter === "function") {
          return [...new Intl.Segmenter().segment(text)].map((s) => s.segment);
        }
        return [...text];
      };

      const calculateEmphasisMetrics = (
        totalDuration,
        wordBufferLength,
        firstDuration,
      ) => {
        const minDuration = 1000;
        const maxDuration = 5000;
        const easingPower = 3;

        const progress = Math.min(
          1,
          Math.max(
            0,
            (totalDuration - minDuration) / (maxDuration - minDuration),
          ),
        );
        const easedProgress = Math.pow(progress, easingPower);

        let penaltyFactor = 1.0;
        if (wordBufferLength > 1) {
          const imbalanceRatio = firstDuration / totalDuration;
          const penaltyThreshold = 0.25;
          if (imbalanceRatio < penaltyThreshold) {
            const minPenaltyFactor = 0.5;
            const penaltyProgress = imbalanceRatio / penaltyThreshold;
            penaltyFactor =
              minPenaltyFactor + (1.0 - minPenaltyFactor) * penaltyProgress;
          }
        }
        return { easedProgress, penaltyFactor };
      };

      const createSyllableElement = (s, totalDuration, idx, isBg) => {
        const sylSpan = document.createElement("span");
        sylSpan.className = "lyrics-syllable";

        // Dataset & Props
        sylSpan.dataset.startTime = s.time;
        sylSpan.dataset.duration = s.duration;
        sylSpan.dataset.endTime = s.time + s.duration;
        sylSpan.dataset.wordDuration = totalDuration;
        sylSpan.dataset.syllableIndex = idx;
        sylSpan._startTimeMs = s.time;
        sylSpan._durationMs = s.duration;
        sylSpan._endTimeMs = s.time + s.duration;
        sylSpan._wordDurationMs = totalDuration;
        sylSpan._isBackground = isBg;
        sylSpan._syllableIdx = idx;
        sylSpan._state = 0; // numeric, faster than dataset string compare

        // First-in-container Logic
        if (isBg) {
          if (isFirstSyllableInBg) {
            sylSpan._isFirstInContainer = true;
            isFirstSyllableInBg = false;
          }
        } else {
          if (isFirstSyllableInMain) {
            sylSpan._isFirstInContainer = true;
            isFirstSyllableInMain = false;
          }
        }

        if (this._isRTL(this._getDataText(s, true))) {
          sylSpan.classList.add("rtl-text");
        }

        return sylSpan;
      };

      const renderCharWipes = (s, sylSpan, referenceFont, characterData) => {
        const syllableText = this._getDataText(s);
        const fontSizePx = getFontSizePx(referenceFont);
        const chars = segmentGraphemes(syllableText);
        const charWidths = chars.map((c) =>
          this._getTextWidth(c, referenceFont),
        );
        const totalSyllableWidth = charWidths.reduce((a, b) => a + b, 0);

        const velocityPxPerMs = totalSyllableWidth / s.duration;
        const gradientDurationMs = (0.375 * fontSizePx) / velocityPxPerMs;

        let cumulativeCharWidth = 0;
        const charSpans = [];

        chars.forEach((char, i) => {
          const charWidth = charWidths[i];
          if (char === " ") {
            sylSpan.appendChild(document.createTextNode(" "));
          } else {
            const charSpan = document.createElement("span");
            charSpan.textContent = char;
            charSpan.className = "char";

            if (totalSyllableWidth > 0) {
              const startPercent = cumulativeCharWidth / totalSyllableWidth;
              const durationPercent = charWidth / totalSyllableWidth;

              charSpan.dataset.wipeStart = startPercent.toFixed(4);
              charSpan.dataset.wipeDuration = durationPercent.toFixed(4);
              charSpan.dataset.preWipeArrival = (
                s.duration * startPercent
              ).toFixed(2);
              charSpan.dataset.preWipeDuration = gradientDurationMs.toFixed(2);
              charSpan._wipeStart = startPercent;
              charSpan._wipeDuration = durationPercent;
              charSpan._preWipeArrival = s.duration * startPercent;
              charSpan._preWipeDuration = gradientDurationMs;
            }

            charSpan.dataset.syllableCharIndex = characterData.length;
            charSpan._syllableCharIndex = characterData.length;
            characterData.push({
              charSpan,
              syllableSpan: sylSpan,
              isBackground: s.isBackground,
            });
            charSpans.push(charSpan);
            sylSpan.appendChild(charSpan);
          }
          cumulativeCharWidth += charWidth;
        });

        if (charSpans.length > 0) sylSpan._cachedCharSpans = charSpans;
      };

      const applyGrowthStyles = (
        wordSpan,
        referenceFont,
        combinedText,
        totalDuration,
        emphasisMetrics,
      ) => {
        if (!wordSpan._cachedChars || wordSpan._cachedChars.length === 0)
          return;

        const { easedProgress, penaltyFactor } = emphasisMetrics;
        const wordWidth = this._getTextWidth(
          wordSpan.textContent.trim(),
          referenceFont,
        );
        const numChars = wordSpan._cachedChars.length;
        const wordLength = segmentGraphemes(combinedText.trim()).length;

        let maxDecayRate = 0;
        const isLongWord = wordLength > 5;
        const isShortDuration = totalDuration < 1500;
        const hasUnbalancedSyllables = penaltyFactor < 0.95;

        if (isLongWord || isShortDuration || hasUnbalancedSyllables) {
          let decayStrength = 0;
          if (isLongWord)
            decayStrength += Math.min((wordLength - 5) / 3, 1.0) * 0.4;
          if (isShortDuration)
            decayStrength +=
              Math.max(0, 1.0 - (totalDuration - 1000) / 500) * 0.4;
          if (hasUnbalancedSyllables)
            decayStrength += Math.pow(1.0 - penaltyFactor, 0.7) * 1.2;
          maxDecayRate = Math.min(decayStrength, 0.85);
        }

        let cumulativeWidth = 0;
        wordSpan._cachedChars.forEach((span, index) => {
          const positionInWord = numChars > 1 ? index / (numChars - 1) : 0;
          const decayFactor = 1.0 - positionInWord * maxDecayRate;
          const charProgress = easedProgress * penaltyFactor * decayFactor;

          const baseGrowth = numChars <= 3 ? 0.07 : 0.05;
          const charMaxScale = 1.0 + baseGrowth + charProgress * 0.1;
          const charShadowIntensity = 0.4 + charProgress * 0.4;
          const normalizedGrowth = (charMaxScale - 1.0) / 0.13;
          const charTranslateYPeak = -normalizedGrowth * 6;

          span.style.setProperty("--max-scale", charMaxScale.toFixed(3));
          span.style.setProperty(
            "--shadow-intensity",
            charShadowIntensity.toFixed(3),
          );
          span.style.setProperty(
            "--translate-y-peak",
            charTranslateYPeak.toFixed(3),
          );

          const charWidth = this._getTextWidth(
            span.textContent.trim(),
            referenceFont,
          );
          const position = (cumulativeWidth + charWidth / 2) / wordWidth;
          const horizontalOffset =
            (position - 0.5) * 2 * ((charMaxScale - 1.0) * 25);

          span.dataset.horizontalOffset = horizontalOffset;
          span._horizontalOffset = horizontalOffset;
          cumulativeWidth += charWidth;
        });
      };

      const shouldAllowBreak = (text) =>
        text.trim().length >= 16 || this._isCJK(text.trim());

      // --- Core Render Function ---

      const renderWordSpan = (
        wordBuffer,
        shouldEmphasize,
        isLastInContiner = false,
      ) => {
        if (!wordBuffer.length) return;

        const currentWordStartTime = wordBuffer[0].time;
        const lastSyllable = wordBuffer[wordBuffer.length - 1];
        const currentWordEndTime = lastSyllable.time + lastSyllable.duration;
        const totalDuration = currentWordEndTime - currentWordStartTime;
        const combinedText = wordBuffer
          .map((s) => this._getDataText(s))
          .join("");
        const isBgWord = wordBuffer[0].isBackground || false;

        const wordSpan = document.createElement("span");
        wordSpan.className = "lyrics-word";

        if (shouldAllowBreak(combinedText)) {
          wordSpan.classList.add("allow-break");
        }

        const referenceFont = mainContainer.firstChild
          ? getComputedFont(mainContainer.firstChild)
          : "400 16px sans-serif";

        let emphasisMetrics = { easedProgress: 0, penaltyFactor: 1.0 };
        if (shouldEmphasize) {
          emphasisMetrics = calculateEmphasisMetrics(
            totalDuration,
            wordBuffer.length,
            wordBuffer[0].duration,
          );
          wordSpan.classList.add("growable");
        }

        const characterData = [];
        const syllableElements = [];

        // Process Syllables
        wordBuffer.forEach((s, idx) => {
          const wrap = document.createElement("span");
          wrap.className = "lyrics-syllable-wrap";

          const sylSpan = createSyllableElement(
            s,
            totalDuration,
            idx,
            s.isBackground || false,
          );

          let txtContent = "";
          if (s.isBackground) {
            txtContent = this._getDataText(s).replace(/[()]/g, "");
            sylSpan.textContent = txtContent;
          } else if (shouldEmphasize) {
            renderCharWipes(s, sylSpan, referenceFont, characterData);
          } else {
            txtContent = this._getDataText(s);
            sylSpan.textContent = txtContent;
          }

          if (!s.isBackground && !shouldEmphasize) {
            const textWidth = this._getTextWidth(
              txtContent.trim(),
              referenceFont,
            );
            const spaceWidth = this._getTextWidth(txtContent, referenceFont);
            if (textWidth > 0) {
              sylSpan._wipeRatio = textWidth / spaceWidth;
            } else {
              sylSpan._wipeRatio = 1;
            }
          } else {
            sylSpan._wipeRatio = 1;
          }

          wrap.appendChild(sylSpan);
          syllableElements.push(sylSpan);
          wordSpan.appendChild(wrap);
        });
        for (let _si = 0; _si < syllableElements.length; _si++) {
          syllableElements[_si]._isGrowable = shouldEmphasize;
        }

        if (shouldEmphasize) {
          wordSpan._cachedChars = characterData.map((cd) => cd.charSpan);
        }

        const hasText = (el) => el && el.textContent.trim().length > 0;

        if (
          pendingSyllable &&
          syllableElements.length > 0 &&
          pendingSyllable._isBackground === isBgWord
        ) {
          const firstVisibleSyllable = syllableElements.find(hasText);
          if (firstVisibleSyllable) {
            linkSyllables(
              pendingSyllable,
              firstVisibleSyllable,
              pendingSyllableFont,
            );
          }
        }

        // Intra-word Linking (Syllable -> Syllable)
        syllableElements.forEach((syllable, index) => {
          if (index < syllableElements.length - 1) {
            let nextIndex = index + 1;
            let nextSyllable = syllableElements[nextIndex];

            while (
              nextSyllable &&
              !hasText(nextSyllable) &&
              nextIndex < syllableElements.length - 1
            ) {
              nextIndex++;
              nextSyllable = syllableElements[nextIndex];
            }

            if (nextSyllable && hasText(nextSyllable)) {
              linkSyllables(syllable, nextSyllable, referenceFont);
            }
          }
        });

        const lastVisible = [...syllableElements].reverse().find(hasText);
        pendingSyllable =
          lastVisible ||
          (syllableElements.length > 0
            ? syllableElements[syllableElements.length - 1]
            : null);
        pendingSyllableFont = referenceFont;

        // Apply Styling
        if (shouldEmphasize) {
          applyGrowthStyles(
            wordSpan,
            referenceFont,
            combinedText,
            totalDuration,
            emphasisMetrics,
          );
        }

        // DOM Insertion
        const MoveEarlier = currentSettings.bkgOverlap;
        let backgroundInnerWrap = backgroundContainer?.querySelector(
          ".background-vocal-wrap",
        );
        const targetContainer = isBgWord
          ? backgroundInnerWrap ||
            (() => {
              backgroundContainer = document.createElement("p");
              backgroundContainer.className = "background-vocal-container";

              backgroundInnerWrap = document.createElement("span");
              backgroundInnerWrap.className = "background-vocal-wrap";
              backgroundContainer.appendChild(backgroundInnerWrap);

              if (MoveEarlier) {
                const firstMainSyllable =
                  mainContainer.querySelector(".lyrics-syllable");
                const mainStartTime = firstMainSyllable
                  ? firstMainSyllable._startTimeMs
                  : Infinity;

                if (currentWordStartTime < mainStartTime) {
                  backgroundContainer.classList.add("onTop");
                  currentLineContainer.prepend(backgroundContainer);
                } else {
                  currentLineContainer.appendChild(backgroundContainer);
                }
              } else {
                currentLineContainer.appendChild(backgroundContainer);
              }

              return backgroundInnerWrap;
            })()
          : mainContainer;

        // BIDI ISOLATION LOGIC
        let actualTarget = targetContainer;

        if (isLineBiDi) {
          const isWordRTL = this._isRTL(combinedText);
          const wrapperClass = isWordRTL ? "bidi-rtl" : "bidi-ltr";
          const wrapperDir = isWordRTL ? "rtl" : "ltr";

          let lastChild = targetContainer.lastElementChild;

          // Reuse the last wrapper if the direction matches
          if (lastChild && lastChild.classList.contains(wrapperClass)) {
            actualTarget = lastChild;
          } else {
            // Create a new directional wrapper
            actualTarget = document.createElement("span");
            actualTarget.className = wrapperClass;
            actualTarget.style.unicodeBidi = "isolate";
            targetContainer.appendChild(actualTarget);
          }
        }

        actualTarget.appendChild(wordSpan);

        const trailText = combinedText.match(/\s+$/);
        if (trailText && !isLastInContiner)
          actualTarget.appendChild(document.createTextNode(trailText[0]));

        pendingSyllable =
          syllableElements.length > 0
            ? syllableElements[syllableElements.length - 1]
            : null;
        pendingSyllableFont = referenceFont;
      };

      // --- Syllabus Processing ---

      if (line.syllabus && line.syllabus.length > 0) {
        const logicalWordGroups = [];
        let currentGroupBuffer = [];

        line.syllabus.forEach((s, idx) => {
          currentGroupBuffer.push(s);
          const syllableText = this._getDataText(s);
          const nextSyllable = line.syllabus[idx + 1];

          const endsWithDelimiter =
            s.isLineEnding ||
            /\s$/.test(syllableText) ||
            (nextSyllable && s.isBackground !== nextSyllable.isBackground);

          if (endsWithDelimiter) {
            logicalWordGroups.push(currentGroupBuffer);
            currentGroupBuffer = [];
          }
        });
        if (currentGroupBuffer.length > 0) {
          logicalWordGroups.push(currentGroupBuffer);
        }

        let lastMainGroupIdx = -1;
        let lastBgGroupIdx = -1;

        for (let i = 0; i < logicalWordGroups.length; i++) {
          const g = logicalWordGroups[i];
          if (g.length > 0) {
            if (g[0].isBackground) {
              lastBgGroupIdx = i;
            } else {
              lastMainGroupIdx = i;
            }
          }
        }

        logicalWordGroups.forEach((group, groupIdx) => {
          const isBg = group.length > 0 && group[0].isBackground;

          const groupText = group.map((s) => this._getDataText(s)).join("");
          const groupDuration = group.reduce((acc, s) => acc + s.duration, 0);

          const isLastGroupInContainer = isBg
            ? groupIdx === lastBgGroupIdx
            : groupIdx === lastMainGroupIdx;

          const isGroupGrowable =
            !isBg &&
            !currentSettings.lightweight &&
            !this._isRTL(groupText) &&
            groupText.trim().length <= 7 &&
            groupDuration >= 1000;

          if (isGroupGrowable) {
            renderWordSpan(group, true, isLastGroupInContainer);
          } else {
            let visualWordBuffer = [];
            group.forEach((s, idxInGroup) => {
              visualWordBuffer.push(s);
              const syllableText = this._getDataText(s);
              const isLastInGroup = idxInGroup === group.length - 1;

              if (
                (groupText.trim().length >= 12 && syllableText.endsWith("-")) ||
                isLastInGroup
              ) {
                renderWordSpan(visualWordBuffer, false, isLastGroupInContainer);
                visualWordBuffer = [];
              }
            });
          }
        });
      } else {
        mainContainer.textContent = line.text;
      }

      // 3. Final Line Cleanup (With First-Word BiDi Check)
      let applyRtlToLine = this._isRTL(mainContainer.textContent);

      // If it's a mixed language line, only apply RTL to the root container if the FIRST word is RTL
      if (applyRtlToLine && isLineBiDi) {
        let firstSyllableText = "";

        // Try to get the text of the first actual syllable with letters
        if (line.syllabus && line.syllabus.length > 0) {
          const firstValid = line.syllabus.find((s) =>
            /[\p{L}\p{N}]/u.test(this._getDataText(s)),
          );
          if (firstValid) {
            firstSyllableText = this._getDataText(firstValid);
          }
        }

        // Fallback: match the first letter/number directly from the main string
        if (!firstSyllableText) {
          const fallbackMatch =
            mainContainer.textContent.match(/[\p{L}\p{N}]/u);
          firstSyllableText = fallbackMatch ? fallbackMatch[0] : "";
        }

        // If the first real syllable/word is LTR, cancel the RTL override for the main container
        if (firstSyllableText && !this._isRTL(firstSyllableText)) {
          applyRtlToLine = false;
        }
      }

      if (applyRtlToLine) {
        mainContainer.classList.add("rtl-text");
        currentLine.classList.add("rtl-text");
      }

      fragment.appendChild(currentLine);

      this._renderTranslationContainer(currentLineContainer, line, displayMode);
    });
  }

  /**
   * Internal helper to render line-by-line lyrics.
   * @private
   */
  _renderLineByLineLyrics(lyrics, displayMode, singerClassMap, fragment) {
    const lineFragment = document.createDocumentFragment();
    lyrics.data.forEach((line) => {
      const lineEl = document.createElement("div");
      lineEl.className = "lyrics-line";
      const lineContainer = document.createElement("div");
      lineContainer.className = "lyrics-line-container";
      lineEl.append(lineContainer);
      lineEl.dataset.startTime = line.startTime;
      lineEl.dataset.endTime = line.endTime;

      const singerClass = line.element?.singer
        ? singerClassMap[line.element.singer] || "singer-left"
        : "singer-left";
      lineEl.classList.add(singerClass);

      const _lineText = this._getDataText(line, true);
      let _lineIsRTL = this._isRTL(_lineText);

      // BiDi First-Letter Check:
      // If the line contains RTL, verify the first strong character
      if (_lineIsRTL) {
        const firstCharMatch = _lineText.match(/[\p{L}\p{N}]/u);
        if (firstCharMatch) {
          const firstChar = firstCharMatch[0];
          // If the first strong character is NOT RTL (e.g., an English word),
          // keep the root container LTR.
          if (!this._isRTL(firstChar)) {
            _lineIsRTL = false;
          }
        }
      }

      if (_lineIsRTL) {
        lineEl.classList.add("rtl-text");
      }

      if (!lineEl._hasSharedListener) {
        lineEl.addEventListener("click", this._boundLyricClickHandler);
        lineEl._hasSharedListener = true;
      }

      const mainContainer = document.createElement("div");
      mainContainer.className = "main-vocal-container";
      mainContainer.textContent = this._getDataText(line);

      if (_lineIsRTL) {
        mainContainer.classList.add("rtl-text");
      }

      lineContainer.appendChild(mainContainer);
      this._renderTranslationContainer(lineContainer, line, displayMode);
      lineFragment.appendChild(lineEl);
    });
    fragment.appendChild(lineFragment);
  }

  /**
   * Internal helper to render plain text lyrics as a single text block.
   * @private
   */
  _renderPlainLyrics(lyrics, fragment) {
    const container = document.createElement("div");
    container.className = "lyrics-plain-text-container";

    const contentWrapper = document.createElement("div");
    contentWrapper.className = "lyrics-plain-text-content";

    let fullText = "";
    let currentSongPartIndex = 0;

    lyrics.data.forEach((line) => {
      const lineText = this._getDataText(line, true);

      if (
        line.element.songPartIndex !== currentSongPartIndex &&
        fullText !== ""
      ) {
        fullText += "\n";
      }

      if (!line.text || !line.text.trim()) {
        fullText += "\n";
      } else {
        fullText += lineText + "\n";
      }

      currentSongPartIndex = line.element.songPartIndex || currentSongPartIndex;
    });

    contentWrapper.textContent = fullText;

    container.appendChild(contentWrapper);
    fragment.appendChild(container);
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
      "lyrics-both-modes",
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
    const isRTL = this._isRTL(this._getDataText(lineData, true));
    const hasSyl =
      Array.isArray(lineData.syllabus) && lineData.syllabus.length > 0;

    if (displayMode === "romanize" || displayMode === "both") {
      if (!this._isPurelyLatinScript(lineData.text)) {
        const isWordSynced =
          lineElement.querySelector(".lyrics-syllable-wrap") !== null;

        if (
          hasSyl &&
          lineData.syllabus.some((s) =>
            (this._getDataText(s, false) || "").trim(),
          ) &&
          isWordSynced
        ) {
          if (isRTL) {
            const cont = document.createElement("div");
            cont.classList.add("lyrics-romanization-container");

            lineData.syllabus.forEach((s) => {
              const txt = this._getDataText(s, false);
              if (!txt) return;

              const span = document.createElement("span");
              span.className = "lyrics-syllable";
              span.textContent = txt;
              if (this._isRTL(txt)) span.classList.add("rtl-text");

              span.dataset.startTime = s.time;
              span.dataset.duration = s.duration;
              span.dataset.endTime = s.time + s.duration;
              span._startTimeMs = s.time;
              span._durationMs = s.duration;
              span._endTimeMs = s.time + s.duration;
              span._isFirstInContainer = true; //force fix bleeding?

              cont.appendChild(span);
            });

            if (cont.textContent.trim()) {
              if (this._isRTL(cont.textContent)) cont.classList.add("rtl-text");
              lineElement.appendChild(cont);
            }
          } else {
            const wraps = Array.from(
              lineElement.querySelectorAll(".lyrics-syllable-wrap"),
            );

            for (
              let i = 0;
              i < lineData.syllabus.length && i < wraps.length;
              i++
            ) {
              const s = lineData.syllabus[i];
              const wrap = wraps[i];
              let isBackground = false;
              if (
                wrap.parentElement.parentElement.classList.contains(
                  "background-vocal-container",
                )
              )
                isBackground = true;

              const transTxt =
                (isBackground
                  ? this._getDataText(s, false).replace(/[()]/g, "")
                  : this._getDataText(s, false)) || "";
              if (!transTxt) continue;

              const tr = document.createElement("span");
              tr.className = "lyrics-syllable transliteration";
              wrap.appendChild(tr);

              if (
                currentSettings.hidePhoneticDup &&
                this._getDataText(s, false).trim() ===
                  this._getDataText(s, true).trim()
              ) {
                tr.classList.add("hidden");
              }

              tr.textContent = transTxt;
              tr.dataset.startTime = s.time;
              tr.dataset.duration = s.duration;
              tr.dataset.endTime = s.time + s.duration;
              tr._startTimeMs = s.time;
              tr._durationMs = s.duration;
              tr._endTimeMs = s.time + s.duration;
              tr._isFirstInContainer = true; //force fix bleeding?
            }
          }
        } else if (
          lineData.romanizedText &&
          lineData.text.trim() !== lineData.romanizedText.trim()
        ) {
          const cont = document.createElement("div");
          cont.classList.add("lyrics-romanization-container");
          cont.textContent = this._getDataText(lineData, false);

          if (this._isRTL(cont.textContent)) {
            cont.classList.add("rtl-text");
          }

          lineElement.appendChild(cont);
        }
      }
    }

    if (displayMode === "translate" || displayMode === "both") {
      if (lineData.translatedText) {
        if (!lineData._normText)
          lineData._normText = lineData.text
            .toLowerCase()
            .replaceAll(" ", "")
            .trim();
        if (!lineData._normTranslated)
          lineData._normTranslated = lineData.translatedText
            .toLowerCase()
            .replaceAll(" ", "")
            .trim();
      }
      if (
        lineData.translatedText &&
        lineData._normText !== lineData._normTranslated
      ) {
        const cont = document.createElement("div");
        cont.classList.add("lyrics-translation-container");
        cont.textContent = lineData.translatedText;
        if (this._isRTL(lineData.translatedText)) {
          cont.classList.add("rtl-text");
        }
        lineElement.appendChild(cont);
      }
    }
  }

  /**
   * Applies palette-related CSS classes and custom properties to the container
   * based on the current settings. Called from both displayLyrics and updateDisplayMode.
   * @param {HTMLElement} container - The lyrics container element.
   * @param {object} currentSettings - The current user settings.
   * @private
   */
  _applyPaletteSettings(container, currentSettings) {
    container.classList.toggle(
      "use-song-palette-fullscreen",
      !!currentSettings.useSongPaletteFullscreen,
    );
    container.classList.toggle(
      "use-song-palette-all-modes",
      !!currentSettings.useSongPaletteAllModes,
    );

    if (currentSettings.overridePaletteColor) {
      container.classList.add("override-palette-color");
      container.style.setProperty(
        "--lyplus-override-pallete",
        currentSettings.overridePaletteColor,
      );
      container.classList.remove(
        "use-song-palette-fullscreen",
        "use-song-palette-all-modes",
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
              `rgb(${r}, ${g}, ${b})`,
            );
          }
        }
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

    this._applyPaletteSettings(container, currentSettings);

    container.classList.toggle(
      "fullscreen",
      document.body.hasAttribute("player-fullscreened_"),
    );

    const isWordByWordMode =
      lyrics.type === "Word" && currentSettings.wordByWord;
    container.classList.toggle("word-by-word-mode", isWordByWordMode);
    container.classList.toggle("line-by-line-mode", !isWordByWordMode);

    // Re-determine text direction
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

    // Singer Side Assignment Logic (i hope it similiar as apple lmfao)
    // We calculate the specific class for every line index.
    const lineSideAssignments = new Array(lyrics.data.length).fill("");
    const singerClassMap = {};
    let isDualSide = false;

    if (lyrics && lyrics.data && lyrics.data.length > 0) {
      const agents = lyrics.metadata?.agents || {};

      let currentSideIsLeft = true;
      let lastPersonSingerId = null;

      let rightCount = 0;
      let totalCount = 0;

      lyrics.data.forEach((line, index) => {
        const singerId = line.element?.singer;
        let sideClass = "";

        if (singerId) {
          const agentData = agents[singerId];
          // ig we guess default types for v1000/v2000?? idk
          const type = agentData
            ? agentData.type
            : singerId === "v1000"
              ? "group"
              : singerId === "v2000"
                ? "other"
                : "person";

          if (type === "group") {
            // Groups are positioned Left (Primary)
            // Groups are 'transparent'. They do NOT update
            // lastPersonSingerId or currentSideIsLeft.
            // This ensures the A/B conversation flow persists across the chorus.
            sideClass = "singer-left";
          } else {
            // Type is "person" or "other" (v2000)

            if (lastPersonSingerId === null) {
              // If the first active singer is "other" (v2000), start on Right.
              if (type === "other") {
                currentSideIsLeft = false;
              } else {
                currentSideIsLeft = true;
              }
            } else if (singerId !== lastPersonSingerId) {
              // If the singer is different from the LAST PERSON, we toggle the side.
              currentSideIsLeft = !currentSideIsLeft;
            }

            sideClass = currentSideIsLeft ? "singer-left" : "singer-right";
            lastPersonSingerId = singerId;
          }
        }

        if (sideClass) {
          totalCount++;
          if (sideClass === "singer-right") rightCount++;
        }

        lineSideAssignments[index] = sideClass;
        if (singerId) singerClassMap[singerId] = sideClass;
      });

      // Flip everything if ≥ 85% are on the right
      if (totalCount > 0 && Math.round((rightCount / totalCount) * 100) >= 85) {
        const flip = (s) =>
          s === "singer-left"
            ? "singer-right"
            : s === "singer-right"
              ? "singer-left"
              : s;

        for (let i = 0; i < lineSideAssignments.length; i++) {
          lineSideAssignments[i] = flip(lineSideAssignments[i]);
        }

        for (const id in singerClassMap) {
          singerClassMap[id] = flip(singerClassMap[id]);
        }
      }

      const hasLeft = lineSideAssignments.includes("singer-left");
      const hasRight = lineSideAssignments.includes("singer-right");
      isDualSide = hasLeft && hasRight;
    }

    if (isDualSide) container.classList.add("dual-side-lyrics");

    const createGapLine = (gapStart, gapEnd, classesToInherit = null) => {
      const gapDuration = gapEnd - gapStart;
      const gapLine = document.createElement("div");
      gapLine.className = "lyrics-line lyrics-gap";
      gapLine._isGap = true;
      gapLine.dataset.startTime = gapStart;
      gapLine.dataset.endTime = gapEnd;
      if (!gapLine._hasSharedListener) {
        gapLine.addEventListener("click", this._boundLyricClickHandler);
        gapLine._hasSharedListener = true;
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
        ".main-vocal-container",
      );
      if (existingMainContainer) existingMainContainer.remove();
      const mainContainer = document.createElement("div");
      mainContainer.className = "main-vocal-container";
      const lyricsWord = document.createElement("div");
      lyricsWord.className = "lyrics-word";
      for (let i = 0; i < 3; i++) {
        const syllableSpan = document.createElement("span");
        syllableSpan.className = "lyrics-syllable";

        const segmentDurationMs = (gapDuration / 3) * 1000;

        const syllableDuration = segmentDurationMs * 0.7;

        const gapPadding = segmentDurationMs * 0.3;
        const syllableStart =
          gapStart * 1000 + i * segmentDurationMs + gapPadding;

        syllableSpan.dataset.startTime = syllableStart;
        syllableSpan.dataset.duration = syllableDuration;
        syllableSpan.dataset.endTime = syllableStart + syllableDuration;

        syllableSpan.textContent = "•";
        syllableSpan._isGap = true;
        lyricsWord.appendChild(syllableSpan);
      }
      mainContainer.appendChild(lyricsWord);
      gapLine.appendChild(mainContainer);
      return gapLine;
    };

    const fragment = document.createDocumentFragment();

    if (isWordByWordMode) {
      this._renderWordByWordLyrics(
        lyrics,
        displayMode,
        singerClassMap,
        fragment,
      );
    } else {
      this._renderLineByLineLyrics(
        lyrics,
        displayMode,
        singerClassMap,
        fragment,
      );
    }

    container.appendChild(fragment);
    if (lineSideAssignments.length > 0) {
      const generatedLines = container.querySelectorAll(
        ".lyrics-line:not(.lyrics-gap)",
      );
      generatedLines.forEach((line, index) => {
        const assignedClass = lineSideAssignments[index];
        if (assignedClass) {
          line.classList.remove("singer-left", "singer-right");
          line.classList.add(assignedClass);
        }
      });
    }

    const originalLines = Array.from(
      container.querySelectorAll(".lyrics-line:not(.lyrics-gap)"),
    );
    if (originalLines.length > 0) {
      const firstLine = originalLines[0];
      const firstStartTime = parseFloat(firstLine.dataset.startTime);
      if (firstStartTime >= 7.0) {
        const classesToInherit = [...firstLine.classList].filter((c) =>
          ["rtl-text", "singer-left", "singer-right"].includes(c),
        );
        container.insertBefore(
          createGapLine(0, firstStartTime - 0.66, classesToInherit),
          firstLine,
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
            ["rtl-text", "singer-left", "singer-right"].includes(c),
          );
          gapLinesToInsert.push({
            gapLine: createGapLine(
              parseFloat(line.dataset.endTime) + 0.31,
              parseFloat(nextLine.dataset.startTime) - 0.66,
              classesToInherit,
            ),
            nextLine,
          });
        }
      }
    });
    gapLinesToInsert.forEach(({ gapLine, nextLine }) =>
      container.insertBefore(gapLine, nextLine),
    );
    this._retimingActiveTimings(originalLines);

    const metadataContainer = document.createElement("div");
    metadataContainer.className = "lyrics-plus-metadata";
    if (lyrics.data[lyrics.data.length - 1]?.endTime != 0) {
      // musixmatch sometimes returning plainText duh
      metadataContainer.dataset.startTime =
        (lyrics.data[lyrics.data.length - 1]?.endTime || 0) + 0.8;
      metadataContainer.dataset.endTime =
        (lyrics.data[lyrics.data.length - 1]?.endTime || 0) + 99999999999999; // soooolonggggg
    }

    // Note: songWriters and source may not be available on subsequent updates.
    // They should ideally be part of the main 'lyrics' object if they can change.
    if (lyrics.metadata.songWriters && lyrics.metadata.songWriters.length > 0) {
      const songWritersDiv = document.createElement("span");
      songWritersDiv.className = "lyrics-song-writters";
      songWritersDiv.textContent = "";
      const writtenByLabel = document.createElement("b");
      writtenByLabel.textContent = t("writtenBy");
      const writersText = document.createTextNode(
        " " + lyrics.metadata.songWriters.join(", "),
      );
      songWritersDiv.appendChild(writtenByLabel);
      songWritersDiv.appendChild(writersText);

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
      container.querySelectorAll(".lyrics-line, .lyrics-plus-metadata"),
    )
      .map((line) => {
        if (line) {
          line._startTimeMs = parseFloat(line.dataset.startTime) * 1000;
          line._endTimeMs = parseFloat(line.dataset.endTime) * 1000;
        }
        return line;
      })
      .filter(Boolean);
    this._lineById = new Map();
    for (let _i = 0; _i < this.cachedLyricsLines.length; _i++) {
      const _l = this.cachedLyricsLines[_i];
      if (_l.id) this._lineById.set(_l.id, _l);
    }

    this.cachedSyllables = Array.from(
      container.getElementsByClassName("lyrics-syllable"),
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
    this.visibleLineIds.clear();
    this.currentPrimaryActiveLine = null;

    if (this.cachedLyricsLines.length > 0) {
      const currentTime =
        (this._getCurrentPlayerTime() - this.offsetLatency) * 1000;
      let activeIndex = this._getLineIndexAtTime(currentTime);
      if (activeIndex === -1) activeIndex = 0;

      const activeLine = this.cachedLyricsLines[activeIndex];
      this.currentPrimaryActiveLine = activeLine;
      this.lastPrimaryActiveLine = activeLine;
      this._lastActiveIndex = activeIndex;
      this._updatePositionClassesAndScroll(activeLine, true, 0);
    }

    this._startLyricsSync(currentSettings);
    container.classList.toggle(
      "blur-inactive-enabled",
      !!currentSettings.blurInactive,
    );
  }

  /**
   * Renders the lyrics, metadata, and control buttons inside the container.
   * This is the main public method to update the display.
   * @param {object} lyrics - The lyrics data object.
   * @param {string} type - The type of lyrics ("Line" or "Word").
   * @param {object} songInfo - Information about the current song.
   * @param {string} displayMode - The current display mode ('none', 'translate', 'romanize').
   * @param {object} currentSettings - The current user settings.
   * @param {Function} fetchAndDisplayLyricsFn - The function to fetch and display lyrics.
   * @param {Function} setCurrentDisplayModeAndRefetchFn - The function to set display mode and refetch.
   */
  displayLyrics(
    lyrics,
    songInfo,
    displayMode = "none",
    currentSettings = {},
    fetchAndDisplayLyricsFn,
    setCurrentDisplayModeAndRefetchFn,
    largerTextMode = "lyrics",
    offsetLatency = 0,
  ) {
    this.lastKnownSongInfo = songInfo;
    this.currentSettings = currentSettings;
    this.fetchAndDisplayLyricsFn = fetchAndDisplayLyricsFn;
    this.setCurrentDisplayModeAndRefetchFn = setCurrentDisplayModeAndRefetchFn;
    this.largerTextMode = largerTextMode;
    this.offsetLatency = offsetLatency;

    // Reset translation loading state if it was active
    this.setTranslationLoading(false);

    const container = this._getContainer();
    if (!container) return;

    container.classList.remove("lyrics-plus-message");

    container.classList.toggle("lightweight-mode", currentSettings.lightweight);

    this._applyPaletteSettings(container, currentSettings);

    container.classList.toggle(
      "fullscreen",
      document.body.hasAttribute("player-fullscreened_"),
    );

    const isPlainLyrics = lyrics.type === "None";
    const isWordByWordMode =
      !isPlainLyrics && lyrics.type === "Word" && currentSettings.wordByWord;

    const isLineByLineMode = !isPlainLyrics && !isWordByWordMode;

    container.classList.toggle("plain-text-mode", isPlainLyrics);
    container.classList.toggle("word-by-word-mode", isWordByWordMode);
    container.classList.toggle("line-by-line-mode", isLineByLineMode);

    container.classList.toggle(
      "romanized-big-mode",
      largerTextMode != "lyrics",
    );

    if (!isPlainLyrics) {
      this.updateDisplayMode(lyrics, displayMode, currentSettings);
    } else {
      container.innerHTML = "";
      const fragment = document.createDocumentFragment();

      const metadataContainer = document.createElement("div");
      metadataContainer.className = "lyrics-plus-metadata";

      if (lyrics.metadata?.songWriters?.length > 0) {
        const songWritersDiv = document.createElement("span");
        songWritersDiv.className = "lyrics-song-writters";
        songWritersDiv.innerHTML = `<b>${t("writtenBy")}</b> ${lyrics.metadata.songWriters.join(", ")}`;
        metadataContainer.appendChild(songWritersDiv);
      }

      const sourceDiv = document.createElement("span");
      sourceDiv.className = "lyrics-source-provider";
      sourceDiv.innerText = `${t("source")} ${lyrics.metadata?.source || "Unknown"}`;
      metadataContainer.appendChild(sourceDiv);

      fragment.appendChild(metadataContainer);

      this._renderPlainLyrics(lyrics, fragment);

      const emptyDiv = document.createElement("div");
      emptyDiv.className = "lyrics-plus-empty";
      fragment.appendChild(emptyDiv);

      container.appendChild(fragment);

      //those stuff randomly fix the mix-blend-mode lmao, not sure why but it works
      const emptyFixedDiv = document.createElement("div");
      emptyFixedDiv.className = "lyrics-plus-empty-fixed";
      container.appendChild(emptyFixedDiv);

      this.cachedLyricsLines = [];
      this.cachedSyllables = [];
      this.activeLineIds.clear();
      this.visibleLineIds.clear();
    }

    // Control buttons are created once to avoid re-rendering them.
    this._createControlButtons();
    container.classList.toggle(
      "blur-inactive-enabled",
      !!currentSettings.blurInactive,
    );
    container.classList.toggle(
      "hide-offscreen",
      !!currentSettings.hideOffscreen,
    );
  }

  /**
   * Sets the loading state of the translation button.
   * @param {boolean} active - Whether the loading state is active.
   */
  setTranslationLoading(active) {
    if (!this.translationButton) return;

    if (active) {
      this.translationButton.classList.add("loading");
      this.translationButton.innerHTML =
        '<div class="loading-loop-m3 small"></div>';
      this.translationButton.disabled = true;
    } else {
      this.translationButton.classList.remove("loading");
      this.translationButton.disabled = false;
      this._updateTranslationButtonText();
    }
  }

  /**
   * Renders a plain status message (e.g. "not found", error) inside the container.
   * @param {string} i18nKey - The translation key for the message text.
   * @private
   */
  _displayMessage(i18nKey) {
    const container = this._getContainer();
    if (container) {
      container.innerHTML = `<span class="text-not-found">${t(i18nKey)}</span>`;
      container.classList.add("lyrics-plus-message");
    }
  }

  /**
   * Displays a "not found" message in the lyrics container.
   */
  displaySongNotFound() {
    this._displayMessage("notFound");
  }

  /**
   * Displays an error message in the lyrics container.
   */
  displaySongError() {
    this._displayMessage("notFoundError");
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
      this.uiConfig.seekTo(time);
      return;
    }
    const player = this._getPlayerElement();
    if (player) {
      player.currentTime = time;
    }
  }

  _getTextWidth(text, font) {
    if (!this.textWidthCanvas) {
      this.textWidthCanvas = document.createElement("canvas");
      this.textWidthCtx = this.textWidthCanvas.getContext("2d", {
        willReadFrequently: true,
      });
      this._lastCtxFont = null;
    }
    if (this._lastCtxFont !== font) {
      this.textWidthCtx.font = font;
      this._lastCtxFont = font;
    }
    return this.textWidthCtx.measureText(text).width;
  }

  _ensureElementIds() {
    if (!this.cachedLyricsLines || !this.cachedSyllables) return;
    this.cachedLyricsLines.forEach((line, i) => {
      if (line && !line.id) line.id = `line-${i}`;
    });
  }

  /**
   * Starts the synchronization loop for highlighting lyrics based on video time.
   * @param {object} currentSettings - The current user settings.
   * @returns {Function} - A cleanup function to stop the sync.
   */
  _startLyricsSync(currentSettings = {}) {
    if (this.currentLyricsType === "None") return () => {};

    const canGetTime =
      typeof this.uiConfig.getCurrentTime === "function" ||
      this._getPlayerElement();
    if (!canGetTime) {
      console.warn(
        "LyricsPlusRenderer: Cannot start sync. No player element found and no custom getCurrentTime function provided in uiConfig.",
      );
      return () => {};
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
        const currentTime =
          (this._getCurrentPlayerTime() - this.offsetLatency) * 1000;
        if (currentTime !== this.lastTime) {
          const isForceScroll = Math.abs(currentTime - this.lastTime) > 1000;
          this._updateLyricsHighlight(
            currentTime,
            isForceScroll,
            currentSettings,
          );
          this.lastTime = currentTime;
        }
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
    this._updateLyricsHighlight(
      currentTime - this.offsetLatency,
      isForceScroll,
      currentSettings,
    );
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
    currentSettings = {},
  ) {
    if (!this.cachedLyricsLines || this.cachedLyricsLines.length === 0) {
      return;
    }

    let scrollLookAheadMs = 350;
    const currentAudioIndex = this._getLineIndexAtTime(
      currentTime,
      this._lastActiveIndex,
    );

    if (
      currentAudioIndex !== -1 &&
      currentAudioIndex + 1 < this.cachedLyricsLines.length
    ) {
      const currentLine = this.cachedLyricsLines[currentAudioIndex];
      const nextLine = this.cachedLyricsLines[currentAudioIndex + 1];
      const rawEndTime =
        currentLine._actualEndTimeMs !== undefined
          ? currentLine._actualEndTimeMs
          : currentLine._endTimeMs;
      const gap = nextLine._startTimeMs - rawEndTime;
      scrollLookAheadMs = Math.min(500, Math.max(350, gap));
    }

    const highlightLookAheadMs = 190;
    const predictiveTime = currentTime + scrollLookAheadMs;

    // 1. Find Primary Line Index
    const hint = isForceScroll ? 0 : this._lastActiveIndex;
    let primaryIndex = this._getLineIndexAtTime(predictiveTime, hint);

    if (primaryIndex !== -1) {
      const lineToCheck = this.cachedLyricsLines[primaryIndex];
      // Sanity check: if we jumped too far ahead/behind
      if (predictiveTime > lineToCheck._endTimeMs + 10) {
        primaryIndex = -1;
      }
    }

    const linesLen = this.cachedLyricsLines.length;
    // Collect all active DOM indices (used by guard later).
    const activeIndices = [];
    const _windowBase = Math.max(
      0,
      (primaryIndex !== -1 ? primaryIndex : this._lastActiveIndex) - 2,
    );
    let _scanStart = _windowBase;
    while (
      _scanStart > 0 &&
      this.cachedLyricsLines[_scanStart - 1]._endTimeMs + 50 >= predictiveTime
    ) {
      _scanStart--;
    }
    for (let i = _scanStart; i < linesLen; i++) {
      const line = this.cachedLyricsLines[i];
      if (line._startTimeMs > predictiveTime + 50) break;
      if (
        predictiveTime >= line._startTimeMs &&
        predictiveTime <= line._endTimeMs + 50
      ) {
        activeIndices.push(i);
      }
    }

    if (primaryIndex !== -1) {
      if (activeIndices.length > 0) {
        let groupEnd = activeIndices.length - 1;
        let groupStart = groupEnd;
        while (
          groupStart > 0 &&
          activeIndices[groupStart] - activeIndices[groupStart - 1] === 1
        ) {
          groupStart--;
        }

        const candidateIndex = Math.max(
          activeIndices[groupStart],
          activeIndices[groupEnd] - 2,
        );

        const lastPrimary = this._lastActiveIndex;
        const lastPrimaryStillActive =
          lastPrimary >= 0 &&
          lastPrimary < this.cachedLyricsLines.length &&
          activeIndices.includes(lastPrimary);
        primaryIndex =
          candidateIndex < lastPrimary && lastPrimaryStillActive
            ? lastPrimary
            : candidateIndex;
      }
    } else {
      const firstLineStartTime = this.cachedLyricsLines[0]._startTimeMs;
      if (predictiveTime < firstLineStartTime) {
        primaryIndex = 0;
      } else {
        primaryIndex = this._lastActiveIndex;
        if (primaryIndex < 0) primaryIndex = 0;
        const linesLength = this.cachedLyricsLines.length;
        if (primaryIndex >= linesLength) {
          primaryIndex = linesLength - 1;
        }
      }
    }

    const currentPrimaryLine = this.cachedLyricsLines[this._lastActiveIndex];
    const candidateLine = this.cachedLyricsLines[primaryIndex];
    const activeCount = activeIndices.length;
    if (
      primaryIndex > this._lastActiveIndex &&
      candidateLine._endTimeMs === currentPrimaryLine._endTimeMs &&
      activeCount <= 3
    ) {
      primaryIndex = this._lastActiveIndex;
    } else {
      this._lastActiveIndex = primaryIndex;
    }
    const lineToScroll = this.cachedLyricsLines[primaryIndex];

    // reuse array to avoid allocation
    let tempActiveCount = 0;

    const startSearch = Math.max(0, primaryIndex - 1);
    const endSearch = Math.min(
      this.cachedLyricsLines.length - 1,
      primaryIndex + 2,
    );

    for (let i = startSearch; i <= endSearch; i++) {
      const line = this.cachedLyricsLines[i];
      if (this.visibleLineIds.has(line.id)) {
        if (
          currentTime >= line._startTimeMs - highlightLookAheadMs &&
          currentTime <= line._endTimeMs - highlightLookAheadMs
        ) {
          this._tempActiveLines[tempActiveCount++] = line;
        }
      }
    }

    if (this._tempActiveLines.length > tempActiveCount) {
      this._tempActiveLines.length = tempActiveCount;
    }

    if (tempActiveCount > 1) {
      this._tempActiveLines.sort((a, b) => a._startTimeMs - b._startTimeMs);
    }

    let hasChanged = this.activeLineIds.size !== tempActiveCount;
    if (!hasChanged && tempActiveCount > 0) {
      for (let i = 0; i < tempActiveCount; i++) {
        if (!this.activeLineIds.has(this._tempActiveLines[i].id)) {
          hasChanged = true;
          break;
        }
      }
    }

    if (hasChanged) {
      for (const oldId of this.activeLineIds) {
        let stillActive = false;
        for (let j = 0; j < tempActiveCount; j++) {
          if (this._tempActiveLines[j].id === oldId) {
            stillActive = true;
            break;
          }
        }

        if (!stillActive) {
          const line =
            (this._lineById && this._lineById.get(oldId)) ||
            document.getElementById(oldId);
          if (line) {
            line.classList.remove("active");
            this._resetSyllables(line);
          }
          this.activeLineIds.delete(oldId);
        }
      }

      for (let i = 0; i < tempActiveCount; i++) {
        const line = this._tempActiveLines[i];
        if (!this.activeLineIds.has(line.id)) {
          line.classList.add("active");
          this.activeLineIds.add(line.id);
        }
      }
    }

    // 4. Scrolling Logic
    if (
      lineToScroll &&
      (lineToScroll !== this.currentPrimaryActiveLine || isForceScroll)
    ) {
      if (!this.isUserControllingScroll || isForceScroll) {
        this._updatePositionClassesAndScroll(
          lineToScroll,
          isForceScroll,
          scrollLookAheadMs,
        );
        this.lastPrimaryActiveLine = this.currentPrimaryActiveLine;
        this.currentPrimaryActiveLine = lineToScroll;
      }
    }

    // 5. Focus Logic
    const mostRecentActiveLine =
      tempActiveCount > 0 ? this._tempActiveLines[tempActiveCount - 1] : null;

    if (this.currentFullscreenFocusedLine !== mostRecentActiveLine) {
      if (this.currentFullscreenFocusedLine) {
        this.currentFullscreenFocusedLine.classList.remove(
          "fullscreen-focused",
        );
      }
      if (mostRecentActiveLine) {
        mostRecentActiveLine.classList.add("fullscreen-focused");
      }
      this.currentFullscreenFocusedLine = mostRecentActiveLine;
    }

    this._updateSyllables(currentTime, this._tempActiveLines);
  }

  _getLineIndexAtTime(timeMs, startHintIndex = 0) {
    const lines = this.cachedLyricsLines;
    const len = lines.length;
    if (len === 0) return -1;

    // Sequential Check
    if (startHintIndex >= 0 && startHintIndex < len) {
      const hintLine = lines[startHintIndex];
      if (timeMs >= hintLine._startTimeMs && timeMs < hintLine._endTimeMs) {
        return startHintIndex;
      }
      if (startHintIndex + 1 < len) {
        const nextLine = lines[startHintIndex + 1];
        if (timeMs >= nextLine._startTimeMs && timeMs < nextLine._endTimeMs) {
          return startHintIndex + 1;
        }
      }
    }

    // Binary Search
    let low = 0;
    let high = len - 1;
    let result = -1;

    while (low <= high) {
      const mid = (low + high) >>> 1;
      const line = lines[mid];

      if (timeMs >= line._startTimeMs && timeMs < line._endTimeMs) {
        return mid;
      } else if (timeMs < line._startTimeMs) {
        high = mid - 1;
      } else {
        low = mid + 1;
        result = mid;
      }
    }

    return result;
  }

  /**
   * Batch update viewport visibility
   */
  _batchUpdateViewportVisibility() {
    if (!this._visibilityChanges) return;

    for (let i = 0; i < this._visibilityChanges.length; i++) {
      const change = this._visibilityChanges[i];
      change.target.classList.toggle("viewport-hidden", !change.isIntersecting);
    }

    this._visibilityChanges = [];
  }

  _updateSyllables(currentTime, activeLines) {
    if (!activeLines || activeLines.length === 0) return;

    const activeLinesLength = activeLines.length;

    for (let i = 0; i < activeLinesLength; i++) {
      const parentLine = activeLines[i];
      if (!parentLine) continue;

      let syllables = parentLine._cachedSyllableElements;
      if (!syllables) {
        syllables = Array.from(parentLine.querySelectorAll(".lyrics-syllable"));
        parentLine._cachedSyllableElements = syllables;
      }

      const syllablesLength = syllables.length;

      for (let j = 0; j < syllablesLength; j++) {
        const syllable = syllables[j];
        const startTime = syllable._startTimeMs;

        if (startTime === undefined) continue;

        const classList = syllable.classList;

        const _st = syllable._state || 0;
        const hasHighlight = (_st & 1) !== 0;
        const hasFinished = (_st & 2) !== 0;
        const hasPreHighlight = (_st & 4) !== 0;
        const hasActiveState = _st !== 0;

        // Early exit only if syllable is far
        if (currentTime < startTime - 1000 && !hasActiveState) continue;

        const endTime = syllable._endTimeMs;

        if (currentTime >= startTime && currentTime <= endTime) {
          if (!hasHighlight) {
            this._updateSyllableAnimation(syllable);
          }
          if (hasFinished) {
            classList.remove("finished");
            syllable._state &= ~2;
          }
        } else if (currentTime > endTime) {
          if (!hasFinished) {
            if (!hasHighlight) {
              this._updateSyllableAnimation(syllable);
            }
            classList.add("finished");
            syllable._state |= 2;
          }
        } else {
          if (hasHighlight || hasFinished) {
            this._resetSyllable(syllable);
          } else if (hasPreHighlight) {
            const shouldReset =
              j === 0 || !(syllables[j - 1] && syllables[j - 1]._state & 1);

            if (shouldReset) {
              this._resetSyllable(syllable, true);
            }
          }
        }
      }
    }
  }

  _updateSyllableAnimation(syllable) {
    // --- READ PHASE ---
    if (syllable._state & 1) return;

    const classList = syllable.classList;
    const isRTL = classList.contains("rtl-text");
    const charSpans = syllable._cachedCharSpans;
    const wordElement = syllable.parentElement.parentElement;
    const allWordCharSpans = wordElement?._cachedChars;
    const isGrowable =
      syllable._isGrowable !== undefined
        ? syllable._isGrowable
        : wordElement
          ? wordElement.classList.contains("growable")
          : false;
    const isFirstSyllable =
      syllable._syllableIdx !== undefined
        ? syllable._syllableIdx === 0
        : syllable.dataset.syllableIndex === "0";
    const isGap =
      syllable._isGap !== undefined
        ? syllable._isGap
        : !!(
            syllable.parentElement &&
            syllable.parentElement.parentElement &&
            syllable.parentElement.parentElement.parentElement &&
            syllable.parentElement.parentElement.parentElement.classList.contains(
              "lyrics-gap",
            )
          );
    const nextSyllable = syllable._nextSyllableInWord;
    const isFirstInContainer = syllable._isFirstInContainer || false;

    // --- CALCULATION PHASE ---
    if (!this._charAnimationsMap) this._charAnimationsMap = new Map();
    else this._charAnimationsMap.clear();
    const charAnimationsMap = this._charAnimationsMap;

    if (!this._styleUpdates) this._styleUpdates = new Array(100);
    const styleUpdates = this._styleUpdates;
    let styleUpdatesCount = 0;

    if (!this._animationParts) this._animationParts = new Array(4);
    const animationParts = this._animationParts;

    // Step 1: Grow Pass.
    if (isGrowable && isFirstSyllable && allWordCharSpans) {
      const finalDuration =
        syllable._wordDurationMs !== undefined &&
        syllable._wordDurationMs !== null
          ? syllable._wordDurationMs
          : syllable._durationMs;
      const baseDelayPerChar = finalDuration * 0.09;
      const growDurationMs = finalDuration * 1.5;

      const charsLength = allWordCharSpans.length;
      for (let i = 0; i < charsLength; i++) {
        const span = allWordCharSpans[i];
        const horizontalOffset =
          span._horizontalOffset !== undefined
            ? span._horizontalOffset
            : parseFloat(span.dataset.horizontalOffset) || 0;
        const growDelay =
          baseDelayPerChar *
          (span._syllableCharIndex !== undefined
            ? span._syllableCharIndex
            : parseFloat(span.dataset.syllableCharIndex) || 0);
        charAnimationsMap.set(
          span,
          `grow-dynamic ${growDurationMs}ms ease-in-out ${growDelay}ms forwards`,
        );
        styleUpdates[styleUpdatesCount++] = {
          element: span,
          property: "--char-offset-x",
          value: `${horizontalOffset}`,
        };
      }
    }

    // Step 2: Wipe Pass.
    if (charSpans && charSpans.length > 0) {
      const syllableDuration = syllable._durationMs;
      const charSpansLength = charSpans.length;

      for (let charIndex = 0; charIndex < charSpansLength; charIndex++) {
        const span = charSpans[charIndex];
        const startPct =
          span._wipeStart !== undefined
            ? span._wipeStart
            : parseFloat(span.dataset.wipeStart) || 0;
        const durationPct =
          span._wipeDuration !== undefined
            ? span._wipeDuration
            : parseFloat(span.dataset.wipeDuration) || 0;

        const wipeDelay = syllableDuration * startPct;
        const wipeDuration = syllableDuration * durationPct;

        const useStartAnimation = isFirstInContainer && charIndex === 0;
        const charWipeAnimation = useStartAnimation
          ? isRTL
            ? "start-wipe-rtl"
            : "start-wipe"
          : isRTL
            ? "wipe-rtl"
            : "wipe";

        const existingAnimation =
          charAnimationsMap.get(span) || span.style.animation;
        let animationPartsCount = 0;

        if (existingAnimation && existingAnimation.includes("grow-dynamic")) {
          animationParts[animationPartsCount++] = existingAnimation
            .split(",")[0]
            .trim();
        }

        if (charIndex > 0) {
          const arrivalTime =
            span._preWipeArrival !== undefined
              ? span._preWipeArrival
              : parseFloat(span.dataset.preWipeArrival) || 0;
          const constantDuration =
            span._preWipeDuration !== undefined
              ? span._preWipeDuration
              : parseFloat(span.dataset.preWipeDuration) || 100;

          const animDelay = arrivalTime - constantDuration;

          if (constantDuration > 0) {
            animationParts[animationPartsCount++] =
              `pre-wipe-char ${constantDuration}ms linear ${animDelay}ms forwards`;
          }
        }

        if (wipeDuration > 0) {
          animationParts[animationPartsCount++] =
            `${charWipeAnimation} ${wipeDuration}ms linear ${wipeDelay}ms forwards`;
        }

        charAnimationsMap.set(
          span,
          animationParts.slice(0, animationPartsCount).join(", "),
        );
      }
    } else {
      const ratio = syllable._wipeRatio || 1;
      const visualDuration = syllable._durationMs * ratio;
      const wipeAnimation = isFirstInContainer
        ? isRTL
          ? "start-wipe-rtl"
          : "start-wipe"
        : isRTL
          ? "wipe-rtl"
          : "wipe";
      const currentWipeAnimation = isGap ? "fade-gap" : wipeAnimation;
      const syllableAnimation = `${currentWipeAnimation} ${visualDuration}ms ${isGap ? "var(--lyplus-fade-gap-timing-function)" : "linear"} forwards`;
      styleUpdates[styleUpdatesCount++] = {
        element: syllable,
        property: "animation",
        value: syllableAnimation,
      };
    }

    // Step 3: Pre-Wipe Pass (Cross-Syllable).
    if (nextSyllable) {
      const preHighlightDuration = syllable._preHighlightDurationMs;
      const preHighlightDelay = syllable._preHighlightDelayMs;

      styleUpdates[styleUpdatesCount++] = {
        element: nextSyllable,
        property: "class",
        action: "add",
        value: "pre-highlight",
      };
      styleUpdates[styleUpdatesCount++] = {
        element: nextSyllable,
        property: "--pre-wipe-duration",
        value: `${preHighlightDuration}ms`,
      };
      styleUpdates[styleUpdatesCount++] = {
        element: nextSyllable,
        property: "--pre-wipe-delay",
        value: `${preHighlightDelay}ms`,
      };

      const nextCharSpan = nextSyllable._cachedCharSpans?.[0];
      if (nextCharSpan) {
        const preWipeAnim = `pre-wipe-char ${preHighlightDuration}ms linear ${preHighlightDelay}ms forwards`;
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
    syllable._state = (syllable._state & ~4) | 1;

    for (const [span, animationString] of charAnimationsMap.entries()) {
      span.style.animation = animationString;
    }

    for (let i = 0; i < styleUpdatesCount; i++) {
      const update = styleUpdates[i];
      if (update.action === "add") {
        update.element.classList.add(update.value);
        if (update.value === "pre-highlight")
          update.element._state = (update.element._state || 0) | 4;
      } else if (update.property === "animation") {
        update.element.style.animation = update.value;
      } else {
        update.element.style.setProperty(update.property, update.value);
      }
    }
  }

  _resetSyllable(syllable, noFade = false) {
    if (!syllable) return;
    syllable.style.animation = "";
    if (!(syllable._state & 2) && !noFade) {
      syllable.classList.add("finished");
      syllable._state |= 2;
    }
    syllable.classList.add("cleanup");
    syllable.style.removeProperty("--pre-wipe-duration");
    syllable.style.removeProperty("--pre-wipe-delay");

    const charSpans =
      syllable._cachedCharSpans || syllable.querySelectorAll("span.char");
    const charSpansLength = charSpans.length;
    for (let i = 0; i < charSpansLength; i++) {
      charSpans[i].style.animation = "";
    }

    requestAnimationFrame(() => {
      setTimeout(() => {
        syllable.classList.remove(
          "highlight",
          "finished",
          "pre-highlight",
          "cleanup",
        );
        syllable._state = 0;
      }, 16);
    });
  }

  _resetSyllables(line, noFade = false) {
    if (!line) return;
    let syllables = line._cachedSyllableElements;
    if (!syllables) {
      syllables = Array.from(line.getElementsByClassName("lyrics-syllable"));
    }

    const syllablesLength = syllables.length;
    for (let i = 0; i < syllablesLength; i++) {
      this._resetSyllable(syllables[i], noFade);
    }
  }

  _getScrollPaddingTop() {
    if (this._scrollPaddingTopCache !== undefined)
      return this._scrollPaddingTopCache;

    const selectors = this.uiConfig.selectors;
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        const style = window.getComputedStyle(element);
        const paddingTopValue =
          style.getPropertyValue("--lyrics-scroll-padding-top") || "25%";
        const result = paddingTopValue.includes("%")
          ? element.getBoundingClientRect().height *
            (parseFloat(paddingTopValue) / 100)
          : parseFloat(paddingTopValue) || 0;
        this._scrollPaddingTopCache = result;
        return result;
      }
    }
    const container = document.querySelector(
      "#lyrics-plus-container",
    )?.parentElement;
    const result = container
      ? parseFloat(
          window
            .getComputedStyle(container)
            .getPropertyValue("scroll-padding-top"),
        ) || 0
      : 0;
    this._scrollPaddingTopCache = result;
    return result;
  }

  /**
   * Applies the new scroll position with a robust buffer logic.
   * Animation delay is applied to a window of approximately two screen heights
   * starting from the first visible line, guaranteeing smooth transitions for
   * lines scrolling into view.
   *
   * @param {number} newTranslateY - The target Y-axis translation value in pixels.
   * @param {boolean} forceScroll - If true, all animation delays are ignored for instant movement.
   * @param {number} duration - The duration of the scroll animation in milliseconds.
   */
  _animateScroll(newTranslateY, forceScroll = false, duration = 300) {
    if (!this.lyricsContainer) return;
    const parent = this.lyricsContainer.parentElement;
    if (!parent) return;

    if (!this._scrollAnimationState) {
      this._scrollAnimationState = {
        isAnimating: false,
        pendingUpdate: null,
      };
      this._animatingLines = [];
    }

    const state = this._scrollAnimationState;

    if (state.isAnimating && !forceScroll) {
      state.pendingUpdate = newTranslateY;
      return;
    }

    if (this._scrollUnlockTimeout) {
      clearTimeout(this._scrollUnlockTimeout);
      this._scrollUnlockTimeout = null;
    }

    if (this._scrollAnimationTimeout) {
      clearTimeout(this._scrollAnimationTimeout);
      this._scrollAnimationTimeout = null;
    }

    duration = Math.min(450, duration);

    const animatingLines = this._animatingLines;
    if (animatingLines.length > 0) {
      for (let i = 0; i < animatingLines.length; i++) {
        const line = animatingLines[i];
        line.classList.remove("scroll-animate");
        line.style.removeProperty("--scroll-delta");
        line.style.removeProperty("--lyrics-line-delay");
        line.style.removeProperty("--scroll-duration");
      }
      animatingLines.length = 0;
    }

    const targetTop = Math.max(0, -newTranslateY);
    const prevOffset = -parent.scrollTop || this.currentScrollOffset || 0;
    const delta = prevOffset - newTranslateY;
    const scrollingDown = delta >= 0;
    this.currentScrollOffset = newTranslateY;

    if (forceScroll) {
      parent.scrollTo({ top: targetTop, behavior: "smooth" });
      state.isAnimating = false;
      state.pendingUpdate = null;
      return;
    }

    const referenceLine =
      this.currentPrimaryActiveLine ||
      this.lastPrimaryActiveLine ||
      this.cachedLyricsLines[0];

    if (!referenceLine) return;

    const referenceIndex =
      referenceLine === this.cachedLyricsLines[this._lastActiveIndex]
        ? this._lastActiveIndex
        : this.cachedLyricsLines.indexOf(referenceLine);
    if (referenceIndex === -1) return;

    const delayIncrement = duration * 0.1;
    const lookAhead = 20;
    const len = this.cachedLyricsLines.length;

    let visMin = referenceIndex;
    let visMax = referenceIndex;
    if (this.visibleLineIds.size > 0) {
      const visIds = this.visibleLineIds;
      for (let vi = 0; vi < len; vi++) {
        if (visIds.has(this.cachedLyricsLines[vi].id)) {
          if (vi < visMin) visMin = vi;
          if (vi > visMax) visMax = vi;
        }
      }
    }

    // start = earliest edge of the current visible viewport (or referenceIndex
    //         if the active line is already above visible content).
    // end   = target visible viewport: from referenceIndex out by lookAhead,
    //         but never less than the current visible bottom so departing lines
    //         also animate out smoothly.
    const start = Math.min(visMin, referenceIndex);
    const end = Math.min(len, Math.max(visMax, referenceIndex) + lookAhead);

    let maxAnimationDuration = 0;
    let delayCounter = 0;

    if (scrollingDown) {
      let delayCounter = 0;
      for (let i = start; i < end; i++) {
        const line = this.cachedLyricsLines[i];
        const delay = i >= referenceIndex ? delayCounter * delayIncrement : 0;

        if (i >= referenceIndex && !line._isGap) {
          delayCounter++;
        }

        line.style.setProperty("--scroll-delta", `${delta}px`);
        line.style.setProperty("--lyrics-line-delay", `${delay}ms`);
        line.style.setProperty("--scroll-duration", `${duration + 100}ms`);
        line.classList.add("scroll-animate");
        animatingLines.push(line);

        const lineDuration = duration + delay;
        if (lineDuration > maxAnimationDuration)
          maxAnimationDuration = lineDuration;
      }
    } else {
      let delayCounter = 0;
      for (let i = end - 1; i >= start; i--) {
        const line = this.cachedLyricsLines[i];
        const delay = i <= referenceIndex ? delayCounter * delayIncrement : 0;

        if (i <= referenceIndex && !line._isGap) {
          delayCounter++;
        }

        line.style.setProperty("--scroll-delta", `${delta}px`);
        line.style.setProperty("--lyrics-line-delay", `${delay}ms`);
        line.style.setProperty("--scroll-duration", `${duration + 100}ms`);
        line.classList.add("scroll-animate");
        animatingLines.push(line);

        const lineDuration = duration + delay;
        if (lineDuration > maxAnimationDuration)
          maxAnimationDuration = lineDuration;
      }
    }

    state.isAnimating = true;
    const BASE_DURATION = 400;

    this._scrollUnlockTimeout = setTimeout(() => {
      state.isAnimating = false;

      if (state.pendingUpdate !== null) {
        const pendingValue = state.pendingUpdate;
        state.pendingUpdate = null;
        this._animateScroll(pendingValue, false);
      }
    }, BASE_DURATION);

    this._scrollAnimationTimeout = setTimeout(() => {
      for (let i = 0; i < animatingLines.length; i++) {
        const line = animatingLines[i];
        line.classList.remove("scroll-animate");
        line.style.removeProperty("--scroll-delta");
        line.style.removeProperty("--lyrics-line-delay");
      }
      animatingLines.length = 0;
      this._scrollAnimationTimeout = null;
    }, maxAnimationDuration + 50);

    parent.scrollTo({ top: targetTop, behavior: "instant" });
  }

  _updatePositionClassesAndScroll(
    lineToScroll,
    forceScroll = false,
    durationScroll = 300,
  ) {
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
      "post-active-line",
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

    if (!this._positionClassedLines) this._positionClassedLines = [];

    // On a force-scroll (seek/click) the previous active line may be far outside
    // the tracked window, so fall back to a full sweep to guarantee cleanup.
    if (forceScroll) {
      this.lyricsContainer
        .querySelectorAll("." + positionClasses.join(", ."))
        .forEach((el) => el.classList.remove(...positionClasses));
      this._positionClassedLines.length = 0;
    } else {
      for (let _pi = 0; _pi < this._positionClassedLines.length; _pi++) {
        this._positionClassedLines[_pi].classList.remove(...positionClasses);
      }
      this._positionClassedLines.length = 0;
    }

    lineToScroll.classList.add("lyrics-activest");
    this._positionClassedLines.push(lineToScroll);
    const elements = this.cachedLyricsLines;
    for (
      let i = Math.max(0, scrollLineIndex - 4);
      i <= Math.min(elements.length - 1, scrollLineIndex + 4);
      i++
    ) {
      const position = i - scrollLineIndex;
      if (position === 0) continue;
      const element = elements[i];
      if (position === -1) element.classList.add("post-active-line");
      else if (position === 1) element.classList.add("next-active-line");
      else if (position < 0)
        element.classList.add(`prev-${Math.abs(position)}`);
      else element.classList.add(`next-${position}`);
      this._positionClassedLines.push(element);
    }

    this._scrollToActiveLine(lineToScroll, forceScroll, false, durationScroll);
  }

  _scrollToActiveLine(
    activeLine,
    forceScroll = false,
    isResize = false,
    durationScroll = 300,
  ) {
    if (!activeLine || !this.lyricsContainer) return;
    if (this._containerDisplayCache === undefined) {
      this._containerDisplayCache = getComputedStyle(
        this.lyricsContainer,
      ).display;
    }
    if (this._containerDisplayCache !== "block") return;
    const scrollContainer = this.lyricsContainer.parentElement;
    if (!scrollContainer) return;

    const paddingTop = this._getScrollPaddingTop();
    const targetTranslateY = paddingTop - activeLine.offsetTop;
    const scrollContainerTop = this._cachedContainerRect
      ? this._cachedContainerRect.scrollContainerTop
      : scrollContainer.getBoundingClientRect().top;

    if (
      !forceScroll &&
      Math.abs(
        activeLine.getBoundingClientRect().top -
          scrollContainerTop -
          paddingTop,
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

    if (isResize) {
      this.currentScrollOffset = targetTranslateY;
      scrollContainer.scrollTo({ top: -targetTranslateY, behavior: "instant" });

      if (this._scrollAnimationState) {
        this._scrollAnimationState.targetOffset = targetTranslateY;
      }
    } else {
      this._animateScroll(targetTranslateY, forceScroll, durationScroll);
    }
  }

  _setupVisibilityTracking() {
    const container = this._getContainer();
    if (!container || !container.parentElement) return null;
    if (this.visibilityObserver) this.visibilityObserver.disconnect();

    this._visibilityChanges = [];

    this.visibilityObserver = new IntersectionObserver(
      (entries) => {
        let hasChanges = false;
        entries.forEach((entry) => {
          const target = entry.target;
          const id = target.id;

          this._visibilityChanges.push({
            target: target,
            isIntersecting: entry.isIntersecting,
          });

          if (entry.isIntersecting) {
            if (!this.visibleLineIds.has(id)) {
              this.visibleLineIds.add(id);
              hasChanges = true;
            }
          } else {
            if (this.visibleLineIds.has(id)) {
              this.visibleLineIds.delete(id);
              hasChanges = true;
            }
          }
        });
        if (hasChanges) {
          if (
            this.lyricsContainer &&
            this.lyricsContainer.classList.contains("hide-offscreen")
          ) {
            this._batchUpdateViewportVisibility();
          }
        }
      },
      {
        root: container.parentElement,
        rootMargin: "200px 0px",
        threshold: 0.1,
      },
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

    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target !== container) continue;
        this._debouncedResizeHandler(container);
      }
    });

    this.resizeObserver.observe(container);
    return this.resizeObserver;
  }

  restore() {
    if (!this.lyricsContainer) return;

    this._playerElement = undefined;

    this.scrollEventHandlerAttached = false;
    this._attachScrollListeners();
    this._setupContainerObserver();

    if (this.visibilityObserver) this.visibilityObserver.disconnect();
    this.visibilityObserver = this._setupVisibilityTracking();

    if (this.resizeObserver) this.resizeObserver.disconnect();
    this._setupResizeObserver();

    this._startLyricsSync(this.currentSettings);
    this._createControlButtons();
  }

  _createControlButtons() {
    // Wrapper Management
    this.buttonsWrapper = document.getElementById(
      "lyrics-plus-buttons-wrapper",
    );

    if (!this.buttonsWrapper) {
      this.buttonsWrapper = document.createElement("div");
      this.buttonsWrapper.id = "lyrics-plus-buttons-wrapper";
      const originalLyricsSection = document.querySelector(
        this.uiConfig.buttonParent || this.uiConfig.patchParent,
      );
      if (originalLyricsSection) {
        originalLyricsSection.appendChild(this.buttonsWrapper);
      }
    }

    // Translation Button Logic
    if (
      this.setCurrentDisplayModeAndRefetchFn &&
      this.currentLyricsType !== "None"
    ) {
      if (!this.translationButton) {
        this.translationButton = document.createElement("button");
        this.translationButton.id = "lyrics-plus-translate-button";
        this.buttonsWrapper.appendChild(this.translationButton);
        this._updateTranslationButtonText();

        this.translationButton.addEventListener("click", (event) => {
          event.stopPropagation();
          this._createDropdownMenu(this.buttonsWrapper);
          if (this.dropdownMenu) this.dropdownMenu.classList.toggle("hidden");
        });

        if (!this._boundDocumentClickHandler) {
          this._boundDocumentClickHandler = (event) => {
            if (
              this.dropdownMenu &&
              !this.dropdownMenu.classList.contains("hidden") &&
              !this.dropdownMenu.contains(event.target) &&
              event.target !== this.translationButton
            ) {
              this.dropdownMenu.classList.add("hidden");
            }
          };
          document.addEventListener("click", this._boundDocumentClickHandler);
        }
      } else if (!this.buttonsWrapper.contains(this.translationButton)) {
        this.buttonsWrapper.appendChild(this.translationButton);
      }
    }

    // Reload Button Logic
    if (!this.reloadButton) {
      this.reloadButton = document.createElement("button");
      this.reloadButton.id = "lyrics-plus-reload-button";
      this.reloadButton.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="#e3e3e3"><path d="M480-192q-120 0-204-84t-84-204q0-120 84-204t204-84q65 0 120.5 27t95.5 72v-99h72v240H528v-72h131q-29-44-76-70t-103-26q-90 0-153 63t-63 153q0 90 63 153t153 63q84 0 144-55.5T693-456h74q-9 112-91 188t-196 76Z"/></svg>';
      this.reloadButton.title = t("refreshLyrics") || "Refresh Lyrics";
      this.buttonsWrapper.appendChild(this.reloadButton);

      this.reloadButton.addEventListener("click", () => {
        if (this.lastKnownSongInfo && this.fetchAndDisplayLyricsFn) {
          this.fetchAndDisplayLyricsFn(this.lastKnownSongInfo, true, true);
        }
      });
    } else if (!this.buttonsWrapper.contains(this.reloadButton)) {
      this.buttonsWrapper.appendChild(this.reloadButton);
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
        if (this.currentDisplayMode === "romanize") newMode = "both";
        if (this.setCurrentDisplayModeAndRefetchFn && this.lastKnownSongInfo) {
          this.setCurrentDisplayModeAndRefetchFn(
            newMode,
            this.lastKnownSongInfo,
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
        if (this.currentDisplayMode === "both") newMode = "romanize";
        if (this.setCurrentDisplayModeAndRefetchFn && this.lastKnownSongInfo) {
          this.setCurrentDisplayModeAndRefetchFn(
            newMode,
            this.lastKnownSongInfo,
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
        if (this.currentDisplayMode === "translate") newMode = "both";
        if (this.setCurrentDisplayModeAndRefetchFn && this.lastKnownSongInfo) {
          this.setCurrentDisplayModeAndRefetchFn(
            newMode,
            this.lastKnownSongInfo,
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
        if (this.currentDisplayMode === "both") newMode = "translate";
        if (this.setCurrentDisplayModeAndRefetchFn && this.lastKnownSongInfo) {
          this.setCurrentDisplayModeAndRefetchFn(
            newMode,
            this.lastKnownSongInfo,
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
   * Removes a button element from the DOM by cloning it (to strip all event
   * listeners) and then removing it. Nulls the provided ref after removal.
   * @param {'translationButton'|'reloadButton'} buttonProp - The instance property name.
   * @private
   */
  _removeButton(buttonProp) {
    const btn = this[buttonProp];
    if (!btn) return;
    const clone = btn.cloneNode(true);
    if (btn.parentNode) btn.parentNode.replaceChild(clone, btn);
    clone.remove();
    this[buttonProp] = null;
  }

  _normalizeSongInfoUrl(href) {
    if (!href) return "";
    if (/^https?:\/\//i.test(href)) return href;
    return new URL(href.startsWith("/") ? href : `/${href}`, window.location.origin).href;
  }

  _getSongInfoPath(href) {
    try {
      return new URL(href, window.location.origin).pathname.replace(/^\/+/, "");
    } catch (_) {
      return (href || "").replace(/^\/+/, "");
    }
  }

  _isArtistSongInfoPath(path) {
    return (
      path.startsWith("channel/") ||
      path.startsWith("browse/UC") ||
      path.includes("artist_detail")
    );
  }

  _createSongInfoLink(text, href, className) {
    const link = document.createElement("a");
    link.href = this._normalizeSongInfoUrl(href);
    link.textContent = text;
    link.className = className;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      window.open(link.href, "_blank");
    });
    return link;
  }

  _appendSongInfoCredits(artistElement, songInfo) {
    const artistLinks = Array.isArray(songInfo.artistLinks)
      ? songInfo.artistLinks.filter((artist) => artist?.name)
      : [];

    if (artistLinks.length > 0) {
      artistLinks.forEach((artist, index) => {
        if (index > 0) {
          artistElement.appendChild(
            document.createTextNode(index === artistLinks.length - 1 ? " & " : ", "),
          );
        }

        if (artist.url) {
          artistElement.appendChild(
            this._createSongInfoLink(
              artist.name,
              artist.url,
              "lyrics-clickable-artist",
            ),
          );
        } else {
          artistElement.appendChild(document.createTextNode(artist.name));
        }
      });
    } else if (songInfo.artistUrl && songInfo.artist) {
      artistElement.appendChild(
        this._createSongInfoLink(
          songInfo.artist,
          songInfo.artistUrl,
          "lyrics-clickable-artist",
        ),
      );
    } else if (songInfo.artist) {
      artistElement.textContent = songInfo.artist;
    }

    if (songInfo.album && songInfo.album.trim() !== "") {
      if (artistElement.childNodes.length > 0) {
        artistElement.appendChild(document.createTextNode(" - "));
      }

      if (songInfo.albumUrl) {
        artistElement.appendChild(
          this._createSongInfoLink(
            songInfo.album,
            songInfo.albumUrl,
            "lyrics-clickable-album",
          ),
        );
      } else {
        artistElement.appendChild(document.createTextNode(songInfo.album));
      }
    }
  }

  _renderSongInfoContainer(songInfo) {
    const songInfoContainer = document.createElement("div");
    songInfoContainer.className = "lyrics-song-info";
    songInfoContainer.style.display = "block";

    const titleElement = document.createElement("p");
    titleElement.id = "lyrics-song-title";
    titleElement.textContent = songInfo.title || "";

    const artistElement = document.createElement("p");
    artistElement.id = "lyrics-song-artist";
    this._appendSongInfoCredits(artistElement, songInfo);

    songInfoContainer.appendChild(titleElement);
    songInfoContainer.appendChild(artistElement);
    return songInfoContainer;
  }

  /**
   * Extracts song information directly from YouTube Music DOM.
   * @private
   */
  _getSongInfoFromDOM() {
    try {
      const titleElement =
        document.querySelector(".title.style-scope.ytmusic-player-bar") ||
        document.querySelector("ytmusic-player-bar .title");
      const byline =
        document.querySelector(".byline.style-scope.ytmusic-player-bar") ||
        document.querySelector("ytmusic-player-bar .subtitle") ||
        document.querySelector("ytmusic-player-bar .byline");

      if (!titleElement || !byline) return null;

      const title = titleElement.textContent.trim();
      if (!title) return null;

      const artistLinks = [];
      let album = "";
      let albumUrl = "";

      for (const link of Array.from(byline.querySelectorAll("a"))) {
        const href = link.getAttribute("href");
        const text = link.textContent?.trim();
        if (!href || !text) continue;

        const path = this._getSongInfoPath(href);
        if (this._isArtistSongInfoPath(path)) {
          artistLinks.push({ name: text, url: href });
        } else if (!album) {
          album = text;
          albumUrl = href;
        }
      }

      let artist = artistLinks.map((item) => item.name).join(", ");
      if (!artist && byline.textContent) {
        artist = byline.textContent.split(/[\u2022\u00b7\u2013\u2014]/)[0]?.trim() || "";
      }

      return {
        title,
        artist,
        album,
        isVideo: album === "" && artist === "",
        videoId: null,
        artistUrl: artistLinks[0]?.url || null,
        artistLinks,
        albumUrl: albumUrl || null,
      };
    } catch (error) {
      try {
        if (typeof LYPLUS_getDOMSongInfo === "function") {
          return LYPLUS_getDOMSongInfo();
        }
      } catch (_) {}
      return null;
    }
  }

  _shouldShowSongInfo() {
    const playerPage = document.querySelector("ytmusic-player-page");
    const isFullscreen =
      playerPage && playerPage.hasAttribute("player-fullscreened");
    const isVideoMode = playerPage && playerPage.hasAttribute("video-mode");
    return isFullscreen && !isVideoMode;
  }

  _removeSongInfoDisplay() {
    if (this._cleanupArtworkObservers) {
      this._cleanupArtworkObservers();
      this._cleanupArtworkObservers = null;
    }

    document.querySelectorAll(".lyrics-song-info").forEach((songInfo) => {
      songInfo
        .querySelectorAll("#lyrics-song-title, #lyrics-song-artist")
        .forEach((element) => {
          if (element._lyplusMarqueeStopTimer) {
            clearTimeout(element._lyplusMarqueeStopTimer);
            element._lyplusMarqueeStopTimer = null;
          }
          if (element._lyplusMarqueeClickHandler) {
            element.removeEventListener(
              "click",
              element._lyplusMarqueeClickHandler,
            );
            element._lyplusMarqueeClickHandler = null;
          }
          if (element._lyplusSongInfoClickHandler) {
            element.removeEventListener(
              "click",
              element._lyplusSongInfoClickHandler,
            );
            element._lyplusSongInfoClickHandler = null;
          }
        });

      if (songInfo._lyplusSongInfoClickHandler) {
        songInfo.removeEventListener(
          "click",
          songInfo._lyplusSongInfoClickHandler,
        );
        songInfo._lyplusSongInfoClickHandler = null;
      }

      songInfo.remove();
    });
  }

  /**
   * Adds the NewSync-style song info below the artwork in fullscreen.
   * @private
   */
  _addSongInfoFromDOM() {
    if (!this._shouldShowSongInfo()) {
      this._removeSongInfoDisplay();
      return;
    }

    const songInfo = this._getSongInfoFromDOM();
    if (!songInfo || songInfo.isVideo) {
      this._removeSongInfoDisplay();
      return;
    }

    this._removeSongInfoDisplay();
    const songInfoContainer = this._renderSongInfoContainer(songInfo);
    document.body.appendChild(songInfoContainer);
    this._positionSongInfoRelativeToArtwork(songInfoContainer);
    this._applySongInfoMarquee(songInfoContainer);
    this._setupArtworkObservers(songInfoContainer);
  }

  /**
   * Finds the album artwork element in the YT Music fullscreen layout.
   */
  _findArtworkElement() {
    const candidates = [
      "ytmusic-player-page[player-fullscreened] img.image",
      "ytmusic-player-page[player-fullscreened] #thumbnail img",
      "ytmusic-player-page[player-fullscreened] .image",
      "ytmusic-player-page[player-fullscreened] #player img",
      "ytmusic-player-page[player-fullscreened] .player-image",
      "ytmusic-player-page[player-fullscreened] ytmusic-player img",
      "ytmusic-player-page[player-fullscreened] #thumbnail",
      ".image.ytmusic-player-bar",
    ];

    for (const selector of candidates) {
      const element = document.querySelector(selector);
      if (element?.getBoundingClientRect) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return element;
      }
    }
    return null;
  }

  /**
   * Positions the provided container just below the artwork bounding box.
   */
  _positionSongInfoRelativeToArtwork(songInfoContainer) {
    const artworkElement = this._findArtworkElement();
    if (!artworkElement) {
      songInfoContainer.style.position = "";
      songInfoContainer.style.left = "";
      songInfoContainer.style.top = "";
      songInfoContainer.style.transform = "";
      songInfoContainer.style.maxWidth = "";
      songInfoContainer.style.textAlign = "";
      return;
    }

    const rect = artworkElement.getBoundingClientRect();
    const width = Math.max(300, Math.floor(rect.width));

    songInfoContainer.style.position = "fixed";
    songInfoContainer.style.left = `${rect.left}px`;
    songInfoContainer.style.top = `${rect.bottom + 20}px`;
    songInfoContainer.style.transform = "none";
    songInfoContainer.style.width = `${width}px`;
    songInfoContainer.style.maxWidth = `${width}px`;
    songInfoContainer.style.textAlign = "left";
    songInfoContainer.style.zIndex = "1000";
  }

  _applySongInfoMarquee(songInfoContainer) {
    if (!songInfoContainer) return;
    const titleElement = songInfoContainer.querySelector("#lyrics-song-title");
    const artistElement = songInfoContainer.querySelector("#lyrics-song-artist");
    if (titleElement) this._setupSongInfoMarqueeForElement(titleElement);
    if (artistElement) this._setupSongInfoMarqueeForElement(artistElement);

    const restartBoth = (event) => {
      if (event?.target?.closest("a")) return;
      titleElement?._lyplusRestartMarquee?.();
      artistElement?._lyplusRestartMarquee?.();
    };

    if (titleElement && !titleElement._lyplusSongInfoClickHandler) {
      titleElement._lyplusSongInfoClickHandler = restartBoth;
      titleElement.addEventListener("click", restartBoth);
    }
    if (artistElement && !artistElement._lyplusSongInfoClickHandler) {
      artistElement._lyplusSongInfoClickHandler = restartBoth;
      artistElement.addEventListener("click", restartBoth);
    }
    if (!songInfoContainer._lyplusSongInfoClickHandler) {
      songInfoContainer._lyplusSongInfoClickHandler = restartBoth;
      songInfoContainer.addEventListener("click", restartBoth);
    }
  }

  _setupSongInfoMarqueeForElement(element) {
    if (!element) return;

    let track = element.querySelector(".lyrics-song-marquee-track");
    let content = element.querySelector(".lyrics-song-marquee-content");
    if (!track || !content) {
      track = document.createElement("span");
      track.className = "lyrics-song-marquee-track";
      content = document.createElement("span");
      content.className = "lyrics-song-marquee-content";
      while (element.firstChild) content.appendChild(element.firstChild);
      track.appendChild(content);
      element.appendChild(track);
    }

    const measureAndToggle = () => {
      const overflow = element.scrollWidth > element.clientWidth + 1;
      if (overflow) {
        let clone = track.querySelector(".lyrics-song-marquee-clone");
        if (!clone) {
          clone = content.cloneNode(true);
          clone.classList.add("lyrics-song-marquee-clone");
          track.appendChild(clone);
        }

        const contentWidth = Math.max(1, content.scrollWidth);
        const durationSeconds = Math.min(900, Math.max(6, contentWidth / 40));
        element.classList.add(
          "lyrics-song-marquee",
          "lyrics-song-marquee-playing",
        );
        element.style.setProperty(
          "--lyrics-song-marquee-duration",
          `${durationSeconds}s`,
        );
        element.style.setProperty(
          "--lyrics-song-marquee-offset",
          `${contentWidth}px`,
        );

        if (element._lyplusMarqueeStopTimer) {
          clearTimeout(element._lyplusMarqueeStopTimer);
        }
        element._lyplusMarqueeStopTimer = setTimeout(() => {
          element.classList.remove("lyrics-song-marquee-playing");
          track.style.animationPlayState = "paused";
        }, Math.ceil(durationSeconds * 1000) + 80);

        track.style.animationPlayState = "running";
      } else {
        element.classList.remove(
          "lyrics-song-marquee",
          "lyrics-song-marquee-playing",
        );
        element.style.removeProperty("--lyrics-song-marquee-duration");
        element.style.removeProperty("--lyrics-song-marquee-offset");
        if (element._lyplusMarqueeStopTimer) {
          clearTimeout(element._lyplusMarqueeStopTimer);
          element._lyplusMarqueeStopTimer = null;
        }
        track.querySelector(".lyrics-song-marquee-clone")?.remove();
        track.style.removeProperty("animation-play-state");
      }
    };

    const restartMarquee = () => {
      element.classList.remove("lyrics-song-marquee");
      element.style.removeProperty("--lyrics-song-marquee-duration");
      element.style.removeProperty("--lyrics-song-marquee-offset");
      if (element._lyplusMarqueeStopTimer) {
        clearTimeout(element._lyplusMarqueeStopTimer);
        element._lyplusMarqueeStopTimer = null;
      }
      track.style.animation = "none";
      void track.offsetWidth;
      track.style.removeProperty("animation");
      track.style.animationPlayState = "running";
      track.querySelector(".lyrics-song-marquee-clone")?.remove();
      requestAnimationFrame(measureAndToggle);
    };

    element._lyplusRestartMarquee = restartMarquee;
    if (!element._lyplusMarqueeClickHandler) {
      element._lyplusMarqueeClickHandler = (event) => {
        if (event.target?.closest("a")) return;
        restartMarquee();
      };
      element.addEventListener("click", element._lyplusMarqueeClickHandler);
    }

    requestAnimationFrame(measureAndToggle);
  }

  /**
   * Observes layout changes to keep song info aligned with artwork.
   */
  _setupArtworkObservers(songInfoContainer) {
    const reposition = () => {
      if (!document.body.contains(songInfoContainer)) return;
      this._positionSongInfoRelativeToArtwork(songInfoContainer);
      this._applySongInfoMarquee(songInfoContainer);
    };

    this._artworkRepositionHandler = reposition;
    window.addEventListener("resize", reposition, { passive: true });
    window.addEventListener("scroll", reposition, { passive: true });

    const playerPage = document.querySelector("ytmusic-player-page");
    if (playerPage) {
      if (this._artworkMutationObserver) {
        this._artworkMutationObserver.disconnect();
      }
      this._artworkMutationObserver = new MutationObserver(reposition);
      this._artworkMutationObserver.observe(playerPage, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ["player-fullscreened", "video-mode", "style"],
      });
    }

    this._cleanupArtworkObservers = () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition);
      if (this._artworkMutationObserver) {
        this._artworkMutationObserver.disconnect();
        this._artworkMutationObserver = null;
      }
      this._artworkRepositionHandler = null;
    };
  }

  /**
   * Cleans up the lyrics container and resets the state for the next song.
   */
  cleanupLyrics() {
    this._removeSongInfoDisplay();

    // Event Cleanup
    const scrollContainer = this.lyricsContainer?.parentElement;
    if (scrollContainer) {
      scrollContainer.removeEventListener(
        "wheel",
        this._boundUserInteractionHandler,
      );
      scrollContainer.removeEventListener(
        "keydown",
        this._boundUserInteractionHandler,
      );

      scrollContainer.removeEventListener(
        "touchstart",
        this._boundTouchStartHandler,
      );
      scrollContainer.removeEventListener(
        "touchmove",
        this._boundTouchMoveHandler,
      );
    }
    this.scrollEventHandlerAttached = false;
    clearTimeout(this.userScrollIdleTimer);

    // Animation Frame Cleanup
    if (this.lyricsAnimationFrameId) {
      cancelAnimationFrame(this.lyricsAnimationFrameId);
      this.lyricsAnimationFrameId = null;
    }

    // WakeLock Cleanup
    if (this.containerObserver) {
      this.containerObserver.disconnect();
      this.containerObserver = null;
    }
    this._releaseWakeLock();

    // Cancel Debounced Resize Handler
    if (this._debouncedResizeHandler && this._debouncedResizeHandler.cancel) {
      this._debouncedResizeHandler.cancel();
    }

    // Timer Cleanup
    if (this.endProgrammaticScrollTimer)
      clearTimeout(this.endProgrammaticScrollTimer);
    if (this.userScrollIdleTimer) clearTimeout(this.userScrollIdleTimer);
    if (this.userScrollRevertTimer) clearTimeout(this.userScrollRevertTimer);

    this.endProgrammaticScrollTimer = null;
    this.userScrollIdleTimer = null;
    this.userScrollRevertTimer = null;

    // Observer Cleanup
    if (this.visibilityObserver) {
      this.visibilityObserver.disconnect();
      this.visibilityObserver = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    // Clean up Control Buttons
    this._removeButton("translationButton");
    this._removeButton("reloadButton");
    if (this.dropdownMenu) {
      this.dropdownMenu.remove();
      this.dropdownMenu = null;
    }

    // DOM & Cache Cleanup
    const container = this._getContainer();

    if (this.cachedLyricsLines) {
      for (let i = 0; i < this.cachedLyricsLines.length; i++) {
        const line = this.cachedLyricsLines[i];
        if (line) {
          line.removeEventListener("click", this._boundLyricClickHandler);
          line._cachedSyllableElements = null;
          line._cachedCharSpans = null;
          line._hasSharedListener = false;
        }
      }
    }

    if (this.cachedSyllables) {
      for (let i = 0; i < this.cachedSyllables.length; i++) {
        const syl = this.cachedSyllables[i];
        if (syl) {
          syl._cachedCharSpans = null;
          syl._nextSyllableInWord = null;
          syl.style.animation = "";
        }
      }
    }

    if (container) {
      container.innerHTML = `<div class="loading-container"><span class="text-loading">${t("loading")}</span><div class="loading-loop-m3"></div></div>`;
      container.classList.add("lyrics-plus-message");
      container.className =
        "lyrics-plus-integrated lyrics-plus-message blur-inactive-enabled";

      container.style.removeProperty("--lyrics-scroll-offset");
      container.style.removeProperty("--lyplus-override-pallete");
      container.style.removeProperty("--lyplus-song-pallete");
    }

    // Release Graphics Memory
    if (this.textWidthCanvas) {
      this.textWidthCanvas.width = 0;
      this.textWidthCanvas.height = 0;
      this.textWidthCanvas = null;
    }

    this.currentPrimaryActiveLine = null;
    this.lastPrimaryActiveLine = null;
    this.currentFullscreenFocusedLine = null;
    this.lastTime = 0;

    this.activeLineIds.clear();
    this.visibleLineIds.clear();
    this.cachedLyricsLines = [];
    this.cachedSyllables = [];
    this.fontCache = {};
    this._lineById = null;
    this._scrollPaddingTopCache = undefined;

    this._cachedContainerRect = null;

    this.currentScrollOffset = 0;
    this.isProgrammaticScrolling = false;
    this.isUserControllingScroll = false;

    this.currentDisplayMode = undefined;
    this.largerTextMode = "lyrics";

    this.lastKnownSongInfo = null;
    this.fetchAndDisplayLyricsFn = null;
    this.setCurrentDisplayModeAndRefetchFn = null;

    this._playerElement = undefined;

    this._lastActiveIndex = 0;
    this._tempActiveLines = [];
  }
}
