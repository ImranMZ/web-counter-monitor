# Web Counter Monitor

A Chrome (Manifest V3) extension that watches a numeric counter on any web page and raises an alert the moment it changes — on the taskbar via desktop notifications and optionally on your phone via the free [ntfy.sh](https://ntfy.sh) push service.

> **Why this exists** — When a phone is stolen, its IMEI is blocked the moment it's reported and matched in a central registry. That single counter is a live signal: a new match usually means a recovered stolen device — often with the person carrying it — has been located, and responding quickly matters. Manually refreshing the dashboard and hoping you glance at the right second was too slow and too risky. This extension turns that daily manual checkpoint into an instant desktop + phone alert, helping cut minutes of delay to seconds.

It generalizes to any office-automation metric that's only computed server-side on page load — an application dashboard, an order queue, an IMEI or registration counter — since a periodic reload plus change detection is all it takes to surface new activity.

## Features

- **Change detection** — watches the number next to any text label on your target page and alerts on every change.
- **Auto-refresh** — reloads the target page every 60 seconds (configurable 30s–5m) from a background `chrome.alarms` tick, which surfaces new counts even when content scripts go stale.
- **Desktop alerts** — professional, single-toast notifications. The previous toast is dismissed *before* the next one appears, so you never see a stale alert next to a fresh one.
- **Phone push (ntfy.sh)** — free push notifications to your phone. Subscribe to your private topic in the ntfy app and receive the same alerts remotely; tapping an alert opens the target page on your phone.
- **Alert on increase only** — optional mode that suppresses alerts on decreases.
- **Local-only configuration** — the target page URL lives in your own browser storage, never on a server.
- **Change history** — last 50 changes with timestamps in the popup.
- **Auto-open if closed** — if no matching tab exists on refresh, the extension opens the target page automatically (toggleable).
- **Stalled watcher alert** — if the counter can't be found for N consecutive checks (session expired, page changed, offline), a distinct high-priority alert fires on desktop and phone.
- **Phone heartbeat** — optional periodic silent ping to ntfy (15m–2h) so you know the watcher is alive even when nothing changes.
- **Health dashboard in popup** — live status dot (green/yellow/red), last-checked timestamp, and next-refresh countdown.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the folder containing this extension.
4. Pin the extension for quick access (puzzle icon → pin).

## First-time setup

1. Click the toolbar icon to open the popup.
2. Open the page that contains your counter, and copy its URL into **Target page URL** (e.g. `https://your-app.example.com/dashboard`).
3. Chrome will ask for permission to access that site — **Allow** it.
4. Enter the exact text label that appears next to the number you want to watch into **Counter label** (e.g. `Matched Unique IMEI` or `Pending Orders`).
5. The extension injects its watch script on that page and records the current value as the baseline. You'll see **Monitoring** once it picks the counter up.

When the number changes, a desktop notification appears with the `old → new` values.

> **Troubleshooting**: if the status shows **Counter not found**, check that you are signed in to the target page and that the label matches exactly (the match is case-insensitive). After configuring, the page reloads automatically so the watcher takes effect.

## Phone push (optional)

1. Toggle **Push to phone (ntfy.sh)** in the popup.
2. Install the **ntfy** app from [ntfy.sh/apps](https://ntfy.sh/apps).
3. Tap **Subscribe to topic** and type the topic name from the popup (e.g. `counter-monitor-abcdefgh`).
4. That's it — changes now push to your phone. Tapping the phone notification opens the target page.

> Keep the topic private: anyone who knows the topic can also subscribe and read the counts.

## Settings summary

| Setting                  | Effect |
| ------------------------ | ------ |
| Target page URL          | The page to watch (required). |
| Counter label            | Text next to the number to track. |
| Desktop alerts           | Enable/disable desktop notifications. |
| Auto-refresh page        | Reload the target every 60s (drives change detection). |
| Auto-open if closed      | Open the target page automatically if no tab matches on refresh. |
| Alert on increase only   | Only alert when the number goes up. |
| Keep alert on screen     | Leave the notification visible until dismissed. |
| Stalled watcher alert    | Alert when the counter isn't found for N consecutive checks. |
| Stall threshold          | How many consecutive misses before the stalled alert fires (2–10). |
| Push to phone (ntfy.sh)  | Forward alerts to your phone. |
| Topic name               | Private ntfy topic for your subscriptions. |
| Phone heartbeat          | Send a periodic silent health ping to your phone (15m–2h). |

## How it works

- **`background.js`** — single source of truth. Persists the last seen value, dedupes identical reports from multiple tabs, decides when to alert, keeps the toolbar badge in sync, schedules the 60-second auto-refresh alarm, and sends ntfy pushes. The watch script is registered per-site with `chrome.scripting`, so the manifest never contains any site-specific URL.
- **`content.js`** — injected only on your configured page. Finds the number next to the configured label, re-reads it on DOM mutations and a periodic fallback poll, and reports the value (or "counter not found") back to the background worker.
- **`popup.html/js/css`** — control panel: status, live value, settings, ntfy config, change history, test notification, and open-target buttons.

## Change log

- **v2.1.0** — Auto-open target tab if missing; stalled-watcher watchdog with urgent ntfy push; optional phone heartbeat (15m–2h); popup health dot + last-checked + next-refresh countdown; new settings: autoOpenTab, stallThreshold, stallAlertEnabled, heartbeatEnabled, heartbeatIntervalMin. Fix: auto-refresh now reloads with cache bypass so a counter that is computed server-side on page load is always freshly fetched instead of served from the browser cache; content script re-reads the counter once the configured label has loaded (prevents a wrong-label read on page load).
- **v2.0.0** — Target page and label are now user-configurable (per-site injection); renamed project to *Web Counter Monitor*; one-time migration preserves existing settings.
- **v1.3.1** — Auto-refresh moved to a background alarm so it keeps working regardless of content-script staleness.
- **v1.3.0** — ntfy.sh phone push added.