// content.js — Web Counter Monitor watch script.
// Injected dynamically at the user-configured target page. Reads the counter
// label from settings, watches the DOM, and reports value changes to the
// background service worker.

(() => {
  if (window.__counterWatcherInjected) return;
  window.__counterWatcherInjected = true;

  const DEBOUNCE_MS = 300;
  const FALLBACK_POLL_MS = 5000;
  const STATUS_THROTTLE_MS = 5000;
  const SETTINGS_KEY = 'counterSettings';
  const DEFAULT_LABEL = 'Matched Unique IMEI';

  let pollTimer = null;
  let debounceTimer = null;
  let lastStatusSentAt = 0;
  let matchLabel = DEFAULT_LABEL;

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Loads the configured label so we only ever match the target stat card.
  // Best-effort: falls back to the default if storage is unavailable. The
  // optional callback runs after the label resolves so callers can re-read
  // the counter with the real label.
  function loadLabel(done) {
    try {
      chrome.storage.local.get(SETTINGS_KEY, (r) => {
        const s = r[SETTINGS_KEY] || {};
        if (typeof s.matchLabel === 'string' && s.matchLabel.trim()) {
          matchLabel = s.matchLabel.trim();
        }
        if (typeof done === 'function') done();
      });
    } catch (_) {}
  }

  // Locates the stat block whose label matches, then returns its number
  // element. Returns null if not found.
  function findCounter() {
    const blocks = document.querySelectorAll('.stats-column');
    const re = new RegExp(escapeRegExp(matchLabel), 'i');
    for (const block of blocks) {
      const textEl = block.querySelector('.info-box-text');
      if (textEl && re.test(textEl.textContent || '')) {
        const numEl = block.querySelector('.info-box-number');
        if (numEl) return numEl;
      }
    }
    return null;
  }

  // Reads a value like "4,642" and normalises it to an integer (4642).
  // Returns null for empty/garbage/"Loading..." style content.
  function parseValue(numEl) {
    const raw = (numEl.textContent || '')
      .replace(/\u00a0/g, ' ')
      .trim();
    const digits = raw.replace(/[^0-9]/g, '');
    if (digits === '') return null;
    const n = parseInt(digits, 10);
    return Number.isNaN(n) ? null : n;
  }

  function sendReport(value) {
    try {
      chrome.runtime.sendMessage({ action: 'reportValue', value }).catch(() => {});
    } catch (_) {
      // Extension context invalidated (e.g. extension reloaded) — ignore.
    }
  }

  function reportNotFound() {
    const now = Date.now();
    if (now - lastStatusSentAt < STATUS_THROTTLE_MS) return;
    lastStatusSentAt = now;
    try {
      chrome.runtime.sendMessage({ action: 'updateWatchStatus', found: false }).catch(() => {});
    } catch (_) {}
  }

  // Re-reads the counter element and reports the value.
  // "source" is informational (init / mutation / poll).
  function recompute(source) {
    const numEl = findCounter();
    if (!numEl) {
      reportNotFound();
      return;
    }
    const value = parseValue(numEl);
    if (value === null) return; // transient state — wait for a real number
    sendReport(value);
  }

  function armWatchers() {
    // 1. Debounced MutationObserver on <body>: survives element rebuilds
    //    because we re-query the DOM on every mutation batch.
    const observer = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => recompute('mutation'), DEBOUNCE_MS);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // 2. Fallback poll — belt and braces if the observer ever misses.
    pollTimer = setInterval(() => recompute('poll'), FALLBACK_POLL_MS);

    // 3. Initial check: on a fresh page load this both (a) seeds the
    //    first-seen value silently and (b) detects a change that happened
    //    between reloads (background decides which is which).
    recompute('init');
  }

  function start() {
    if (document.body) {
      armWatchers();
      // The label is loaded asynchronously, so re-read the counter once the
      // real label is available — the synchronous recompute('init') inside
      // armWatchers may have matched the default label instead, which would
      // cause a bogus "not found" (or stale match) on page load.
      loadLabel(() => recompute('init'));
      return;
    }
    setTimeout(start, 300);
  }

  // Answer popup status queries with the live DOM value.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.action === 'queryLiveValue') {
      const numEl = findCounter();
      const value = numEl ? parseValue(numEl) : null;
      sendResponse({ found: !!numEl, value });
      return false;
    }
    return false;
  });

  start();
})();