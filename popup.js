// popup.js — control panel for Web Counter Monitor.

const el = {
  status: document.getElementById('status'),
  value: document.getElementById('value'),
  updatedAt: document.getElementById('updatedAt'),
  pageUrl: document.getElementById('pageUrl'),
  matchLabel: document.getElementById('matchLabel'),
  enabled: document.getElementById('enabled'),
  onlyIncrease: document.getElementById('onlyIncrease'),
  persistAlert: document.getElementById('persistAlert'),
  autoRefresh: document.getElementById('autoRefresh'),
  ntfyEnabled: document.getElementById('ntfyEnabled'),
  ntfyConfig: document.getElementById('ntfyConfig'),
  ntfyTopic: document.getElementById('ntfyTopic'),
  ntfyStatus: document.getElementById('ntfyStatus'),
  log: document.getElementById('log'),
  clearLog: document.getElementById('clearLog'),
  testAlert: document.getElementById('testAlert'),
  openPage: document.getElementById('openPage'),
};

const STATUS_LABELS = {
  watching: 'Monitoring',
  paused: 'Paused',
  'element-not-found': 'Counter not found',
  starting: 'Initializing\u2026',
};

function send(payload) {
  return chrome.runtime.sendMessage(payload).catch(() => null);
}

function fmt(n) {
  if (n === null || n === undefined) return '\u2014';
  return Number(n).toLocaleString('en-US');
}

function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}

function render(state) {
  const { lastValue, lastChangedAt, log, status, statusDetail, settings } = state;

  el.value.textContent = fmt(lastValue);
  el.updatedAt.textContent = lastChangedAt
    ? `Last updated: ${fmtTime(lastChangedAt)}`
    : 'Baseline not recorded';

  el.pageUrl.value = settings.pageUrl || '';
  el.matchLabel.value = settings.matchLabel || '';
  el.openPage.disabled = !settings.pageUrl;

  el.enabled.checked = settings.enabled;
  el.onlyIncrease.checked = !!settings.onlyIncrease;
  el.persistAlert.checked = !!settings.persistAlert;
  el.autoRefresh.checked = !!settings.autoRefresh;
  el.ntfyEnabled.checked = !!settings.ntfyEnabled;
  el.ntfyTopic.value = settings.ntfyTopic || '';
  el.ntfyConfig.classList.toggle('hidden', !settings.ntfyEnabled);

  const push = state.ntfyLastPush;
  el.ntfyStatus.textContent = '';
  el.ntfyStatus.classList.remove('push-ok', 'push-fail');
  if (push) {
    const t = new Date(push.at).toLocaleTimeString();
    el.ntfyStatus.textContent = push.ok
      ? `\u2713 Push sent ${t} (${push.status})`
      : `\u26a0 Push failed ${t}: ${push.status}`;
    el.ntfyStatus.classList.add(push.ok ? 'push-ok' : 'push-fail');
  }

  const statusKey = STATUS_LABELS[status] ? status : 'starting';
  document
    .querySelectorAll('.status')
    .forEach((s) =>
      s.classList.remove(
        'status-watching',
        'status-paused',
        'status-element-not-found',
        'status-starting'
      )
    );
  el.status.classList.add(`status-${statusKey}`);
  let label = STATUS_LABELS[statusKey];
  if (statusDetail) label += ` \u2014 ${statusDetail}`;
  el.status.textContent = label;
  el.status.title = statusDetail || '';

  const items = (log || []).slice().reverse().slice(0, 20);
  if (!items.length) {
    el.log.innerHTML = '<li class="log-empty">No changes recorded</li>';
    return;
  }
  el.log.innerHTML = '';
  items.forEach((entry) => {
    const li = document.createElement('li');
    li.className = 'log-item';

    const change = document.createElement('span');
    change.className = 'log-change';
    change.innerHTML = `${fmt(entry.from)}<span class="arrow">&rarr;</span>${fmt(entry.to)}`;

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = fmtTime(entry.at);

    li.append(change, time);
    el.log.appendChild(li);
  });
}

async function refresh() {
  const state = await send({ action: 'getSnapshot' });
  if (state) render(state);

  // If the target page is open in the active tab, pull the live value.
  if (state && state.settings.pageUrl) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && tab.url.startsWith(state.settings.pageUrl)) {
        const live = await chrome.tabs
          .sendMessage(tab.id, { action: 'queryLiveValue' })
          .catch(() => null);
        if (live && live.found) {
          el.value.textContent = fmt(live.value);
          el.updatedAt.textContent = 'Live \u2014 from open tab';
        }
      }
    } catch (_) {}
  }
}

el.pageUrl.addEventListener('change', async (e) => {
  await send({ action: 'setPageUrl', value: e.target.value });
  refresh();
});

el.matchLabel.addEventListener('change', async (e) => {
  await send({ action: 'setMatchLabel', value: e.target.value });
  refresh();
});

el.enabled.addEventListener('change', async (e) => {
  await send({ action: 'setEnabled', value: e.target.checked });
  refresh();
});

el.onlyIncrease.addEventListener('change', async (e) => {
  await send({ action: 'setOnlyIncrease', value: e.target.checked });
  refresh();
});

el.persistAlert.addEventListener('change', async (e) => {
  await send({ action: 'setPersistAlert', value: e.target.checked });
  refresh();
});

el.autoRefresh.addEventListener('change', async (e) => {
  await send({ action: 'setAutoRefresh', value: e.target.checked });
  refresh();
});

el.ntfyEnabled.addEventListener('change', async (e) => {
  await send({ action: 'setNtfyEnabled', value: e.target.checked });
  refresh();
});

el.ntfyTopic.addEventListener('change', async (e) => {
  await send({ action: 'setNtfyTopic', value: e.target.value });
  refresh();
});

el.testAlert.addEventListener('click', async () => {
  await send({ action: 'testAlert' });
  refresh();
});

el.clearLog.addEventListener('click', async () => {
  await send({ action: 'clearLog' });
  refresh();
});

el.openPage.addEventListener('click', () => {
  send({ action: 'openPage' });
  window.close();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.counterState || changes.counterSettings)) {
    refresh();
  }
});

refresh();