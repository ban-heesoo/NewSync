class LyricsPlusRenderer {
  /**
   * Static regular expressions and segmenter shared across all instances
   * to eliminate object allocation and compilation overhead.
   */
  static _RTL_RE = /[\u0600-\u06FF\u0750-\u077F\u0590-\u05FF\u08A0-\u08FF\uFB50-\uFDCF\uFDF0-\uFDFF\uFE70-\uFEFF]/;
  static _CJK_RE = /[\u4E00-\u9FFF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/;
  static _NEED_SPLIT_RE = /[\u4E00-\u9FFF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF]/;
  static _LATIN_RE = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\s]*$/u;
  static _BIDI_CHECK_RE = /[\p{Script=Latin}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}]/u;
  static _LETTER_OR_NUM_RE = /[\p{L}\p{N}]/u;
  static _NEED_SPLIT_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  static _NEED_SPLIT_ONLY_RE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30FC\p{P}\p{S}\s]+$/u;
  static _JOIN_TAIL_RE = /[\p{Script=Arabic}\p{M}]$/u;
  static _JOIN_HEAD_RE = /^[\p{Script=Arabic}\p{M}]/u;
  static _TRAILING_PUNCT_RE = /^[!?.,;:~…‥。、！？]/;
  static _FONT_SIZE_RE = /(\d+(?:\.\d+)?)px/;
  static _WHITESPACE_ONLY_RE = /^\s+$/;
  static _SEGMENTER = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter() : null;
  static _fontSizeCache = new Map();
  static _MASK_LEAD_TRIM = 1;
  static _NATIVE_SCROLL_DISTANCE_RATIO = 2;
  static _SCROLL_LEAD_GAP_MIN = 200;
  static _SCROLL_LEAD_GAP_MAX = 750;
  static _SCROLL_LEAD_MIN = 480;
  static _SCROLL_LEAD_MAX = 750;
  static _SPRING_GAP_MIN_MS = 0;
  static _SPRING_GAP_MAX_MS = 2500;
  static _SPRING_ZETA_TIGHT_GAP = 0.85;
  static _SPRING_ZETA_WIDE_GAP = 0.73;
  static _POSITION_CLASSES = [
    "lyrics-activest", "post-active-line", "next-active-line",
    "prev-1", "prev-2", "prev-3", "prev-4",
    "next-1", "next-2", "next-3", "next-4",
  ];
  static _POSITION_SELECTOR = "." + LyricsPlusRenderer._POSITION_CLASSES.join(", .");
  static _isFirefox = typeof navigator !== "undefined" && (
    /firefox|fxios/i.test(navigator.userAgent) ||
    (typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("-moz-appearance", "none"))
  );

  /**
   * Helper function to segment text into graphemes efficiently.
   * Reuses static Intl.Segmenter instance.
   * @param {string} text - The input text string.
   * @returns {string[]} - Array of graphemes.
   */
  static _segmentGraphemes(text) {
    if (!text) return [];
    const merged = [];
    const punctRe = LyricsPlusRenderer._TRAILING_PUNCT_RE;
    const add = (char) => {
      if (merged.length > 0 && punctRe.test(char)) {
        merged[merged.length - 1] += char;
      } else {
        merged.push(char);
      }
    };
    if (LyricsPlusRenderer._SEGMENTER) {
      for (const s of LyricsPlusRenderer._SEGMENTER.segment(text)) add(s.segment);
    } else {
      for (const ch of text) add(ch);
    }
    return merged;
  }

  /**
   * Helper function to count graphemes including punctuation marks.
   * Unlike _segmentGraphemes, this does not merge trailing punctuation.
   * @param {string} text - The input text string.
   * @returns {number} - Number of graphemes.
   */
  static _countGraphemes(text) {
    if (!text) return 0;
    if (LyricsPlusRenderer._SEGMENTER) {
      let count = 0;
      for (const _ of LyricsPlusRenderer._SEGMENTER.segment(text)) count++;
      return count;
    }
    return Array.from(text).length;
  }

  _mergeJoiningSyllables(syllabus, getText) {
    if (!syllabus || syllabus.length < 2) return syllabus;
    const TAIL = LyricsPlusRenderer._JOIN_TAIL_RE;
    const HEAD = LyricsPlusRenderer._JOIN_HEAD_RE;
    const groups = [];
    let cur = [syllabus[0]];
    for (let i = 1; i < syllabus.length; i++) {
      const prev = syllabus[i - 1];
      const s = syllabus[i];
      const pt = getText(prev) || "";
      const st = getText(s) || "";
      const joins =
        pt && st &&
        !!prev.isBackground === !!s.isBackground &&
        !prev.isLineEnding &&
        Number.isFinite(prev.time) && Number.isFinite(s.time) &&
        TAIL.test(pt) && HEAD.test(st);
      if (joins) cur.push(s);
      else { groups.push(cur); cur = [s]; }
    }
    groups.push(cur);
    if (groups.length === syllabus.length) return syllabus;

    return groups.map((g) => {
      if (g.length === 1) return g[0];
      const first = g[0];
      const last = g[g.length - 1];
      let end = first.time + first.duration;
      for (const p of g) end = Math.max(end, p.time + p.duration);
      const hasRoman = g.some((p) => p.romanizedText);
      const merged = Object.assign({}, first, {
        text: g.map((p) => p.text || "").join(""),
        romanizedText: hasRoman
          ? g.map((p) => p.romanizedText || p.text || "").join("")
          : first.romanizedText,
        time: first.time,
        duration: Math.max(0, end - first.time),
        _parts: g,
      });
      if ("isLineEnding" in last) merged.isLineEnding = last.isLineEnding;
      return merged;
    });
  }

  _buildSegments(s, isOriginal, stripParens) {
    if (!s || !s._parts) return null;
    return s._parts.map((p) => {
      let t = this._getDataText(p, isOriginal) || "";
      if (stripParens) t = t.replace(/[()]/g, "");
      return { text: t, time: p.time, duration: p.duration };
    });
  }

  static _isNeedSplitOnly(text) {
    return !!text &&
      LyricsPlusRenderer._NEED_SPLIT_CHAR_RE.test(text) &&
      LyricsPlusRenderer._NEED_SPLIT_ONLY_RE.test(text);
  }

  static _segmentNeedSplit(text) {
    const out = [];
    const seg = LyricsPlusRenderer._SEGMENTER;
    const wsRe = LyricsPlusRenderer._WHITESPACE_ONLY_RE;
    const add = (ch) => {
      if (out.length && wsRe.test(ch)) out[out.length - 1] += ch;
      else out.push(ch);
    };
    if (seg) for (const x of seg.segment(text)) add(x.segment);
    else for (const ch of text) add(ch);
    return out;
  }

  /**
   * Helper function to extract numeric font size in pixels from computed font string.
   * Caches results in static map.
   * @param {string} font - Font string (e.g. "700 24px Roboto").
   * @returns {number} - Font size in pixels.
   */
  static _getFontSizePx(font) {
    let size = LyricsPlusRenderer._fontSizeCache.get(font);
    if (size !== undefined) return size;
    const match = font.match(LyricsPlusRenderer._FONT_SIZE_RE);
    size = match ? parseFloat(match[1]) : 16;
    LyricsPlusRenderer._fontSizeCache.set(font, size);
    return size;
  }

  static _SPRING_EASING_CACHE = new Map();

  static _cubicBezierY(t, x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    let u = t;
    for (let i = 0; i < 8; i++) {
      const x = ((ax * u + bx) * u + cx) * u - t;
      const dx = (3 * ax * u + 2 * bx) * u + cx;
      if (Math.abs(dx) < 1e-6) break;
      u -= x / dx;
    }
    return ((ay * u + by) * u + cy) * u;
  }

  static _getSpringEasing(peakTimeMs, zeta = 0.78, settleTailMs = 400, mass = 1) {
    peakTimeMs = Math.max(10, Math.round(peakTimeMs / 20) * 20);
    settleTailMs = Math.max(10, Math.round(settleTailMs / 20) * 20);
    const key = `${peakTimeMs}:${zeta}:${settleTailMs}:${mass}`;
    const cached = LyricsPlusRenderer._SPRING_EASING_CACHE.get(key);
    if (cached) return cached;

    const peakTimeS = peakTimeMs / 1000;
    const settleTailS = settleTailMs / 1000;
    const omegaD = Math.PI / peakTimeS;
    const omega0 = omegaD / Math.sqrt(1 - zeta * zeta);
    const decayRate = zeta * omega0;
    const dt = 1 / 120;

    let peakValue = 1;
    for (let t = 0; t <= peakTimeS; t += dt) {
      peakValue = 1 - Math.exp(-decayRate * t) * (Math.cos(omegaD * t) + (decayRate / omegaD) * Math.sin(omegaD * t));
    }

    const points = [];
    for (let t = 0; t <= peakTimeS; t += dt) {
      const u = t / peakTimeS;
      points.push(peakValue * LyricsPlusRenderer._cubicBezierY(u, 0.41, 0, 0.12, 0.99));
    }

    for (let t = dt; t <= settleTailS; t += dt) {
      const u = t / settleTailS;
      points.push(1 + (peakValue - 1) * 0.5 * (1 + Math.cos(Math.PI * u)));
    }

    points.push(1);
    const easing = `linear(${points.map((v) => v.toFixed(4)).join(",")})`;
    const result = { easing, duration: Math.round((peakTimeS + settleTailS) * 1000) };
    const springCache = LyricsPlusRenderer._SPRING_EASING_CACHE;
    if (springCache.size >= 64) springCache.delete(springCache.keys().next().value);
    springCache.set(key, result);
    return result;
  }

  /**
   * Constructor for the LyricsPlusRenderer.
   * Initializes state variables and sets up the initial environment for the lyrics display.
   * @param {object} uiConfig - Configuration for UI element selectors.
   */
  constructor(uiConfig) {
    this.lyricsAnimationFrameId = null;
    this.currentPrimaryActiveLine = null;
    this._resetGapState();
    this.lastPrimaryActiveLine = null;
    this.currentFullscreenFocusedLine = null;
    this.lastTime = 0;
    this.offsetLatency = 0;

    this.uiConfig = uiConfig;
    this.lyricsContainer = null;
    this.cachedLyricsLines = [];
    this.cachedSyllables = [];
    this.activeLineIds = new Set();
    this._suggestedLineOffsetMs = -500;
    this._appleScrollDurationMs = 750;
    this._scrollGapT = null;
    this._lastHighlightTime = undefined;
    this._activeLineIndices = [];
    this._prevActiveLineIndices = [];
    this._lastActiveGroupEndIndex = 0;
    this.visibleLineIds = new Set();
    this.fontCache = Object.create(null);
    this._containerFontCache = null;
    this._trackStyleCache = new Map();
    this._textWidthCache = new Map();
    this._textWidthCount = 0;
    this._maskObservedLines = new Set();

    this.textWidthCanvas = null;
    this.textWidthCtx = null;
    this._lastCtxFont = null;

    this.visibilityObserver = null;
    this.resizeObserver = null;
    this.containerObserver = null;
    this._artworkMutationObserver = null;
    this._artworkRepositionHandler = null;
    this._cleanupArtworkObservers = null;
    this._debouncedResizeHandler = this._debounce(
      this._handleContainerResize,
      120,
      { leading: true, trailing: true }
    );

    this.translationButton = null;
    this.reloadButton = null;
    this.dropdownMenu = null;
    this.optionsDropdown = null;
    this.userOffsetMs = 0;
    this.currentLyrics = null;
    this._userSelectedProvider = null;
    this.availableProviders = new Set();
    this._notFoundProviders = new Set();
    this.saveLyricsOffsetFn = null;
    this.getProviderContextFn = null;
    this._toastElement = null;
    this._toastTimeout = null;
    this.buttonsWrapper = null;
    this._boundContainerClickHandler = this._onContainerClick.bind(this);

    this.scrollEventHandlerAttached = false;
    this.currentScrollOffset = 0;
    this.userScrollIdleTimer = null;
    this.isUserControllingScroll = false;

    this._boundUserInteractionHandler = this._onUserInteraction.bind(this);
    this._boundTouchStartHandler = this._onTouchStart.bind(this);
    this._boundTouchMoveHandler = this._onTouchMove.bind(this);

    this._touchStartY = 0;
    this._touchStartX = 0;

    this._lastActiveIndex = 0;
    this._tempActiveLines = [];
    this._deactivatingLines = [];
    this._activatingLines = [];
    this._bgShifts = [];
    this._bgShifts = [];
    this._activeIndices = [];
    this._rtlVocalContainers = [];
    this._lastContainerWidth = 0;
    this._lastContainerFont = "";
    this._rtlNeedsInitialLayout = false;
    this._lineById = new Map();
    this._positionClassedLines = [];
    this._nextPositionClassedLines = [];
    this._lastPastLineIndex = -1;
    this._animatingLines = [];
    this._visibilityChanges = [];
    this._springConfigCache = null;
    this._elevationConfigCache = null;
    this._appliedScrollDurStr = null;
    this._appliedScrollEasing = null;
    this._lastScrollDurationMs = 400;
    this._cachedGapHeight = 0;
    this._renderedState = null;
    this._renderedLyricLines = null;

    if (typeof document !== "undefined" && document.fonts && typeof document.fonts.addEventListener === "function") {
      this._boundFontLoadingDoneHandler = () => {
        this._containerFontCache = null;
        this._clearTextWidthCache();
        this._invalidateMaskAnimators(true);
        if (this.lyricsContainer) {
          this._debouncedResizeHandler(this.lyricsContainer);
        }
      };
      document.fonts.addEventListener("loadingdone", this._boundFontLoadingDoneHandler);
    }

    this.wakeLock = null;
    this._wakeLockPending = false;
    this._isContainerIntersecting = false;
    this._explicitPlaybackState = null;
    this._lastTickTime = 0;
    this._tickWatchdogTimer = null;
    this._wakeLockListenersAttached = false;
    this._setupWakeLockListeners();

    this._getContainer();
  }

  _setupWakeLockListeners() {
    if (this._wakeLockListenersAttached) return;
    this._wakeLockListenersAttached = true;

    this._boundWakeLockMediaHandler = (event) => {
      if (event && event.target && (event.target.tagName === 'VIDEO' || event.target.tagName === 'AUDIO')) {
        this._explicitPlaybackState = !event.target.paused && !event.target.ended;
        this._updateWakeLock();
      }
    };

    this._boundWakeLockVisibilityHandler = () => {
      this._updateWakeLock();
    };

    document.addEventListener('play', this._boundWakeLockMediaHandler, true);
    document.addEventListener('playing', this._boundWakeLockMediaHandler, true);
    document.addEventListener('pause', this._boundWakeLockMediaHandler, true);
    document.addEventListener('ended', this._boundWakeLockMediaHandler, true);
    document.addEventListener('visibilitychange', this._boundWakeLockVisibilityHandler);
  }

  _isLyricsOpen() {
    if (!this.lyricsContainer || !this.lyricsContainer.isConnected) {
      return false;
    }
    if (typeof this._isContainerIntersecting === 'boolean') {
      return this._isContainerIntersecting;
    }
    return this.lyricsContainer.offsetWidth > 0 || this.lyricsContainer.offsetHeight > 0;
  }

  _isSongPlaying() {
    if (typeof this.uiConfig?.isPlaying === 'function') {
      try {
        return !!this.uiConfig.isPlaying();
      } catch (e) { }
    }
    const player = this._getPlayerElement();
    if (player && typeof player.paused === 'boolean') {
      return !player.paused && !player.ended;
    }
    if (typeof this._explicitPlaybackState === 'boolean') {
      return this._explicitPlaybackState;
    }
    if (this.uiConfig?.disableNativeTick && this._lastTickTime) {
      return (Date.now() - this._lastTickTime) < 2000;
    }
    return false;
  }

  _shouldHoldWakeLock() {
    return !document.hidden && this._isLyricsOpen() && this._isSongPlaying();
  }

  _updateWakeLock() {
    if (this._shouldHoldWakeLock()) {
      this._requestWakeLock();
    } else {
      this._releaseWakeLock();
    }
  }

  setPlaybackState(isPlaying) {
    this._explicitPlaybackState = !!isPlaying;
    this._updateWakeLock();
  }

  async _requestWakeLock() {
    if (!('wakeLock' in navigator) || this.wakeLock || this._wakeLockPending) return;
    if (!this._shouldHoldWakeLock()) return;

    this._wakeLockPending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!this._shouldHoldWakeLock()) {
        lock.release().catch(() => {});
        if (this.wakeLock === lock) this.wakeLock = null;
        return;
      }
      this.wakeLock = lock;
      lock.addEventListener('release', () => {
        if (this.wakeLock === lock) this.wakeLock = null;
      });
    } catch (err) {
      console.warn(`LYPLUS: Wakelock error: ${err.name}, ${err.message}`);
    } finally {
      this._wakeLockPending = false;
    }
  }

  _releaseWakeLock() {
    const lock = this.wakeLock;
    if (!lock) return;
    this.wakeLock = null;
    lock.release().catch(err => {
      console.warn(`LYPLUS: Wakelock release error: ${err.name}, ${err.message}`);
    });
  }

  _setupContainerObserver() {
    if (!this.lyricsContainer) return;

    if (!this.containerObserver) {
      this.containerObserver = new IntersectionObserver((entries) => {
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          this._isContainerIntersecting = entry.isIntersecting;
          if (entry.isIntersecting) {
            if (this._rtlNeedsInitialLayout && this._rtlVocalContainers && this._rtlVocalContainers.length > 0) {
              this._lastContainerWidth = this.lyricsContainer.clientWidth || 0;
              this._layoutAllRtlVisualRowRomanizations();
              this._invalidateMaskAnimators();
            }
          }
          this._updateWakeLock();
        }
      }, { threshold: 0.01 });
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

  _splitNeedSplitSyllable(s) {
    const text = s && s.text;
    if (!text || !LyricsPlusRenderer._isNeedSplitOnly(text)) return null;
    if (!Number.isFinite(s.time) || !Number.isFinite(s.duration)) return null;

    let parts = LyricsPlusRenderer._segmentNeedSplit(text);
    if (s.isBackground) {
      const merged = [];
      let pendingOpen = "";
      for (const part of parts) {
        if (/^\(\s*$/.test(part)) { pendingOpen += part; continue; }
        if (/^\)\s*$/.test(part) && merged.length) { merged[merged.length - 1] += part; continue; }
        merged.push(pendingOpen + part);
        pendingOpen = "";
      }
      if (pendingOpen) merged.length ? (merged[merged.length - 1] += pendingOpen) : merged.push(pendingOpen);
      parts = merged;
    }
    const n = parts.length;
    if (n < 2) return null;

    const font = "400 16px sans-serif";
    let widths = parts.map((t) => Math.max(0, this._getTextWidth(t.replace(/[()]/g, "").trim(), font)));
    let total = widths.reduce((a, b) => a + b, 0);
    if (!(total > 0)) { widths = parts.map(() => 1); total = n; }

    const end = s.time + s.duration;
    const pieces = [];
    let cum = 0;
    for (let i = 0; i < n; i++) {
      const start = i === 0 ? s.time : Math.round(s.time + (s.duration * cum) / total);
      cum += widths[i];
      const stop = i === n - 1 ? end : Math.round(s.time + (s.duration * cum) / total);
      const piece = Object.assign({}, s, {
        text: parts[i],
        time: start,
        duration: Math.max(0, stop - start),
        romanizedText: undefined,
        _origSyl: s,
      });
      if ("isLineEnding" in s) piece.isLineEnding = i === n - 1 ? s.isLineEnding : false;
      pieces.push(piece);
    }
    return pieces;
  }

  _isNeedSplitOnly(text) {
    return LyricsPlusRenderer._isNeedSplitOnly(text);
  }

  _segmentNeedSplit(text) {
    return LyricsPlusRenderer._segmentNeedSplit(text);
  }

  _splitNeedSplitSyllables(syllabus) {
    if (!syllabus || !syllabus.length) return syllabus;
    let changed = false;
    const out = [];
    for (const s of syllabus) {
      const pieces = this._splitNeedSplitSyllable(s);
      if (pieces) {
        changed = true;
        for (const piece of pieces) out.push(piece);
      } else {
        out.push(s);
      }
    }
    return changed ? out : syllabus;
  }

  _isReplacementActive(line, displayMode = this.currentDisplayMode) {
    return false;
  }

  _getActiveSyllabus(line, displayMode = this.currentDisplayMode) {
    if (!line) return [];
    return line.syllabus || [];
  }

  _getDataText(normal, isOriginal = true) {
    if (!normal) return "";

    const baseText = normal.text || "";
    const isRomanizationMode = this.largerTextMode === "romanization";

    if (isOriginal) {
      return isRomanizationMode
        ? normal.romanizedText || baseText
        : baseText;
    } else {
      return isRomanizationMode
        ? baseText
        : normal.romanizedText || baseText;
    }
  }

  /**
   * Handles the actual logic for container resize, debounced by _debouncedResizeHandler.
   * @param {HTMLElement} container - The lyrics container element.
   * @private
   */
  _handleContainerResize(container) {
    if (!container) return;

    this._scrollPaddingTopCache = undefined;
    this._containerDisplayCache = undefined;
    this._springConfigCache = null;
    this._elevationConfigCache = null;
    this._containerFontCache = null;
    this._cachedGapHeight = 0;
    this._trackStyleCache.clear();

    const newW = container.clientWidth || 0;
    const newFont = this._getContainerFont();
    const widthChanged = newW > 0 && Math.abs((this._lastContainerWidth || 0) - newW) > 1;
    const fontChanged = !!(this._lastContainerFont && this._lastContainerFont !== newFont);
    if (newW > 0 && (this._rtlNeedsInitialLayout || widthChanged || fontChanged)) {
      this._lastContainerWidth = newW;
      this._lastContainerFont = newFont;
      if (this._rtlVocalContainers && this._rtlVocalContainers.length > 0) {
        this._layoutAllRtlVisualRowRomanizations();
      }
      this._invalidateMaskAnimators(true);
    }

    if (!this.isUserControllingScroll && this.currentPrimaryActiveLine) {
      this._scrollToActiveLine(this.currentPrimaryActiveLine, false, true);
    }
  }

  /**
   * A helper method to determine if a text string contains Right-to-Left characters.
   * @param {string} text - The text to check.
   * @returns {boolean} - True if the text contains RTL characters.
   */
  _isRTL(text) {
    return LyricsPlusRenderer._RTL_RE.test(text);
  }

  /**
   * A helper method to determine if a text string contains characters from scripts without spaces.
   * @param {string} text - The text to check.
   * @returns {boolean} - True if the text contains non-spaced script characters.
   */
  _isNeedSplit(text) {
    return LyricsPlusRenderer._NEED_SPLIT_RE.test(text);
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
      if (LyricsPlusRenderer._isFirefox && !this.lyricsContainer.classList.contains("is-firefox")) {
        this.lyricsContainer.classList.add("is-firefox");
      }
      this._attachClickDelegate();
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
      this.uiConfig.patchParent
    );
    if (!originalLyricsSection) {
      console.log("Unable to find " + this.uiConfig.patchParent);
      this.lyricsContainer = null;
      return null;
    }
    return this._renderContainer(originalLyricsSection);
  }

  _renderContainer(originalLyricsSection) {
    const container = document.createElement("div");
    container.id = "lyrics-plus-container";
    container.className = "lyrics-plus-integrated blur-inactive-enabled";
    if (LyricsPlusRenderer._isFirefox) {
      container.classList.add("is-firefox");
    }
    originalLyricsSection.appendChild(container);
    this.lyricsContainer = container;
    this._invalidateSpringConfig();
    this._invalidateElevationConfig();
    return container;
  }

  _attachScrollListeners() {
    const scrollContainer = this.lyricsContainer?.parentElement;
    if (!scrollContainer) return;
    if (this.scrollEventHandlerAttached) return;

    scrollContainer.addEventListener('wheel', this._boundUserInteractionHandler, { passive: true });
    scrollContainer.addEventListener('keydown', this._boundUserInteractionHandler, { passive: true });

    scrollContainer.addEventListener('touchstart', this._boundTouchStartHandler, { passive: true });
    scrollContainer.addEventListener('touchmove', this._boundTouchMoveHandler, { passive: true });

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
   * Records the starting position of a touch.
   */
  _onTouchStart(e) {
    if (e.touches.length > 0) {
      this._touchStartX = e.touches[0].clientX;
      this._touchStartY = e.touches[0].clientY;
    }
  }

  /**
   * Checks if the user moved their finger enough to be considered a scroll.
   */
  _onTouchMove(e) {
    if (e.touches.length > 0) {
      const currentX = e.touches[0].clientX;
      const currentY = e.touches[0].clientY;

      const diffX = Math.abs(currentX - this._touchStartX);
      const diffY = Math.abs(currentY - this._touchStartY);

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
      if (!this.isUserControllingScroll) {
        this.isUserControllingScroll = true;
        this.lyricsContainer?.classList.add("user-scrolling", "not-focused");
        if (this._scrollUnlockTimeout) {
          clearTimeout(this._scrollUnlockTimeout);
          this._scrollUnlockTimeout = null;
        }
        if (this._scrollAnimationState) {
          this._scrollAnimationState.isAnimating = false;
          this._scrollAnimationState.pendingUpdate = null;
        }
        if (this._animatingLines && this._animatingLines.length > 0) {
          for (let i = 0; i < this._animatingLines.length; i++) {
            const line = this._animatingLines[i];
            if (line._scrollAnim) {
              line._scrollAnim.cancel();
              line._scrollAnim = null;
            }
            line._scrollDelay = 0;
          }
          this._animatingLines.length = 0;
        }
      }

      clearTimeout(this.userScrollIdleTimer);
      this.userScrollIdleTimer = setTimeout(() => {
        this.isUserControllingScroll = false;
        this.lyricsContainer?.classList.remove("user-scrolling", "not-focused");

        this._closeHiddenGaps(false);
        if (this.currentPrimaryActiveLine) {
          this._scrollToActiveLine(this.currentPrimaryActiveLine, true);
        }
      }, 5000);
    }
  }

  /**
   * One delegated listener on the container replaces a listener per line.
   */
  _attachClickDelegate() {
    const c = this.lyricsContainer;
    if (!c || c._lyplusClickBound) return;
    c.addEventListener("click", this._boundContainerClickHandler);
    c._lyplusClickBound = true;
  }

  _onContainerClick(e) {
    const line = e.target && e.target.closest ? e.target.closest(".lyrics-line") : null;
    if (line && this.lyricsContainer && this.lyricsContainer.contains(line)) {
      this._onLyricClick(line);
    }
  }

  /**
   * Seeks the player to the clicked line's start time.
   * @param {HTMLElement} lineEl - The clicked .lyrics-line element.
   */
  _onLyricClick(lineEl) {
    const time = parseFloat(lineEl.dataset.startTime);
    const offsetSec = (this.userOffsetMs || 0) / 1000;
    this._clickSeekUntil = performance.now() + 500;
    this._seekPlayerTo(time + offsetSec - 0.05);
    this._scrollToActiveLine(lineEl, true);
  }

  /**
   * Reads and caches the base computed font of the connected lyricsContainer once,
   * avoiding getComputedStyle calls on detached DocumentFragment children during render.
   */
  _getContainerFont() {
    if (this._containerFontCache) return this._containerFontCache;
    if (this.lyricsContainer && this.lyricsContainer.isConnected) {
      const style = getComputedStyle(this.lyricsContainer);
      const weight = style.fontWeight || "400";
      const size = style.fontSize || "16px";
      const family = style.fontFamily || "sans-serif";
      const font = `${weight} ${size} ${family}`.trim();
      if (font && font !== "  ") {
        this._containerFontCache = font;
        return font;
      }
    }
    return "400 16px sans-serif";
  }

  /**
   * Internal helper to render word-by-word lyrics.
   * @private
   */
  _renderWordByWordLyrics(
    lyrics,
    displayMode,
    singerClassMap,
    fragment,
    lineSideAssignments = null
  ) {
    const referenceFont = this._getContainerFont();
    const referenceFontSizePx = LyricsPlusRenderer._getFontSizePx(referenceFont);
    const gradientDistancePx = 0.75 * referenceFontSizePx;

    const calculatePhysicsPreHighlightDelay = (syllable, currentDuration) => {
      const textWidthPx = this._getTextWidth(syllable._rawText ?? syllable.textContent, referenceFont);
      if (textWidthPx <= 0.1 || currentDuration <= 0) return { delay: 0, duration: 0 };

      const velocityPxPerMs = textWidthPx / currentDuration;
      const gradientDurationMs = gradientDistancePx / velocityPxPerMs;

      return {
        delay: currentDuration - gradientDurationMs,
        duration: gradientDurationMs
      };
    };

    lyrics.data.forEach((line, lineIdx) => {
      const activeSyllabus = this._getActiveSyllabus(line, displayMode);
      const activeLineText = this._getDataText(line, true);
      if (activeSyllabus) {
        for (let si = 0; si < activeSyllabus.length; si++) {
          activeSyllabus[si]._rawSylIdx = si;
        }
      }
      const currentLine = document.createElement("div");
      currentLine.className = "lyrics-line";
      currentLine.dataset.startTime = line.startTime;
      currentLine.dataset.endTime = line.endTime;
      currentLine._startTimeMs = parseFloat(line.startTime) * 1000;
      currentLine._endTimeMs = parseFloat(line.endTime) * 1000;

      const currentLineContainer = document.createElement("div");
      currentLineContainer.className = "lyrics-line-container";
      currentLine.appendChild(currentLineContainer);
      currentLine._lineContainer = currentLineContainer;
      currentLine._rawLineData = line;
      currentLine._rawSyllabus = activeSyllabus || null;

      const assignedSide = lineSideAssignments && lineSideAssignments[lineIdx];
      const singerClass = assignedSide || (
        line.element?.singer
          ? singerClassMap[line.element.singer] || "singer-left"
          : "singer-left"
      );
      currentLine.classList.add(singerClass);

      const mainContainer = document.createElement("p");
      mainContainer.classList.add("main-vocal-container");
      currentLineContainer.appendChild(mainContainer);
      currentLine._mainVocalContainer = mainContainer;

      const lineSyllables = [];
      const lineWraps = [];
      const mainWords = [];
      const bgWords = [];
      currentLine._cachedSyllableElements = lineSyllables;
      currentLineContainer._wraps = lineWraps;
      mainContainer._words = mainWords;

      let backgroundContainer = null;
      let backgroundInnerWrap = null;
      let firstMainStartTime = Infinity;
      let isFirstSyllableInMain = true;
      let isFirstSyllableInBg = true;
      let pendingSyllable = null;

      const renderSyllabus = this._splitNeedSplitSyllables(
        this._mergeJoiningSyllables(activeSyllabus, (s) => this._getDataText(s, true))
      );

      const isLineBiDi = activeLineText &&
        this._isRTL(activeLineText) &&
        LyricsPlusRenderer._BIDI_CHECK_RE.test(activeLineText);

      const linkSyllables = (prevSyllable, nextSyllable) => {
        const physicsData = calculatePhysicsPreHighlightDelay(
          prevSyllable,
          prevSyllable._durationMs
        );
        prevSyllable._nextSyllableInWord = nextSyllable;
        prevSyllable._preHighlightDurationMs = physicsData.duration;
        prevSyllable._preHighlightDelayMs = physicsData.delay;
      };

      const createSyllableElement = (s, totalDuration, idx, isBg) => {
        const sylSpan = document.createElement("span");
        sylSpan.className = "lyrics-syllable";

        sylSpan._startTimeMs = s.time;
        sylSpan._durationMs = s.duration;
        sylSpan._endTimeMs = s.time + s.duration;
        sylSpan._wordDurationMs = totalDuration;
        sylSpan._isBackground = isBg;
        sylSpan._syllableIdx = idx;
        sylSpan._isGap = false;
        sylSpan._isGrowable = false;
        sylSpan._state = 0;

        if (isBg) {
          if (isFirstSyllableInBg) {
            sylSpan._isFirstInContainer = true;
            isFirstSyllableInBg = false;
          }
        } else {
          if (s.time < firstMainStartTime) {
            firstMainStartTime = s.time;
          }
          if (isFirstSyllableInMain) {
            sylSpan._isFirstInContainer = true;
            isFirstSyllableInMain = false;
          }
        }

        const origText = this._getDataText(s, true);
        if (this._isRTL(origText)) {
          sylSpan.classList.add("rtl-text");
        }

        if (s._parts) sylSpan._segments = this._buildSegments(s, true, !!isBg);

        return sylSpan;
      };

      const renderCharWipes = (s, sylSpan, characterData) => {
        const syllableText = this._getDataText(s);
        sylSpan._rawText = syllableText;
        const chars = LyricsPlusRenderer._segmentGraphemes(syllableText);
        const charsLen = chars.length;
        const charWidths = new Array(charsLen);
        let totalSyllableWidth = 0;

        for (let i = 0; i < charsLen; i++) {
          const w = this._getTextWidth(chars[i], referenceFont);
          charWidths[i] = w;
          totalSyllableWidth += w;
        }

        const velocityPxPerMs = totalSyllableWidth / s.duration;
        const gradientDurationMs = gradientDistancePx / velocityPxPerMs;

        let cumulativeCharWidth = 0;
        const charSpans = [];

        for (let i = 0; i < charsLen; i++) {
          const char = chars[i];
          const charWidth = charWidths[i];
          if (char === " ") {
            sylSpan.appendChild(document.createTextNode(" "));
          } else {
            const charSpan = document.createElement("span");
            charSpan.textContent = char;
            charSpan._rawText = char;
            charSpan.className = "char";

            if (totalSyllableWidth > 0) {
              const startPercent = cumulativeCharWidth / totalSyllableWidth;
              const durationPercent = charWidth / totalSyllableWidth;

              charSpan._wipeStart = startPercent;
              charSpan._wipeDuration = durationPercent;
              charSpan._preWipeArrival = s.duration * startPercent;
              charSpan._preWipeDuration = gradientDurationMs;
            }

            charSpan._syllableCharIndex = characterData.length;
            characterData.push({ charSpan, syllableSpan: sylSpan, isBackground: s.isBackground });
            charSpans.push(charSpan);
            sylSpan.appendChild(charSpan);
          }
          cumulativeCharWidth += charWidth;
        }

        if (charSpans.length > 0) {
          sylSpan._cachedCharSpans = charSpans;
          sylSpan.classList.add("has-chars");
        }
      };

      const shouldAllowBreak = (text) =>
        text.trim().length >= 16 || this._isCJK(text.trim());

      const renderWordSpan = (wordBuffer, shouldEmphasize, isLastInContiner = false) => {
        if (!wordBuffer.length) return;

        const currentWordStartTime = wordBuffer[0].time;
        const lastSyllable = wordBuffer[wordBuffer.length - 1];
        const currentWordEndTime = lastSyllable.time + lastSyllable.duration;
        const totalDuration = currentWordEndTime - currentWordStartTime;
        const combinedText = wordBuffer.map((s) => this._getDataText(s)).join("");
        const isBgWord = wordBuffer[0].isBackground || false;

        const wordSpan = document.createElement("span");
        wordSpan.className = "lyrics-word";
        wordSpan._wordSyllabus = wordBuffer;

        if (shouldAllowBreak(combinedText)) {
          wordSpan.classList.add("allow-break");
        }

        if (shouldEmphasize) {
          wordSpan.classList.add("growable");
          wordSpan._wordStartMs = currentWordStartTime;
          wordSpan._wordDurationMs = totalDuration;
        }

        const characterData = [];
        const syllableElements = [];

        let prevOrig = null;
        let wrap = null;
        let sylParent = null;
        wordBuffer.forEach((s, idx) => {
          if (!(s._origSyl && s._origSyl === prevOrig)) {
            wrap = document.createElement("span");
            wrap.className = "lyrics-syllable-wrap";
            wordSpan.appendChild(wrap);
            lineWraps.push(wrap);
            sylParent = wrap;
            if (s._origSyl) {
              sylParent = document.createElement("span");
              sylParent.className = "lyrics-syllable-letters";
              wrap.appendChild(sylParent);
            }
          }
          prevOrig = s._origSyl || null;

          const sylSpan = createSyllableElement(s, totalDuration, idx, s.isBackground || false);

          let txtContent = "";
          if (s.isBackground) {
            txtContent = this._getDataText(s).replace(/[()]/g, "");
            sylSpan.textContent = txtContent;
            sylSpan._rawText = txtContent;
          } else if (shouldEmphasize) {
            renderCharWipes(s, sylSpan, characterData);
          } else {
            txtContent = this._getDataText(s);
            sylSpan.textContent = txtContent;
            sylSpan._rawText = txtContent;
          }

          if (!s.isBackground && !shouldEmphasize) {
            const trimmed = txtContent.trim();
            if (trimmed.length > 0 && trimmed.length !== txtContent.length) {
              const textWidth = this._getTextWidth(trimmed, referenceFont);
              const spaceWidth = this._getTextWidth(txtContent, referenceFont);
              sylSpan._wipeRatio = textWidth > 0 ? textWidth / spaceWidth : 1;
            } else {
              sylSpan._wipeRatio = 1;
            }
          } else {
            sylSpan._wipeRatio = 1;
          }

          sylParent.appendChild(sylSpan);
          syllableElements.push(sylSpan);
          lineSyllables.push(sylSpan);
        });
        for (let _si = 0; _si < syllableElements.length; _si++) {
          syllableElements[_si]._isGrowable = shouldEmphasize;
        }

        if (shouldEmphasize) {
          wordSpan._cachedChars = characterData.map((cd) => cd.charSpan);
          this._prepareEmphasis(wordSpan, totalDuration);
        }

        const hasText = (el) => {
          const raw = el ? (el._rawText ?? el.textContent) : "";
          return raw.trim().length > 0;
        };

        if (pendingSyllable && syllableElements.length > 0 && pendingSyllable._isBackground === isBgWord) {
          const firstVisibleSyllable = syllableElements.find(hasText);
          if (firstVisibleSyllable) {
            linkSyllables(pendingSyllable, firstVisibleSyllable);
          }
        }

        syllableElements.forEach((syllable, index) => {
          if (index < syllableElements.length - 1) {
            let nextIndex = index + 1;
            let nextSyllable = syllableElements[nextIndex];

            while (nextSyllable && !hasText(nextSyllable) && nextIndex < syllableElements.length - 1) {
              nextIndex++;
              nextSyllable = syllableElements[nextIndex];
            }

            if (nextSyllable && hasText(nextSyllable)) {
              linkSyllables(syllable, nextSyllable);
            }
          }
        });

        const MoveEarlier = currentSettings.bkgOverlap;
        const targetContainer = isBgWord
          ? backgroundInnerWrap ||
          (() => {
            backgroundContainer = document.createElement("p");
            backgroundContainer.className = "background-vocal-container";
            currentLine.classList.add("has-bg-vocal");

            backgroundInnerWrap = document.createElement("span");
            backgroundInnerWrap.className = "background-vocal-wrap";
            backgroundInnerWrap._words = bgWords;
            backgroundContainer.appendChild(backgroundInnerWrap);
            currentLine._bgWrap = backgroundInnerWrap;
            this._observeBgWrap(backgroundInnerWrap);

            if (MoveEarlier) {
              if (currentWordStartTime < firstMainStartTime) {
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

        const vocalRootContainer = isBgWord ? backgroundContainer : mainContainer;
        for (let _si = 0; _si < syllableElements.length; _si++) {
          syllableElements[_si]._vocalContainer = vocalRootContainer;
        }

        if (isBgWord) {
          bgWords.push(wordSpan);
        } else {
          mainWords.push(wordSpan);
        }

        let actualTarget = targetContainer;

        if (isLineBiDi) {
          const isWordRTL = this._isRTL(combinedText);
          const wrapperClass = isWordRTL ? "bidi-rtl" : "bidi-ltr";
          const wrapperDir = isWordRTL ? "rtl" : "ltr";

          const lastChild = targetContainer.lastElementChild;

          if (lastChild && lastChild.classList.contains(wrapperClass)) {
            actualTarget = lastChild;
          } else {
            actualTarget = document.createElement("span");
            actualTarget.className = wrapperClass;
            actualTarget.setAttribute("dir", wrapperDir);
            targetContainer.appendChild(actualTarget);
          }
        }

        actualTarget.appendChild(wordSpan);

        const trailText = combinedText.match(/\s+$/);
        if (trailText && !isLastInContiner) {
          actualTarget.appendChild(document.createTextNode(trailText[0]));
        }

        pendingSyllable = syllableElements.length > 0 ? syllableElements[syllableElements.length - 1] : null;
      };

      if (activeSyllabus && activeSyllabus.length > 0) {
        const logicalWordGroups = [];
        let currentGroupBuffer = [];

        renderSyllabus.forEach((s, idx) => {
          currentGroupBuffer.push(s);
          const syllableText = this._getDataText(s);
          const nextSyllable = renderSyllabus[idx + 1];

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

          const trimmedGroupText = groupText.trim();
          const isGroupGrowable =
            !isBg &&
            !currentSettings.lightweight &&
            !this._isRTL(groupText) &&
            !LyricsPlusRenderer._isNeedSplitOnly(groupText) &&
            trimmedGroupText.length > 0 &&
            LyricsPlusRenderer._countGraphemes(trimmedGroupText) <= 7 &&
            groupDuration >= 1000;

          if (isGroupGrowable) {
            const origGroup = [];
            for (const p of group) {
              const o = p._origSyl || p;
              if (origGroup[origGroup.length - 1] !== o) origGroup.push(o);
            }
            renderWordSpan(origGroup, true, isLastGroupInContainer);
          } else {
            let visualWordBuffer = [];
            group.forEach((s, idxInGroup) => {
              visualWordBuffer.push(s);
              const syllableText = this._getDataText(s);
              const isLastInGroup = idxInGroup === group.length - 1;

              if (groupText.trim().length >= 12 && syllableText.endsWith("-") || isLastInGroup) {
                renderWordSpan(visualWordBuffer, false, isLastGroupInContainer);
                visualWordBuffer = [];
              }
            });
          }
        });
      } else {
        mainContainer.textContent = activeLineText;
      }

      if (!backgroundInnerWrap) {
        currentLine._bgWrap = null;
      }

      const mainText = activeLineText || mainContainer.textContent;
      let applyRtlToLine = this._isRTL(mainText);

      if (applyRtlToLine && isLineBiDi) {
        let firstSyllableText = "";

        if (activeSyllabus && activeSyllabus.length > 0) {
          const firstValid = activeSyllabus.find(s => LyricsPlusRenderer._LETTER_OR_NUM_RE.test(this._getDataText(s)));
          if (firstValid) {
            firstSyllableText = this._getDataText(firstValid);
          }
        }

        if (!firstSyllableText) {
          const fallbackMatch = mainText.match(LyricsPlusRenderer._LETTER_OR_NUM_RE);
          firstSyllableText = fallbackMatch ? fallbackMatch[0] : "";
        }

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

      if (backgroundContainer && !backgroundContainer.classList.contains("onTop")) {
        currentLineContainer.appendChild(backgroundContainer);
      }
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
    fragment,
    lineSideAssignments = null
  ) {
    lyrics.data.forEach((line, lineIdx) => {
      const lineEl = document.createElement("div");
      lineEl.className = "lyrics-line";
      lineEl._bgWrap = null;
      lineEl._cachedSyllableElements = [];
      const lineContainer = document.createElement("div");
      lineContainer.className = "lyrics-line-container";
      lineEl.append(lineContainer);
      lineEl.dataset.startTime = line.startTime;
      lineEl.dataset.endTime = line.endTime;
      lineEl._startTimeMs = parseFloat(line.startTime) * 1000;
      lineEl._endTimeMs = parseFloat(line.endTime) * 1000;

      const assignedSide = lineSideAssignments && lineSideAssignments[lineIdx];
      const singerClass = assignedSide || (
        line.element?.singer
          ? singerClassMap[line.element.singer] || "singer-left"
          : "singer-left"
      );
      lineEl.classList.add(singerClass);

      const _lineText = this._getDataText(line, true);
      let _lineIsRTL = this._isRTL(_lineText);

      if (_lineIsRTL) {
        const firstCharMatch = _lineText.match(LyricsPlusRenderer._LETTER_OR_NUM_RE);
        if (firstCharMatch) {
          const firstChar = firstCharMatch[0];
          if (!this._isRTL(firstChar)) {
            _lineIsRTL = false;
          }
        }
      }

      if (_lineIsRTL) {
        lineEl.classList.add("rtl-text");
      }

      const mainContainer = document.createElement("div");
      mainContainer.className = "main-vocal-container";
      mainContainer.textContent = this._getDataText(line);

      if (_lineIsRTL) {
        mainContainer.classList.add("rtl-text");
      }

      lineEl._lineContainer = lineContainer;
      lineEl._mainVocalContainer = mainContainer;
      lineEl._rawLineData = line;
      lineEl._rawSyllabus = null;
      lineContainer.appendChild(mainContainer);
      this._renderTranslationContainer(lineContainer, line, displayMode);
      fragment.appendChild(lineEl);
    });
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
      const partIdx = line.element?.songPartIndex;

      if (partIdx !== currentSongPartIndex && fullText !== "") {
        fullText += "\n";
      }

      if (!line.text || !line.text.trim()) {
        fullText += "\n";
      } else {
        fullText += lineText + "\n";
      }

      currentSongPartIndex = partIdx || currentSongPartIndex;
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
    container.classList.toggle("lyrics-translated", displayMode === "translate");
    container.classList.toggle("lyrics-romanized", displayMode === "romanize");
    container.classList.toggle("lyrics-both-modes", displayMode === "both");
  }

  _populateRtlSubrow(subrow, words, startW, endW) {
    subrow.textContent = "";
    let hasSpans = false;
    for (let w = startW; w < endW; w++) {
      const spans = words[w]._romanSpans;
      if (!spans) continue;
      const sLen = spans.length;
      for (let sIdx = 0; sIdx < sLen; sIdx++) {
        const sp = spans[sIdx];
        sp.textContent = sp._baseText;
        sp._rawText = sp._baseText;
        sp._vocalContainer = subrow;
        subrow.appendChild(sp);
        hasSpans = true;
      }
      if (sLen > 0) {
        const lastSpan = spans[sLen - 1];
        const finalTxt = (w < endW - 1)
          ? lastSpan._trimmedText + " "
          : lastSpan._trimmedText;
        lastSpan.textContent = finalTxt;
        lastSpan._rawText = finalTxt;
      }
    }
    subrow._hasSpans = hasSpans;
    return hasSpans;
  }

  _layoutAllRtlVisualRowRomanizations() {
    const containers = this._rtlVocalContainers;
    if (!containers || containers.length === 0 || !this.lyricsContainer) return;

    const len = containers.length;
    const isMeasured = (this.lyricsContainer.clientWidth || 0) > 0;
    this._rtlNeedsInitialLayout = !isMeasured;

    let pendingCount = 0;

    for (let i = 0; i < len; i++) {
      const vc = containers[i];
      const words = vc._rtlWords;
      const wLen = words ? words.length : 0;
      if (wLen === 0) continue;
      if (wLen === 1 && vc._rtlInitialized) continue;

      const subrows = vc._rtlSubrows || (vc._rtlSubrows = []);
      for (let j = 0, sLen = subrows.length; j < sLen; j++) {
        subrows[j].remove();
      }
      subrows.length = 0;

      const pool = vc._rtlSubrowPool || (vc._rtlSubrowPool = []);
      let subrow0 = pool[0];
      if (!subrow0) {
        subrow0 = document.createElement("span");
        subrow0.className = vc._translitIsRtl
          ? "lyrics-romanization-container lyrics-romanization-subrow rtl-text"
          : "lyrics-romanization-container lyrics-romanization-subrow";
        pool[0] = subrow0;
      }

      if (this._populateRtlSubrow(subrow0, words, 0, wLen)) {
        const anchor = words[wLen - 1]._insertAnchor;
        anchor.parentNode.insertBefore(subrow0, anchor.nextSibling);
        subrows.push(subrow0);
      }

      vc._rtlInitialized = true;
      vc._rowStart = 0;
      vc._rowIdx = 0;
      vc._nextBreak = -1;
      vc._done = !isMeasured || wLen <= 1;
      if (!vc._done) pendingCount++;
      if (vc._parentLine) vc._parentLine._cachedSyllableElements = null;
    }

    while (pendingCount > 0) {
      let splitCount = 0;

      for (let i = 0; i < len; i++) {
        const vc = containers[i];
        if (!vc || vc._done) continue;

        const words = vc._rtlWords;
        const wLen = words.length;
        const rowStart = vc._rowStart;
        const baseWordTop = words[rowStart].offsetTop;

        let baseRomanTop = null;
        for (let w = rowStart; w < wLen; w++) {
          const spans = words[w]._romanSpans;
          if (spans && spans.length > 0) {
            baseRomanTop = spans[0].offsetTop;
            break;
          }
        }

        let breakW = -1;
        for (let w = rowStart + 1; w < wLen; w++) {
          if (Math.abs(words[w].offsetTop - baseWordTop) > 2) {
            breakW = w;
            break;
          }
          if (baseRomanTop !== null) {
            const spans = words[w]._romanSpans;
            if (spans && spans.length > 0) {
              const lastSp = spans[spans.length - 1];
              if (Math.abs(lastSp.offsetTop - baseRomanTop) > 2) {
                breakW = w;
                break;
              }
            }
          }
        }

        if (breakW !== -1) {
          vc._nextBreak = breakW;
          splitCount++;
        } else {
          vc._done = true;
          pendingCount--;
        }
      }

      if (splitCount === 0) break;

      for (let i = 0; i < len; i++) {
        const vc = containers[i];
        if (!vc || vc._nextBreak === -1) continue;

        const words = vc._rtlWords;
        const wLen = words.length;
        const rowStart = vc._rowStart;
        const breakW = vc._nextBreak;
        const r = vc._rowIdx;
        const pool = vc._rtlSubrowPool;
        const subrows = vc._rtlSubrows;

        const curSubrow = pool[r];
        curSubrow.remove();
        if (this._populateRtlSubrow(curSubrow, words, rowStart, breakW)) {
          const prevAnchor = words[breakW - 1]._insertAnchor;
          prevAnchor.parentNode.insertBefore(curSubrow, prevAnchor.nextSibling);
        }

        let nextSubrow = pool[r + 1];
        if (!nextSubrow) {
          nextSubrow = document.createElement("span");
          nextSubrow.className = vc._translitIsRtl
            ? "lyrics-romanization-container lyrics-romanization-subrow rtl-text"
            : "lyrics-romanization-container lyrics-romanization-subrow";
          pool[r + 1] = nextSubrow;
        }

        if (this._populateRtlSubrow(nextSubrow, words, breakW, wLen)) {
          const lastAnchor = words[wLen - 1]._insertAnchor;
          lastAnchor.parentNode.insertBefore(nextSubrow, lastAnchor.nextSibling);
          subrows.push(nextSubrow);
        }

        vc._rowStart = breakW;
        vc._rowIdx = r + 1;
        vc._nextBreak = -1;
        if (wLen - breakW <= 1) {
          vc._done = true;
          pendingCount--;
        }
      }
    }
  }

  /**
   * Syncs newly arrived romanizedText onto the initial raw syllabus objects
   * so existing word buffers on the DOM line have up-to-date romanization.
   * @private
   */
  _syncLineRomanizationData(parentLine, lineData) {
    if (!parentLine || !lineData) return;
    parentLine._rawLineData = lineData;
    const rawSyls = parentLine._rawSyllabus;
    const newSyls = this._getActiveSyllabus(lineData);
    if (rawSyls && Array.isArray(newSyls)) {
      const len = Math.min(rawSyls.length, newSyls.length);
      for (let i = 0; i < len; i++) {
        if (newSyls[i] && newSyls[i].romanizedText !== undefined) {
          rawSyls[i].romanizedText = newSyls[i].romanizedText;
        }
      }
      const lineContainer = parentLine._lineContainer;
      if (lineContainer) {
        const vcList = lineContainer.querySelectorAll(".main-vocal-container, .background-vocal-wrap");
        for (let v = 0; v < vcList.length; v++) {
          const words = vcList[v]._words;
          if (!words) continue;
          for (let w = 0; w < words.length; w++) {
            const buf = words[w]._wordSyllabus;
            if (!buf) continue;
            for (let k = 0; k < buf.length; k++) {
              const item = buf[k];
              const orig = item._origSyl || item;
              if (orig._parts) {
                const hasRom = orig._parts.some((p) => p.romanizedText);
                if (hasRom) {
                  orig.romanizedText = orig._parts.map((p) => p.romanizedText || p.text || "").join("");
                }
              } else if (orig._rawSylIdx !== undefined && newSyls[orig._rawSylIdx]) {
                orig.romanizedText = newSyls[orig._rawSylIdx].romanizedText;
              }
            }
          }
        }
      }
    }
  }

  /**
   * Removes previously built romanization DOM elements from a line container
   * when romanization settings/data change for the same song.
   * @private
   */
  _cleanupLineRomanization(lineElement) {
    if (!lineElement) return;
    const parentLine = lineElement.parentElement;
    if (lineElement._romanContainer) {
      lineElement._romanContainer.remove();
      lineElement._romanContainer = null;
    }
    const wraps = lineElement._wraps || lineElement.querySelectorAll(".lyrics-syllable-wrap");
    for (let i = 0; i < wraps.length; i++) {
      const wrap = wraps[i];
      wrap.classList.remove("has-translit", "has-translit-rtl");
      if (wrap.parentElement && wrap.parentElement.classList.contains("lyrics-word")) {
        wrap.parentElement.classList.remove("has-translit");
      }
      const trs = wrap.querySelectorAll(".lyrics-syllable.transliteration");
      for (let j = 0; j < trs.length; j++) {
        trs[j].remove();
      }
    }
    const subrows = lineElement.querySelectorAll(".lyrics-romanization-subrow");
    for (let i = 0; i < subrows.length; i++) {
      subrows[i].remove();
    }
    const vcList = lineElement.querySelectorAll(".main-vocal-container, .background-vocal-wrap");
    for (let i = 0; i < vcList.length; i++) {
      const vc = vcList[i];
      vc._rtlInitialized = false;
      if (vc._rtlSubrows) vc._rtlSubrows.length = 0;
      const idx = this._rtlVocalContainers ? this._rtlVocalContainers.indexOf(vc) : -1;
      if (idx !== -1) this._rtlVocalContainers.splice(idx, 1);
    }
    if (parentLine) {
      parentLine.classList.remove("has-rtl-row-roman");
      parentLine._cachedSyllableElements = Array.from(parentLine.querySelectorAll(".lyrics-syllable"));
      parentLine._maskPreMeasured = false;
      if (parentLine._maskAnimator) parentLine._maskAnimator.dispose();
    }
    lineElement._romanBuiltSig = null;
  }

  /**
   * Renders or updates the translation/romanization containers for a given lyric line in-place.
   * @param {HTMLElement} lineElement - The .lyrics-line-container element for the lyric line.
   * @param {object} lineData - The data object for the lyric line (from lyrics.data).
   * @param {string} displayMode - The current display mode ('none', 'translate', 'romanize', 'both').
   * @returns {{ builtRoman: boolean, builtTrans: boolean }}
   * @private
   */
  _renderTranslationContainer(lineElement, lineData, displayMode) {
    let builtRoman = false;
    let builtTrans = false;
    const parentLine = lineElement.parentElement;
    const activeSyllabus = this._getActiveSyllabus(lineData, displayMode);
    const activeLineText = this._getDataText(lineData, true);
    const isRTL = this._isRTL(activeLineText);
    const hasSyl = Array.isArray(activeSyllabus) && activeSyllabus.length > 0;

    if (displayMode === "romanize" || displayMode === "both") {
      const targetScript = (typeof currentSettings !== 'undefined' && currentSettings.transliterationTargetScript) || 'latin';
      const hasExplicitRomanText = !!(lineData.romanizedText && lineData.text && lineData.text.trim() !== lineData.romanizedText.trim());
      const hasPerSyllableTransliteration =
        hasSyl &&
        activeSyllabus.some(s => {
          const orig = (this._getDataText(s, true) || "").trim();
          const trans = (this._getDataText(s, false) || "").trim();
          return trans && orig && trans !== orig;
        });

      if (hasExplicitRomanText || hasPerSyllableTransliteration || targetScript !== 'latin' || !this._isPurelyLatinScript(activeLineText)) {
        const cachedWraps = lineElement._wraps;
        const isWordSynced = cachedWraps
          ? cachedWraps.length > 0
          : lineElement.querySelector(".lyrics-syllable-wrap") !== null;

        let romanSig = "";
        if (hasPerSyllableTransliteration && isWordSynced) {
          romanSig = "W:" + activeSyllabus.map(s => this._getDataText(s, false) || "").join("|");
        } else if (lineData.romanizedText && lineData.text.trim() !== lineData.romanizedText.trim()) {
          romanSig = "L:" + this._getDataText(lineData, false);
        }

        if (romanSig && lineElement._romanBuiltSig !== romanSig) {
          if (lineElement._romanBuiltSig) {
            this._cleanupLineRomanization(lineElement);
          }
          this._syncLineRomanizationData(parentLine, lineData);

          if (hasPerSyllableTransliteration && isWordSynced) {
            const translitIsRtl = activeSyllabus.some(s => {
              const trans = this._getDataText(s, false);
              return trans && this._isRTL(trans) && trans.trim() !== this._getDataText(s, true).trim();
            });

            if (isRTL || translitIsRtl) {
              const vocalContainers = lineElement.querySelectorAll(".main-vocal-container, .background-vocal-wrap");
              for (let vcIdx = 0; vcIdx < vocalContainers.length; vcIdx++) {
                const vc = vocalContainers[vcIdx];
                const words = vc._words || vc.querySelectorAll(".lyrics-word");
                const wLen = words.length;
                if (!wLen) continue;

                const isBg = vc.classList.contains("background-vocal-wrap");
                let hasAnyTranslit = false;
                let vcTranslitIsRtl = false;

                for (let wIdx = 0; wIdx < wLen; wIdx++) {
                  const wordEl = words[wIdx];
                  const rawBuf = wordEl._wordSyllabus;
                  if (!rawBuf || !rawBuf.length) continue;

                  const pEl = wordEl.parentElement;
                  let anchor = wordEl;
                  if (pEl && pEl !== vc && (pEl.classList.contains("bidi-rtl") || pEl.classList.contains("bidi-ltr"))) {
                    if (wordEl === pEl.lastElementChild) anchor = pEl;
                  }
                  if (anchor.nextSibling && anchor.nextSibling.nodeType === 3) {
                    anchor = anchor.nextSibling;
                  }
                  wordEl._insertAnchor = anchor;

                  const origSyls = [];
                  for (let k = 0; k < rawBuf.length; k++) {
                    const o = rawBuf[k]._origSyl || rawBuf[k];
                    if (origSyls[origSyls.length - 1] !== o) origSyls.push(o);
                  }

                  const mergedRoman = this._mergeJoiningSyllables(
                    origSyls,
                    (s) => this._getDataText(s, false)
                  );

                  const wordRomanSpans = [];
                  for (let mIdx = 0; mIdx < mergedRoman.length; mIdx++) {
                    const s = mergedRoman[mIdx];
                    let txt = this._getDataText(s, false);
                    if (!txt) continue;
                    if (isBg) txt = txt.replace(/[()]/g, "");
                    const origTxt = this._getDataText(s, true) || "";
                    if (currentSettings.hidePhoneticDup && txt.trim() === origTxt.trim()) continue;

                    const span = document.createElement("span");
                    span.className = "lyrics-syllable";
                    span.textContent = txt;
                    span._rawText = txt;
                    span._baseText = txt;
                    span._trimmedText = txt.replace(/\s+$/, "");
                    if (this._isRTL(txt)) {
                      span.classList.add("rtl-text");
                      vcTranslitIsRtl = true;
                    }

                    span._startTimeMs = s.time;
                    span._durationMs = s.duration;
                    span._endTimeMs = s.time + s.duration;
                    span._isFirstInContainer = true;
                    span._state = 0;
                    if (s._parts) span._segments = this._buildSegments(s, false, isBg);

                    wordRomanSpans.push(span);
                  }

                  if (wordRomanSpans.length > 0) {
                    wordEl._romanSpans = wordRomanSpans;
                    hasAnyTranslit = true;
                  }
                }

                if (hasAnyTranslit) {
                  vc.style.whiteSpace = "normal";
                  vc._rtlWords = words;
                  vc._translitIsRtl = vcTranslitIsRtl;
                  vc._parentLine = parentLine;
                  vc._rtlInitialized = false;
                  if (parentLine) {
                    parentLine.classList.add("has-rtl-row-roman");
                    parentLine.style.contentVisibility = "visible";
                  }
                  if (!this._rtlVocalContainers.includes(vc)) {
                    this._rtlVocalContainers.push(vc);
                  }
                  builtRoman = true;
                }
              }

            } else {
              const wraps = cachedWraps || Array.from(lineElement.querySelectorAll(".lyrics-syllable-wrap"));
              const lineSyllables = parentLine ? parentLine._cachedSyllableElements : null;

              for (let i = 0; i < activeSyllabus.length && i < wraps.length; i++) {
                const s = activeSyllabus[i];
                const wrap = wraps[i];
                const wrapContainer = wrap.parentElement?.parentElement;
                const isBackground = !!(wrapContainer && (
                  wrapContainer.classList.contains("background-vocal-container") ||
                  wrapContainer.classList.contains("background-vocal-wrap")
                ));

                const transTxt = ((isBackground ? this._getDataText(s, false).replace(/[()]/g, "") : (this._getDataText(s, false))) || "");
                if (!transTxt) continue;

                const tr = document.createElement("span");
                tr.className = "lyrics-syllable transliteration";
                if (this._isRTL(transTxt)) tr.classList.add("rtl-text");
                wrap.appendChild(tr);
                wrap.classList.add("has-translit");
                if (tr.classList.contains("rtl-text")) wrap.classList.add("has-translit-rtl");
                const wordEl = wrap.parentElement;
                if (wordEl && wordEl.classList.contains("lyrics-word")) wordEl.classList.add("has-translit");

                if (currentSettings.hidePhoneticDup && this._getDataText(s, false).trim() === this._getDataText(s, true).trim()) {
                  tr.classList.add("hidden");
                }

                tr.textContent = transTxt;
                tr._rawText = transTxt;
                tr.dataset.startTime = s.time;
                tr.dataset.duration = s.duration;
                tr.dataset.endTime = s.time + s.duration;
                tr._startTimeMs = s.time;
                tr._durationMs = s.duration;
                tr._endTimeMs = s.time + s.duration;
                tr._isFirstInContainer = true;
                tr._state = 0;
                tr._vocalContainer = isBackground
                  ? (wrapContainer.classList.contains("background-vocal-container") ? wrapContainer : wrapContainer.parentElement)
                  : wrapContainer;
                if (lineSyllables) lineSyllables.push(tr);
                builtRoman = true;
              }
            }

          } else if (lineData.romanizedText && lineData.text.trim() !== lineData.romanizedText.trim()) {
            const cont = document.createElement("div");
            cont.classList.add("lyrics-romanization-container");
            const romanText = this._getDataText(lineData, false);
            cont.textContent = romanText;
            cont._rawText = romanText;

            if (this._isRTL(romanText)) {
              cont.classList.add("rtl-text");
            }

            const transEl = lineElement._translationContainer;
            const bottomBg = parentLine?._bgWrap?.parentElement;
            if (transEl && transEl.parentElement === lineElement) {
              lineElement.insertBefore(cont, transEl);
            } else if (bottomBg && !bottomBg.classList.contains("onTop") && bottomBg.parentElement === lineElement) {
              lineElement.insertBefore(cont, bottomBg);
            } else {
              lineElement.appendChild(cont);
            }
            lineElement._romanContainer = cont;
            builtRoman = true;
          }

          lineElement._romanBuiltSig = romanSig;
          if (parentLine && builtRoman) {
            parentLine._maskPreMeasured = false;
            if (parentLine._maskAnimator) parentLine._maskAnimator.dispose();
          }
        }
      }
    }

    if (displayMode === "translate" || displayMode === "both") {
      if (this._isReplacementActive(lineData, displayMode)) {
        if (lineElement._translationContainer) {
          lineElement._translationContainer.remove();
          lineElement._translationContainer = null;
        }
      } else {
        if (lineData.translatedText) {
          if (!lineData._normText) lineData._normText = lineData.text.toLowerCase().replaceAll(' ', '').trim();
          if (!lineData._normTranslated) lineData._normTranslated = lineData.translatedText.toLowerCase().replaceAll(' ', '').trim();
        }
        if (lineData.translatedText && lineData._normText !== lineData._normTranslated) {
          let cont = lineElement._translationContainer;
          if (!cont) {
            cont = document.createElement("div");
            cont.classList.add("lyrics-translation-container");
            cont.textContent = lineData.translatedText;
            cont._rawText = lineData.translatedText;
            if (this._isRTL(lineData.translatedText)) {
              cont.classList.add("rtl-text");
            }
            const bottomBg = parentLine?._bgWrap?.parentElement;
            if (bottomBg && !bottomBg.classList.contains("onTop") && bottomBg.parentElement === lineElement) {
              lineElement.insertBefore(cont, bottomBg);
            } else {
              lineElement.appendChild(cont);
            }
            lineElement._translationContainer = cont;
            builtTrans = true;
          } else if (cont._rawText !== lineData.translatedText) {
            cont.textContent = lineData.translatedText;
            cont._rawText = lineData.translatedText;
            cont.classList.toggle("rtl-text", this._isRTL(lineData.translatedText));
            builtTrans = true;
          }
        }
      }
    }

    return { builtRoman, builtTrans };
  }

  /**
   * Builds the writers/source metadata block shared by all render paths.
   * Uses textContent/DOM nodes only (no innerHTML interpolation).
   * @param {object} lyrics
   * @param {boolean} timed - attach start/end times so it takes part in sync.
   */
  _createMetadataContainer(lyrics, timed) {
    const metadataContainer = document.createElement("div");
    metadataContainer.className = "lyrics-plus-metadata";
    metadataContainer._bgWrap = null;
    metadataContainer._cachedSyllableElements = [];

    if (timed) {
      const lastEnd = lyrics.data[lyrics.data.length - 1]?.endTime;
      if (lastEnd != 0) {
        const startSec = (lastEnd || 0) + 0.8;
        const endSec = (lastEnd || 0) + 99999999999999;
        metadataContainer.dataset.startTime = startSec;
        metadataContainer.dataset.endTime = endSec;
        metadataContainer._startTimeMs = startSec * 1000;
        metadataContainer._endTimeMs = endSec * 1000;
      } else {
        metadataContainer._startTimeMs = NaN;
        metadataContainer._endTimeMs = NaN;
      }
    }

    const writers = lyrics.metadata?.songWriters;
    if (writers && writers.length > 0) {
      const songWritersDiv = document.createElement("span");
      songWritersDiv.className = "lyrics-song-writters";
      const label = document.createElement("b");
      label.textContent = t("writtenBy");
      songWritersDiv.append(label, document.createTextNode(" " + writers.join(", ")));
      metadataContainer.appendChild(songWritersDiv);
    }
    if (lyrics.metadata?.source && (lyrics.metadata?.sourceUrl || isValidLyricsSource(lyrics.metadata?.source, this.currentSettings, lyrics))) {
      const sourceDiv = document.createElement("span");
      sourceDiv.className = "lyrics-source-provider";

      const sourceLabel = t("source") || "Lyrics provided by: ";
      sourceDiv.appendChild(document.createTextNode(sourceLabel));

      const sourceName = lyrics.metadata.source;
      const sourceUrl = lyrics.metadata?.sourceUrl || lyrics.metadata?.url;

      if (sourceUrl) {
        const sourceLink = document.createElement("a");
        sourceLink.href = sourceUrl;
        sourceLink.target = "_blank";
        sourceLink.rel = "noopener noreferrer";
        sourceLink.textContent = sourceName;
        sourceLink.style.color = "inherit";
        sourceLink.style.textDecoration = "none";
        sourceLink.style.cursor = "pointer";
        sourceLink.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          window.open(sourceUrl, "_blank", "noopener,noreferrer");
        });
        sourceDiv.appendChild(sourceLink);
      } else {
        sourceDiv.appendChild(document.createTextNode(sourceName));
      }

      const curator = lyrics.metadata?.curator || lyrics.metadata?.submitter;
      const curatorName = typeof curator === "string"
        ? curator
        : (typeof curator === "object" && curator ? (curator.displayName || curator.name) : null);

      if (curatorName) {
        const syncedPrefix = t("syncedBy") || "Synced by ";
        sourceDiv.appendChild(document.createTextNode(` (${syncedPrefix}`));

        const curatorUrl = lyrics.metadata?.curatorUrl || (typeof curator === "object" ? curator?.url : null);
        if (curatorUrl) {
          const curatorLink = document.createElement("a");
          curatorLink.href = curatorUrl;
          curatorLink.target = "_blank";
          curatorLink.rel = "noopener noreferrer";
          curatorLink.textContent = curatorName;
          curatorLink.style.color = "inherit";
          curatorLink.style.textDecoration = "none";
          curatorLink.style.cursor = "pointer";
          curatorLink.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.open(curatorUrl, "_blank", "noopener,noreferrer");
          });
          sourceDiv.appendChild(curatorLink);
        } else {
          sourceDiv.appendChild(document.createTextNode(curatorName));
        }

        sourceDiv.appendChild(document.createTextNode(")"));
      }

      metadataContainer.appendChild(sourceDiv);
    }
    return metadataContainer;
  }

  _createTrailingSpacers() {
    const emptyDiv = document.createElement("div");
    emptyDiv.className = "lyrics-plus-empty";
    const emptyFixedDiv = document.createElement("div");
    emptyFixedDiv.className = "lyrics-plus-empty-fixed";
    return [emptyDiv, emptyFixedDiv];
  }

  /**
   * Applies palette-related CSS classes and custom properties to the container
   * based on the current settings. Called from both displayLyrics and updateDisplayMode.
   * @param {HTMLElement} container - The lyrics container element.
   * @param {object} currentSettings - The current user settings.
   * @private
   */
  _applyPaletteSettings(container, currentSettings) {
    const prevBgWipe = container.classList.contains("use-background-wipe");

    if (currentSettings.overridePaletteColor) {
      container.classList.add("override-palette-color");
      container.style.setProperty(
        "--lyplus-override-pallete",
        currentSettings.overridePaletteColor
      );
      container.classList.remove(
        "use-song-palette-fullscreen",
        "use-song-palette-all-modes"
      );
    } else {
      container.classList.remove("override-palette-color");
      container.classList.toggle(
        "use-song-palette-fullscreen",
        !!currentSettings.useSongPaletteFullscreen
      );
      container.classList.toggle(
        "use-song-palette-all-modes",
        !!currentSettings.useSongPaletteAllModes
      );
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
          }
        }
      }
    }
    const patchParent = container.parentElement;
    if (patchParent && patchParent.id === "lyplus-patch-container") {
      patchParent.classList.toggle("override-palette-color", container.classList.contains("override-palette-color"));
      patchParent.classList.toggle("use-song-palette-fullscreen", container.classList.contains("use-song-palette-fullscreen"));
      patchParent.classList.toggle("use-song-palette-all-modes", container.classList.contains("use-song-palette-all-modes"));
    }

    const isBgWipe = this._isBackgroundWipeEnabled(container);
    container.classList.toggle("use-background-wipe", isBgWipe);

    if (prevBgWipe !== isBgWipe) {
      this._invalidateMaskAnimators();
    }
  }

  _isBackgroundWipeEnabled(container) {
    if (!container) return false;
    return (
      container.classList.contains("override-palette-color") ||
      container.classList.contains("use-song-palette-all-modes") ||
      container.classList.contains("use-song-palette-fullscreen") ||
      container.classList.contains("use-background-wipe")
    );
  }

  _getSongRenderKey(songInfo) {
    if (!songInfo) return "";
    return `${songInfo.videoId || ""}|${songInfo.title || ""}|${songInfo.artist || ""}|${songInfo.album || ""}`;
  }

  _hasAnyRomanizationData(lyrics) {
    if (!lyrics || !Array.isArray(lyrics.data)) return false;
    for (let i = 0; i < lyrics.data.length; i++) {
      const line = lyrics.data[i];
      if (line.romanizedText) return true;
      if (Array.isArray(line.syllabus)) {
        for (let j = 0; j < line.syllabus.length; j++) {
          if (line.syllabus[j].romanizedText) return true;
        }
      }
    }
    return false;
  }

  _hasAnyReplacementData(lyrics) {
    return false;
  }

  _canUpdateInPlace(lyrics, currentSettings, displayMode = this.currentDisplayMode) {
    const state = this._renderedState;
    const lines = this._renderedLyricLines;
    if (!state || !lines || !lyrics || !Array.isArray(lyrics.data)) return false;
    if (lines.length === 0 || lines.length !== lyrics.data.length) return false;
    if (!this.lyricsContainer || !lines[0].isConnected || !this.lyricsContainer.contains(lines[0])) return false;
    if (this.lyricsContainer.classList.contains("lyrics-plus-message") || this.lyricsContainer.classList.contains("plain-text-mode")) return false;

    const isWordByWordMode = lyrics.type === "Word" && !!currentSettings.wordByWord;
    const provider = lyrics.provider || lyrics.metadata?.provider || lyrics.metadata?.source || "";
    const targetScript = (currentSettings && currentSettings.transliterationTargetScript) || "latin";
    const mainUsedRoman = this.largerTextMode === "romanization" && this._hasAnyRomanizationData(lyrics);
    const mainUsedReplacement = (displayMode === "translate" || displayMode === "both") && this._hasAnyReplacementData(lyrics);

    if (
      state.songKey !== this._getSongRenderKey(this.lastKnownSongInfo) ||
      state.provider !== provider ||
      state.isWordByWordMode !== isWordByWordMode ||
      state.largerTextMode !== this.largerTextMode ||
      state.lightweight !== !!currentSettings.lightweight ||
      state.bkgOverlap !== !!currentSettings.bkgOverlap ||
      state.hidePhoneticDup !== !!currentSettings.hidePhoneticDup ||
      state.targetScript !== targetScript ||
      state.mainUsedRoman !== mainUsedRoman ||
      state.mainUsedReplacement !== mainUsedReplacement
    ) {
      return false;
    }

    for (let i = 0; i < lines.length; i++) {
      const domLine = lines[i];
      const lineData = lyrics.data[i];
      const startMs = parseFloat(lineData.startTime) * 1000;
      const endMs = parseFloat(lineData.endTime) * 1000;
      if (Math.abs(domLine._startTimeMs - startMs) > 1 || Math.abs(domLine._endTimeMs - endMs) > 1) {
        return false;
      }
    }

    return true;
  }

  /**
   * Updates translation and romanization in-place without recreating the container or lyric lines.
   * Translation/romanization layout appears/disappears directly (no transition on the subtext),
   * while the lyric lines smoothly slide (FLIP) into their new positions.
   * @private
   */
  _updateDisplayModeInPlace(lyrics, displayMode, currentSettings) {
    const container = this._getContainer();
    if (!container) return;

    const prevMode = this.currentDisplayMode || "none";
    this.currentDisplayMode = displayMode;

    const prevShowTrans = prevMode === "translate" || prevMode === "both";
    const prevShowRoman = prevMode === "romanize" || prevMode === "both";
    const nextShowTrans = displayMode === "translate" || displayMode === "both";
    const nextShowRoman = displayMode === "romanize" || displayMode === "both";

    const renderedLines = this._renderedLyricLines;
    const allTimedLines = this.cachedLyricsLines || [];
    const scroller = container.parentElement;
    const canAnimate =
      typeof Element.prototype.animate === "function" &&
      container.offsetWidth > 0 &&
      container.offsetHeight > 0;

    // 1. Capture visible line positions & anchor line before DOM/class changes
    let visMin = Infinity;
    let visMax = -1;
    if (this.visibleLineIds && this.visibleLineIds.size > 0 && this._lineById) {
      for (const id of this.visibleLineIds) {
        const idx = this._lineById.get(id)?._idx;
        if (idx !== undefined) {
          if (idx < visMin) visMin = idx;
          if (idx > visMax) visMax = idx;
        }
      }
    }
    if (visMax < 0 && allTimedLines.length > 0) {
      const center = Math.max(0, this._lastActiveIndex || 0);
      visMin = Math.max(0, center - 4);
      visMax = Math.min(allTimedLines.length - 1, center + 6);
    }
    const lo = visMax >= 0 ? Math.max(0, visMin - 2) : 0;
    const hi = visMax >= 0 ? Math.min(allTimedLines.length - 1, visMax + 4) : -1;

    let anchorLine = null;
    if (!this.isUserControllingScroll && this.currentPrimaryActiveLine) {
      anchorLine = this.currentPrimaryActiveLine;
    } else if (visMin < allTimedLines.length) {
      anchorLine = allTimedLines[visMin] || this.currentPrimaryActiveLine || allTimedLines[0];
    }

    const scrollTopBefore = scroller ? scroller.scrollTop : 0;
    const anchorTopBefore = canAnimate && anchorLine ? anchorLine.offsetTop : null;

    const snapshotLines = [];
    if (canAnimate && hi >= lo) {
      for (let i = lo; i <= hi; i++) {
        const line = allTimedLines[i];
        if (!line) continue;
        snapshotLines.push({
          line,
          topBefore: line.offsetTop
        });
      }
    }

    // 2. Patch new translation/romanization data into existing line DOM elements
    let anyBuiltRoman = false;
    let anyBuiltTrans = false;
    for (let i = 0; i < renderedLines.length; i++) {
      const lineEl = renderedLines[i];
      const lineData = lyrics.data[i];
      if (!lineEl || !lineData || !lineEl._lineContainer) continue;
      lineEl._rawLineData = lineData;
      const { builtRoman, builtTrans } = this._renderTranslationContainer(
        lineEl._lineContainer,
        lineData,
        displayMode
      );
      if (builtRoman) anyBuiltRoman = true;
      if (builtTrans) anyBuiltTrans = true;
    }

    // 3. Apply display mode classes (translation/romanization layout shows/hides directly)
    this._applyDisplayModeClasses(container, displayMode);
    this._applyPaletteSettings(container, currentSettings);
    container.classList.toggle("blur-inactive-enabled", !!currentSettings.blurInactive);

    if (nextShowRoman && this._rtlVocalContainers && this._rtlVocalContainers.length > 0) {
      this._layoutAllRtlVisualRowRomanizations();
    }

    // 4. Refresh syllable cache and mask animators when romanization state changes
    if (anyBuiltRoman || prevShowRoman !== nextShowRoman) {
      const allSyllables = [];
      for (let i = 0; i < allTimedLines.length; i++) {
        const l = allTimedLines[i];
        let syls = l._cachedSyllableElements;
        if (!syls) {
          syls = Array.from(l.querySelectorAll(".lyrics-syllable"));
          l._cachedSyllableElements = syls;
        }
        for (let j = 0; j < syls.length; j++) {
          allSyllables.push(syls[j]);
        }
      }
      this.cachedSyllables = allSyllables;
      this._invalidateMaskAnimators(true);
    }

    // 5. Compensate scrollTop so anchor line stays pinned, and slide lines (FLIP) into their new positions
    const layoutChanged =
      prevShowTrans !== nextShowTrans ||
      prevShowRoman !== nextShowRoman ||
      (nextShowTrans && anyBuiltTrans) ||
      (nextShowRoman && anyBuiltRoman);

    if (canAnimate && layoutChanged) {
      const anchorTopAfter = anchorLine ? anchorLine.offsetTop : null;
      if (scroller && anchorTopBefore !== null && anchorTopAfter !== null) {
        const anchorDelta = anchorTopAfter - anchorTopBefore;
        if (Math.abs(anchorDelta) >= 0.5) {
          const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          const nextScrollTop = Math.min(maxScroll, Math.max(0, scrollTopBefore + anchorDelta));
          scroller.scrollTo({ top: nextScrollTop, behavior: "instant" });
          const applied = nextScrollTop - scrollTopBefore;
          this.currentScrollOffset = -nextScrollTop;
          const st = this._scrollAnimationState;
          if (st && st.pendingUpdate !== null) st.pendingUpdate -= applied;
        }
      }

      const scrollTopAfter = scroller ? scroller.scrollTop : 0;
      const ms = this._lastScrollDurationMs || 400;
      const easing = this._appliedScrollEasing || "cubic-bezier(.41, 0, .12, .99)";
      const userScrolling = container.classList.contains("user-scrolling");
      const elapsed = performance.now() - (this._scrollAnimT0 || -1e9);

      for (let i = 0; i < snapshotLines.length; i++) {
        const item = snapshotLines[i];
        const line = item.line;
        const dy = (item.topBefore - scrollTopBefore) - (line.offsetTop - scrollTopAfter);
        const delay = (!userScrolling && line._scrollAnim)
          ? Math.max(0, (line._scrollDelay || 0) - elapsed)
          : 0;
        LyricsPlusRenderer._flipTranslateY(line, dy, ms, easing, delay);
      }
    }

    // 6. Re-sync active syllable mask animations at current playback time
    const currentTime = (this._getCurrentPlayerTime() - this.offsetLatency) * 1000 - (this.userOffsetMs || 0);
    if (this._tempActiveLines && this._tempActiveLines.length > 0) {
      this._updateSyllables(currentTime, this._tempActiveLines);
    }

    if (this.dropdownMenu && !this.dropdownMenu.classList.contains("hidden")) {
      this._createDropdownMenu(this.buttonsWrapper);
    }
  }

  /**
   * Updates the display of lyrics based on a new display mode (translation/romanization).
   * Updates in-place when the base lyrics for the current song are already rendered.
   * @param {object} lyrics - The lyrics data object.
   * @param {string} displayMode - The new display mode ('none', 'translate', 'romanize', 'both').
   * @param {object} currentSettings - The current user settings.
   */
  updateDisplayMode(lyrics, displayMode, currentSettings) {
    if (this._canUpdateInPlace(lyrics, currentSettings, displayMode)) {
      this._updateDisplayModeInPlace(lyrics, displayMode, currentSettings);
      return;
    }

    this.currentDisplayMode = displayMode;
    const container = this._getContainer();
    if (!container) return;

    // Pre-warm style/layout caches BEFORE mutating any classes on container
    this._getContainerFont();
    this._getScrollPaddingTop();
    if (!this._springConfigCache) this._springConfigCache = this._resolveSpringConfig();
    this._getElevationConfig();
    if (this._containerDisplayCache === undefined) {
      this._containerDisplayCache = getComputedStyle(container).display;
    }

    this._rtlVocalContainers = [];
    this._trackStyleCache.clear();
    this._cachedGapHeight = 0;

    // 1. Batch all container class/style updates before building or mounting children
    this._applyDisplayModeClasses(container, displayMode);
    this._applyPaletteSettings(container, currentSettings);

    container.classList.toggle(
      "fullscreen",
      document.body.hasAttribute("player-fullscreened_")
    );

    const isWordByWordMode = lyrics.type === "Word" && currentSettings.wordByWord;
    container.classList.toggle("word-by-word-mode", isWordByWordMode);
    container.classList.toggle("line-by-line-mode", !isWordByWordMode);
    container.classList.toggle(
      "blur-inactive-enabled",
      !!currentSettings.blurInactive
    );

    // Re-determine text direction & singer side assignments before DOM creation
    let hasRTL = false,
      hasLTR = false;
    if (lyrics && lyrics.data && lyrics.data.length > 0) {
      for (const line of lyrics.data) {
        if (this._isRTL(line.text)) hasRTL = true;
        else hasLTR = true;
        if (hasRTL && hasLTR) break;
      }
    }
    container.classList.toggle("mixed-direction-lyrics", !!(hasRTL && hasLTR));

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
          const type = agentData
            ? agentData.type
            : (singerId === "v1000" ? "group" : (singerId === "v2000" ? "other" : "person"));

          if (type === "group") {
            sideClass = "singer-left";
          } else {
            if (lastPersonSingerId === null) {
              currentSideIsLeft = type !== "other";
            } else if (singerId !== lastPersonSingerId) {
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

      if (totalCount > 0 && Math.round((rightCount / totalCount) * 100) >= 85) {
        const flip = (s) => s === "singer-left" ? "singer-right" : (s === "singer-right" ? "singer-left" : s);

        for (let i = 0; i < lineSideAssignments.length; i++) {
          lineSideAssignments[i] = flip(lineSideAssignments[i]);
        }

        for (const id in singerClassMap) {
          singerClassMap[id] = flip(singerClassMap[id]);
        }
      }

      let leftCount = 0, rightSideCount = 0;
      for (let i = 0; i < lineSideAssignments.length; i++) {
        const side = lineSideAssignments[i];
        if (side === "singer-left") leftCount++;
        else if (side === "singer-right") rightSideCount++;
      }
      const totalSideLines = leftCount + rightSideCount;
      const leftRatio = totalSideLines > 0 ? (leftCount / totalSideLines) * 100 : 0;

      isDualSide = leftCount > 0 && rightSideCount > 0 && leftRatio <= 90;
    }

    container.classList.toggle("dual-side-lyrics", isDualSide);

    const gapEndLead = 0.5;

    const createGapLine = (gapStart, gapEnd, classesToInherit = null) => {
      const gapDuration = gapEnd - gapStart;
      const gapLine = document.createElement("div");
      gapLine.className = "lyrics-line lyrics-gap";
      gapLine._isGap = true;
      gapLine._bgWrap = null;
      gapLine.dataset.startTime = gapStart;
      gapLine.dataset.endTime = gapEnd;
      gapLine._startTimeMs = gapStart * 1000;
      gapLine._endTimeMs = gapEnd * 1000;
      if (classesToInherit) {
        if (classesToInherit.includes("rtl-text"))
          gapLine.classList.add("rtl-text");
        if (classesToInherit.includes("singer-left"))
          gapLine.classList.add("singer-left");
        if (classesToInherit.includes("singer-right"))
          gapLine.classList.add("singer-right");
      }
      const mainContainer = document.createElement("div");
      mainContainer.className = "main-vocal-container";
      const lyricsWord = document.createElement("div");
      lyricsWord.className = "lyrics-word";
      const gapSyllables = [];
      for (let i = 0; i < 3; i++) {
        const syllableSpan = document.createElement("span");
        syllableSpan.className = "lyrics-syllable";

        const segmentDurationMs = (gapDuration / 3) * 1000;
        const syllableDuration = segmentDurationMs * 0.7;
        const gapPadding = segmentDurationMs * 0.3;
        const syllableStart = (gapStart * 1000) + (i * segmentDurationMs) + gapPadding;

        syllableSpan.dataset.startTime = syllableStart;
        syllableSpan.dataset.duration = syllableDuration;
        syllableSpan.dataset.endTime = syllableStart + syllableDuration;
        syllableSpan._startTimeMs = syllableStart;
        syllableSpan._durationMs = syllableDuration;
        syllableSpan._endTimeMs = syllableStart + syllableDuration;
        syllableSpan._isGap = true;
        syllableSpan._isGrowable = false;
        syllableSpan._syllableIdx = i;
        syllableSpan._state = 0;

        syllableSpan.textContent = "•";
        syllableSpan._rawText = "•";
        syllableSpan.style.setProperty("--lyplus-gap-duration", `${syllableDuration || 1000}ms`);
        lyricsWord.appendChild(syllableSpan);
        gapSyllables.push(syllableSpan);
      }
      gapLine._cachedSyllableElements = gapSyllables;
      mainContainer.appendChild(lyricsWord);
      gapLine.appendChild(mainContainer);
      return gapLine;
    };

    // 2. Build all lines inside a detached DocumentFragment with final singer classes already applied
    const linesFragment = document.createDocumentFragment();

    if (isWordByWordMode) {
      this._renderWordByWordLyrics(
        lyrics,
        displayMode,
        singerClassMap,
        linesFragment,
        lineSideAssignments
      );
    } else {
      this._renderLineByLineLyrics(
        lyrics,
        displayMode,
        singerClassMap,
        linesFragment,
        lineSideAssignments
      );
    }

    // 3. Assemble final fragment with gap lines, metadata, and trailing spacers in memory before mounting
    const originalLines = Array.from(linesFragment.childNodes);
    this._renderedLyricLines = originalLines;
    this._renderedState = {
      songKey: this._getSongRenderKey(this.lastKnownSongInfo),
      provider: lyrics.provider || lyrics.metadata?.provider || lyrics.metadata?.source || "",
      isWordByWordMode,
      largerTextMode: this.largerTextMode,
      lightweight: !!currentSettings.lightweight,
      bkgOverlap: !!currentSettings.bkgOverlap,
      hidePhoneticDup: !!currentSettings.hidePhoneticDup,
      targetScript: (currentSettings && currentSettings.transliterationTargetScript) || "latin",
      mainUsedRoman: this.largerTextMode === "romanization" && this._hasAnyRomanizationData(lyrics),
      mainUsedReplacement: (displayMode === "translate" || displayMode === "both") && this._hasAnyReplacementData(lyrics)
    };
    const finalFragment = document.createDocumentFragment();
    const allTimedLines = [];

    const getInheritedGapClasses = (el) => {
      const out = [];
      if (el.classList.contains("rtl-text")) out.push("rtl-text");
      if (el.classList.contains("singer-left")) out.push("singer-left");
      if (el.classList.contains("singer-right")) out.push("singer-right");
      return out;
    };

    if (originalLines.length > 0) {
      const firstLine = originalLines[0];
      const firstStartTime = firstLine._startTimeMs / 1000;
      if (firstStartTime >= 7.0) {
        const gapLine = createGapLine(0, firstStartTime - gapEndLead, getInheritedGapClasses(firstLine));
        finalFragment.appendChild(gapLine);
        allTimedLines.push(gapLine);
      }
    }

    for (let index = 0; index < originalLines.length; index++) {
      const line = originalLines[index];
      finalFragment.appendChild(line);
      allTimedLines.push(line);

      if (index < originalLines.length - 1) {
        const nextLine = originalLines[index + 1];
        const curEndSec = line._endTimeMs / 1000;
        const nextStartSec = nextLine._startTimeMs / 1000;
        if (nextStartSec - curEndSec >= 7.0) {
          const gapLine = createGapLine(
            curEndSec + 0.31,
            nextStartSec - gapEndLead,
            getInheritedGapClasses(nextLine)
          );
          finalFragment.appendChild(gapLine);
          allTimedLines.push(gapLine);
        }
      }
    }

    const metadataEl = this._createMetadataContainer(lyrics, true);
    finalFragment.appendChild(metadataEl);
    allTimedLines.push(metadataEl);
    finalFragment.append(...this._createTrailingSpacers());

    // Stamp IDs & indices while still in memory
    this.cachedLyricsLines = allTimedLines;
    this._lineById = new Map();
    for (let i = 0; i < allTimedLines.length; i++) {
      const l = allTimedLines[i];
      if (!l.id) l.id = `line-${i}`;
      l._idx = i;
      this._lineById.set(l.id, l);
    }

    this._initMaskResizeObserver();
    this.activeLineIds.clear();
    this.visibleLineIds.clear();
    this.currentPrimaryActiveLine = null;
    this._suggestedLineOffsetMs = -500;
    this._appleScrollDurationMs = 750;
    this._scrollGapT = null;
    if (this._activeLineIndices) this._activeLineIndices.length = 0;
    if (this._prevActiveLineIndices) this._prevActiveLineIndices.length = 0;
    this._lastActiveGroupEndIndex = 0;
    this._positionClassedLines.length = 0;
    this._nextPositionClassedLines.length = 0;
    this._lastPastLineIndex = -1;
    this._resetGapState();

    // Pre-apply initial gap-open class in detached fragment before mounting to avoid post-mount reflow
    let initialActiveIndex = 0;
    let currentTime = 0;
    if (allTimedLines.length > 0) {
      currentTime = (this._getCurrentPlayerTime() - this.offsetLatency) * 1000 - (this.userOffsetMs || 0);
      const predictiveTime = currentTime - this._suggestedLineOffsetMs;
      initialActiveIndex = this._getLineIndexAtTime(predictiveTime);
      if (initialActiveIndex === -1) initialActiveIndex = 0;
      const initialActiveLine = allTimedLines[initialActiveIndex];
      if (initialActiveLine && initialActiveLine._isGap) {
        initialActiveLine.classList.add("gap-open");
        this._openGaps.add(initialActiveLine);
      }
    }

    // Single atomic DOM replacement
    container.replaceChildren(finalFragment);

    this._lastContainerWidth = container.clientWidth || 0;
    this._lastContainerFont = this._getContainerFont();
    if (this._rtlVocalContainers.length > 0) {
      this._layoutAllRtlVisualRowRomanizations();
    }

    // Collect cachedSyllables and cache initial gap height while layout is already clean
    const allSyllables = [];
    for (let i = 0; i < allTimedLines.length; i++) {
      const l = allTimedLines[i];
      if (l._isGap && this._cachedGapHeight === 0 && l.classList.contains("gap-open")) {
        const h = l.offsetHeight;
        if (h > 0) this._cachedGapHeight = h;
      }
      let syls = l._cachedSyllableElements;
      if (!syls) {
        syls = Array.from(l.querySelectorAll(".lyrics-syllable"));
        l._cachedSyllableElements = syls;
      }
      for (let j = 0; j < syls.length; j++) {
        allSyllables.push(syls[j]);
      }
    }
    this.cachedSyllables = allSyllables;

    if (this.cachedLyricsLines.length > 0) {
      const activeLine = this.cachedLyricsLines[initialActiveIndex];
      this.currentPrimaryActiveLine = activeLine;
      this.lastPrimaryActiveLine = activeLine;
      this._lastActiveIndex = initialActiveIndex;
      this._lastActiveGroupEndIndex = initialActiveIndex;
      this._updateLyricsHighlight(currentTime, true, currentSettings);
    }

    this._startLyricsSync(currentSettings);
  }

  /**
   * Sets the user offset in milliseconds.
   * @param {number} offsetMs
   */
  setUserOffset(offsetMs) {
    if (typeof offsetMs === "number") {
      this.userOffsetMs = Math.round(offsetMs / 10) * 10;
      this._updateOffsetDisplay();
      if (this.cachedLyricsLines && this.cachedLyricsLines.length > 0) {
        const currentTime = (this._getCurrentPlayerTime() - this.offsetLatency) * 1000 - this.userOffsetMs;
        this._updateLyricsHighlight(currentTime, false);
      }
    }
  }

  /**
   * Main entry point to display lyrics.
   * Renders the UI and starts synchronization.
   *
   * @param {object} lyrics - The lyrics data object (type, data, metadata).
   * @param {object} songInfo - Information about the currently playing song.
   * @param {string} displayMode - The current display mode ('none', 'translate', 'romanize').
   * @param {object} currentSettings - The current user settings.
   * @param {Function} fetchAndDisplayLyricsFn - The function to fetch and display lyrics.
   * @param {Function} setCurrentDisplayModeAndRefetchFn - The function to set display mode and refetch.
   * @param {string} largerTextMode - Which text to enlarge.
   * @param {number} offsetLatency - Audio context output latency.
   * @param {Function} switchLyricsProviderFn - Function to switch lyrics provider.
   * @param {Function} saveLyricsOffsetFn - Function to persist lyrics offset.
   * @param {Function} getProviderContextFn - Function to resolve provider options context.
   * @param {number} userOffsetMs - Initial user offset in milliseconds.
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
    switchLyricsProviderFn = null,
    saveLyricsOffsetFn = null,
    getProviderContextFn = null,
    userOffsetMs = 0
  ) {
    if (this.lastKnownSongInfo && songInfo && (this.lastKnownSongInfo.title !== songInfo.title || this.lastKnownSongInfo.artist !== songInfo.artist || this.lastKnownSongInfo.album !== songInfo.album)) {
      this._userSelectedProvider = null;
      if (this.availableProviders) this.availableProviders.clear();
      if (this._notFoundProviders) this._notFoundProviders.clear();
    }
    if (!this.availableProviders) this.availableProviders = new Set();
    if (!this._notFoundProviders) this._notFoundProviders = new Set();
    this.currentLyrics = lyrics;
    this.currentLyricsType = lyrics?.type;
    if (lyrics?.provider) {
      this._userSelectedProvider = lyrics.provider;
      this.availableProviders.add(lyrics.provider.toLowerCase());
    }
    this.lastKnownSongInfo = songInfo;
    this.currentSettings = currentSettings;
    this.fetchAndDisplayLyricsFn = fetchAndDisplayLyricsFn;
    this.setCurrentDisplayModeAndRefetchFn = setCurrentDisplayModeAndRefetchFn;
    this.largerTextMode = largerTextMode;
    this.offsetLatency = offsetLatency;
    if (switchLyricsProviderFn) {
      this.switchLyricsProviderFn = switchLyricsProviderFn;
    }
    this.saveLyricsOffsetFn = saveLyricsOffsetFn;
    this.getProviderContextFn = getProviderContextFn;
    if (typeof userOffsetMs === "number") {
      this.userOffsetMs = userOffsetMs;
      this._updateOffsetDisplay();
    }

    this.setTranslationLoading(false);

    const container = this._getContainer();
    if (!container) return;

    // Pre-warm style/layout caches BEFORE mutating any classes on container
    this._getContainerFont();
    this._getScrollPaddingTop();
    if (!this._springConfigCache) this._springConfigCache = this._resolveSpringConfig();
    this._getElevationConfig();
    if (this._containerDisplayCache === undefined) {
      this._containerDisplayCache = getComputedStyle(container).display;
    }

    const isPlainLyrics = lyrics.type === "None";
    const isWordByWordMode = !isPlainLyrics && (lyrics.type === "Word") && currentSettings.wordByWord;
    const isLineByLineMode = !isPlainLyrics && !isWordByWordMode;

    // Batch all container class updates upfront
    container.classList.remove("lyrics-plus-message");
    container.classList.toggle("lightweight-mode", !!currentSettings.lightweight);
    container.classList.toggle("fullscreen", document.body.hasAttribute("player-fullscreened_"));
    container.classList.toggle("plain-text-mode", isPlainLyrics);
    container.classList.toggle("word-by-word-mode", isWordByWordMode);
    container.classList.toggle("line-by-line-mode", isLineByLineMode);
    container.classList.toggle("romanized-big-mode", largerTextMode != "lyrics");
    container.classList.toggle("blur-inactive-enabled", !!currentSettings.blurInactive);
    container.classList.toggle("hide-offscreen", !!currentSettings.hideOffscreen);
    container.classList.toggle("relax-scroll", !!currentSettings.relaxScroll);

    this._applyPaletteSettings(container, currentSettings);

    if (!isPlainLyrics) {
      this.updateDisplayMode(lyrics, displayMode, currentSettings);
    } else {
      const fragment = document.createDocumentFragment();
      fragment.appendChild(this._createMetadataContainer(lyrics, false));
      this._renderPlainLyrics(lyrics, fragment);
      const [emptyDiv, emptyFixedDiv] = this._createTrailingSpacers();
      fragment.append(emptyDiv, emptyFixedDiv);
      container.replaceChildren(fragment);

      this._renderedState = null;
      this._renderedLyricLines = null;
      this.cachedLyricsLines = [];
      this.cachedSyllables = [];
      this.activeLineIds.clear();
      if (this._activeLineIndices) this._activeLineIndices.length = 0;
      if (this._prevActiveLineIndices) this._prevActiveLineIndices.length = 0;
      this.visibleLineIds.clear();
      this._lineById = new Map();
    }

    this._createControlButtons();
    this._updateWakeLock();
    if (this.pipWindow && !this.pipWindow.closed) {
      this._renderPictureInPictureContent();
    }
  }

  /**
   * Sets the loading state of the translation button.
   * @param {boolean} active - Whether the loading state is active.
   */
  setTranslationLoading(active) {
    if (!this.translationButton) return;

    if (active) {
      this.translationButton.classList.add("loading");
      this.translationButton.innerHTML = '<div class="loading-loop-m3 small"></div>';
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
      container.classList.add("lyrics-plus-message");
      container.innerHTML = `<span class="text-not-found">${t(i18nKey)}</span>`;
    }
  }

  /**
   * Displays a "not found" message in the lyrics container.
   */
  displaySongNotFound(songInfo = null) {
    if (songInfo) {
      this.lastKnownSongInfo = songInfo;
    }
    this._displayMessage("notFound");
  }

  /**
   * Displays an error message in the lyrics container.
   */
  displaySongError(songInfo = null) {
    if (songInfo) {
      this.lastKnownSongInfo = songInfo;
    }
    this._displayMessage("notFoundError");
  }

  /**
   * Gets a reference to the player element, caching it for performance.
   * @returns {HTMLVideoElement | null} - The player element.
   * @private
   */
  _getPlayerElement() {
    if (!this._playerElement || !this._playerElement.isConnected) {
      this._playerElement =
        (this.uiConfig?.player ? document.querySelector(this.uiConfig.player) : null) ||
        document.querySelector('video, audio') ||
        null;
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
    if (!text) return 0;
    let byFont = this._textWidthCache.get(font);
    if (byFont !== undefined) {
      const hit = byFont.get(text);
      if (hit !== undefined) return hit;
    }

    if (!this.textWidthCanvas) {
      this.textWidthCanvas = document.createElement("canvas");
      this.textWidthCtx = this.textWidthCanvas.getContext("2d", { willReadFrequently: true });
      this._lastCtxFont = null;
    }
    if (this._lastCtxFont !== font) {
      this.textWidthCtx.font = font;
      this._lastCtxFont = font;
    }
    const width = this.textWidthCtx.measureText(text).width;

    if (this._textWidthCount >= 6000) {
      this._clearTextWidthCache();
      byFont = undefined;
    }
    if (byFont === undefined) {
      byFont = new Map();
      this._textWidthCache.set(font, byFont);
    }
    byFont.set(text, width);
    this._textWidthCount++;
    return width;
  }

  _clearTextWidthCache() {
    this._textWidthCache.clear();
    this._textWidthCount = 0;
  }

  _ensureElementIds() {
    if (!this.cachedLyricsLines) return;
    const lines = this.cachedLyricsLines;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      if (!line.id) line.id = `line-${i}`;
      line._idx = i;
    }
  }

  /**
   * Starts the synchronization loop for highlighting lyrics based on video time.
   * @param {object} currentSettings - The current user settings.
   * @returns {Function} - A cleanup function to stop the sync.
   */
  _startLyricsSync(currentSettings = {}) {
    if (this.currentLyricsType === "None") return () => { };

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
    this.lastTime = this._getCurrentPlayerTime() * 1000 - (this.userOffsetMs || 0);
    this._lastPlayerPaused = false;
    if (!this.uiConfig.disableNativeTick) {
      const sync = () => {
        const player = this._getPlayerElement();
        const isPaused = player ? player.paused : false;
        const currentTime = (this._getCurrentPlayerTime() - this.offsetLatency) * 1000 - (this.userOffsetMs || 0);
        if (currentTime !== this.lastTime || isPaused !== this._lastPlayerPaused) {
          const isForceScroll = Math.abs(currentTime - this.lastTime) > 1000;
          if (isPaused !== this._lastPlayerPaused) {
            this._lastPlayerPaused = isPaused;
            this._explicitPlaybackState = !isPaused;
            this._updateWakeLock();
          }
          this._updateLyricsHighlight(
            currentTime,
            isForceScroll,
            currentSettings
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
    this._updateLyricsHighlight((currentTime - (this.offsetLatency * 1000) - (this.userOffsetMs || 0)), isForceScroll);
    this.lastTime = currentTime;
    this._lastTickTime = Date.now();
    this._explicitPlaybackState = true;
    if (!this.wakeLock && !this._wakeLockPending && this._shouldHoldWakeLock()) {
      this._requestWakeLock();
    }
    if (this.uiConfig?.disableNativeTick) {
      clearTimeout(this._tickWatchdogTimer);
      this._tickWatchdogTimer = setTimeout(() => {
        const player = this._getPlayerElement();
        if (player && player.paused) {
          this._explicitPlaybackState = false;
        } else if (!player && (Date.now() - this._lastTickTime >= 2000)) {
          this._explicitPlaybackState = false;
        }
        if (this.wakeLock) {
          this._updateWakeLock();
        }
      }, 2000);
    }
  }

  /**
   * Checks if a line has active main vocal syllables at currentTime.
   */
  _hasActiveMainVocals(line, currentTime) {
    if (!line) return false;
    let syllables = line._cachedSyllableElements;
    if (!syllables) {
      syllables = Array.from(line.querySelectorAll(".lyrics-syllable"));
      line._cachedSyllableElements = syllables;
    }
    for (let i = 0; i < syllables.length; i++) {
      const syl = syllables[i];
      if (!syl._isBackground && !syl._isGap && syl._startTimeMs !== undefined) {
        if (currentTime >= syl._startTimeMs && currentTime < syl._endTimeMs) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Pre-reads scroll container and target line geometry before DOM class/style writes
   * to prevent forced synchronous layout (reflow).
   * @param {HTMLElement} activeLine - Target line to scroll to.
   * @param {number} offsetAboveDelta - Known vertical layout shift occurring above activeLine in this tick.
   * @param {number} totalHeightDelta - Known total height change occurring in the container in this tick.
   */
  _captureScrollSnapshot(activeLine, offsetAboveDelta = 0, totalHeightDelta = 0, layoutShifts = null) {
    if (!activeLine || !this.lyricsContainer) return null;
    if (this._containerDisplayCache === undefined) {
      this._containerDisplayCache = getComputedStyle(this.lyricsContainer).display;
    }
    if (this._containerDisplayCache !== "block") return { hidden: true };

    const scrollContainer = this.lyricsContainer.parentElement;
    if (!scrollContainer) return { hidden: true };

    if (layoutShifts && layoutShifts.length > 0) {
      const targetIdx = this._lineIndex(activeLine);
      offsetAboveDelta = 0;
      totalHeightDelta = 0;
      for (let i = 0; i < layoutShifts.length; i++) {
        const s = layoutShifts[i];
        totalHeightDelta += s.shift;
        if (s.idx < targetIdx) offsetAboveDelta += s.shift;
      }
    }

    const paddingTop = this._getScrollPaddingTop();
    const scrollHeight = scrollContainer.scrollHeight + totalHeightDelta;
    const clientHeight = scrollContainer.clientHeight;
    const scrollTop = scrollContainer.scrollTop;
    const activeOffsetTop = activeLine.offsetTop + offsetAboveDelta;
    const maxScroll = Math.max(0, scrollHeight - clientHeight);
    const targetTop = Math.min(maxScroll, Math.max(0, activeOffsetTop - paddingTop));
    const delta = (-scrollTop) - (-targetTop);

    // Pre-compute tail end index while layout is clean
    const linesArr = this.cachedLyricsLines;
    const len = linesArr ? linesArr.length : 0;
    const referenceLine =
      this.currentPrimaryActiveLine ||
      this.lastPrimaryActiveLine ||
      (len > 0 ? linesArr[0] : null);
    const referenceIndex = referenceLine ? this._lineIndex(referenceLine) : 0;

    let visMin = referenceIndex >= 0 ? referenceIndex : 0;
    let visMax = visMin;
    if (this.visibleLineIds.size > 0 && this._lineById) {
      for (const id of this.visibleLineIds) {
        const vi = this._lineById.get(id)?._idx;
        if (vi !== undefined) {
          if (vi < visMin) visMin = vi;
          if (vi > visMax) visMax = vi;
        }
      }
    }

    const shiftAboveLine = (lineIdx) => {
      if (!layoutShifts || layoutShifts.length === 0) return offsetAboveDelta;
      let sum = 0;
      for (let i = 0; i < layoutShifts.length; i++) {
        if (layoutShifts[i].idx < lineIdx) sum += layoutShifts[i].shift;
      }
      return sum;
    };

    const SCROLL_TAIL_MARGIN_PX = 200;
    const SCROLL_TAIL_MIN_LINES = 3;
    const reachBottom = targetTop + clientHeight + Math.abs(delta) + SCROLL_TAIL_MARGIN_PX;
    let end = Math.min(len, Math.max(visMax, Math.max(0, referenceIndex)) + 1);
    while (end < len && (linesArr[end].offsetTop + shiftAboveLine(end)) < reachBottom) end++;
    end = Math.min(len, end + SCROLL_TAIL_MIN_LINES);

    return {
      hidden: false,
      scrollContainer,
      paddingTop,
      scrollHeight,
      clientHeight,
      scrollTop,
      activeOffsetTop,
      targetTop,
      delta,
      referenceIndex,
      visMin,
      visMax,
      start: Math.min(visMin, Math.max(0, referenceIndex)),
      end
    };
  }

  /**
   * Computes planned gap layout shifts during the Clean Read Phase (before DOM class mutations)
   * if gap heights are already known, so we never have to read layout after mutating classes.
   */
  _planGapChanges(newPrimary, force, activeLines, activeCount) {
    if (!this.cachedLyricsLines) return null;
    if (!this._openGaps) this._resetGapState();

    const toOpen = [];
    const toClose = [];
    const scheduleClose = [];

    const checkOpen = (l) => {
      this._cancelGapClose(l);
      if (!l.classList.contains("gap-open")) {
        toOpen.push(l);
      }
    };

    if (newPrimary && newPrimary._isGap) checkOpen(newPrimary);
    for (let i = 0; i < activeCount; i++) {
      const l = activeLines[i];
      if (l && l._isGap && l !== newPrimary) checkOpen(l);
    }

    if (this._openGaps.size > 0) {
      const nextActiveSet = this.activeLineIds;
      for (const g of Array.from(this._openGaps)) {
        if (g === newPrimary || nextActiveSet.has(g.id)) continue;
        if (!g.isConnected) {
          this._openGaps.delete(g);
          continue;
        }
        if (force) {
          scheduleClose.push(g);
        } else if (g.classList.contains("gap-open")) {
          // Pre-read closing gap height while DOM is still 100% clean!
          if (!(this._cachedGapHeight > 0)) {
            const h = g.offsetHeight;
            if (h > 0) this._cachedGapHeight = h;
          }
          toClose.push(g);
        }
      }
    }

    return { toOpen, toClose, scheduleClose };
  }

  /**
   * Updates the highlighted lyrics and syllables based on the current time.
   * Structured with strict Read Phase -> Write Phase separation so zero forced reflows occur during playback.
   * @param {number} currentTime - The current video time in milliseconds.
   * @param {boolean} isForceScroll - Whether to force a scroll update.
   */
  _updateLyricsHighlight(
    currentTime,
    isForceScroll = false
  ) {
    const lines = this.cachedLyricsLines;
    if (!lines || lines.length === 0) {
      return;
    }

    const linesLen = lines.length;
    const isBackwardSeek = this._lastHighlightTime !== undefined && (this._lastHighlightTime - currentTime) > 80;
    this._lastHighlightTime = currentTime;
    const isSeek = isForceScroll || isBackwardSeek;
    if (isSeek || this._suggestedLineOffsetMs === undefined) {
      this._suggestedLineOffsetMs = -500;
      this._appleScrollDurationMs = 750;
    }

    const isWordByWord = !!(this.lyricsContainer && this.lyricsContainer.classList.contains("word-by-word-mode"));
    const scrollLookAheadMs = -this._suggestedLineOffsetMs;
    const predictiveTime = currentTime + scrollLookAheadMs;
    const activationStartDelayMs = isWordByWord ? 150 : 250;
    const overlapLookAheadMs = Math.max(250, scrollLookAheadMs - activationStartDelayMs);
    const overlapTime = currentTime + overlapLookAheadMs;
    const lastLineEndLookAheadMs = 200;
    const lastLinePredictiveTime = currentTime + lastLineEndLookAheadMs;

    // 1. Pure JS: Collect raw active lines at predictiveTime
    const hint = isSeek ? 0 : this._lastActiveIndex;
    const searchIdx = this._getLineIndexAtTime(predictiveTime, hint);

    const rawActiveIndices = this._activeIndices;
    rawActiveIndices.length = 0;

    let scanStart = Math.max(0, (searchIdx !== -1 ? searchIdx : this._lastActiveIndex) - 2);
    while (scanStart > 0 && lines[scanStart - 1]._endTimeMs > overlapTime) {
      scanStart--;
    }
    let maxActiveEndMs = -Infinity;
    for (let i = scanStart; i < linesLen; i++) {
      const line = lines[i];
      if (line._startTimeMs > predictiveTime) break;
      const isOverlappingNext = rawActiveIndices.length > 0 && line._startTimeMs < maxActiveEndMs;
      const startCheckTime = (isOverlappingNext && !this.activeLineIds.has(line.id))
        ? overlapTime
        : predictiveTime;
      const nextLine = i + 1 < linesLen ? lines[i + 1] : null;
      const overlapsNextLine = !!(
        nextLine &&
        !nextLine._isGap &&
        !line._isGap &&
        nextLine._startTimeMs < line._endTimeMs
      );
      const isLastLyricLine = !nextLine || !nextLine.classList.contains("lyrics-line");
      const endCheckTime = overlapsNextLine
        ? overlapTime
        : (isLastLyricLine ? lastLinePredictiveTime : predictiveTime);
      if (startCheckTime >= line._startTimeMs && endCheckTime < line._endTimeMs) {
        rawActiveIndices.push(i);
        if (line._endTimeMs > maxActiveEndMs) {
          maxActiveEndMs = line._endTimeMs;
        }
      }
    }

    const currentActiveIndices = this._activeLineIndices || (this._activeLineIndices = []);
    const prevActiveIndices = this._prevActiveLineIndices || (this._prevActiveLineIndices = []);

    if (!isSeek && rawActiveIndices.length === 0 && currentActiveIndices.length > 0) {
      for (let k = 0; k < currentActiveIndices.length; k++) {
        const prevIdx = currentActiveIndices[k];
        const prevLine = lines[prevIdx];
        const nextAfterPrev = (prevIdx >= 0 && prevIdx + 1 < linesLen) ? lines[prevIdx + 1] : null;
        const prevIsLastLyricLine = !nextAfterPrev || !nextAfterPrev.classList.contains("lyrics-line");
        const prevEndCheckTime = prevIsLastLyricLine ? lastLinePredictiveTime : predictiveTime;
        if (
          prevLine &&
          prevEndCheckTime < prevLine._endTimeMs &&
          currentTime + LyricsPlusRenderer._SCROLL_LEAD_MAX >= prevLine._startTimeMs
        ) {
          rawActiveIndices.push(prevIdx);
        }
      }
    }

    if (!isSeek && rawActiveIndices.length > 0 && currentActiveIndices.length > 0) {
      const minCurrentActive = currentActiveIndices[0];
      let writeIdx = 0;
      for (let i = 0; i < rawActiveIndices.length; i++) {
        const idx = rawActiveIndices[i];
        if (!(idx > 0 && idx < minCurrentActive)) {
          rawActiveIndices[writeIdx++] = idx;
        }
      }
      rawActiveIndices.length = writeIdx;
      if (rawActiveIndices.length === 0) {
        for (let i = 0; i < currentActiveIndices.length; i++) {
          rawActiveIndices.push(currentActiveIndices[i]);
        }
      }
    }

    if (rawActiveIndices.length >= 2) {
      let anyHasBg = false;
      for (let i = 0; i < rawActiveIndices.length; i++) {
        if (this._getBgVocalWrap(lines[rawActiveIndices[i]])) {
          anyHasBg = true;
          break;
        }
      }
      if (anyHasBg) {
        const lastIdx = rawActiveIndices[rawActiveIndices.length - 1];
        const prevIdx = rawActiveIndices[rawActiveIndices.length - 2];
        const isConsecutive = (lastIdx - prevIdx === 1);
        const prevLine = lines[prevIdx];
        const lastLine = lines[lastIdx];
        const prevHasNoActiveMainWords = !this._hasActiveMainVocals(prevLine, currentTime);
        const prevHasBg = !!this._getBgVocalWrap(prevLine);
        const lastHasBg = !!this._getBgVocalWrap(lastLine);

        rawActiveIndices.length = 0;
        if (isConsecutive && (prevHasNoActiveMainWords || !prevHasBg || !lastHasBg)) {
          rawActiveIndices.push(prevIdx);
        }
        rawActiveIndices.push(lastIdx);
      }
    }

    if (rawActiveIndices.length === 0) {
      const firstLineStartTime = lines[0]._startTimeMs;
      if (predictiveTime >= firstLineStartTime && !isSeek && currentActiveIndices.length > 0) {
        const lastPrevIdx = currentActiveIndices[currentActiveIndices.length - 1];
        const lastPrevLine = lastPrevIdx >= 0 ? lines[lastPrevIdx] : null;
        const nextAfterPrev = (lastPrevIdx >= 0 && lastPrevIdx + 1 < linesLen) ? lines[lastPrevIdx + 1] : null;
        const hasNextLyricLine = !!(nextAfterPrev && nextAfterPrev.classList.contains("lyrics-line"));
        const exitedGapLine = !!(lastPrevLine && lastPrevLine._isGap && predictiveTime >= lastPrevLine._endTimeMs);
        const exitedLastLyricLine = !!(lastPrevLine && !hasNextLyricLine && lastLinePredictiveTime >= lastPrevLine._endTimeMs);
        let maxPrevEndMs = lastPrevLine ? lastPrevLine._endTimeMs : -Infinity;
        for (let k = 0; k < currentActiveIndices.length; k++) {
          const l = lines[currentActiveIndices[k]];
          if (l && l._endTimeMs > maxPrevEndMs) maxPrevEndMs = l._endTimeMs;
        }
        const inactiveAfter = (predictiveTime - maxPrevEndMs) >= 1000 + (this._suggestedLineOffsetMs * -1);

        if (!exitedGapLine && !exitedLastLyricLine && !inactiveAfter) {
          for (let k = 0; k < currentActiveIndices.length; k++) {
            const idx = currentActiveIndices[k];
            const l = lines[idx];
            if (l && !l._isGap) {
              rawActiveIndices.push(idx);
            }
          }
        }
      }
    }

    if (rawActiveIndices.length > 0) {
      const R = LyricsPlusRenderer;
      const lastActiveIdx = rawActiveIndices[rawActiveIndices.length - 1];
      const lastActiveLine = lines[lastActiveIdx];
      const isRealLine = (l) => !!(l && !l._isGap && l.classList.contains("lyrics-line"));

      let rawEnd = lastActiveLine._endTimeMs;
      for (let k = 0; k < rawActiveIndices.length; k++) {
        const endMs = lines[rawActiveIndices[k]]._endTimeMs;
        if (endMs > rawEnd) rawEnd = endMs;
      }
      let nextRealLine = null;
      for (let k = lastActiveIdx + 1; k < linesLen; k++) {
        if (isRealLine(lines[k])) { nextRealLine = lines[k]; break; }
      }
      const timeGap = nextRealLine ? (nextRealLine._startTimeMs - rawEnd) : -1;
      const gapRange = R._SPRING_GAP_MAX_MS - R._SPRING_GAP_MIN_MS;
      this._scrollGapT = nextRealLine
        ? Math.min(1, Math.max(0, (timeGap - R._SPRING_GAP_MIN_MS) / gapRange))
        : 1;

      if (isWordByWord && isRealLine(lastActiveLine)) {
        const nextLine = lastActiveIdx + 1 < linesLen ? lines[lastActiveIdx + 1] : null;
        const leadGap = isRealLine(nextLine) ? (nextLine._startTimeMs - rawEnd) : -1;
        const clampedGap = Math.min(R._SCROLL_LEAD_GAP_MAX, Math.max(R._SCROLL_LEAD_GAP_MIN, leadGap));
        const t = (clampedGap - R._SCROLL_LEAD_GAP_MIN) / (R._SCROLL_LEAD_GAP_MAX - R._SCROLL_LEAD_GAP_MIN);
        const iRound = Math.round(R._SCROLL_LEAD_MIN + t * (R._SCROLL_LEAD_MAX - R._SCROLL_LEAD_MIN));
        this._suggestedLineOffsetMs = -iRound;
        this._appleScrollDurationMs = iRound;
      } else {
        this._suggestedLineOffsetMs = -500;
        this._appleScrollDurationMs = 750;
      }
    }

    const scrollDurationMs = Math.min(500, Math.max(350, Math.round((this._appleScrollDurationMs || 500) * 0.65)));

    let isNonEmptySubsetOfCurrent = false;
    if (
      !isSeek &&
      rawActiveIndices.length > 0 &&
      rawActiveIndices.length <= currentActiveIndices.length
    ) {
      isNonEmptySubsetOfCurrent = true;
      for (let i = 0; i < rawActiveIndices.length; i++) {
        if (!currentActiveIndices.includes(rawActiveIndices[i])) {
          isNonEmptySubsetOfCurrent = false;
          break;
        }
      }
      if (isNonEmptySubsetOfCurrent) {
        const maxRawIdx = rawActiveIndices[rawActiveIndices.length - 1];
        for (let i = 0; i < currentActiveIndices.length; i++) {
          const curIdx = currentActiveIndices[i];
          if (!rawActiveIndices.includes(curIdx) && maxRawIdx >= curIdx + 2) {
            isNonEmptySubsetOfCurrent = false;
            break;
          }
        }
      }
    }

    if (!isNonEmptySubsetOfCurrent) {
      prevActiveIndices.length = 0;
      for (let i = 0; i < currentActiveIndices.length; i++) {
        prevActiveIndices.push(currentActiveIndices[i]);
      }
      currentActiveIndices.length = 0;
      for (let i = 0; i < rawActiveIndices.length; i++) {
        currentActiveIndices.push(rawActiveIndices[i]);
      }
    }

    let lineToScroll = null;
    if (currentActiveIndices.length > 0) {
      let isContiguous = true;
      for (let i = 1; i < currentActiveIndices.length; i++) {
        if (currentActiveIndices[i] - currentActiveIndices[i - 1] !== 1) {
          isContiguous = false;
          break;
        }
      }
      let hasIntersection = false;
      for (let i = 0; i < currentActiveIndices.length; i++) {
        if (prevActiveIndices.includes(currentActiveIndices[i])) {
          hasIntersection = true;
          break;
        }
      }
      const rFirst = currentActiveIndices[0];
      const rLast = currentActiveIndices[currentActiveIndices.length - 1];
      const sLast = prevActiveIndices.length > 0 ? prevActiveIndices[prevActiveIndices.length - 1] : -1;

      let primaryIndex;
      if (hasIntersection && rLast > sLast && !isContiguous) {
        primaryIndex = rLast;
      } else if (currentActiveIndices.length > 3) {
        primaryIndex = Math.max(rFirst, rLast - 2);
      } else {
        primaryIndex = rFirst;
      }

      this._lastActiveIndex = primaryIndex;
      this._lastActiveGroupEndIndex = rLast;
      lineToScroll = lines[primaryIndex];
    } else {
      if (predictiveTime < lines[0]._startTimeMs) {
        this._lastActiveIndex = 0;
        this._lastActiveGroupEndIndex = 0;
        lineToScroll = lines[0];
      } else if (isSeek && searchIdx >= 0 && searchIdx < linesLen) {
        this._lastActiveIndex = searchIdx;
        this._lastActiveGroupEndIndex = searchIdx;
        lineToScroll = lines[searchIdx];
      } else {
        lineToScroll = this.currentPrimaryActiveLine || lines[this._lastActiveIndex] || lines[0];
      }
    }

    let tempActiveCount = 0;
    for (let k = 0; k < currentActiveIndices.length; k++) {
      const line = lines[currentActiveIndices[k]];
      if (line) {
        this._tempActiveLines[tempActiveCount++] = line;
      }
    }
    if (this._tempActiveLines.length > tempActiveCount) {
      this._tempActiveLines.length = tempActiveCount;
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

    const shouldScroll = !!(
      lineToScroll &&
      (lineToScroll !== this.currentPrimaryActiveLine || isForceScroll) &&
      (!this.isUserControllingScroll || isForceScroll)
    );

    const bgToggled = this._bgToggled || (this._bgToggled = []);
    bgToggled.length = 0;
    const bgShifts = this._bgShifts || (this._bgShifts = []);
    bgShifts.length = 0;
    const deactivating = this._deactivatingLines;
    const activating = this._activatingLines;
    deactivating.length = 0;
    activating.length = 0;

    // =========================================================================
    // PHASE 1: CLEAN DOM READS (100% of layout/style reads happen here!)
    // =========================================================================
    if (hasChanged) {
      const anchorBefore = this.currentPrimaryActiveLine;
      this._bgAnchorTop = anchorBefore ? 0 : null;
      this._bgAnchorLine = anchorBefore;

      for (const oldId of this.activeLineIds) {
        let stillActive = false;
        for (let j = 0; j < tempActiveCount; j++) {
          if (this._tempActiveLines[j].id === oldId) {
            stillActive = true;
            break;
          }
        }
        if (!stillActive) {
          const line = (this._lineById && this._lineById.get(oldId)) || document.getElementById(oldId);
          if (line) {
            deactivating.push(line);
            const wrap = this._getBgVocalWrap(line);
            if (wrap) {
              const h = this._measureBgHeight(wrap);
              bgToggled.push(line, false);
              if (h >= 0.5) {
                const idx = this._lineIndex(line);
                if (idx >= 0) bgShifts.push({ idx, shift: -h });
              }
            }
          }
          this.activeLineIds.delete(oldId);
        }
      }

      for (let i = 0; i < tempActiveCount; i++) {
        const line = this._tempActiveLines[i];
        if (!this.activeLineIds.has(line.id)) {
          activating.push(line);
          this.activeLineIds.add(line.id);
          const wrap = this._getBgVocalWrap(line);
          if (wrap) {
            const h = this._measureBgHeight(wrap);
            bgToggled.push(line, true);
            if (h >= 0.5) {
              const idx = this._lineIndex(line);
              if (idx >= 0) bgShifts.push({ idx, shift: h });
            }
          }
        }
      }
    }

    if (shouldScroll && !this._springConfigCache) {
      this._springConfigCache = this._resolveSpringConfig();
    }

    // Pre-measure syllable geometry for any active lines that will need a mask animator
    for (let i = 0; i < tempActiveCount; i++) {
      const activeLine = this._tempActiveLines[i];
      if (activeLine && !activeLine._maskAnimator && !activeLine._isGap && !activeLine._maskFinished) {
        this._preMeasureLineMask(activeLine);
      }
    }

    let gapPlan = null;
    let gapShifts = null;
    let unmeasuredGapOpen = false;
    if (shouldScroll) {
      gapPlan = this._planGapChanges(lineToScroll, isForceScroll, this._tempActiveLines, tempActiveCount);
      if (gapPlan) {
        if (gapPlan.toOpen.length > 0 && !(this._cachedGapHeight > 0)) {
          unmeasuredGapOpen = true;
        } else {
          const gapH = this._cachedGapHeight;
          if (gapH > 0) {
            for (let i = 0; i < gapPlan.toOpen.length; i++) {
              const idx = this._lineIndex(gapPlan.toOpen[i]);
              if (idx >= 0) (gapShifts || (gapShifts = [])).push({ idx, shift: gapH });
            }
            for (let i = 0; i < gapPlan.toClose.length; i++) {
              const idx = this._lineIndex(gapPlan.toClose[i]);
              if (idx >= 0) (gapShifts || (gapShifts = [])).push({ idx, shift: -gapH });
            }
          }
        }
      }
    }

    // Read scroll snapshot on the clean DOM (adjusting for both gapShifts and bgShifts)
    let scrollSnapshot = null;
    if (shouldScroll && !unmeasuredGapOpen) {
      let combinedShifts = null;
      if (gapShifts && bgShifts.length > 0) {
        combinedShifts = gapShifts.concat(bgShifts);
      } else if (gapShifts) {
        combinedShifts = gapShifts;
      } else if (bgShifts.length > 0) {
        combinedShifts = bgShifts;
      }
      scrollSnapshot = this._captureScrollSnapshot(lineToScroll, 0, 0, combinedShifts);
    }

    // Pre-read scroller state for _animateBgVocalReflow if needed
    let bgScrollerSnapshot = null;
    if (bgToggled.length > 0 && this.lyricsContainer?.parentElement) {
      let totalBgAndGapDelta = 0;
      for (let i = 0; i < bgShifts.length; i++) totalBgAndGapDelta += bgShifts[i].shift;
      if (gapShifts) {
        for (let i = 0; i < gapShifts.length; i++) totalBgAndGapDelta += gapShifts[i].shift;
      }
      const scroller = this.lyricsContainer.parentElement;
      bgScrollerSnapshot = scrollSnapshot && !scrollSnapshot.hidden ? {
        scrollTop: scrollSnapshot.scrollTop,
        scrollHeight: scrollSnapshot.scrollHeight,
        clientHeight: scrollSnapshot.clientHeight
      } : {
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight + totalBgAndGapDelta,
        clientHeight: scroller.clientHeight
      };
    }

    // =========================================================================
    // PHASE 2 & 3: PURE DOM WRITES & WAAPI UPDATES (Zero layout reads!)
    // =========================================================================
    let scrollAnimated = false;
    if (shouldScroll) {
      if (unmeasuredGapOpen) {
        gapShifts = this._syncGapLayout(lineToScroll, isForceScroll, this._tempActiveLines, tempActiveCount);
        scrollSnapshot = this._captureScrollSnapshot(lineToScroll, 0, 0, bgShifts.length > 0 ? bgShifts : null);
      } else if (gapPlan) {
        for (let i = 0; i < gapPlan.toOpen.length; i++) {
          const g = gapPlan.toOpen[i];
          g.classList.add("gap-open");
          this._openGaps.add(g);
        }
        for (let i = 0; i < gapPlan.toClose.length; i++) {
          const g = gapPlan.toClose[i];
          g.classList.remove("gap-open");
          this._openGaps.delete(g);
        }
        for (let i = 0; i < gapPlan.scheduleClose.length; i++) {
          this._scheduleGapClose(gapPlan.scheduleClose[i]);
        }
      }
      this._pendingGapShifts = isForceScroll ? null : gapShifts;
      const scrollT0Before = this._scrollAnimT0;
      // Scroll BEFORE mutating .active / .fullscreen-focused so scrollTo executes on a clean layout tree
      this._updatePositionClassesAndScroll(lineToScroll, isForceScroll, scrollDurationMs, scrollSnapshot);
      scrollAnimated = isForceScroll || this._scrollAnimT0 !== scrollT0Before;
      this._pendingGapShifts = null;
      this.lastPrimaryActiveLine = this.currentPrimaryActiveLine;
      this.currentPrimaryActiveLine = lineToScroll;
    } else if (hasChanged) {
      this._openActiveGapsNow(this._tempActiveLines, tempActiveCount);
      if (this.isUserControllingScroll) this._scheduleHiddenGapCloses();
    }

    for (let i = 0; i < deactivating.length; i++) {
      deactivating[i].classList.remove("active");
    }
    for (let i = 0; i < activating.length; i++) {
      const line = activating[i];
      line.classList.add("active");
      line._maskFinished = false;
      if (line._maskAnimator && line._maskAnimator._filling) {
        line._maskAnimator.cancelFill();
      }
    }

    for (let i = 0; i < deactivating.length; i++) {
      this._resetSyllables(deactivating[i], isForceScroll);
    }

    if (bgToggled.length > 0) {
      this._animateBgVocalReflow(
        bgToggled,
        !scrollAnimated && !this.isUserControllingScroll,
        bgScrollerSnapshot
      );
    }

    const mostRecentActiveLine =
      tempActiveCount > 0 ? this._tempActiveLines[tempActiveCount - 1] : null;

    if (this.currentFullscreenFocusedLine !== mostRecentActiveLine) {
      if (this.currentFullscreenFocusedLine) {
        this.currentFullscreenFocusedLine.classList.remove("fullscreen-focused");
      }
      if (mostRecentActiveLine) {
        mostRecentActiveLine.classList.add("fullscreen-focused");
      }
      this.currentFullscreenFocusedLine = mostRecentActiveLine;
    }

    this._updateSyllables(currentTime, this._tempActiveLines);
  }

  /** Cached `.background-vocal-wrap` of a line (null when the line has none). */
  _getBgVocalWrap(line) {
    let wrap = line._bgWrap;
    if (wrap === undefined || (wrap !== null && !wrap.isConnected)) {
      wrap = line.querySelector(".background-vocal-wrap");
      line._bgWrap = wrap;
      if (wrap) line.classList.add("has-bg-vocal");
    }
    return wrap;
  }

  _observeBgWrap(wrap) {
    if (typeof ResizeObserver === "undefined") return;
    if (!this._bgResizeObserver) {
      this._bgResizeObserver = new ResizeObserver((entries) => {
        for (const e of entries) {
          const h = e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height;
          if (h > 0.5) e.target._bgH = h;
        }
      });
    }
    this._bgResizeObserver.observe(wrap);
  }

  _measureBgHeight(wrap) {
    if (wrap._bgH > 0.5) return wrap._bgH;
    const h = wrap.offsetHeight;
    if (h > 0.5) wrap._bgH = h;
    return h;
  }

  /**
   * FLIP for background vocals.
   * Uses pre-measured heights and scroller state so zero layout reads occur after DOM writes.
   *
   * @param {Array} toggled Flat list [line, expanding, line, expanding, ...]
   * @param {boolean} reanchor Keep the primary line pinned (no scroll call this tick)
   * @param {object|null} scrollerSnap Pre-captured scroller metrics
   */
  _animateBgVocalReflow(toggled, reanchor = false, scrollerSnap = null) {
    const lines = this.cachedLyricsLines;
    const anchorTopBefore = this._bgAnchorTop;
    const anchorLineBefore = this._bgAnchorLine;
    this._bgAnchorTop = null;
    this._bgAnchorLine = null;
    if (!lines || lines.length === 0 || typeof Element.prototype.animate !== "function") {
      toggled.length = 0;
      return;
    }

    const indexOf = (line) => (line._idx !== undefined && lines[line._idx] === line)
      ? line._idx
      : lines.indexOf(line);

    const events = [];
    for (let i = 0; i < toggled.length; i += 2) {
      const line = toggled[i];
      const wrap = this._getBgVocalWrap(line);
      if (!wrap) continue;
      const h = this._measureBgHeight(wrap);
      if (h < 0.5) continue;
      const idx = indexOf(line);
      if (idx < 0) continue;
      const expanding = toggled[i + 1];
      events.push({ line, wrap, idx, expanding, delta: expanding ? h : -h });
    }
    toggled.length = 0;
    if (events.length === 0) return;
    events.sort((a, b) => a.idx - b.idx);

    const containerEl = this.lyricsContainer;
    const scroller = containerEl ? containerEl.parentElement : null;
    const anchor = reanchor ? (anchorLineBefore || this.currentPrimaryActiveLine) : null;
    let applied = 0;
    let anchorIdx = -1;
    if (anchor && scroller && anchorTopBefore !== null) {
      anchorIdx = indexOf(anchor);
      let moved = 0;
      for (let e = 0; e < events.length && events[e].idx < anchorIdx; e++) moved += events[e].delta;
      if (anchorIdx >= 0 && Math.abs(moved) >= 0.5) {
        const before = scrollerSnap ? scrollerSnap.scrollTop : -this.currentScrollOffset;
        const maxScroll = scrollerSnap
          ? Math.max(0, scrollerSnap.scrollHeight - scrollerSnap.clientHeight)
          : Infinity;
        const nextTop = Math.min(maxScroll, Math.max(0, before + moved));
        scroller.scrollTo({ top: nextTop, behavior: "instant" });
        applied = nextTop - before;
        this.currentScrollOffset = -nextTop;
        const st = this._scrollAnimationState;
        if (st && st.pendingUpdate !== null) st.pendingUpdate -= applied;
      }
    }

    const ms = this._lastScrollDurationMs || 400;
    const easing = this._appliedScrollEasing || "cubic-bezier(.41, 0, .12, .99)";
    const userScrolling = !!(containerEl && containerEl.classList.contains("user-scrolling"));
    const elapsed = performance.now() - (this._scrollAnimT0 || -1e9);
    const lineDelay = (line) => {
      if (userScrolling || !line._scrollAnim) return 0;
      return Math.max(0, (line._scrollDelay || 0) - elapsed);
    };

    let visMin = Infinity;
    let visMax = -1;
    const ids = this.visibleLineIds;
    const byId = this._lineById;
    if (ids && ids.size > 0 && byId) {
      for (const id of ids) {
        const v = byId.get(id)?._idx;
        if (v === undefined) continue;
        if (v < visMin) visMin = v;
        if (v > visMax) visMax = v;
      }
    }
    const lastEvent = events[events.length - 1].idx;
    const last = Math.min(lines.length, Math.max(visMax, lastEvent, anchorIdx) + 2);
    const first = visMin === Infinity ? 0 : Math.max(0, visMin - 1);

    let ei = 0;
    let above = 0;
    for (let i = first; i < last; i++) {
      while (ei < events.length && events[ei].idx < i) above += events[ei++].delta;
      const line = lines[i];
      LyricsPlusRenderer._flipTranslateY(line, applied - above, ms, easing, lineDelay(line));
    }

    const durStr = `${ms}ms`;
    for (let e = 0; e < events.length; e++) {
      const ev = events[e];
      const ownDelay = lineDelay(ev.line);
      const bgContainer = ev.wrap.parentElement;
      if (bgContainer) {
        if (bgContainer._scrollDur !== durStr) {
          bgContainer.style.setProperty("--scroll-duration", durStr);
          bgContainer._scrollDur = durStr;
        }
        if (bgContainer._scrollEase !== easing) {
          bgContainer.style.setProperty("--scroll-easing", easing);
          bgContainer._scrollEase = easing;
        }
      }
      for (let el = bgContainer && bgContainer.nextElementSibling; el; el = el.nextElementSibling) {
        LyricsPlusRenderer._flipTranslateY(el, -ev.delta, ms, easing, ownDelay);
      }
    }
  }

  static _flipTranslateY(el, px, ms, easing, delay = 0) {
    if (!el || Math.abs(px) < 0.5) return;
    const anim = el.animate(
      [{ transform: `translateY(${px.toFixed(2)}px)` }, { transform: "translateY(0px)" }],
      { duration: ms, delay, easing, fill: "backwards", composite: "add" }
    );
    anim.onfinish = () => anim.cancel();
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
      if (startHintIndex - 1 >= 0) {
        const prevLine = lines[startHintIndex - 1];
        if (timeMs >= prevLine._startTimeMs && timeMs < prevLine._endTimeMs) {
          return startHintIndex - 1;
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
    const changes = this._visibilityChanges;
    if (!changes || changes.length === 0) return;

    for (let i = 0; i < changes.length; i++) {
      const target = changes[i];
      target.classList.toggle("viewport-hidden", !this.visibleLineIds.has(target.id));
    }

    changes.length = 0;
  }

  /**
   * Decides the wipe direction from what is actually displayed in a syllable,
   * not from the line. An LTR transliteration under an RTL line must wipe LTR.
   */
  static _resolveWipeRtl(text, computedDirection) {
    if (LyricsPlusRenderer._RTL_RE.test(text)) return true;
    if (LyricsPlusRenderer._BIDI_CHECK_RE.test(text)) return false;
    return computedDirection === "rtl"; // neutral text (digits, punctuation)
  }

  static _generateFadeGradient(widthRatio, dir = "to right", isBackground = false) {
    const totalAspect = 2 + widthRatio;
    const halfFadePercent = (widthRatio / totalAspect) * 50;
    const leftPercent = 50 - halfFadePercent;
    const rightPercent = 50 + halfFadePercent;

    if (isBackground) {
      const bright = "var(--lyplus-text-primary, #fff)";
      const dark = "var(--lyplus-text-secondary, rgba(255, 255, 255, 0.333))";
      return [
        `linear-gradient(${dir}, ${bright} ${leftPercent.toFixed(3)}%, ${dark} ${rightPercent.toFixed(3)}%)`,
        totalAspect,
      ];
    }

    const bright = "rgb(0 0 0 / 1)";
    const dark = "rgb(0 0 0 / var(--lyplus-mask-dim-alpha, 0.35))";

    return [
      `linear-gradient(${dir}, ${bright} ${leftPercent.toFixed(3)}%, ${dark} ${rightPercent.toFixed(3)}%)`,
      totalAspect,
    ];
  }

  /**
   * Normalised time range [lo, hi] in which a word's mask actually moves.
   * Before lo / after hi the keyframes hold one constant value.
   * Returns [-1, 2] (never skip) when it cannot be determined.
   */
  static _maskStaticWindow(frames) {
    const n = frames ? frames.length : 0;
    if (n < 2) return [-1, 2];
    const key = (f) => (f.maskPosition !== undefined ? f.maskPosition : f.backgroundPosition);
    const first = key(frames[0]);
    const last = key(frames[n - 1]);
    if (first === undefined || last === undefined) return [-1, 2];
    let lo = 0;
    while (lo + 1 < n && key(frames[lo + 1]) === first) lo++;
    let hi = n - 1;
    while (hi - 1 >= 0 && key(frames[hi - 1]) === last) hi--;
    return [frames[lo].offset, frames[hi].offset];
  }

  static _flattenSegments(words) {
    let any = false;
    for (let i = 0; i < words.length; i++) {
      words[i]._wordIdx = i;
      if (words[i].segments) { any = true; }
    }
    if (!any) return words;
    const pieces = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const segs = w.segments;
      if (!segs) { pieces.push(w); continue; }
      for (let k = 0; k < segs.length; k++) {
        pieces.push({
          _wordIdx: i,
          startTime: segs[k].startTime,
          endTime: segs[k].endTime,
          width: w.width * segs[k].frac,
          padding: w.padding,
          gapAfter: k === segs.length - 1 ? (w.gapAfter || 0) : 0,
        });
      }
    }
    return pieces;
  }

  static _buildMaskFrames(words, targetIndex, fadeWidth, lineStartTime, totalFadeDuration, rtl = false, widthBefore, isBackground = false, gradientImage = null, sizeStr = null) {
    const targetWord = words[targetIndex];
    const pieces = LyricsPlusRenderer._flattenSegments(words);
    if (widthBefore === undefined) {
      widthBefore = 0;
      for (let k = 0; k < targetIndex; k++) widthBefore += words[k].width + (words[k].gapAfter || 0);
    }
    const widthBeforeSelf = widthBefore + (words[0] ? fadeWidth : 0);

    const minOffset = -(targetWord.width + targetWord.padding * 2 + fadeWidth);
    const leadTrim = LyricsPlusRenderer._MASK_LEAD_TRIM *
      Math.max(0, fadeWidth - (words[0] ? words[0].padding : 0));
    const initialPos = -widthBeforeSelf - targetWord.width - targetWord.padding - fadeWidth + leadTrim;

    const cursor = {
      curPos: initialPos,
      lastPos: initialPos,
      timeOffset: 0,
      lastTime: 0,
      lastTimeMs: lineStartTime,
      frames: [],
    };

    const makeFrame = (offset, pos) => {
      if (isBackground) {
        return gradientImage
          ? {
              offset,
              backgroundImage: gradientImage,
              backgroundSize: sizeStr,
              backgroundRepeat: "no-repeat",
              webkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
              backgroundPosition: pos
            }
          : { offset, backgroundPosition: pos };
      }
      return gradientImage
        ? {
            offset,
            maskImage: gradientImage,
            webkitMaskImage: gradientImage,
            maskSize: sizeStr,
            webkitMaskSize: sizeStr,
            maskPosition: pos,
            webkitMaskPosition: pos
          }
        : { offset, maskPosition: pos, webkitMaskPosition: pos };
    };

    const pushClampedKeyframe = () => {
      const time = Math.min(1, Math.max(cursor.lastTime, cursor.timeOffset));
      const moveOffset = cursor.curPos - cursor.lastPos;
      const duration = time - cursor.lastTime;

      if (duration > 0 && moveOffset !== 0) {
        const msPerPixel = Math.abs(duration / moveOffset);

        if (cursor.curPos > minOffset && cursor.lastPos < minOffset) {
          const staticTime = Math.min(duration, Math.max(0, Math.abs(cursor.lastPos - minOffset) * msPerPixel));
          const clamped = minOffset;
          const xPos = (rtl ? minOffset - clamped : clamped).toFixed(2);
          const pos = `${xPos}px 0`;
          cursor.frames.push(
            makeFrame(Math.min(1, Math.max(cursor.lastTime, cursor.lastTime + staticTime)), pos)
          );
        }

        if (cursor.curPos > 0 && cursor.lastPos < 0) {
          const staticTime = Math.min(duration, Math.max(0, Math.abs(cursor.lastPos) * msPerPixel));
          const clamped = 0;
          const xPos = (rtl ? minOffset - clamped : clamped).toFixed(2);
          const pos = `${xPos}px 0`;
          cursor.frames.push(
            makeFrame(Math.min(1, Math.max(cursor.lastTime, cursor.lastTime + staticTime)), pos)
          );
        }
      }

      const clamped = Math.min(Math.max(cursor.curPos, minOffset), 0);
      const xPos = (rtl ? minOffset - clamped : clamped).toFixed(2);
      const pos = `${xPos}px 0`;
      cursor.frames.push(makeFrame(time, pos));

      cursor.lastPos = cursor.curPos;
      cursor.lastTime = time;
    };

    pushClampedKeyframe();

    for (let j = 0; j < pieces.length; j++) {
      const otherWord = pieces[j];
      const effectiveStart = Math.max(cursor.lastTimeMs, otherWord.startTime);
      const effectiveEnd = Math.max(effectiveStart, otherWord.endTime);

      const startOffset = Math.min(1, Math.max(cursor.lastTime, (effectiveStart - lineStartTime) / totalFadeDuration));
      if (startOffset > cursor.lastTime) {
        cursor.timeOffset = startOffset;
        pushClampedKeyframe();
      }

      let movePx = otherWord.width + (otherWord.gapAfter || 0);
      if (j === 0) {
        movePx += fadeWidth * 1.5 - leadTrim;
      }
      if (j === pieces.length - 1) {
        movePx += fadeWidth * 0.5;
      }

      const nextWord = pieces[j + 1];
      const nextStartTime = nextWord !== undefined ? nextWord.startTime : Infinity;
      const dur = effectiveEnd - effectiveStart;

      if (dur > 0 && nextStartTime < effectiveEnd) {
        const cutTime = Math.max(effectiveStart, nextStartTime);
        const fraction = (cutTime - effectiveStart) / dur;
        const cutOffset = Math.min(1, Math.max(startOffset, (cutTime - lineStartTime) / totalFadeDuration));
        const isBeforeTarget = (otherWord._wordIdx !== undefined ? otherWord._wordIdx : j) < targetIndex;

        if (isBeforeTarget) {
          cursor.timeOffset = cutOffset;
          cursor.curPos += movePx;
          pushClampedKeyframe();
          cursor.lastTimeMs = cutTime;
        } else {
          if (fraction > 0 && cutOffset > startOffset) {
            cursor.timeOffset = cutOffset;
            cursor.curPos += movePx * fraction;
            pushClampedKeyframe();
          }

          const fillDurMs = Math.min(250, Math.max(60, effectiveEnd - cutTime));
          const fillEndMs = Math.min(lineStartTime + totalFadeDuration, cutTime + fillDurMs);
          const fillOffset = Math.min(1, Math.max(cutOffset, (fillEndMs - lineStartTime) / totalFadeDuration));

          cursor.timeOffset = fillOffset;
          cursor.curPos += movePx * (1 - fraction);
          pushClampedKeyframe();

          cursor.lastTimeMs = fillEndMs;
        }
      } else {
        const endOffset = dur > 0
          ? Math.min(1, Math.max(startOffset, (effectiveEnd - lineStartTime) / totalFadeDuration))
          : startOffset;

        cursor.timeOffset = endOffset;
        cursor.curPos += movePx;
        pushClampedKeyframe();

        cursor.lastTimeMs = effectiveEnd;
      }
    }

    if (cursor.lastTime < 1) {
      cursor.timeOffset = 1;
      pushClampedKeyframe();
    }
    if (cursor.frames.length > 0) {
      cursor.frames[cursor.frames.length - 1].offset = 1;
    }

    return cursor.frames;
  }

  /**
   * Pre-observes syllables across nearby lines using ResizeObserver.
   */
  _initMaskResizeObserver() {
    if (typeof ResizeObserver === "undefined") return;
    if (this._maskResizeObserver) {
      this._maskResizeObserver.disconnect();
      this._maskResizeObserver = null;
    }

    this._maskResizeObserver = new ResizeObserver((entries) => {
      const invalidatedLines = new Set();
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const el = entry.target;
        const newWidth = entry.contentRect ? entry.contentRect.width : 0;
        const newHeight = entry.contentRect ? entry.contentRect.height : 0;
        if (newWidth > 0) {
          const oldWidth = el._roContentWidth;
          el._roContentWidth = newWidth;
          el._roContentHeight = newHeight;
          if (oldWidth !== undefined && Math.abs(oldWidth - newWidth) > 0.5) {
            const owner = el._maskOwnerLine;
            if (owner) {
              owner._maskPreMeasured = false;
              if (owner._maskAnimator) {
                invalidatedLines.add(owner);
              }
            }
          }
        }
      }
      for (const line of invalidatedLines) {
        if (line._maskAnimator) {
          line._maskAnimator.dispose();
        }
      }
    });

    this._maskObservedLines = new Set();
  }

  _observeMaskLine(line) {
    const ro = this._maskResizeObserver;
    if (!ro || !line || line._isGap || line.classList.contains("lyrics-gap")) return;
    const set = this._maskObservedLines;
    if (set.has(line)) return;
    set.add(line);
    let syllables = line._cachedSyllableElements;
    if (!syllables) {
      syllables = Array.from(line.querySelectorAll(".lyrics-syllable"));
      line._cachedSyllableElements = syllables;
    }
    for (let j = 0; j < syllables.length; j++) {
      const syl = syllables[j];
      syl._maskOwnerLine = line;
      ro.observe(syl);
      const chars = syl._cachedCharSpans;
      if (chars) {
        for (let c = 0; c < chars.length; c++) {
          chars[c]._maskOwnerLine = line;
          ro.observe(chars[c]);
        }
      }
    }
  }

  _unobserveMaskLine(line) {
    const ro = this._maskResizeObserver;
    this._maskObservedLines.delete(line);
    const syllables = line._cachedSyllableElements;
    if (!ro || !syllables) return;
    for (let j = 0; j < syllables.length; j++) {
      const syl = syllables[j];
      ro.unobserve(syl);
      syl._maskOwnerLine = null;
      const chars = syl._cachedCharSpans;
      if (chars) {
        for (let c = 0; c < chars.length; c++) {
          const ch = chars[c];
          ro.unobserve(ch);
          ch._maskOwnerLine = null;
        }
      }
    }
  }

  _syncMaskObservation(centerIdx) {
    const lines = this.cachedLyricsLines;
    if (!this._maskResizeObserver || !lines || lines.length === 0) return;
    const lo = Math.max(0, centerIdx - 2);
    const hi = Math.min(lines.length - 1, centerIdx + 6);
    for (const line of this._maskObservedLines) {
      const i = line._idx;
      if (i === undefined || i < lo || i > hi) this._unobserveMaskLine(line);
    }
    for (let i = lo; i <= hi; i++) this._observeMaskLine(lines[i]);
  }

  _hasTrailingInterWordSpace(syl) {
    if (syl._hasInterWordSpace !== undefined) return syl._hasInterWordSpace;
    let wrap = syl.parentElement;
    if (wrap && wrap.classList.contains("lyrics-syllable-letters")) {
      if (syl.nextElementSibling) {
        syl._hasInterWordSpace = false;
        return false;
      }
      wrap = wrap.parentElement;
    }
    if (!wrap || !wrap.classList.contains("lyrics-syllable-wrap") || wrap.nextSibling) {
      syl._hasInterWordSpace = false;
      return false;
    }
    const wordEl = wrap.parentElement;
    const next = wordEl && wordEl.nextSibling;
    const hasSpace = !!(next && next.nodeType === 3 && LyricsPlusRenderer._WHITESPACE_ONLY_RE.test(next.data));
    syl._hasInterWordSpace = hasSpace;
    return hasSpace;
  }

  _getInterWordSpaceWidth(syl, cs) {
    if (!this._hasTrailingInterWordSpace(syl)) return 0;
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    let w = this._getTextWidth(" ", font);
    const letterSpacing = parseFloat(cs.letterSpacing) || 0;
    if (letterSpacing) w += letterSpacing;
    return w;
  }

  /**
   * Resolves and caches computed style metrics per track type (only 1 getComputedStyle call per track),
   * avoiding per-syllable and per-character getComputedStyle overhead.
   */
  _getTrackStyleMetrics(sampleEl, trackCacheKey) {
    let metrics = this._trackStyleCache.get(trackCacheKey);
    if (metrics) return metrics;

    const cs = window.getComputedStyle(sampleEl);
    const isHidden = cs.display === "none";
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padRight = parseFloat(cs.paddingRight) || 0;
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const fontSize = parseFloat(cs.fontSize) || 24;
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const letterSpacing = parseFloat(cs.letterSpacing) || 0;
    const spaceWidth = this._getTextWidth(" ", font) + letterSpacing;
    const direction = cs.direction;

    metrics = {
      isHidden,
      padLeft,
      padRight,
      padH: padLeft + padRight,
      padTop,
      padBottom,
      padV: padTop + padBottom,
      fontSize,
      font,
      letterSpacing,
      spaceWidth,
      direction
    };
    this._trackStyleCache.set(trackCacheKey, metrics);
    return metrics;
  }

  /**
   * Pre-measures syllable and character dimensions for a line during the Clean Read Phase
   * before any DOM class or style mutations occur in the frame.
   */
  _preMeasureLineMask(lineElement) {
    if (!lineElement || lineElement._maskPreMeasured || lineElement._isGap || lineElement.classList.contains("lyrics-gap")) return;
    let syllables = lineElement._cachedSyllableElements;
    if (!syllables) {
      syllables = Array.from(lineElement.querySelectorAll(".lyrics-syllable"));
      lineElement._cachedSyllableElements = syllables;
    }
    if (!syllables || syllables.length === 0) return;

    const container = this._getContainer();
    const useBackgroundWipe = this._isBackgroundWipeEnabled(container);
    const isRomanMode = !!(container && (container.classList.contains("lyrics-romanized") || container.classList.contains("lyrics-both-modes")));
    const lineIsRtl = lineElement.classList.contains("rtl-text") ? "rtl" : "ltr";

    for (let i = 0; i < syllables.length; i++) {
      const syl = syllables[i];
      if (syl.classList.contains("hidden")) continue;

      const containerEl = syl._vocalContainer || (
        syl._vocalContainer = syl.closest(".background-vocal-container, .lyrics-romanization-container, .main-vocal-container") || lineElement
      );
      const isBg = containerEl.classList.contains("background-vocal-container");
      const isRoman = containerEl.classList.contains("lyrics-romanization-container");
      const isTranslit = syl.classList.contains("transliteration");
      if (!isRomanMode && (isTranslit || isRoman)) continue;
      const trackTypeKey = `${isBg ? "bg" : (isRoman ? "rom" : "main")}:${isTranslit ? "t" : "m"}:${lineIsRtl}`;

      const tm = this._getTrackStyleMetrics(syl, trackTypeKey);
      if (tm.isHidden) continue;

      if (!syl._roContentWidth || syl._roContentWidth <= 0) {
        const domWidth = syl.clientWidth - tm.padH;
        if (domWidth > 0) {
          syl._roContentWidth = domWidth;
        }
      }
      if (!syl._roContentHeight || syl._roContentHeight <= 0) {
        const domHeight = syl.clientHeight - tm.padV;
        if (domHeight > 0) {
          syl._roContentHeight = domHeight;
        }
      }

      if (useBackgroundWipe && syl._cachedCharSpans && syl._cachedCharSpans.length > 0) {
        const chars = syl._cachedCharSpans;
        const charTrackKey = `${trackTypeKey}:char`;
        const charTm = this._getTrackStyleMetrics(chars[0], charTrackKey);
        for (let c = 0; c < chars.length; c++) {
          const charSpan = chars[c];
          if (!charSpan._roContentWidth || charSpan._roContentWidth <= 0) {
            const cw = charSpan.clientWidth - charTm.padH;
            if (cw > 0) charSpan._roContentWidth = cw;
          }
          if (!charSpan._roContentHeight || charSpan._roContentHeight <= 0) {
            const ch = charSpan.clientHeight - charTm.padV;
            if (ch > 0) charSpan._roContentHeight = ch;
          }
        }
      }
    }
    lineElement._maskPreMeasured = true;
  }

  /** Drops cached mask animators so they are re-measured on the next frame. */
  _invalidateMaskAnimators(clearDimensions = false) {
    this._trackStyleCache.clear();
    const lines = this.cachedLyricsLines;
    if (!lines) return;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l) continue;
      l._maskPreMeasured = false;
      if (l._maskAnimator) l._maskAnimator.dispose();
      if (clearDimensions && l._bgWrap) {
        l._bgWrap._bgH = undefined;
      }
      if (clearDimensions && l._cachedSyllableElements) {
        const syls = l._cachedSyllableElements;
        for (let j = 0; j < syls.length; j++) {
          const s = syls[j];
          s._roContentWidth = undefined;
          s._roContentHeight = undefined;
          if (s._cachedCharSpans) {
            for (let c = 0; c < s._cachedCharSpans.length; c++) {
              s._cachedCharSpans[c]._roContentWidth = undefined;
              s._cachedCharSpans[c]._roContentHeight = undefined;
            }
          }
        }
      }
    }
    this._clearTextWidthCache();
  }

  /**
   * Builds and attaches WAAPI mask/background wipe animations for a line.
   * All maskImage / maskSize / backgroundImage / backgroundSize properties are embedded
   * directly inside the WAAPI keyframes rather than mutating el.style, completely eliminating
   * inline style attribute invalidations on start and dispose().
   */
  _getOrCreateLineMaskAnimator(lineElement) {
    if (lineElement._maskAnimator) return lineElement._maskAnimator;
    if (lineElement._isGap || lineElement.classList.contains("lyrics-gap")) return null;

    let syllables = lineElement._cachedSyllableElements;
    if (!syllables) {
      syllables = Array.from(lineElement.querySelectorAll(".lyrics-syllable"));
      lineElement._cachedSyllableElements = syllables;
    }
    if (!syllables || syllables.length === 0) return null;

    if (!lineElement._maskPreMeasured) {
      this._preMeasureLineMask(lineElement);
    }

    const container = this._getContainer();
    const useBackgroundWipe = this._isBackgroundWipeEnabled(container);
    const isRomanMode = !!(container && (container.classList.contains("lyrics-romanized") || container.classList.contains("lyrics-both-modes")));
    const lineIsRtl = lineElement.classList.contains("rtl-text") ? "rtl" : "ltr";

    const lineStartTime = lineElement._startTimeMs !== undefined
      ? lineElement._startTimeMs
      : parseFloat(lineElement.dataset.startTime) * 1000;
    let lineEndTime = lineElement._endTimeMs !== undefined
      ? lineElement._endTimeMs
      : parseFloat(lineElement.dataset.endTime) * 1000;
    for (let i = 0; i < syllables.length; i++) {
      const sylEnd = syllables[i]._endTimeMs;
      if (sylEnd !== undefined && sylEnd > lineEndTime) {
        lineEndTime = sylEnd;
      }
    }
    const totalFadeDuration = Math.max(1, lineEndTime - lineStartTime);
    lineElement._maskTotalFadeDuration = totalFadeDuration;

    const containers = [];
    const tracks = new Map();

    for (let i = 0; i < syllables.length; i++) {
      const syl = syllables[i];
      if (syl.classList.contains("hidden")) continue;

      const containerEl = syl._vocalContainer || (
        syl._vocalContainer = syl.closest(".background-vocal-container, .lyrics-romanization-container, .main-vocal-container") || lineElement
      );
      const isBg = containerEl.classList.contains("background-vocal-container");
      const isRoman = containerEl.classList.contains("lyrics-romanization-container");
      const isTranslit = syl.classList.contains("transliteration");
      if (!isRomanMode && (isTranslit || isRoman)) continue;

      let ci = containers.indexOf(containerEl);
      if (ci < 0) ci = containers.push(containerEl) - 1;
      const key = (isTranslit ? "t" : "m") + ci;
      const trackTypeKey = `${isBg ? "bg" : (isRoman ? "rom" : "main")}:${isTranslit ? "t" : "m"}:${lineIsRtl}`;
      const tm = this._getTrackStyleMetrics(syl, trackTypeKey);
      if (tm.isHidden) continue;

      const text = syl._rawText ?? syl.textContent ?? "";
      const start = syl._startTimeMs !== undefined ? syl._startTimeMs : (parseFloat(syl.dataset.startTime) || 0);
      const dur = syl._durationMs !== undefined ? syl._durationMs : (parseFloat(syl.dataset.duration) || 0);

      let width = syl._roContentWidth;
      if (!width || width <= 0) {
        width = text ? this._getTextWidth(text, tm.font) : 1;
      }
      width = Math.max(1, width);
      const gapAfter = this._hasTrailingInterWordSpace(syl) ? tm.spaceWidth : 0;

      let height = syl._roContentHeight;
      if (!height || height <= 0) {
        height = tm.fontSize;
      }

      let wordList = tracks.get(key);
      if (!wordList) {
        wordList = [];
        tracks.set(key, wordList);
      }

      const sylDir = syl.classList.contains("rtl-text") ? "rtl" : tm.direction;

      if (useBackgroundWipe && syl._cachedCharSpans && syl._cachedCharSpans.length > 0) {
        const chars = syl._cachedCharSpans;
        const charTrackKey = `${trackTypeKey}:char`;
        const charTm = this._getTrackStyleMetrics(chars[0], charTrackKey);

        for (let c = 0; c < chars.length; c++) {
          const charSpan = chars[c];
          const cText = charSpan._rawText ?? charSpan.textContent ?? "";
          let charWidth = charSpan._roContentWidth;
          if (!charWidth || charWidth <= 0) {
            charWidth = cText ? this._getTextWidth(cText, charTm.font) : 1;
          }
          charWidth = Math.max(1, charWidth);

          let charHeight = charSpan._roContentHeight;
          if (!charHeight || charHeight <= 0) {
            charHeight = charTm.fontSize || height;
          }

          const cWipeStart = charSpan._wipeStart !== undefined ? charSpan._wipeStart : parseFloat(charSpan.dataset.wipeStart) || (c / chars.length);
          const cWipeDur = charSpan._wipeDuration !== undefined ? charSpan._wipeDuration : parseFloat(charSpan.dataset.wipeDuration) || (1 / chars.length);
          const cStart = start + cWipeStart * dur;
          const cDur = Math.max(0, cWipeDur * dur);

          wordList.push({
            word: cText,
            startTime: cStart,
            endTime: cStart + cDur,
            mainElement: charSpan,
            width: charWidth,
            height: charHeight,
            padding: charTm.padLeft,
            gapAfter: c === chars.length - 1 ? gapAfter : 0,
            rtl: LyricsPlusRenderer._resolveWipeRtl(cText, sylDir),
          });
        }
      } else {
        let segments = null;
        const segSrc = syl._segments;
        if (segSrc && segSrc.length > 1) {
          const full = this._getTextWidth(text.trim(), tm.font);
          if (full > 0) {
            segments = [];
            let acc = "";
            let prevW = 0;
            for (let k = 0; k < segSrc.length; k++) {
              acc += segSrc[k].text;
              const w = k === segSrc.length - 1 ? full : Math.min(full, this._getTextWidth(acc.trim(), tm.font));
              segments.push({
                startTime: segSrc[k].time,
                endTime: segSrc[k].time + segSrc[k].duration,
                frac: Math.max(0, w - prevW) / full,
              });
              prevW = Math.max(prevW, w);
            }
          }
        }

        wordList.push({
          word: text,
          startTime: start,
          endTime: start + dur,
          mainElement: syl,
          width,
          height,
          padding: tm.padLeft,
          gapAfter,
          segments,
          rtl: LyricsPlusRenderer._resolveWipeRtl(text, sylDir),
        });
      }
    }

    const animations = [];
    const boundsMs = []; // [loMs, hiMs] per animation in milliseconds

    tracks.forEach((words) => {
      if (!words.length) return;
      let widthBefore = 0;
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const el = w.mainElement;
        const fadeWidth = w.height * 0.5;
        const totalWordWidth = w.width + w.padding * 2;
        const [gradientImage, totalAspect] = LyricsPlusRenderer._generateFadeGradient(
          fadeWidth / totalWordWidth,
          w.rtl ? "to left" : "to right",
          useBackgroundWipe
        );
        const sizeStr = `${(totalAspect * 100).toFixed(3)}% 100%`;

        const frames = LyricsPlusRenderer._buildMaskFrames(
          words, i, fadeWidth, lineStartTime, totalFadeDuration, w.rtl, widthBefore, useBackgroundWipe, gradientImage, sizeStr
        );
        widthBefore += w.width + (w.gapAfter || 0);

        try {
          const anim = el.animate(frames, { duration: totalFadeDuration, fill: "both" });
          anim.pause();
          animations.push(anim);
          const win = LyricsPlusRenderer._maskStaticWindow(frames);
          boundsMs.push(win[0] * totalFadeDuration, win[1] * totalFadeDuration);
        } catch (err) {
          console.warn("LYPLUS: WAAPI animation creation error:", err);
        }
      }
    });

    if (this._maskResizeObserver && !this._maskObservedLines.has(lineElement)) {
      this._observeMaskLine(lineElement);
    }

    const animator = {
      animations,
      totalFadeDuration,
      _lastT: -1,
      _fillTimer: null,
      _filling: false,
      setCurrentTime(relativeTime) {
        if (this._filling) this.cancelFill();
        const t = Math.min(totalFadeDuration, Math.max(0, relativeTime));
        if (t === this._lastT) return;
        const prev = this._lastT;
        this._lastT = t;
        const len = animations.length;
        if (prev < 0) {
          for (let idx = 0; idx < len; idx++) animations[idx].currentTime = t;
          return;
        }
        for (let idx = 0; idx < len; idx++) {
          const loMs = boundsMs[idx * 2];
          const hiMs = boundsMs[idx * 2 + 1];
          if (t < loMs && prev < loMs) continue;
          if (t > hiMs && prev > hiMs) continue;
          animations[idx].currentTime = t;
        }
      },
      cancelFill() {
        if (this._fillTimer) {
          clearTimeout(this._fillTimer);
          this._fillTimer = null;
        }
        if (this._filling) {
          this._filling = false;
          for (let idx = 0; idx < animations.length; idx++) {
            const anim = animations[idx];
            anim.pause();
            anim.playbackRate = 1;
          }
          this._lastT = -1;
        }
      },
      fillToEnd(durationMs = 250, onDone) {
        if (this._fillTimer) {
          clearTimeout(this._fillTimer);
          this._fillTimer = null;
        }
        const startT = Math.max(0, Math.min(totalFadeDuration, this._lastT));
        const remaining = totalFadeDuration - startT;
        if (!(remaining > 1) || !(durationMs > 0) || animations.length === 0) {
          this.dispose();
          if (onDone) onDone();
          return;
        }
        this._filling = true;
        const rate = remaining / durationMs;
        for (let idx = 0; idx < animations.length; idx++) {
          const anim = animations[idx];
          const hiMs = boundsMs[idx * 2 + 1];
          if (startT >= hiMs) {
            anim.pause();
            anim.currentTime = totalFadeDuration;
          } else {
            anim.currentTime = startT;
            anim.playbackRate = rate;
            anim.play();
          }
        }
        this._fillTimer = setTimeout(() => {
          this._fillTimer = null;
          this._filling = false;
          this.dispose();
          if (onDone) onDone();
        }, durationMs);
      },
      dispose() {
        if (this._fillTimer) {
          clearTimeout(this._fillTimer);
          this._fillTimer = null;
        }
        this._filling = false;
        for (let idx = 0; idx < animations.length; idx++) {
          animations[idx].cancel();
        }
        animations.length = 0;
        lineElement._maskAnimator = null;
      },
    };

    lineElement._maskAnimator = animator;
    return animator;
  }

  static _springProgress(time, response) {
    if (time <= 0) return 0;
    const phase = (2 * Math.PI * time) / Math.max(0.001, response);
    return 1 - (1 + phase) * Math.exp(-phase);
  }

  static _getEmphasisParams(duration, count) {
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const delay = Math.min((duration / count) * 0.4, 0.4);
    const hold = (2 * duration) / count;
    const response = Math.min(3, duration);
    const emphasis = clamp(duration - 1, 0, 1);
    const glow = 0.45 * clamp((duration - 1) / 0.5, 0, 1);
    const spanDuration = hold + response * 2;
    return { delay, hold, response, emphasis, glow, spanDuration };
  }

  static _getEmphasisFrames(duration, count, index, elevationNum = -0.05, elevationUnit = "em") {
    const isFirefox = LyricsPlusRenderer._isFirefox;
    const cache = (LyricsPlusRenderer._emphasisFrameCache ||= new Map());
    const key = `${duration}:${count}:${index}:${elevationNum}:${elevationUnit}:${isFirefox ? 1 : 0}`;
    let frames = cache.get(key);
    if (frames) return frames;

    const SPREAD_EM = 0.05;
    const LIFT_EM = 0.035;
    const { response, hold, emphasis, spanDuration } =
      LyricsPlusRenderer._getEmphasisParams(duration, count);
    const half = Math.max(1, (count - 1) / 2);
    const side = (index - (count - 1) / 2) / half; // -1 .. 1
    const extraRotate = isFirefox ? " rotate(0.0001deg)" : "";

    frames = Array.from({ length: 61 }, (_, frame) => {
      const time = (spanDuration * frame) / 60;
      const rise = frame === 60 ? 1 : LyricsPlusRenderer._springProgress(time, response);
      const envelope = frame === 60
        ? 0
        : LyricsPlusRenderer._springProgress(time, response) *
        (1 - LyricsPlusRenderer._springProgress(time - hold, response));
      const x = side * SPREAD_EM * emphasis * envelope;
      const y = elevationNum * rise - LIFT_EM * emphasis * envelope;
      return {
        offset: frame / 60,
        transform: `translate3d(${x.toFixed(4)}em, ${y.toFixed(4)}${elevationUnit}, 1px) scale(${(1 + 0.1 * emphasis * envelope).toFixed(4)})${extraRotate}`,
      };
    });
    if (cache.size >= 256) cache.delete(cache.keys().next().value);
    cache.set(key, frames);
    return frames;
  }

  _prepareEmphasis(wordSpan, durationMs) {
    const chars = wordSpan._cachedChars;
    if (!chars || chars.length === 0) return;
    const duration = Math.max(0.001, durationMs / 1000);
    const count = chars.length;
    const { delay, response, glow, spanDuration } = LyricsPlusRenderer._getEmphasisParams(duration, count);
    const { num: elevationNum, unit: elevationUnit } = this._getElevationConfig();

    for (let i = 0; i < count; i++) {
      const span = chars[i];
      const startDelay = (i + 1) * delay * 1000;
      span._emphasisFrames = LyricsPlusRenderer._getEmphasisFrames(duration, count, i, elevationNum, elevationUnit);
      span._emphasisTiming = {
        duration: spanDuration * 1000,
        delay: startDelay,
        fill: "both",
        easing: "linear",
      };
      span._emphasisEnd = spanDuration * 1000 + startDelay;
      span._emphasisStartDelay = startDelay;
      span._emphasisElevationNum = elevationNum;
      span._emphasisElevationUnit = elevationUnit;
      span._emphasisGlow = glow > 0;
      span._emphasisResponse = response;
      span._isEmphasisActive = false;
      if (glow > 0) {
        span.setAttribute("data-glyph", span._rawText ?? span.textContent ?? "");
        span.setAttribute("data-glow", "");
        span.style.setProperty("--char-glow-max", `${glow}`);
        span.style.setProperty("--char-glow-duration", `${spanDuration * 1000}ms`);
        span.style.setProperty("--char-glow-delay", `${startDelay}ms`);
      }
    }
  }

  _clearEmphasis(chars) {
    if (!chars) return;
    for (let i = 0; i < chars.length; i++) {
      const span = chars[i];
      if (span._emphasis) {
        span._emphasis.animation.cancel();
        span._emphasis = null;
      }
      if (span._emphasisFall) {
        span._emphasisFall.cancel();
        span._emphasisFall = null;
      }
      if (span._isEmphasisActive) {
        span.classList.remove("emphasis-active");
        span._isEmphasisActive = false;
      }
    }
  }

  _triggerGrowable(syllable, currentTime) {
    const wordElement = syllable.parentElement?.parentElement;
    const chars = wordElement?._cachedChars;
    const isGrowable = (syllable._isGrowable !== undefined)
      ? syllable._isGrowable
      : (wordElement ? wordElement.classList.contains("growable") : false);
    const isFirstSyllable = syllable._syllableIdx !== undefined
      ? syllable._syllableIdx === 0
      : syllable.dataset.syllableIndex === "0";
    if (!isGrowable || !isFirstSyllable || !chars || chars.length === 0) return;

    const startMs = wordElement._wordStartMs ?? syllable._startTimeMs;
    const elapsed = currentTime - startMs;
    if (elapsed < 0) return;

    syllable._emphasisCleanupToken = null;

    for (let i = 0; i < chars.length; i++) {
      const span = chars[i];
      if (!span._emphasisFrames) continue;
      if (span._emphasis) span._emphasis.animation.cancel();
      if (span._emphasisFall) { span._emphasisFall.cancel(); span._emphasisFall = null; }

      if (!span._isEmphasisActive) {
        span.classList.add("emphasis-active");
        span._isEmphasisActive = true;
      }

      const animation = span.animate(span._emphasisFrames, span._emphasisTiming);
      animation.currentTime = Math.min(elapsed, span._emphasisEnd);
      span._emphasis = { animation, end: span._emphasisEnd, startMs, glowEpoch: elapsed };
    }
  }

  _isEmphasisRunning(chars) {
    if (!chars) return false;
    for (let i = 0; i < chars.length; i++) {
      const e = chars[i]._emphasis;
      if (!e) continue;
      const t = Number(e.animation.currentTime);
      if (e.animation.playState !== "finished" && t < e.end) return true;
    }
    return false;
  }

  _deferEmphasisCleanup(syllable, chars) {
    const token = {};
    syllable._emphasisCleanupToken = token;
    const pending = [];
    for (let i = 0; i < chars.length; i++) {
      const a = chars[i]._emphasis?.animation;
      if (a && a.playState !== "finished") {
        pending.push(a.finished);
        this._startEmphasisFall(chars[i]);
      }
    }
    Promise.allSettled(pending).then(() => {
      if (syllable._emphasisCleanupToken !== token) return;
      syllable._emphasisCleanupToken = null;
      this._finishDeferredEmphasis(syllable, chars);
    });
  }

  _startEmphasisFall(span) {
    const e = span._emphasis;
    if (!e) return;
    if (span._emphasisFall) span._emphasisFall.cancel();
    const cur = Number(e.animation.currentTime);
    const remaining = e.end - cur;
    if (!(remaining > 0)) return;

    const response = span._emphasisResponse || 1;
    const delay = span._emphasisStartDelay || 0;
    const elevationNum = span._emphasisElevationNum ?? -0.05;
    const elevationUnit = span._emphasisElevationUnit || "em";
    const fallAmount = -elevationNum;
    const fallMs = Math.min(500, remaining);
    const N = 30;
    const frames = [];
    for (let i = 0; i <= N; i++) {
      const f = i / N;
      const ms = remaining * f;
      const t = (cur + ms - delay) / 1000;
      const rise = i === N ? 1 : LyricsPlusRenderer._springProgress(t, response);
      const r = Math.min(1, ms / fallMs);
      const ramp = r * r * (3 - 2 * r);
      frames.push({ offset: f, translate: `0 ${(fallAmount * rise * ramp).toFixed(4)}${elevationUnit}` });
    }
    span._emphasisFall = span.animate(frames, {
      duration: remaining,
      easing: "linear",
      fill: "forwards",
    });
  }

  _finishDeferredEmphasis(syllable, chars) {
    this._clearEmphasis(chars);
  }

  _scheduleSyllableCleanup(syllable) {
    if (!this._cleanupSet) this._cleanupSet = new Set();
    syllable._cleanupPending = true;
    this._cleanupSet.add(syllable);
    if (!this._cleanupTimer) {
      this._cleanupTimer = setTimeout(() => {
        this._cleanupTimer = null;
        const set = this._cleanupSet;
        if (!set) return;
        for (const syl of set) {
          syl._cleanupPending = false;
          syl.classList.remove("highlight", "finished", "pre-highlight", "cleanup");
          syl._state = 0;
        }
        set.clear();
      }, 16);
    }
  }

  _syncEmphasis(wordElement, currentTime) {
    const chars = wordElement?._cachedChars;
    const first = chars?.[0];
    const entry = first?._emphasis;
    if (!entry) return;
    const elapsed = currentTime - entry.startMs;
    if (elapsed < 0) return;
    if (Math.abs(Number(entry.animation.currentTime) - Math.min(elapsed, entry.end)) <= 200) return;

    for (let i = 0; i < chars.length; i++) {
      const span = chars[i];
      const e = span._emphasis;
      if (!e) continue;
      e.animation.currentTime = Math.min(elapsed, e.end);
      if (elapsed < e.end && e.animation.playState === "finished") e.animation.play();
      if (span._emphasisGlow) {
        for (const eff of span.getAnimations()) {
          if (eff.animationName === "char-glow") {
            eff.currentTime = Math.max(0, elapsed - e.glowEpoch);
            if (elapsed < e.end) eff.play();
          }
        }
      }
    }
  }

  _updateSyllables(currentTime, activeLines) {
    if (!activeLines || activeLines.length === 0) return;

    const activeLinesLength = activeLines.length;

    // Pre-ensure all active lines have their mask animators created before mutating syllable classes
    for (let i = 0; i < activeLinesLength; i++) {
      const parentLine = activeLines[i];
      if (!parentLine) continue;
      const isGapLine = parentLine._isGap || parentLine.classList.contains("lyrics-gap");
      const lineStartTime = parentLine._startTimeMs !== undefined
        ? parentLine._startTimeMs
        : parseFloat(parentLine.dataset.startTime) * 1000;
      const relativeTime = currentTime - lineStartTime;
      const fadeDur = parentLine._maskTotalFadeDuration || (parentLine._endTimeMs - lineStartTime);
      if (parentLine._maskFinished && relativeTime < fadeDur) {
        parentLine._maskFinished = false;
      }
      if (!isGapLine && !parentLine._maskFinished && !parentLine._maskAnimator) {
        this._getOrCreateLineMaskAnimator(parentLine);
      }
    }

    for (let i = 0; i < activeLinesLength; i++) {
      const parentLine = activeLines[i];
      if (!parentLine) continue;

      let syllables = parentLine._cachedSyllableElements;
      if (!syllables) {
        syllables = Array.from(parentLine.querySelectorAll(".lyrics-syllable"));
        parentLine._cachedSyllableElements = syllables;
      }
      const syllablesLength = syllables.length;

      // 1. Advance the continuous WAAPI mask gradient
      const lineStartTime = parentLine._startTimeMs !== undefined
        ? parentLine._startTimeMs
        : parseFloat(parentLine.dataset.startTime) * 1000;
      const relativeTime = currentTime - lineStartTime;
      const animator = parentLine._maskAnimator;
      if (animator) {
        if (relativeTime >= animator.totalFadeDuration) {
          animator.dispose();
          parentLine._maskFinished = true;
          for (let j = 0; j < syllablesLength; j++) {
            const syl = syllables[j];
            if (syl._state !== 3) {
              syl.classList.remove("pre-highlight");
              syl.classList.add("highlight", "finished");
              syl._state = 3;
            }
          }
        } else {
          animator.setCurrentTime(relativeTime);
        }
      }

      // 2. Drive syllable state and growable bounce animations
      for (let j = 0; j < syllablesLength; j++) {
        const syllable = syllables[j];
        const startTime = syllable._startTimeMs;
        if (startTime === undefined) continue;

        const _st = syllable._state || 0;
        const hasHighlight = (_st & 1) !== 0;
        const hasFinished = (_st & 2) !== 0;
        const endTime = syllable._endTimeMs;

        if (currentTime >= startTime && currentTime <= endTime) {
          if (!hasHighlight) {
            syllable.classList.add("highlight");
            syllable._state = (_st & ~4) | 1;
            if (!syllable._isGap) this._triggerGrowable(syllable, currentTime);
          }
          if (hasFinished) {
            syllable.classList.remove("finished");
            syllable._state &= ~2;
          }
          if (hasHighlight && syllable._isGrowable && syllable._syllableIdx === 0) {
            const wordEl = syllable.parentElement?.parentElement;
            if (wordEl?._cachedChars?.[0]?._emphasis) {
              this._syncEmphasis(wordEl, currentTime);
            } else {
              this._triggerGrowable(syllable, currentTime);
            }
          }
        } else if (currentTime > endTime) {
          if (!hasFinished) {
            if (!hasHighlight) {
              syllable.classList.add("highlight");
              syllable._state = (_st & ~4) | 1;
              if (!syllable._isGap) {
                this._triggerGrowable(syllable, currentTime);
              }
            }
            syllable.classList.add("finished");
            syllable._state |= 2;
          }
        } else if (hasHighlight || hasFinished) {
          this._resetSyllable(syllable, true);
        }
      }
    }
  }

  _resetSyllable(syllable, noFade = false, deferEmphasis = false) {
    if (!syllable) return;
    if (syllable._cleanupPending) {
      syllable._cleanupPending = false;
      this._cleanupSet?.delete(syllable);
    }

    const wasActive = (syllable._state & 3) !== 0;
    const hasChars = !!(syllable._cachedCharSpans && syllable._cachedCharSpans.length > 0);

    if (syllable._isGrowable) {
      if (syllable._syllableIdx === 0) {
        const chars = syllable.parentElement?.parentElement?._cachedChars;
        if (deferEmphasis && !noFade && this._isEmphasisRunning(chars)) {
          this._deferEmphasisCleanup(syllable, chars);
        } else {
          syllable._emphasisCleanupToken = null;
          this._clearEmphasis(chars);
        }
      }
    }

    // .cleanup only matches .lyrics-syllable.cleanup span.char in CSS;
    // syllables without span.char children reset directly in a single pass.
    if (noFade || !wasActive || !hasChars) {
      if (wasActive || syllable._state !== 0) {
        syllable.classList.remove("highlight", "finished", "pre-highlight", "cleanup");
        syllable._state = 0;
      }
    } else {
      if (!(syllable._state & 2)) {
        syllable.classList.add("finished");
        syllable._state |= 2;
      }
      syllable.classList.add("cleanup");
      this._scheduleSyllableCleanup(syllable);
    }
  }

  _resetSyllables(line, noFade = false) {
    if (!line) return;
    const wasMaskFinished = !!line._maskFinished;
    line._maskFinished = false;
    let syllables = line._cachedSyllableElements;
    if (!syllables) {
      syllables = Array.from(line.getElementsByClassName("lyrics-syllable"));
      line._cachedSyllableElements = syllables;
    }
    const syllablesLength = syllables.length;

    const animator = line._maskAnimator;
    if (
      !noFade &&
      !wasMaskFinished &&
      animator &&
      animator._lastT > 0 &&
      animator._lastT < animator.totalFadeDuration
    ) {
      for (let i = 0; i < syllablesLength; i++) {
        const syl = syllables[i];
        if (!syl) continue;
        if (syl._cleanupPending) {
          syl._cleanupPending = false;
          this._cleanupSet?.delete(syl);
        }
        if (syl._state !== 3) {
          syl.classList.remove("pre-highlight", "cleanup");
          syl.classList.add("highlight", "finished");
          syl._state = 3;
        }
        if (syl._isGrowable && syl._syllableIdx === 0) {
          const chars = syl.parentElement?.parentElement?._cachedChars;
          if (this._isEmphasisRunning(chars)) {
            this._deferEmphasisCleanup(syl, chars);
          } else {
            syl._emphasisCleanupToken = null;
            this._clearEmphasis(chars);
          }
        }
      }
      animator.fillToEnd(250, () => {
        if (line.classList.contains("active")) return;
        for (let i = 0; i < syllablesLength; i++) {
          const syl = syllables[i];
          if (!syl) continue;
          if (syl._cachedCharSpans && syl._cachedCharSpans.length > 0) {
            syl.classList.add("cleanup");
            this._scheduleSyllableCleanup(syl);
          } else if (syl._state !== 0) {
            syl.classList.remove("highlight", "finished", "pre-highlight", "cleanup");
            syl._state = 0;
          }
        }
      });
      return;
    }

    if (animator) {
      animator.dispose();
    }

    for (let i = 0; i < syllablesLength; i++) {
      this._resetSyllable(syllables[i], noFade, true);
    }
  }

  _clampScrollTop(scroller, top) {
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    return Math.min(max, Math.max(0, top));
  }

  _getScrollPaddingTop() {
    if (this._scrollPaddingTopCache !== undefined) return this._scrollPaddingTopCache;

    const selectors = this.uiConfig.selectors;
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        const style = window.getComputedStyle(element);
        const paddingTopValue =
          style.getPropertyValue("--lyrics-scroll-padding-top") || "25%";
        const result = paddingTopValue.includes("%")
          ? (element.clientHeight || 0) *
          (parseFloat(paddingTopValue) / 100)
          : parseFloat(paddingTopValue) || 0;
        this._scrollPaddingTopCache = result;
        return result;
      }
    }
    const container = this.lyricsContainer?.parentElement;
    const result = container
      ? parseFloat(
        window
          .getComputedStyle(container)
          .getPropertyValue("scroll-padding-top")
      ) || 0
      : 0;
    this._scrollPaddingTopCache = result;
    return result;
  }

  _resolveSpringConfig() {
    const style = getComputedStyle(this.lyricsContainer);
    const readNum = (prop, fallback) => {
      const v = parseFloat(style.getPropertyValue(prop));
      return Number.isFinite(v) ? v : fallback;
    };
    return {
      enabled: style.getPropertyValue('--lyplus-spring-scroll').trim() !== 'false',
      zeta: readNum('--lyplus-spring-zeta', 0.78),
      settleRatio: readNum('--lyplus-spring-settle-ratio', 1.5),
      zetaRelax: readNum('--lyplus-spring-zeta-relax', 0.8),
      dynamicZeta: style.getPropertyValue('--lyplus-spring-dynamic').trim() !== 'false',
      zetaTight: readNum('--lyplus-spring-zeta-tight-gap', LyricsPlusRenderer._SPRING_ZETA_TIGHT_GAP),
      zetaWide: readNum('--lyplus-spring-zeta-wide-gap', LyricsPlusRenderer._SPRING_ZETA_WIDE_GAP),
      settleRatioRelax: readNum('--lyplus-spring-settle-ratio-relax', 1.5)
    };
  }

  _invalidateSpringConfig() {
    this._springConfigCache = null;
  }

  _resolveElevationConfig() {
    const style = this.lyricsContainer ? getComputedStyle(this.lyricsContainer) : null;
    const raw = style ? style.getPropertyValue('--lyplus-lyrics-elevation').trim() : '';
    const fallbackVal = -0.05;
    const fallbackUnit = 'em';
    if (!raw) {
      return { num: fallbackVal, unit: fallbackUnit };
    }
    const num = parseFloat(raw);
    const unitMatch = raw.match(/[a-z%]+$/i);
    return {
      num: Number.isFinite(num) ? num : fallbackVal,
      unit: unitMatch ? unitMatch[0] : fallbackUnit,
    };
  }

  _getElevationConfig() {
    return this._elevationConfigCache || (this._elevationConfigCache = this._resolveElevationConfig());
  }

  _invalidateElevationConfig() {
    this._elevationConfigCache = null;
  }

  /**
   * Applies the new scroll position with a robust buffer logic.
   * Keeps scroll duration and easing in JS without mutating #lyrics-plus-container's inline style
   * attribute (which would force a 1,000+ element inherited custom property recalculation on every scroll).
   *
   * @param {number} newTranslateY - The target Y-axis translation value in pixels.
   * @param {boolean} forceScroll - If true, all animation delays are ignored for instant movement.
   * @param {number} duration - The duration of the scroll animation in milliseconds.
   * @param {object|null} snapshot - Pre-captured scroll geometry snapshot.
   */
  _animateScroll(newTranslateY, forceScroll = false, duration = 300, snapshot = null) {
    if (!this.lyricsContainer) return;
    const parent = snapshot?.scrollContainer || this.lyricsContainer.parentElement;
    if (!parent) return;

    if (!this._scrollAnimationState) {
      this._scrollAnimationState = {
        isAnimating: false,
        pendingUpdate: null
      };
      this._animatingLines = [];
    }

    const state = this._scrollAnimationState;

    const hasGapShifts = !!(this._pendingGapShifts && this._pendingGapShifts.length);
    if (state.isAnimating && !forceScroll && !hasGapShifts) {
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

    const isRelaxMode = this.currentSettings && this.currentSettings.relaxScroll;
    duration = Math.min(450, duration > 0 ? duration : 300);
    duration = isRelaxMode ? duration * 1.5 : duration;

    const cfg = this._springConfigCache || (this._springConfigCache = this._resolveSpringConfig());
    const springEnabled = cfg.enabled;
    let zeta = isRelaxMode ? cfg.zetaRelax : cfg.zeta;
    const gapT = this._scrollGapT;
    if (cfg.dynamicZeta && gapT !== null && gapT !== undefined && !forceScroll) {
      zeta = cfg.zetaTight + (cfg.zetaWide - cfg.zetaTight) * gapT;
      if (isRelaxMode) zeta = Math.min(0.95, zeta + 0.05);
    }
    zeta = Math.round(Math.min(0.97, Math.max(0.3, zeta)) * 50) / 50;
    const settleTail = duration * (isRelaxMode ? cfg.settleRatioRelax : cfg.settleRatio);

    let easing, scrollDuration;
    if (springEnabled) {
      ({ easing, duration: scrollDuration } = LyricsPlusRenderer._getSpringEasing(duration, zeta, settleTail));
    } else {
      easing = null;
      scrollDuration = duration + settleTail;
    }
    const delayIncrement = duration * (isRelaxMode ? 0.05 : 0.1);

    // 1. Read all layout values FIRST (from snapshot if available, or clean DOM)
    let targetTop, prevOffset, clientHeight, referenceIndex, start, end;
    const len = this.cachedLyricsLines.length;

    if (snapshot && !snapshot.hidden) {
      targetTop = snapshot.targetTop;
      prevOffset = -snapshot.scrollTop;
      clientHeight = snapshot.clientHeight;
      referenceIndex = snapshot.referenceIndex;
      start = snapshot.start;
      end = snapshot.end;
    } else {
      targetTop = this._clampScrollTop(parent, -newTranslateY);
      prevOffset = -parent.scrollTop;
      clientHeight = parent.clientHeight;

      const referenceLine =
        this.currentPrimaryActiveLine ||
        this.lastPrimaryActiveLine ||
        this.cachedLyricsLines[0];
      referenceIndex = referenceLine ? this._lineIndex(referenceLine) : -1;

      if (referenceIndex !== -1) {
        let visMin = referenceIndex;
        let visMax = referenceIndex;
        if (this.visibleLineIds.size > 0 && this._lineById) {
          for (const id of this.visibleLineIds) {
            const vi = this._lineById.get(id)?._idx;
            if (vi !== undefined) {
              if (vi < visMin) visMin = vi;
              if (vi > visMax) visMax = vi;
            }
          }
        }
        start = Math.min(visMin, referenceIndex);
        const SCROLL_TAIL_MARGIN_PX = 200;
        const SCROLL_TAIL_MIN_LINES = 3;
        const linesArr = this.cachedLyricsLines;
        const deltaTmp = prevOffset - (-targetTop);
        const reachBottom = targetTop + clientHeight + Math.abs(deltaTmp) + SCROLL_TAIL_MARGIN_PX;
        end = Math.min(len, Math.max(visMax, referenceIndex) + 1);
        while (end < len && linesArr[end].offsetTop < reachBottom) end++;
        end = Math.min(len, end + SCROLL_TAIL_MIN_LINES);
      }
    }

    newTranslateY = -targetTop;
    const delta = prevOffset - newTranslateY;
    this.currentScrollOffset = newTranslateY;

    // 2. Store scroll timing in JS (avoids mutating #lyrics-plus-container's inline style attribute)
    this._lastScrollDurationMs = scrollDuration;
    this._appliedScrollEasing = easing;

    const animatingLines = this._animatingLines;
    const cancelPrev = () => {
      for (let i = 0; i < animatingLines.length; i++) {
        const line = animatingLines[i];
        const a = line._scrollAnim;
        if (a) { a.cancel(); line._scrollAnim = null; }
        line._scrollDelay = 0;
      }
      animatingLines.length = 0;
    };

    const gapShifts = this._pendingGapShifts;
    const gapShiftAt = (i) => {
      if (!gapShifts) return 0;
      let sh = 0;
      for (let g = 0; g < gapShifts.length; g++) if (i > gapShifts[g].idx) sh += gapShifts[g].shift;
      return sh;
    };

    const canAnimate = typeof Element.prototype.animate === 'function';
    const waapiEasing = easing || 'cubic-bezier(.41, 0, .12, .99)';
    const FINAL_TRANSFORM = 'translateY(0px) translateZ(1px)';

    const applyLine = (line, delay, i, dur = scrollDuration, ease = waapiEasing) => {
      if (!canAnimate) return;
      const d = delta - gapShiftAt(i);
      if (!(Math.abs(d) >= 0.5)) return;
      const anim = line.animate(
        [{ transform: `translateY(${d.toFixed(2)}px) translateZ(1px)` }, { transform: FINAL_TRANSFORM }],
        { duration: dur, delay, easing: ease, fill: 'backwards', composite: 'add' }
      );
      line._scrollAnim = anim;
      line._scrollDelay = delay;
      anim.onfinish = () => {
        if (line._scrollAnim === anim) { line._scrollAnim = null; line._scrollDelay = 0; }
        anim.cancel();
      };
      animatingLines.push(line);
    };

    const isFarJump = Math.abs(delta) > clientHeight * LyricsPlusRenderer._NATIVE_SCROLL_DISTANCE_RATIO;

    if (forceScroll || isFarJump) {
      state.isAnimating = false;
      state.pendingUpdate = null;
      const clickSeek = !!this._clickSeekUntil && performance.now() < this._clickSeekUntil;
      if (!clickSeek || !canAnimate) {
        cancelPrev();
        parent.scrollTo({ top: targetTop, behavior: 'smooth' });
        return;
      }
      if (Math.abs(delta) < 0.5) return;

      const prevTop = -prevOffset;
      const margin = 200;
      const oldLo = prevTop - margin;
      const oldHi = prevTop + clientHeight + margin;
      const newLo = targetTop - margin;
      const newHi = targetTop + clientHeight + margin;
      const flipLines = [];
      const flipIdx = [];
      for (let i = 0; i < len; i++) {
        const line = this.cachedLyricsLines[i];
        const top = line.offsetTop;
        const bottom = top + line.offsetHeight;
        if ((bottom > oldLo && top < oldHi) || (bottom > newLo && top < newHi)) {
          flipLines.push(line);
          flipIdx.push(i);
        }
      }

      const flatEasing = 'cubic-bezier(.41, 0, .12, .99)';
      const anchorTop = snapshot && !snapshot.hidden
        ? snapshot.activeOffsetTop
        : targetTop + this._getScrollPaddingTop();
      let anchorIdx = 0;
      for (let i = 0; i < len; i++) {
        if (this.cachedLyricsLines[i].offsetTop <= anchorTop + 1) anchorIdx = i;
        else break;
      }

      parent.scrollTo({ top: targetTop, behavior: 'instant' });
      const flipDuration = 380;
      this._lastScrollDurationMs = flipDuration;
      this._appliedScrollEasing = flatEasing;
      this._scrollAnimT0 = performance.now();

      const maxStagger = 6;
      const down = delta > 0;
      let counter = 0;
      if (down) {
        for (let k = 0; k < flipLines.length; k++) {
          const i = flipIdx[k];
          const line = flipLines[k];
          if (i > anchorIdx && !line._isGap) counter++;
          const delay = i > anchorIdx ? Math.min(counter, maxStagger) * delayIncrement : 0;
          applyLine(line, delay, i, flipDuration, flatEasing);
        }
      } else {
        for (let k = flipLines.length - 1; k >= 0; k--) {
          const i = flipIdx[k];
          const line = flipLines[k];
          if (i < anchorIdx && !line._isGap) counter++;
          let delay = i < anchorIdx ? Math.min(counter, maxStagger) * delayIncrement : 0;
          if (isRelaxMode) delay = delay / 2;
          applyLine(line, delay, i, flipDuration, flatEasing);
        }
      }
      return;
    }

    if (referenceIndex === -1 || referenceIndex === undefined) {
      cancelPrev();
      return;
    }

    let totalShift = 0;
    if (gapShifts) for (let g = 0; g < gapShifts.length; g++) totalShift += gapShifts[g].shift;
    const newIndex = this._lastActiveIndex;
    let scrollingDown;
    if (newIndex > referenceIndex) scrollingDown = true;
    else if (newIndex < referenceIndex) scrollingDown = false;
    else scrollingDown = (delta - totalShift) >= 0;


    state.isAnimating = true;
    const BASE_DURATION = 400;

    this._scrollUnlockTimeout = setTimeout(() => {
      state.isAnimating = false;

      if (state.pendingUpdate !== null) {
        let pendingValue = state.pendingUpdate;
        state.pendingUpdate = null;
        const primary = this.currentPrimaryActiveLine;
        if (primary && primary.isConnected && !this.isUserControllingScroll) {
          pendingValue = this._getScrollPaddingTop() - primary.offsetTop;
        }
        this._animateScroll(pendingValue, false);
      }
    }, BASE_DURATION);

    parent.scrollTo({ top: targetTop, behavior: 'instant' });
    cancelPrev();
    this._scrollAnimT0 = performance.now();

    if (scrollingDown) {
      const staggerAfterIndex = Math.max(
        referenceIndex,
        this._lastActiveIndex || 0,
        this._lastActiveGroupEndIndex || 0
      );
      let delayCounter = 0;
      for (let i = start; i < end; i++) {
        const line = this.cachedLyricsLines[i];
        if (i > staggerAfterIndex && !line._isGap) delayCounter++;
        const delay = i > staggerAfterIndex ? delayCounter * delayIncrement : 0;
        applyLine(line, delay, i);
      }
    } else {
      let delayCounter = 0;
      for (let i = end - 1; i >= start; i--) {
        const line = this.cachedLyricsLines[i];
        let delay = i <= referenceIndex ? delayCounter * delayIncrement : 0;
        if (i <= referenceIndex && !line._isGap) delayCounter++;
        if (isRelaxMode) delay = delay / 2;
        applyLine(line, delay, i);
      }
    }
  }


  _resetGapState() {
    if (this._gapCloseTimers) for (const t of this._gapCloseTimers.values()) clearTimeout(t);
    this._gapCloseTimers = new Map();
    this._openGaps = new Set();
    this._pendingGapShifts = null;
  }

  /**
   * Opens/closes the layout box of a gap line (instantly, class 'gap-open').
   * Caches the measured gap height to avoid repeated forced reflows when opening/closing gaps.
   * @returns {number} signed change of its height (+h opened, -h closed, 0 when nothing changed)
   */
  _setGapOpen(line, open) {
    if (!line || !line._isGap || line.classList.contains("gap-open") === open) return 0;
    if (!this._openGaps) this._resetGapState();

    if (open) {
      line.classList.add("gap-open");
      this._openGaps.add(line);
      if (this._cachedGapHeight > 0) return this._cachedGapHeight;
      const inFlow = line.offsetParent !== null && getComputedStyle(line).position !== "absolute";
      const h = inFlow ? line.offsetHeight : 0;
      if (h > 0) this._cachedGapHeight = h;
      return h;
    }

    let h = this._cachedGapHeight;
    if (!(h > 0)) {
      const inFlow = line.offsetParent !== null && getComputedStyle(line).position !== "absolute";
      h = inFlow ? line.offsetHeight : 0;
      if (h > 0) this._cachedGapHeight = h;
    }
    line.classList.remove("gap-open");
    this._openGaps.delete(line);
    return -h;
  }

  _lineIndex(line) {
    const lines = this.cachedLyricsLines;
    if (!lines) return -1;
    return (line._idx !== undefined && lines[line._idx] === line) ? line._idx : lines.indexOf(line);
  }

  _syncGapLayout(newPrimary, force, activeLines, activeCount) {
    if (!this.cachedLyricsLines) return null;
    if (!this._openGaps) this._resetGapState();
    let out = null;
    const add = (line, shift) => {
      if (!shift) return;
      const idx = this._lineIndex(line);
      if (idx < 0) return;
      (out || (out = [])).push({ idx, shift });
    };

    const needOpen = (l) => {
      this._cancelGapClose(l);
      add(l, this._setGapOpen(l, true));
    };
    if (newPrimary && newPrimary._isGap) needOpen(newPrimary);
    for (let i = 0; i < activeCount; i++) {
      const l = activeLines[i];
      if (l && l._isGap && l !== newPrimary) needOpen(l);
    }

    if (this._openGaps.size > 0) {
      for (const g of Array.from(this._openGaps)) {
        if (g === newPrimary || g.classList.contains("active")) continue;
        if (!g.isConnected) { this._openGaps.delete(g); continue; }
        if (force) this._scheduleGapClose(g);
        else add(g, this._setGapOpen(g, false));
      }
    }
    return out;
  }

  /** Active gap but no scroll tick this frame (user is scrolling): open it without a scroll. */
  _openActiveGapsNow(activeLines, activeCount) {
    for (let i = 0; i < activeCount; i++) {
      const l = activeLines[i];
      if (!l || !l._isGap) continue;
      this._cancelGapClose(l);
      if (!l.classList.contains("gap-open")) this._openGapUnanimated(l);
    }
  }

  _scheduleHiddenGapCloses() {
    if (!this._openGaps) return;
    for (const g of this._openGaps) {
      if (g.classList.contains("active")) continue;
      this._scheduleGapClose(g);
    }
  }

  _openGapUnanimated(line) {
    const scroller = this.lyricsContainer && this.lyricsContainer.parentElement;
    const lineTopBefore = scroller ? line.offsetTop : 0;
    const scrollTopBefore = scroller ? scroller.scrollTop : 0;
    const maxScrollBefore = scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0;
    const h = this._setGapOpen(line, true);
    if (h < 0.5) return;
    const idx = this._lineIndex(line);
    if (idx < 0) return;
    let rest = h;
    if (scroller && lineTopBefore <= scrollTopBefore) {
      const nextTop = Math.min(maxScrollBefore + h, Math.max(0, scrollTopBefore + h));
      scroller.scrollTo({ top: nextTop, behavior: "instant" });
      const applied = nextTop - scrollTopBefore;
      this.currentScrollOffset = -nextTop;
      const st = this._scrollAnimationState;
      if (st && st.pendingUpdate !== null) st.pendingUpdate -= applied;
      rest = h - applied;
    }
    if (Math.abs(rest) >= 0.5) this._flipGapShifts([{ idx, shift: rest }]);
  }

  _cancelGapClose(line) {
    const t = this._gapCloseTimers && this._gapCloseTimers.get(line);
    if (t) {
      clearTimeout(t);
      this._gapCloseTimers.delete(line);
    }
  }

  /** Apple-style: let the dots play their hide animation, then fix the layout. */
  _scheduleGapClose(line) {
    if (!this._gapCloseTimers) this._resetGapState();
    if (this._gapCloseTimers.has(line)) return;
    const HIDE_MS = 850;
    this._gapCloseTimers.set(line, setTimeout(() => {
      this._gapCloseTimers.delete(line);
      this._closeGapAfterHide(line);
    }, HIDE_MS));
  }

  _closeGapAfterHide(line) {
    if (!line.isConnected || !line.classList.contains("gap-open")) return;
    if (line.classList.contains("active")) return;
    if (this.isUserControllingScroll) {
      this._closeGapUnanimated(line);
      return;
    }
    if (line === this.currentPrimaryActiveLine) return;
    const idx = this._lineIndex(line);
    if (idx < 0) return;
    const primary = this.currentPrimaryActiveLine;
    if (!primary) return;

    // Read snapshot BEFORE mutating gap-open class
    let h = this._cachedGapHeight;
    if (!(h > 0)) {
      const inFlow = line.offsetParent !== null && getComputedStyle(line).position !== "absolute";
      h = inFlow ? line.offsetHeight : 0;
      if (h > 0) this._cachedGapHeight = h;
    }
    if (!h) return;
    const shift = -h;
    const primaryIdx = this._lineIndex(primary);
    const aboveDelta = idx < primaryIdx ? shift : 0;
    const snapshot = this._captureScrollSnapshot(primary, aboveDelta, shift);

    line.classList.remove("gap-open");
    this._openGaps.delete(line);

    this._pendingGapShifts = [{ idx, shift }];
    this._scrollToActiveLine(primary, false, false, 300, snapshot);
    this._pendingGapShifts = null;
  }

  _flipGapShifts(shifts) {
    const lines = this.cachedLyricsLines;
    if (!shifts || !lines || typeof Element.prototype.animate !== "function") return;
    let visMin = Infinity;
    let visMax = -1;
    if (this.visibleLineIds.size > 0 && this._lineById) {
      for (const id of this.visibleLineIds) {
        const v = this._lineById.get(id)?._idx;
        if (v === undefined) continue;
        if (v < visMin) visMin = v;
        if (v > visMax) visMax = v;
      }
    }
    if (visMax < 0) return;
    const last = Math.min(lines.length, visMax + 2);
    for (const g of shifts) {
      const stagger = this.isUserControllingScroll || g.shift > 0 ? 0 : 40;
      let n = 0;
      for (let i = Math.max(g.idx + 1, visMin - 1); i < last; i++) {
        const line = lines[i];
        LyricsPlusRenderer._flipTranslateY(line, -g.shift, 350, "cubic-bezier(.41, 0, .12, .99)", n * stagger);
        if (!line._isGap) n++;
      }
    }
  }

  _closeGapUnanimated(line) {
    const idx = this._lineIndex(line);
    const scroller = this.lyricsContainer && this.lyricsContainer.parentElement;
    const topBefore = line.offsetTop;
    const scrollTopBefore = scroller ? scroller.scrollTop : 0;
    const maxScrollBefore = scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0;
    const above = scroller ? topBefore <= scrollTopBefore : false;
    const shift = this._setGapOpen(line, false);
    if (!shift || idx < 0) return;
    let rest = shift;
    if (scroller && above) {
      const nextTop = Math.min(Math.max(0, maxScrollBefore + shift), Math.max(0, scrollTopBefore + shift));
      scroller.scrollTo({ top: nextTop, behavior: "instant" });
      const applied = nextTop - scrollTopBefore;
      this.currentScrollOffset = -nextTop;
      const st = this._scrollAnimationState;
      if (st && st.pendingUpdate !== null) st.pendingUpdate -= applied;
      rest = shift - applied;
    }
    if (Math.abs(rest) >= 0.5) this._flipGapShifts([{ idx, shift: rest }]);
  }

  _closeHiddenGaps(skipPrimary = true) {
    if (!this._openGaps || this._openGaps.size === 0) return;
    for (const g of Array.from(this._openGaps)) {
      if (!g.isConnected) { this._openGaps.delete(g); continue; }
      if (g.classList.contains("active")) continue;
      if (skipPrimary && g === this.currentPrimaryActiveLine) continue;
      this._cancelGapClose(g);
      this._closeGapUnanimated(g);
    }
  }

  _updatePositionClassesAndScroll(lineToScroll, forceScroll = false, durationScroll = 300, snapshot = null) {
    if (
      !this.lyricsContainer ||
      !this.cachedLyricsLines ||
      this.cachedLyricsLines.length === 0
    )
      return;
    const scrollLineIndex = (lineToScroll._idx !== undefined && this.cachedLyricsLines[lineToScroll._idx] === lineToScroll)
      ? lineToScroll._idx
      : this.cachedLyricsLines.indexOf(lineToScroll);
    if (scrollLineIndex === -1) return;

    // 1. Capture layout snapshot and execute scroll FIRST (before mutating position classes)
    if (!snapshot) {
      snapshot = this._captureScrollSnapshot(lineToScroll);
    }
    this._scrollToActiveLine(lineToScroll, forceScroll, false, durationScroll, snapshot);
    this._updatePictureInPictureActiveLine(lineToScroll);

    // 2. Apply position classes after scrollTo so scrollTo never triggers a synchronous style recalc
    const prevClassed = this._positionClassedLines;
    const nextClassed = this._nextPositionClassedLines;
    nextClassed.length = 0;

    if (forceScroll && prevClassed.length > 0) {
      for (let i = 0; i < prevClassed.length; i++) {
        const el = prevClassed[i];
        if (el._posCls) {
          el.classList.remove(el._posCls);
          el._posCls = null;
        }
      }
      prevClassed.length = 0;
    }

    const gen = (this._posGen = (this._posGen || 0) + 1);
    const assign = (el, cls) => {
      el._posGen = gen;
      if (el._posCls !== cls) {
        if (el._posCls) el.classList.remove(el._posCls);
        el.classList.add(cls);
        el._posCls = cls;
      }
      nextClassed.push(el);
    };
    assign(lineToScroll, "lyrics-activest");
    const elements = this.cachedLyricsLines;
    const targetPastEnd = scrollLineIndex - 1;

    if (forceScroll || this._lastPastLineIndex === -1 || Math.abs((this._lastPastLineIndex ?? -1) - targetPastEnd) > 5) {
      for (let i = 0; i <= targetPastEnd && i < elements.length; i++) {
        elements[i].classList.add("past-line");
      }
      for (let i = Math.max(0, targetPastEnd + 1); i < elements.length; i++) {
        elements[i].classList.remove("past-line");
      }
    } else if (this._lastPastLineIndex < targetPastEnd) {
      for (let i = this._lastPastLineIndex + 1; i <= targetPastEnd && i < elements.length; i++) {
        elements[i].classList.add("past-line");
      }
    } else if (this._lastPastLineIndex > targetPastEnd) {
      for (let i = targetPastEnd + 1; i <= this._lastPastLineIndex && i < elements.length; i++) {
        elements[i].classList.remove("past-line");
      }
    }
    this._lastPastLineIndex = targetPastEnd;

    for (
      let i = Math.max(0, scrollLineIndex - 4);
      i <= Math.min(elements.length - 1, scrollLineIndex + 4);
      i++
    ) {
      const position = i - scrollLineIndex;
      if (position === 0) continue;
      const element = elements[i];
      assign(
        element,
        position === -1 ? "post-active-line"
          : position === 1 ? "next-active-line"
            : position < 0 ? `prev-${-position}` : `next-${position}`
      );
    }
    for (let _pi = 0; _pi < prevClassed.length; _pi++) {
      const el = prevClassed[_pi];
      if (el._posGen !== gen && el._posCls) {
        el.classList.remove(el._posCls);
        el._posCls = null;
      }
    }
    this._positionClassedLines = nextClassed;
    this._nextPositionClassedLines = prevClassed;
    this._syncMaskObservation(scrollLineIndex);
  }

  _scrollToActiveLine(activeLine, forceScroll = false, isResize = false, durationScroll = 300, snapshot = null) {
    if (!activeLine || !this.lyricsContainer) return;

    if (!snapshot) {
      snapshot = this._captureScrollSnapshot(activeLine);
    }
    if (!snapshot || snapshot.hidden) return;

    const scrollContainer = snapshot.scrollContainer;
    const targetScrollTop = snapshot.targetTop;
    const targetTranslateY = -targetScrollTop;

    if (
      !forceScroll &&
      !(this._pendingGapShifts && this._pendingGapShifts.length) &&
      Math.abs(snapshot.scrollTop - targetScrollTop) < 1
    ) {
      return;
    }

    if (this.isUserControllingScroll || this.lyricsContainer.classList.contains("user-scrolling")) {
      this.lyricsContainer.classList.remove("not-focused", "user-scrolling");
      this.isUserControllingScroll = false;
    }
    clearTimeout(this.userScrollIdleTimer);

    if (isResize) {
      this.currentScrollOffset = targetTranslateY;
      scrollContainer.scrollTo({ top: -targetTranslateY, behavior: 'instant' });
    } else {
      this._animateScroll(targetTranslateY, forceScroll, durationScroll, snapshot);
    }
  }

  _setupVisibilityTracking() {
    const container = this._getContainer();
    if (!container || !container.parentElement) return null;
    if (this.visibilityObserver) this.visibilityObserver.disconnect();

    if (!this._visibilityChanges) this._visibilityChanges = [];
    else this._visibilityChanges.length = 0;

    this.visibilityObserver = new IntersectionObserver(
      (entries) => {
        const hideOffscreen = !!(this.lyricsContainer && this.lyricsContainer.classList.contains("hide-offscreen"));
        for (let ei = 0; ei < entries.length; ei++) {
          const entry = entries[ei];
          const target = entry.target;
          const id = target.id;

          if (entry.isIntersecting) {
            if (!this.visibleLineIds.has(id)) {
              this.visibleLineIds.add(id);
              if (hideOffscreen) this._visibilityChanges.push(target);
            }
          } else {
            if (this.visibleLineIds.has(id)) {
              this.visibleLineIds.delete(id);
              if (hideOffscreen) this._visibilityChanges.push(target);
            }
          }
        }
        if (hideOffscreen && this._visibilityChanges.length > 0) {
          this._batchUpdateViewportVisibility();
        }
      },
      { root: container.parentElement, rootMargin: "200px 0px", threshold: 0.1 }
    );

    if (this.cachedLyricsLines) {
      for (let i = 0; i < this.cachedLyricsLines.length; i++) {
        const line = this.cachedLyricsLines[i];
        if (line) this.visibilityObserver.observe(line);
      }
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
        if (this._rtlNeedsInitialLayout && container.clientWidth > 0) {
          this._lastContainerWidth = container.clientWidth;
          this._layoutAllRtlVisualRowRomanizations();
          this._invalidateMaskAnimators(true);
        }
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
    this._updateWakeLock();
  }

  _createControlButtons() {
    this.buttonsWrapper = document.getElementById("lyrics-plus-buttons-wrapper");

    if (!this.buttonsWrapper) {
      this.buttonsWrapper = document.createElement("div");
      this.buttonsWrapper.id = "lyrics-plus-buttons-wrapper";
      const originalLyricsSection = document.querySelector(
        this.uiConfig.buttonParent || this.uiConfig.patchParent
      );
      if (originalLyricsSection) {
        originalLyricsSection.appendChild(this.buttonsWrapper);
      }
    }

    if (!this._boundDocumentClickHandler) {
      this._boundDocumentClickHandler = (event) => {
        if (
          this.dropdownMenu &&
          !this.dropdownMenu.classList.contains("hidden") &&
          !this.dropdownMenu.contains(event.target) &&
          event.target !== this.translationButton &&
          !this.translationButton?.contains(event.target)
        ) {
          this.dropdownMenu.classList.add("hidden");
        }
        if (
          this.optionsDropdown &&
          !this.optionsDropdown.classList.contains("hidden") &&
          !this.optionsDropdown.contains(event.target) &&
          event.target !== this.reloadButton &&
          !this.reloadButton?.contains(event.target)
        ) {
          this.optionsDropdown.classList.add("hidden");
        }
      };
      document.addEventListener("click", this._boundDocumentClickHandler);
    }

    if (this.setCurrentDisplayModeAndRefetchFn && this.currentLyricsType !== "None") {
      if (!this.translationButton) {
        this.translationButton = document.createElement("button");
        this.translationButton.id = "lyrics-plus-translate-button";
        this.buttonsWrapper.appendChild(this.translationButton);
        this._updateTranslationButtonText();

        this.translationButton.addEventListener("click", (event) => {
          event.stopPropagation();
          if (this.optionsDropdown) this.optionsDropdown.classList.add("hidden");
          this._createDropdownMenu(this.buttonsWrapper);
          if (this.dropdownMenu) {
            this.dropdownMenu.classList.toggle("hidden");
            this._clampDropdownToViewport(this.dropdownMenu);
          }
        });
      } else if (!this.buttonsWrapper.contains(this.translationButton)) {
        this.buttonsWrapper.appendChild(this.translationButton);
      }
    }

    if (!this.reloadButton) {
      this.reloadButton = document.createElement("button");
      this.reloadButton.id = "lyrics-plus-reload-button";
      this.reloadButton.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px"><path d="M480-192q-120 0-204-84t-84-204q0-120 84-204t204-84q65 0 120.5 27t95.5 72v-99h72v240H528v-72h131q-29-44-76-70t-103-26q-90 0-153 63t-63 153q0 90 63 153t153 63q84 0 144-55.5T693-456h74q-9 112-91 188t-196 76Z"/></svg>';
      this.reloadButton.title = t("lyricsOptions") || t("refreshLyrics") || "Lyrics Options";
      this.buttonsWrapper.appendChild(this.reloadButton);

      this.reloadButton.addEventListener("click", (event) => {
        event.stopPropagation();
        if (this.dropdownMenu) this.dropdownMenu.classList.add("hidden");
        this._createOptionsMenu(this.buttonsWrapper);
        if (this.optionsDropdown) {
          this.optionsDropdown.classList.toggle("hidden");
          this._clampDropdownToViewport(this.optionsDropdown);
        }
      });
    } else if (!this.buttonsWrapper.contains(this.reloadButton)) {
      this.buttonsWrapper.appendChild(this.reloadButton);
    }
  }

  /**
   * Creates a single clickable dropdown option element.
   * @param {string} labelKey - The i18n key for the option label.
   * @param {string} iconSvg - SVG markup for the option icon.
   * @param {Function} onClick - Click handler; the menu is hidden automatically before it fires.
   * @returns {HTMLDivElement}
   * @private
   */
  _createDropdownOption(labelKey, iconSvg, onClick) {
    const optionDiv = document.createElement("div");
    optionDiv.className = "dropdown-option";
    const textSpan = document.createElement("span");
    textSpan.textContent = t(labelKey);
    const iconDiv = document.createElement("div");
    iconDiv.className = "dropdown-icon";
    iconDiv.innerHTML = iconSvg;
    optionDiv.appendChild(textSpan);
    optionDiv.appendChild(iconDiv);
    optionDiv.addEventListener("click", () => {
      this.dropdownMenu.classList.add("hidden");
      onClick();
    });
    return optionDiv;
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

    const dispatchModeChange = (newMode) => {
      if (this.setCurrentDisplayModeAndRefetchFn && this.lastKnownSongInfo) {
        this.setCurrentDisplayModeAndRefetchFn(newMode, this.lastKnownSongInfo);
      }
    };

    if (!hasTranslation) {
      this.dropdownMenu.appendChild(
        this._createDropdownOption("showTranslation", translationIconSVG, () => {
          dispatchModeChange(this.currentDisplayMode === "romanize" ? "both" : "translate");
        })
      );
    }

    if (hasTranslation) {
      this.dropdownMenu.appendChild(
        this._createDropdownOption("hideTranslation", hideTranslationIconSVG, () => {
          dispatchModeChange(this.currentDisplayMode === "both" ? "romanize" : "none");
        })
      );
    }

    if (!hasRomanization) {
      const romanizeLabel = this.largerTextMode == "romanization" ? "showOriginal" : "showPronunciation";
      this.dropdownMenu.appendChild(
        this._createDropdownOption(romanizeLabel, textIconSVG, () => {
          dispatchModeChange(this.currentDisplayMode === "translate" ? "both" : "romanize");
        })
      );
    }

    if (hasRomanization) {
      const hideLabel = this.largerTextMode == "romanization" ? "hideOriginal" : "hidePronunciation";
      this.dropdownMenu.appendChild(
        this._createDropdownOption(hideLabel, hideTextIconSVG, () => {
          dispatchModeChange(this.currentDisplayMode === "both" ? "translate" : "none");
        })
      );
    }
  }

  _updateTranslationButtonText() {
    if (!this.translationButton) return;
    this.translationButton.innerHTML = `<svg width="16" height="12" viewBox="0 0 16 12" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:1.5em;height:1.5em;vertical-align:middle;">
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
    this.translationButton.title = t("showTranslationOptions") || "Translation";
  }

  _createOptionsMenu(parentWrapper) {
    if (this.optionsDropdown) {
      this.optionsDropdown.innerHTML = "";
    } else {
      this.optionsDropdown = document.createElement("div");
      this.optionsDropdown.id = "lyrics-plus-options-dropdown";
      this.optionsDropdown.className = "lyrics-plus-menu-dropdown hidden";
      parentWrapper?.appendChild(this.optionsDropdown);
    }
    this._renderOptionsMenuMain();
  }

  _renderOptionsMenuMain() {
    if (!this.optionsDropdown) return;
    this.optionsDropdown.innerHTML = "";

    const chevronSvg = '<svg class="dropdown-chevron-svg" width="16" height="16" viewBox="0 0 24 24"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/></svg>';
    const reloadSvg = '<svg class="dropdown-item-icon-svg" width="16" height="16" viewBox="0 0 24 24"><path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>';

    const offsetOpt = document.createElement("div");
    offsetOpt.className = "dropdown-option";
    const offsetDisplay = this.userOffsetMs ? `${this.userOffsetMs > 0 ? '+' : ''}${this.userOffsetMs}ms` : '0ms';
    offsetOpt.innerHTML = `
      <span class="dropdown-item-label">${t("offsetLyrics") || "Lyrics Offset"}</span>
      <div class="dropdown-item-right">
        <span class="lyrics-option-value-preview">${offsetDisplay}</span>
        ${chevronSvg}
      </div>
    `;
    offsetOpt.addEventListener("click", (e) => {
      e.stopPropagation();
      this._renderOptionsMenuOffset();
    });
    this.optionsDropdown.appendChild(offsetOpt);

    const { providerKeys, activeProvider, providerDisplayNames, pinnedProvider } = (this.getProviderContextFn || getLyricsProviderContext)(
      this.lastKnownSongInfo,
      this.currentLyrics,
      this.currentSettings,
      this._userSelectedProvider
    );

    let availableList;
    if (this.availableProviders && this.availableProviders.size > 0) {
      availableList = Array.from(this.availableProviders).filter(p => !this._notFoundProviders?.has(p.toLowerCase()));
    } else {
      availableList = (providerKeys || []).filter(p => !this._notFoundProviders?.has(p.toLowerCase()));
    }

    if (availableList.length > 1 || pinnedProvider) {
      const sourceOpt = document.createElement("div");
      sourceOpt.className = "dropdown-option";
      const activeProviderName = providerDisplayNames[activeProvider] || (activeProvider ? activeProvider.charAt(0).toUpperCase() + activeProvider.slice(1) : "");
      const pinBadge = pinnedProvider ? " (Pinned)" : "";
      sourceOpt.innerHTML = `
        <span class="dropdown-item-label">${t("changeLyricsSource") || "Change Lyrics Source"}</span>
        <div class="dropdown-item-right">
          <span class="lyrics-option-value-preview">${activeProviderName}${pinBadge}</span>
          ${chevronSvg}
        </div>
      `;
      sourceOpt.addEventListener("click", (e) => {
        e.stopPropagation();
        this._renderOptionsMenuSources();
        this._clampDropdownToViewport(this.optionsDropdown);
      });
      this.optionsDropdown.appendChild(sourceOpt);
    }

    const sep = document.createElement("div");
    sep.className = "dropdown-separator";
    this.optionsDropdown.appendChild(sep);

    const reloadOpt = document.createElement("div");
    reloadOpt.className = "dropdown-option";
    reloadOpt.innerHTML = `
      <span class="dropdown-item-label">${t("reloadLyrics") || t("refreshLyrics") || "Reload Lyrics"}</span>
      ${reloadSvg}
    `;
    reloadOpt.addEventListener("click", () => {
      this.optionsDropdown.classList.add("hidden");
      if (this.lastKnownSongInfo && this.fetchAndDisplayLyricsFn) {
        this.fetchAndDisplayLyricsFn(this.lastKnownSongInfo, true, true);
      }
    });
    this.optionsDropdown.appendChild(reloadOpt);
  }

  _renderOptionsMenuOffset() {
    if (!this.optionsDropdown) return;
    this.optionsDropdown.innerHTML = "";

    const backSvg = '<svg class="dropdown-back-svg" width="18" height="18" viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>';

    const backOpt = document.createElement("div");
    backOpt.className = "dropdown-header-back";
    backOpt.innerHTML = `${backSvg} <span>${t("offsetLyrics") || "Lyrics Offset"}</span>`;
    backOpt.addEventListener("click", (e) => {
      e.stopPropagation();
      this._renderOptionsMenuMain();
      this._clampDropdownToViewport(this.optionsDropdown);
    });
    this.optionsDropdown.appendChild(backOpt);

    const sep = document.createElement("div");
    sep.className = "dropdown-separator";
    this.optionsDropdown.appendChild(sep);

    const panel = document.createElement("div");
    panel.className = "dropdown-offset-panel";

    const ms = this.userOffsetMs || 0;
    const formatted = `${ms > 0 ? '+' : ''}${ms} ms`;

    panel.innerHTML = `
      <div class="offset-display-row">
        <div class="offset-current-value">${formatted}</div>
      </div>
      <div class="offset-stepper-row">
        <button class="offset-step-pill" data-step="-100" type="button">-100ms</button>
        <button class="offset-step-pill" data-step="-10" type="button">-10ms</button>
        <button class="offset-step-pill" data-step="10" type="button">+10ms</button>
        <button class="offset-step-pill" data-step="100" type="button">+100ms</button>
      </div>
      <div class="offset-reset-row" style="${ms === 0 ? 'display: none;' : ''}">
        <button class="offset-reset-link" type="button">${t("reset") || "Reset to 0ms"}</button>
      </div>
    `;

    panel.querySelectorAll(".offset-step-pill").forEach((btn) => {
      this._attachHoldRepeat(btn, () => {
        const step = parseInt(btn.dataset.step, 10) || 0;
        this._adjustOffset((this.userOffsetMs || 0) + step);
      });
    });

    panel.querySelector(".offset-reset-link").addEventListener("click", (e) => {
      e.stopPropagation();
      this._adjustOffset(0);
    });

    this.optionsDropdown.appendChild(panel);
    this._clampDropdownToViewport(this.optionsDropdown);
  }

  setAvailableProviders(providers) {
    if (!this.availableProviders) this.availableProviders = new Set();
    if (Array.isArray(providers)) {
      providers.forEach(p => {
        if (p && !this._notFoundProviders?.has(p.toLowerCase())) {
          this.availableProviders.add(p.toLowerCase());
        }
      });
    }
    const activeProvider = (
      this._userSelectedProvider ||
      this.currentLyrics?.provider ||
      this.currentLyrics?.metadata?.provider ||
      detectLyricsProviderFromSource(this.currentLyrics?.metadata?.source)
    );
    if (activeProvider) {
      this.availableProviders.add(activeProvider.toLowerCase());
    }

    if (this.optionsDropdown && !this.optionsDropdown.classList.contains("hidden")) {
      const isSubmenu = this.optionsDropdown.querySelector(".dropdown-header-back");
      if (isSubmenu) {
        this._renderOptionsMenuSources();
      } else {
        this._renderOptionsMenuMain();
      }
    }
  }

  _renderOptionsMenuSources() {
    if (!this.optionsDropdown) return;
    this.optionsDropdown.innerHTML = "";

    const backSvg = '<svg class="dropdown-back-svg" width="18" height="18" viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>';
    const checkSvg = '<svg class="dropdown-check-svg" width="16" height="16" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
    const pinSvg = '<svg class="dropdown-pin-svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="margin-left:6px;opacity:0.75;flex-shrink:0;"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>';

    const backOpt = document.createElement("div");
    backOpt.className = "dropdown-header-back";
    backOpt.innerHTML = `${backSvg} <span>${t("changeLyricsSource") || "Change Lyrics Source"}</span>`;
    backOpt.addEventListener("click", (e) => {
      e.stopPropagation();
      this._renderOptionsMenuMain();
      this._clampDropdownToViewport(this.optionsDropdown);
    });
    this.optionsDropdown.appendChild(backOpt);

    const sep = document.createElement("div");
    sep.className = "dropdown-separator";
    this.optionsDropdown.appendChild(sep);

    const { providerKeys, activeProvider, providerDisplayNames, pinnedProvider } = (this.getProviderContextFn || getLyricsProviderContext)(
      this.lastKnownSongInfo,
      this.currentLyrics,
      this.currentSettings,
      this._userSelectedProvider
    );

    const visibleProviders = (providerKeys || []).filter((providerId) => {
      const pLower = providerId.toLowerCase();
      if (this._notFoundProviders?.has(pLower)) return false;
      if (this.availableProviders && this.availableProviders.size > 0) {
        return this.availableProviders.has(pLower) || pLower === activeProvider;
      }
      return true;
    });

    if (visibleProviders.length <= 1 && !pinnedProvider) {
      this._renderOptionsMenuMain();
      return;
    }

    const autoOpt = document.createElement("div");
    autoOpt.className = "dropdown-option lyrics-source-option lyrics-source-auto";
    const isAutoSelected = !pinnedProvider;
    if (isAutoSelected) autoOpt.classList.add("selected");
    autoOpt.innerHTML = `
      <span class="source-name">${providerDisplayNames?.auto || t("autoBestMatch") || "Auto (Best Match)"}</span>
      ${isAutoSelected ? checkSvg : ''}
    `;
    autoOpt.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (this.switchLyricsProviderFn) {
        const success = await this.switchLyricsProviderFn("auto");
        if (success) {
          this._userSelectedProvider = null;
          this.optionsDropdown.classList.add("hidden");
        }
      }
    });
    this.optionsDropdown.appendChild(autoOpt);

    visibleProviders.forEach((providerId) => {
      const name = providerDisplayNames[providerId] || (providerId.charAt(0).toUpperCase() + providerId.slice(1));
      const opt = document.createElement("div");
      opt.className = "dropdown-option lyrics-source-option";
      const pLower = providerId.toLowerCase();
      const isSelected = activeProvider === pLower;
      const isPinned = pinnedProvider && pinnedProvider.toLowerCase() === pLower;

      if (isSelected) opt.classList.add("selected");

      opt.innerHTML = `
        <span class="source-name">${name}</span>
        ${isPinned ? pinSvg : ''}
        ${isSelected ? checkSvg : ''}
      `;

      opt.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (this.switchLyricsProviderFn) {
          const success = await this.switchLyricsProviderFn(providerId);
          if (success) {
            this._userSelectedProvider = providerId;
            if (!this.availableProviders) this.availableProviders = new Set();
            this.availableProviders.add(pLower);
            this.optionsDropdown.classList.add("hidden");
          } else {
            if (!this._notFoundProviders) this._notFoundProviders = new Set();
            this._notFoundProviders.add(pLower);
            if (this.availableProviders) {
              this.availableProviders.delete(pLower);
            }
            opt.remove();
            const remaining = this.optionsDropdown.querySelectorAll(".lyrics-source-option:not(.lyrics-source-auto)");
            if (remaining.length <= 1 && !pinnedProvider) {
              this._renderOptionsMenuMain();
            }
          }
        }
      });

      this.optionsDropdown.appendChild(opt);
    });
    this._clampDropdownToViewport(this.optionsDropdown);
  }

  _clampDropdownToViewport(dropdownEl) {
    if (!dropdownEl || dropdownEl.classList.contains("hidden")) return;
    dropdownEl.style.marginLeft = "";
    dropdownEl.style.marginTop = "";
    dropdownEl.style.maxHeight = "";
    dropdownEl.style.overflowY = "";

    requestAnimationFrame(() => {
      if (!dropdownEl || dropdownEl.classList.contains("hidden")) return;
      const rect = dropdownEl.getBoundingClientRect();
      const pad = 8;
      let shiftX = 0;
      let shiftY = 0;
      if (rect.right > window.innerWidth - pad) {
        shiftX -= rect.right - (window.innerWidth - pad);
      }
      if (rect.left + shiftX < pad) {
        shiftX += pad - (rect.left + shiftX);
      }
      if (rect.bottom > window.innerHeight - pad) {
        shiftY -= rect.bottom - (window.innerHeight - pad);
      }
      if (rect.top + shiftY < pad) {
        shiftY += pad - (rect.top + shiftY);
      }
      if (shiftX !== 0) {
        dropdownEl.style.marginLeft = `${Math.round(shiftX)}px`;
      }
      if (shiftY !== 0) {
        dropdownEl.style.marginTop = `${Math.round(shiftY)}px`;
      }
      const maxAvailableHeight = window.innerHeight - pad * 2;
      if (rect.height > maxAvailableHeight) {
        dropdownEl.style.maxHeight = `${maxAvailableHeight}px`;
        dropdownEl.style.overflowY = "auto";
      }
    });
  }

  _attachHoldRepeat(button, onStep, options = {}) {
    if (!button || typeof onStep !== "function") return () => {};
    const initialDelay = options.initialDelay ?? 400;
    const startInterval = options.startInterval ?? 180;
    const minInterval = options.minInterval ?? 45;
    const decay = options.decay ?? 0.82;

    let timerId = null;
    let activePointerId = null;
    let currentInterval = startInterval;

    const stop = () => {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      if (activePointerId !== null && button.hasPointerCapture?.(activePointerId)) {
        try {
          button.releasePointerCapture(activePointerId);
        } catch (err) {}
      }
      activePointerId = null;
      currentInterval = startInterval;
    };

    const scheduleNext = (delay) => {
      timerId = setTimeout(() => {
        onStep();
        currentInterval = Math.max(minInterval, Math.round(currentInterval * decay));
        scheduleNext(currentInterval);
      }, delay);
    };

    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      stop();
      activePointerId = e.pointerId;
      try {
        button.setPointerCapture?.(e.pointerId);
      } catch (err) {}
      onStep();
      scheduleNext(initialDelay);
    };

    const onClick = (e) => {
      e.stopPropagation();
    };

    const onKeyDown = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat && timerId === null) {
        onStep();
        scheduleNext(initialDelay);
      }
    };

    const onKeyUp = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        stop();
      }
    };

    button.addEventListener("pointerdown", onPointerDown);
    button.addEventListener("click", onClick);
    button.addEventListener("pointerup", stop);
    button.addEventListener("pointercancel", stop);
    button.addEventListener("pointerleave", stop);
    button.addEventListener("lostpointercapture", stop);
    button.addEventListener("blur", stop);
    button.addEventListener("keydown", onKeyDown);
    button.addEventListener("keyup", onKeyUp);

    return stop;
  }

  async _togglePictureInPicture() {
    if (typeof window === "undefined" || !("documentPictureInPicture" in window)) return;
    if (this.pipWindow && !this.pipWindow.closed) {
      this.pipWindow.close();
      this.pipWindow = null;
      return;
    }

    try {
      const pipWin = await window.documentPictureInPicture.requestWindow({
        width: 420,
        height: 560
      });
      this.pipWindow = pipWin;
      this._renderPictureInPictureContent();
      pipWin.addEventListener("pagehide", () => {
        if (this.pipWindow === pipWin) {
          this.pipWindow = null;
        }
      });
    } catch (err) {
      console.warn("Failed to open Lyrics PiP window:", err);
    }
  }

  _renderPictureInPictureContent() {
    const pipWin = this.pipWindow;
    if (!pipWin || pipWin.closed) return;

    const doc = pipWin.document;
    doc.head.innerHTML = "";
    doc.body.innerHTML = "";

    const style = doc.createElement("style");
    style.textContent = `
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        background: radial-gradient(circle at top, #1f1f2e 0%, #0e0e12 100%);
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif;
        overflow: hidden;
      }
      .pip-shell {
        display: flex;
        flex-direction: column;
        height: 100%;
      }
      .pip-header {
        padding: 14px 18px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(18, 18, 24, 0.72);
        backdrop-filter: blur(20px);
        flex-shrink: 0;
      }
      .pip-title {
        font-size: 15px;
        font-weight: 700;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .pip-artist {
        font-size: 12px;
        color: rgba(255, 255, 255, 0.62);
        margin-top: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .pip-lyrics-list {
        flex: 1;
        overflow-y: auto;
        padding: 28px 18px 40vh;
        scroll-behavior: smooth;
        scrollbar-width: none;
      }
      .pip-lyrics-list::-webkit-scrollbar { display: none; }
      .pip-line {
        padding: 8px 10px;
        margin: 4px 0;
        border-radius: 10px;
        font-size: 20px;
        font-weight: 700;
        line-height: 1.32;
        color: rgba(255, 255, 255, 0.4);
        cursor: pointer;
        transition: color 0.2s ease, transform 0.2s ease, background 0.2s ease;
      }
      .pip-line:hover {
        color: rgba(255, 255, 255, 0.8);
        background: rgba(255, 255, 255, 0.06);
      }
      .pip-line.active {
        color: #fff;
        transform: scale(1.02);
        text-shadow: 0 0 20px rgba(255, 255, 255, 0.25);
      }
      .pip-sub {
        display: block;
        font-size: 13px;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.55);
        margin-top: 4px;
      }
      .pip-line.active .pip-sub {
        color: rgba(255, 255, 255, 0.78);
      }
    `;
    doc.head.appendChild(style);

    const shell = doc.createElement("div");
    shell.className = "pip-shell";

    const header = doc.createElement("div");
    header.className = "pip-header";
    const titleEl = doc.createElement("div");
    titleEl.className = "pip-title";
    titleEl.textContent = this.lastKnownSongInfo?.title || "NewSync Lyrics";
    const artistEl = doc.createElement("div");
    artistEl.className = "pip-artist";
    artistEl.textContent = this.lastKnownSongInfo?.artist || "";
    header.append(titleEl, artistEl);

    const listEl = doc.createElement("div");
    listEl.className = "pip-lyrics-list";

    const lines = this.cachedLyricsLines || [];
    lines.forEach((lineEl, idx) => {
      if (!lineEl || lineEl._isGap) return;
      const item = doc.createElement("div");
      item.className = "pip-line";
      item.dataset.lineIdx = String(idx);
      const rawText =
        lineEl._rawLineData?.text ||
        lineEl.querySelector(".main-vocal-container")?.textContent ||
        lineEl.textContent ||
        "";
      const mainText = doc.createElement("span");
      mainText.textContent = rawText.trim();
      item.appendChild(mainText);

      const subText = lineEl._rawLineData?.translatedText || lineEl._rawLineData?.romanizedText || "";
      if (subText) {
        const subEl = doc.createElement("span");
        subEl.className = "pip-sub";
        subEl.textContent = subText;
        item.appendChild(subEl);
      }

      if (lineEl === this.currentPrimaryActiveLine || lineEl.classList.contains("active")) {
        item.classList.add("active");
      }

      item.addEventListener("click", () => {
        const startTime = parseFloat(lineEl.dataset.startTime);
        if (Number.isFinite(startTime)) {
          const offsetSec = (this.userOffsetMs || 0) / 1000;
          this._clickSeekUntil = performance.now() + 500;
          this._seekPlayerTo(startTime + offsetSec - 0.05);
        }
      });

      listEl.appendChild(item);
    });

    shell.append(header, listEl);
    doc.body.appendChild(shell);
    if (this.currentPrimaryActiveLine) {
      this._updatePictureInPictureActiveLine(this.currentPrimaryActiveLine);
    }
  }

  _updatePictureInPictureActiveLine(activeLine) {
    const pipWin = this.pipWindow;
    if (!pipWin || pipWin.closed || !activeLine) return;
    const idx = (activeLine._idx !== undefined && this.cachedLyricsLines[activeLine._idx] === activeLine)
      ? activeLine._idx
      : this.cachedLyricsLines.indexOf(activeLine);
    if (idx === -1) return;

    const doc = pipWin.document;
    const prevActive = doc.querySelector(".pip-line.active");
    if (prevActive) prevActive.classList.remove("active");
    const target = doc.querySelector(`.pip-line[data-line-idx="${idx}"]`);
    if (target) {
      target.classList.add("active");
      target.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  _adjustOffset(newOffsetMs) {
    this.userOffsetMs = Math.round(newOffsetMs / 10) * 10;
    this._updateOffsetDisplay();
    if (this.lastKnownSongInfo) {
      (this.saveLyricsOffsetFn || saveLyricsOffset)(this.lastKnownSongInfo, this.userOffsetMs);
    }
    const currentTime = (this._getCurrentPlayerTime() - this.offsetLatency) * 1000 - this.userOffsetMs;
    this._updateLyricsHighlight(currentTime, false);
  }

  _updateOffsetDisplay() {
    const valueEl = this.optionsDropdown?.querySelector(".offset-current-value");
    if (valueEl) {
      const ms = this.userOffsetMs || 0;
      valueEl.textContent = `${ms > 0 ? '+' : ''}${ms} ms`;
    }
    const resetRow = this.optionsDropdown?.querySelector(".offset-reset-row");
    if (resetRow) {
      resetRow.style.display = (this.userOffsetMs || 0) === 0 ? "none" : "";
    }
    const previewEl = this.optionsDropdown?.querySelector(".lyrics-option-value-preview");
    if (previewEl) {
      const ms = this.userOffsetMs || 0;
      previewEl.textContent = `${ms > 0 ? '+' : ''}${ms}ms`;
    }
  }

  showToast(message, duration = 3000) {
    if (this._toastElement) {
      this._toastElement.remove();
      clearTimeout(this._toastTimeout);
    }
    this._toastElement = document.createElement("div");
    this._toastElement.className = "lyrics-plus-toast";
    this._toastElement.textContent = message;

    const parent = document.querySelector(
      this.uiConfig.buttonParent || this.uiConfig.patchParent
    ) || this.buttonsWrapper?.parentElement || document.body;
    parent.appendChild(this._toastElement);

    this._toastTimeout = setTimeout(() => {
      if (this._toastElement) {
        this._toastElement.classList.add("fade-out");
        setTimeout(() => {
          this._toastElement?.remove();
          this._toastElement = null;
        }, 300);
      }
    }, duration);
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
        artistElement.appendChild(document.createTextNode(" — "));
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
    const scrollContainer = this.lyricsContainer?.parentElement;
    if (scrollContainer) {
      scrollContainer.removeEventListener('wheel', this._boundUserInteractionHandler);
      scrollContainer.removeEventListener('keydown', this._boundUserInteractionHandler);

      scrollContainer.removeEventListener('touchstart', this._boundTouchStartHandler);
      scrollContainer.removeEventListener('touchmove', this._boundTouchMoveHandler);
    }
    this.scrollEventHandlerAttached = false;
    clearTimeout(this.userScrollIdleTimer);

    if (this.lyricsAnimationFrameId) {
      cancelAnimationFrame(this.lyricsAnimationFrameId);
      this.lyricsAnimationFrameId = null;
    }

    if (this.containerObserver) {
      this.containerObserver.disconnect();
      this.containerObserver = null;
    }
    this._isContainerIntersecting = false;
    clearTimeout(this._tickWatchdogTimer);
    this._tickWatchdogTimer = null;
    this._releaseWakeLock();

    if (this._debouncedResizeHandler && this._debouncedResizeHandler.cancel) {
      this._debouncedResizeHandler.cancel();
    }

    if (this._cleanupTimer) clearTimeout(this._cleanupTimer);
    this._cleanupTimer = null;
    if (this._cleanupSet) this._cleanupSet.clear();
    if (this.userScrollIdleTimer) clearTimeout(this.userScrollIdleTimer);
    if (this._scrollUnlockTimeout) clearTimeout(this._scrollUnlockTimeout);
    if (this._scrollAnimationTimeout) clearTimeout(this._scrollAnimationTimeout);

    this.userScrollIdleTimer = null;
    this._scrollUnlockTimeout = null;
    this._scrollAnimationTimeout = null;

    if (this._maskResizeObserver) {
      this._maskResizeObserver.disconnect();
      this._maskResizeObserver = null;
    }
    if (this._maskObservedLines) this._maskObservedLines.clear();
    if (this._bgResizeObserver) {
      this._bgResizeObserver.disconnect();
      this._bgResizeObserver = null;
    }
    if (this.visibilityObserver) {
      this.visibilityObserver.disconnect();
      this.visibilityObserver = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    if (this._boundDocumentClickHandler) {
      document.removeEventListener("click", this._boundDocumentClickHandler);
      this._boundDocumentClickHandler = null;
    }
    this._removeButton("translationButton");
    this._removeButton("reloadButton");
    if (this.dropdownMenu) {
      this.dropdownMenu.remove();
      this.dropdownMenu = null;
    }
    if (this.optionsDropdown) {
      this.optionsDropdown.remove();
      this.optionsDropdown = null;
    }
    if (this._toastElement) {
      this._toastElement.remove();
      this._toastElement = null;
    }
    if (this._toastTimeout) clearTimeout(this._toastTimeout);
    this._toastTimeout = null;
    this._invalidateSpringConfig();
    this._invalidateElevationConfig();
    this._containerFontCache = null;
    this._trackStyleCache.clear();
    this._appliedScrollDurStr = null;
    this._appliedScrollEasing = null;
    this._cachedGapHeight = 0;
    this._renderedState = null;
    this._renderedLyricLines = null;
    this.userOffsetMs = 0;
    this.currentLyrics = null;
    this.currentLyricsType = null;
    this._userSelectedProvider = null;
    this.switchLyricsProviderFn = null;
    this.saveLyricsOffsetFn = null;
    this.getProviderContextFn = null;
    if (this.availableProviders) this.availableProviders.clear();
    if (this._notFoundProviders) this._notFoundProviders.clear();

    const container = this._getContainer();

    if (this._animatingLines) {
      for (const l of this._animatingLines) {
        if (l._scrollAnim) l._scrollAnim.cancel();
        l._scrollAnim = null;
      }
      this._animatingLines.length = 0;
    }

    if (this.cachedLyricsLines) {
      for (let i = 0; i < this.cachedLyricsLines.length; i++) {
        const line = this.cachedLyricsLines[i];
        if (line) {
          if (line._maskAnimator) line._maskAnimator.dispose();
          line._cachedSyllableElements = null;
          line._cachedCharSpans = null;
        }
      }
    }

    if (this.cachedSyllables) {
      for (let i = 0; i < this.cachedSyllables.length; i++) {
        const syl = this.cachedSyllables[i];
        if (syl) {
          syl._cleanupPending = false;
          syl._cachedCharSpans = null;
          syl._nextSyllableInWord = null;
        }
      }
    }

    if (container) {
      container.className = LyricsPlusRenderer._isFirefox
        ? "lyrics-plus-integrated lyrics-plus-message blur-inactive-enabled is-firefox"
        : "lyrics-plus-integrated lyrics-plus-message blur-inactive-enabled";
      container.innerHTML = `<div class="loading-container"><span class="text-loading">${t("loading")}</span><div class="loading-loop-m3"></div></div>`;
      container.style.removeProperty("--lyplus-override-pallete");
      container.style.removeProperty("--lyplus-song-pallete");
    }

    if (this.textWidthCanvas) {
      this.textWidthCanvas.width = 0;
      this.textWidthCanvas.height = 0;
      this.textWidthCanvas = null;
      this.textWidthCtx = null;
      this._lastCtxFont = null;
    }

    this.currentPrimaryActiveLine = null;
    this._resetGapState();
    this.lastPrimaryActiveLine = null;
    this.currentFullscreenFocusedLine = null;
    this.lastTime = 0;

    this.activeLineIds.clear();
    this._suggestedLineOffsetMs = -500;
    this._appleScrollDurationMs = 750;
    this._scrollGapT = null;
    if (this._activeLineIndices) this._activeLineIndices.length = 0;
    if (this._prevActiveLineIndices) this._prevActiveLineIndices.length = 0;
    this._lastActiveGroupEndIndex = 0;
    this.visibleLineIds.clear();
    this.cachedLyricsLines = [];
    this.cachedSyllables = [];
    this.fontCache = Object.create(null);
    this._clearTextWidthCache();
    this._lineById = null;
    this._positionClassedLines = [];
    this._nextPositionClassedLines = [];
    this._lastPastLineIndex = -1;
    this._scrollPaddingTopCache = undefined;
    this._containerDisplayCache = undefined;

    this.currentScrollOffset = 0;
    this.isUserControllingScroll = false;

    this.currentDisplayMode = undefined;
    this.largerTextMode = "lyrics";

    this.lastKnownSongInfo = null;
    this.fetchAndDisplayLyricsFn = null;
    this.setCurrentDisplayModeAndRefetchFn = null;

    this._playerElement = undefined;
    this._explicitPlaybackState = null;

    this._lastActiveIndex = 0;
    this._tempActiveLines = [];
    this._deactivatingLines = [];
    this._activatingLines = [];
    this._activeIndices = [];
  }
}