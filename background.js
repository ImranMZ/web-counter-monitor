// background.js — Web Counter Monitor.
// Single source of truth for the watched counter: persists state, dedupes
// duplicate reports, fires desktop alerts, keeps the toolbar badge in sync
// and optionally pushes a phone notification via ntfy.sh.

const APP_NAME = 'Web Counter Monitor';
const STATE_KEY = 'counterState';
const SETTINGS_KEY = 'counterSettings';
const LEGACY_STATE_KEY = 'egadgetState';
const LEGACY_SETTINGS_KEY = 'egadgetSettings';
const COOLDOWN_MS = 3000;
const LOG_MAX = 50;
const BADGE_COLOR = '#2563eb';
const DEFAULT_LABEL = 'Matched Unique IMEI';
const ALARM_REFRESH = 'auto-refresh';
const ALARM_PERIOD_MIN = 1;
const ALARM_HEARTBEAT = 'heartbeat';
const WATCHER_ID = 'counter-watcher';
const STALLED_THRESHOLD = 3;
const HEARTBEAT_INTERVALS = [15, 30, 60, 120];

// Serialise storage reads/writes so concurrent tabs can't interleave.
let writeChain = Promise.resolve();
function enqueue(fn) {
  const next = writeChain.then(fn);
  writeChain = next.catch(() => {});
  return next;
}

let notifySeq = 0;

// ---- Content-script registration ----
// The watched page is user-configured, so the content script is injected
// dynamically with chrome.scripting instead of a static manifest match.

function targetPattern(pageUrl) {
  try {
    return new URL(pageUrl).origin + '/*';
  } catch (_) {
    return null;
  }
}

async function unregisterWatcher() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [WATCHER_ID] });
  } catch (_) {}
}

async function registerWatcher(pattern) {
  try {
    await unregisterWatcher();
    await chrome.scripting.registerContentScripts([
      {
        id: WATCHER_ID,
        matches: [pattern],
        js: ['content.js'],
        runAt: 'document_idle',
        allFrames: false,
      },
    ]);
    console.log(`[monitor] watcher registered for ${pattern}`);
  } catch (err) {
    console.warn('[monitor] failed to register watcher:', err);
  }
}

async function grantTargetOrigin(pageUrl) {
  try {
    const origin = new URL(pageUrl).origin;
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (has) return true;
    const granted = await chrome.permissions.request({ origins: [origin] });
    return !!granted;
  } catch (err) {
    console.warn('[monitor] could not request host permission:', err);
    return false;
  }
}

async function ensureWatcher() {
  const settings = await getSettings();
  if (!settings.pageUrl) {
    await unregisterWatcher();
    return;
  }
  const pattern = targetPattern(settings.pageUrl);
  if (!pattern) return;
  const origin = new URL(settings.pageUrl).origin;
  try {
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (has) await registerWatcher(pattern);
  } catch (err) {
    console.warn('[monitor] permission check failed:', err);
  }
}

// ---- Auto-refresh ----
// The counter is computed server-side on page load, so a periodic full reload
// surfaces new matches. A chrome.alarm drives this from the background so it
// works even when the service worker sleeps and the content script goes stale.
async function ensureRefreshAlarm() {
  try {
    const existing = await chrome.alarms.get(ALARM_REFRESH);
    if (!existing || existing.periodInMinutes !== ALARM_PERIOD_MIN) {
      await chrome.alarms.create(ALARM_REFRESH, { periodInMinutes: ALARM_PERIOD_MIN });
      console.log('[monitor] auto-refresh alarm scheduled (every 1 min)');
    }
  } catch (err) {
    console.warn('[monitor] failed to schedule auto-refresh alarm:', err);
  }
}

async function clearRefreshAlarm() {
  try {
    await chrome.alarms.clear(ALARM_REFRESH);
    console.log('[monitor] auto-refresh alarm cleared');
  } catch (err) {
    console.warn('[monitor] failed to clear auto-refresh alarm:', err);
  }
}

// Reload every open target tab so a fresh content script re-reads the
// counter. Reload-diff logic in onReportValue turns a real change into an alert.
async function reloadTargetTabs() {
  const settings = await getSettings();
  const pattern = targetPattern(settings.pageUrl);
  if (!pattern) return;
  try {
    const tabs = await chrome.tabs.query({ url: pattern });
    const ids = tabs.map((t) => t.id).filter((id) => id !== undefined);
    if (ids.length) {
      // bypassCache forces a real server fetch on every tick so a counter
      // that is computed server-side on page load is always freshly rendered
      // instead of being served from the browser cache.
      await Promise.all(ids.map((id) => chrome.tabs.reload(id, { bypassCache: true })));
      console.log(`[monitor] auto-refresh reloading ${ids.length} tab(s)`);
    } else if (settings.autoOpenTab && settings.enabled) {
      await chrome.tabs.create({ url: settings.pageUrl });
      console.log('[monitor] no matching tab — auto-opening target page');
    }
  } catch (err) {
    console.warn('[monitor] auto-refresh reload failed:', err);
  }
}

async function applyAutoRefresh(setting) {
  if (setting) await ensureRefreshAlarm();
  else await clearRefreshAlarm();
}

async function ensureHeartbeatAlarm() {
  try {
    const settings = await getSettings();
    const existing = await chrome.alarms.get(ALARM_HEARTBEAT);
    const period = settings.heartbeatIntervalMin;
    if (!existing || existing.periodInMinutes !== period) {
      await chrome.alarms.create(ALARM_HEARTBEAT, { periodInMinutes: period });
      console.log(`[monitor] heartbeat alarm scheduled (every ${period} min)`);
    }
  } catch (err) {
    console.warn('[monitor] failed to schedule heartbeat alarm:', err);
  }
}

async function clearHeartbeatAlarm() {
  try {
    await chrome.alarms.clear(ALARM_HEARTBEAT);
    console.log('[monitor] heartbeat alarm cleared');
  } catch (err) {
    console.warn('[monitor] failed to clear heartbeat alarm:', err);
  }
}

async function applyHeartbeat(setting) {
  if (setting) await ensureHeartbeatAlarm();
  else await clearHeartbeatAlarm();
}

async function getState() {
  const r = await chrome.storage.local.get(STATE_KEY);
  const s = r[STATE_KEY] || {};
  return {
    lastValue: s.lastValue ?? null,
    lastChangedAt: s.lastChangedAt ?? null,
    lastNotify: s.lastNotify ?? null,
    lastNotifyId: s.lastNotifyId ?? null,
    ntfyLastPush: s.ntfyLastPush ?? null,
    log: s.log ?? [],
    status: s.status ?? 'starting',
    statusDetail: s.statusDetail ?? '',
    consecutiveNotFound: s.consecutiveNotFound ?? 0,
    stalledAlertSent: s.stalledAlertSent ?? false,
    lastCheckedAt: s.lastCheckedAt ?? null,
  };
}

async function setState(patch) {
  return enqueue(async () => {
    const current = await getState();
    await chrome.storage.local.set({ [STATE_KEY]: { ...current, ...patch } });
  });
}

async function getSettings() {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  const s = r[SETTINGS_KEY] || {};
  return {
    enabled: s.enabled ?? true,
    onlyIncrease: s.onlyIncrease ?? false,
    persistAlert: s.persistAlert ?? false,
    autoRefresh: s.autoRefresh ?? true,
    ntfyEnabled: s.ntfyEnabled ?? false,
    ntfyTopic: s.ntfyTopic ?? '',
    pageUrl: s.pageUrl ?? '',
    matchLabel: s.matchLabel ?? DEFAULT_LABEL,
    autoOpenTab: s.autoOpenTab ?? true,
    stallThreshold: s.stallThreshold ?? STALLED_THRESHOLD,
    stallAlertEnabled: s.stallAlertEnabled ?? true,
    heartbeatEnabled: s.heartbeatEnabled ?? false,
    heartbeatIntervalMin: s.heartbeatIntervalMin ?? 30,
  };
}

async function setSettings(patch) {
  return enqueue(async () => {
    const current = await getSettings();
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, ...patch } });
  });
}

function fmt(n) {
  return Number(n).toLocaleString('en-US');
}

// Compact form for the 4-character toolbar badge: 4642, 10.5k, 120k.
function badgeText(value) {
  if (value === null || value === undefined) return '';
  if (value >= 10000) {
    const k = value / 1000;
    return (k >= 100 ? Math.round(k) : Math.round(k * 10) / 10) + 'k';
  }
  return String(value);
}

async function updateBadge(value) {
  try {
    await chrome.action.setBadgeText({ text: badgeText(value) });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  } catch (err) {
    console.warn('[monitor] badge update failed:', err);
  }
}

// Every alert gets a fresh, unique notification ID. Reusing one ID makes
// Chrome silently UPDATE the existing toast instead of showing a new one.
async function showAlert(notifyId, { title, message }, requireInteraction) {
  try {
    await chrome.notifications.create(notifyId, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
      contextMessage: APP_NAME,
      priority: 1,
      requireInteraction: !!requireInteraction,
    });
    console.log(`[monitor] alert shown: "${title}" (${notifyId})`);
  } catch (err) {
    console.warn('[monitor] alert failed:', err);
  }
}

// Clear the previously shown alert so the Notification Center stays tidy.
// Called BEFORE showing a new alert so two toasts are never on screen at once.
async function retireAlert(prevId) {
  if (prevId) {
    try {
      await chrome.notifications.clear(prevId);
    } catch (_) {}
  }
}

function label(settings) {
  return settings.matchLabel || DEFAULT_LABEL;
}

// Unpredictable topic name doubles as the access token on ntfy.sh.
function randomTopic() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const arr = crypto.getRandomValues(new Uint8Array(8));
  let s = '';
  for (let i = 0; i < arr.length; i++) s += alphabet[arr[i] % alphabet.length];
  return `counter-monitor-${s}`;
}

// Headers must stay ISO-8859-1 encodable or Chrome rejects the fetch with
// "String contains non ISO-8859-1 code point". Map the em-dash to a hyphen
// and drop anything else outside Latin-1. Body text is unaffected.
function headerSafe(str) {
  return String(str)
    .replace(/\u2014/g, '-')
    .replace(/[^\u0000-\u00FF]/g, '?');
}

// Send a push notification to the phone via ntfy.sh.
// Never enqueues here: callers already hold the serialized write section
// (this is only ever invoked from within an enqueued task).
async function sendNtfy(topic, title, message, clickUrl, options = {}) {
  let url;
  try {
    url = new URL(`https://ntfy.sh/${encodeURIComponent(topic)}`).toString();
  } catch (_) {
    return { ok: false, status: 'invalid topic' };
  }
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Title: headerSafe(title),
        Priority: options.priority || 'high',
        Click: headerSafe(clickUrl),
      },
      body: message,
    });
    if (!resp.ok) {
      console.warn(`[monitor] ntfy push failed: HTTP ${resp.status}`);
      return { ok: false, status: `HTTP ${resp.status}` };
    }
    console.log(`[monitor] ntfy push sent (${topic}) priority=${options.priority || 'high'}`);
    return { ok: true, status: `HTTP ${resp.status}` };
  } catch (err) {
    console.warn('[monitor] ntfy push error:', err);
    return { ok: false, status: String((err && err.message) || err) };
  }
}

async function sendHeartbeat() {
  const settings = await getSettings();
  if (!settings.ntfyEnabled || !settings.ntfyTopic) return null;
  const state = await getState();
  const title = `${APP_NAME} \u2014 Heartbeat`;
  const current = state.lastValue === null ? 'baseline not set' : fmt(state.lastValue);
  const message = `Watcher alive. Current count: ${current}. Status: ${state.status}.`;
  const result = await sendNtfy(settings.ntfyTopic, title, message, settings.pageUrl, { priority: 'low' });
  return { at: Date.now(), ...result };
}

async function pushNtfy(title, message, clickUrl) {
  const settings = await getSettings();
  if (!settings.ntfyEnabled || !settings.ntfyTopic) return null;
  const result = await sendNtfy(settings.ntfyTopic, title, message, clickUrl);
  return { at: Date.now(), ...result };
}

async function onReportValue(value) {
  if (value === null || value === undefined) return;

  await enqueue(async () => {
    const state = await getState();
    const settings = await getSettings();

    const prev = state.lastValue;
    const now = Date.now();
    console.log(`[monitor] value reported: ${value} (prev ${prev})`);

    // First value ever seen — record the baseline silently, never alert.
    if (prev === null) {
      await chrome.storage.local.set({
        [STATE_KEY]: {
          ...state,
          lastValue: value,
          status: settings.enabled ? 'watching' : 'paused',
          statusDetail: 'Baseline count recorded',
          consecutiveNotFound: 0,
          stalledAlertSent: false,
          lastCheckedAt: now,
        },
      });
      await updateBadge(value);
      return;
    }

    // No change — but bounce a "counter not found" status back to monitoring.
    if (value === prev) {
      if (state.status === 'element-not-found') {
        await chrome.storage.local.set({
          [STATE_KEY]: {
            ...state,
            status: settings.enabled ? 'watching' : 'paused',
            statusDetail: '',
            consecutiveNotFound: 0,
            stalledAlertSent: false,
            lastCheckedAt: now,
          },
        });
      }
      return;
    }

    // The count changed. Record it immediately so every tab converges; only
    // the alert is gated by settings/dedup.
    const update = {
      ...state,
      lastValue: value,
      lastChangedAt: now,
      status: settings.enabled ? 'watching' : 'paused',
      statusDetail: 'Count changed',
      consecutiveNotFound: 0,
      stalledAlertSent: false,
      lastCheckedAt: now,
    };
    await chrome.storage.local.set({ [STATE_KEY]: update });
    await updateBadge(value);

    if (!settings.enabled) return;

    // "Alert on increase only" gate.
    if (settings.onlyIncrease && value < prev) return;

    // Cross-tab dedupe: same old->new fired recently = another tab sent it.
    if (
      state.lastNotify &&
      state.lastNotify.old === prev &&
      state.lastNotify.new === value &&
      now - state.lastNotify.at < COOLDOWN_MS
    ) {
      return;
    }

    // Retire the previous toast before raising the new one so only one
    // notification is ever visible (no stale test alert next to a real one).
    await retireAlert(state.lastNotifyId);
    const notifyId = `imei-${now}-${notifySeq++}`;
    const title = `${label(settings)} Updated`;
    const message = `${label(settings)} changed: ${fmt(prev)} \u2192 ${fmt(value)}`;
    await showAlert(notifyId, { title, message }, settings.persistAlert);
    const pushState = await pushNtfy(title, message, settings.pageUrl);

    const entry = { from: prev, to: value, at: now };
    const log = [...state.log, entry].slice(-LOG_MAX);
    await chrome.storage.local.set({
      [STATE_KEY]: {
        ...update,
        log,
        lastNotify: { old: prev, new: value, at: now },
        lastNotifyId: notifyId,
        ntfyLastPush: pushState || update.ntfyLastPush,
      },
    });
  });
}

async function onUpdateWatchStatus(found) {
  await enqueue(async () => {
    const state = await getState();
    const settings = await getSettings();
    const now = Date.now();
    let consecutiveNotFound = state.consecutiveNotFound;
    let stalledAlertSent = state.stalledAlertSent;
    let status = state.status;
    let statusDetail = state.statusDetail;

    if (found) {
      consecutiveNotFound = 0;
      stalledAlertSent = false;
      status = settings.enabled ? 'watching' : 'paused';
      statusDetail = '';
      await updateBadge(state.lastValue);
    } else {
      consecutiveNotFound += 1;
      await updateBadge(null);
      status = 'element-not-found';
      statusDetail = 'Counter not found \u2014 verify the target page is open and you are signed in';

      if (settings.stallAlertEnabled && consecutiveNotFound >= settings.stallThreshold && !stalledAlertSent) {
        await retireAlert(state.lastNotifyId);
        const notifyId = `stalled-${now}-${notifySeq++}`;
        const title = `\u26a0\ufe0f Watcher Stalled`;
        const message = `Counter not found for ${consecutiveNotFound} consecutive checks \u2014 session expired or page changed?`;
        await showAlert(notifyId, { title, message }, true);
        if (settings.ntfyEnabled && settings.ntfyTopic) {
          await sendNtfy(settings.ntfyTopic, title, message, settings.pageUrl, { priority: 'urgent' });
        }
        stalledAlertSent = true;
        console.log('[monitor] watcher stalled alert fired');
      }
    }

    await chrome.storage.local.set({
      [STATE_KEY]: {
        ...state,
        status,
        statusDetail,
        consecutiveNotFound,
        stalledAlertSent,
        lastCheckedAt: now,
      },
    });
  });
}

async function onTestAlert() {
  let push = null;
  await enqueue(async () => {
    const state = await getState();
    const settings = await getSettings();
    const current = state.lastValue;
    const now = Date.now();

    // Retire the previous toast before showing the test one for the same
    // single-toast guarantee as the organic path.
    await retireAlert(state.lastNotifyId);
    const notifyId = `test-${now}-${notifySeq++}`;
    const title = `${APP_NAME} \u2014 Test Alert`;
    const message =
      current === null
        ? 'This is a test alert. No count recorded yet.'
        : `This is a test alert. Current count: ${fmt(current)}`;
    await showAlert(notifyId, { title, message }, settings.persistAlert);
    push = await pushNtfy(title, message, settings.pageUrl);
    await chrome.storage.local.set({
      [STATE_KEY]: {
        ...state,
        lastNotifyId: notifyId,
        ntfyLastPush: push || state.ntfyLastPush,
        lastCheckedAt: now,
      },
    });
  });
  return push;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg && msg.action) {
      case 'reportValue':
        await onReportValue(msg.value);
        return { ok: true };

      case 'updateWatchStatus':
        await onUpdateWatchStatus(!!msg.found);
        return { ok: true };

      case 'getSnapshot': {
        const state = await getState();
        const settings = await getSettings();
        return { ...state, settings };
      }

      case 'setEnabled':
        await setSettings({ enabled: !!msg.value });
        return { ok: true };

      case 'setOnlyIncrease':
        await setSettings({ onlyIncrease: !!msg.value });
        return { ok: true };

      case 'setPersistAlert':
        await setSettings({ persistAlert: !!msg.value });
        return { ok: true };

      case 'setAutoRefresh': {
        const value = !!msg.value;
        await setSettings({ autoRefresh: value });
        await applyAutoRefresh(value);
        return { ok: true };
      }

      case 'setNtfyEnabled':
        await setSettings({ ntfyEnabled: !!msg.value });
        return { ok: true };

      case 'setNtfyTopic':
        await setSettings({ ntfyTopic: String(msg.value || '').trim() });
        return { ok: true };

      case 'setPageUrl': {
        const value = String(msg.value || '').trim();
        await setSettings({ pageUrl: value });
        if (value) {
          if (await grantTargetOrigin(value)) {
            await ensureWatcher();
            await reloadTargetTabs();
          }
        } else {
          await unregisterWatcher();
        }
        return { ok: true };
      }

      case 'setMatchLabel':
        await setSettings({ matchLabel: String(msg.value || '').trim() });
        return { ok: true };

      case 'setAutoOpenTab':
        await setSettings({ autoOpenTab: !!msg.value });
        return { ok: true };

      case 'setStallThreshold': {
        const value = parseInt(msg.value, 10);
        if (!isNaN(value) && value >= 2 && value <= 10) {
          await setSettings({ stallThreshold: value });
        }
        return { ok: true };
      }

      case 'setStallAlertEnabled':
        await setSettings({ stallAlertEnabled: !!msg.value });
        return { ok: true };

      case 'setHeartbeatEnabled': {
        const value = !!msg.value;
        await setSettings({ heartbeatEnabled: value });
        await applyHeartbeat(value);
        return { ok: true };
      }

      case 'setHeartbeatIntervalMin': {
        const value = parseInt(msg.value, 10);
        if (HEARTBEAT_INTERVALS.includes(value)) {
          await setSettings({ heartbeatIntervalMin: value });
          const settings = await getSettings();
          if (settings.heartbeatEnabled) await ensureHeartbeatAlarm();
        }
        return { ok: true };
      }

      case 'testAlert': {
        const push = await onTestAlert();
        return { ok: true, push };
      }

      case 'clearLog': {
        await enqueue(async () => {
          const state = await getState();
          await chrome.storage.local.set({
            [STATE_KEY]: { ...state, log: [], lastChangedAt: null },
          });
        });
        return { ok: true };
      }

      case 'openPage': {
        const settings = await getSettings();
        if (!settings.pageUrl) return { ok: false, error: 'No target site configured' };
        await chrome.tabs.create({ url: settings.pageUrl });
        return { ok: true };
      }

      default:
        return { ok: false };
    }
  })()
    .then(sendResponse)
    .catch((err) => {
      console.error('[monitor] handler error:', err);
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    });
  return true; // keep the message channel open for the async reply
});

chrome.notifications.onClicked.addListener(async () => {
  const settings = await getSettings();
  if (!settings.pageUrl) return;
  const pattern = targetPattern(settings.pageUrl);
  if (!pattern) return;
  const tabs = await chrome.tabs.query({ url: pattern });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId) {
      await chrome.windows.update(tabs[0].windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url: settings.pageUrl });
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm && alarm.name === ALARM_REFRESH) await reloadTargetTabs();
  if (alarm && alarm.name === ALARM_HEARTBEAT) await sendHeartbeat();
});

// One-time migration from the legacy internal key names so an existing
// installation keeps its settings (including the ntfy topic) and baseline.
async function migrateLegacyKeys() {
  try {
    const legacy = await chrome.storage.local.get([LEGACY_STATE_KEY, LEGACY_SETTINGS_KEY]);
    const migrated = {};
    const current = await chrome.storage.local.get([STATE_KEY, SETTINGS_KEY]);
    if (legacy[LEGACY_STATE_KEY] && !current[STATE_KEY]) {
      migrated[STATE_KEY] = legacy[LEGACY_STATE_KEY];
    }
    if (legacy[LEGACY_SETTINGS_KEY] && !current[SETTINGS_KEY]) {
      migrated[SETTINGS_KEY] = legacy[LEGACY_SETTINGS_KEY];
    }
    if (Object.keys(migrated).length) {
      await chrome.storage.local.set(migrated);
      console.log('[monitor] migrated legacy settings/state');
    }
  } catch (err) {
    console.warn('[monitor] migration failed:', err);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await migrateLegacyKeys();
  const settings = await getSettings();
  if (!settings.ntfyTopic) {
    await chrome.storage.local.set({
      [SETTINGS_KEY]: { ...settings, ntfyTopic: randomTopic() },
    });
  } else {
    await setSettings(settings); // persist defaults on first install
  }
  // Re-register the watcher and keep the refresh alarm in sync after extension
  // updates, and reload any open tabs so a fresh content script loads.
  await ensureWatcher();
  await applyAutoRefresh(settings.autoRefresh);
  await applyHeartbeat(settings.heartbeatEnabled);
  await reloadTargetTabs();
});