// Dueboard Sync: downloads the Moodle calendar from inside the browser (which passes Moodle's
// bot check) and uploads it to Dueboard with a key that can only do that.

const SYNC_EVERY_MINUTES = 60;
const MOODLE_VISIT_MIN_GAP_MS = 10 * 60 * 1000;
const DUEBOARD_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const KEY = /^[a-f0-9]{64}$/;

function scheduleSync() {
  chrome.alarms.create('sync', { periodInMinutes: SYNC_EVERY_MINUTES });
}
chrome.runtime.onInstalled.addListener(scheduleSync);
chrome.runtime.onStartup.addListener(() => { scheduleSync(); sync(); });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'sync') sync(); });

async function setStatus(ok, message) {
  const status = { ok, message, at: Date.now() };
  await chrome.storage.local.set(ok ? { status, lastOkAt: status.at } : { status });
  await chrome.action.setBadgeText({ text: ok ? '' : '!' });
  await chrome.action.setBadgeBackgroundColor({ color: '#c62f2f' });
}

async function dueboard(path, init = {}) {
  const { server, key } = await chrome.storage.local.get(['server', 'key']);
  if (!server || !key) throw new Error('Not connected. Open Dueboard → Settings → Connect extension.');
  let res;
  try {
    res = await fetch(server + path, { ...init, headers: { ...init.headers, authorization: `Bearer ${key}` } });
  } catch {
    throw new Error(`Dueboard is not reachable at ${server}. Is it running?`);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('Dueboard no longer accepts this extension. Connect it again in Settings.');
  if (!res.ok) throw new Error(data.error || `Dueboard error ${res.status}`);
  return data;
}

async function upload(ics) {
  const { imported } = await dueboard('/api/extension/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ics }),
  });
  await setStatus(true, `Synced ${imported} Moodle events`);
  return { ok: true, imported };
}

async function calendarLink() {
  const { icsUrl } = await dueboard('/api/extension/config');
  if (!icsUrl) throw new Error('Add your Moodle calendar link in Dueboard → Settings.');
  return icsUrl;
}

async function sync() {
  try {
    const res = await fetch(await calendarLink(), { credentials: 'include' });
    const ics = await res.text();
    if (!res.ok || !/BEGIN:VCALENDAR/i.test(ics)) {
      throw new Error('Moodle wants a browser check. Open Moodle once and it will sync from there.');
    }
    return await upload(ics);
  } catch (err) {
    await setStatus(false, err.message);
    return { ok: false, error: err.message };
  }
}

const isFrom = (sender, pattern) => {
  try { return pattern.test(new URL(sender.url).origin); } catch { return false; }
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    const fromPopup = !sender.tab && sender.id === chrome.runtime.id;
    const fromDueboard = isFrom(sender, DUEBOARD_ORIGIN);
    const fromMoodle = isFrom(sender, /^https:\/\/learn\.ucu\.edu\.ua$/);

    if (msg.type === 'connect' && fromDueboard && KEY.test(msg.key || '')) {
      await chrome.storage.local.set({ server: new URL(sender.url).origin, key: msg.key });
      return reply(await sync());
    }
    if (msg.type === 'sync' && (fromDueboard || fromPopup)) return reply(await sync());

    // A Moodle tab just loaded: it can download the calendar as a normal same-site request.
    if (msg.type === 'moodle-visit' && fromMoodle) {
      const { lastOkAt = 0 } = await chrome.storage.local.get('lastOkAt');
      if (Date.now() - lastOkAt < MOODLE_VISIT_MIN_GAP_MS) return reply({ skip: true });
      try {
        const icsUrl = await calendarLink();
        return reply({ icsUrl: new URL(icsUrl).origin === new URL(sender.url).origin ? icsUrl : null });
      } catch (err) {
        await setStatus(false, err.message);
        return reply({ skip: true });
      }
    }
    if (msg.type === 'moodle-ics' && fromMoodle && typeof msg.ics === 'string') {
      try { return reply(await upload(msg.ics)); } catch (err) {
        await setStatus(false, err.message);
        return reply({ ok: false, error: err.message });
      }
    }
    reply({ ok: false, error: 'Unsupported message' });
  })();
  return true; // reply asynchronously
});
