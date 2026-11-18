// Runs on Moodle pages. The page already passed the bot check, so a same-site download works here.
(async () => {
  const { icsUrl } = await chrome.runtime.sendMessage({ type: 'moodle-visit' });
  if (!icsUrl) return;
  try {
    const res = await fetch(icsUrl, { credentials: 'include' });
    const ics = await res.text();
    if (res.ok && /BEGIN:VCALENDAR/i.test(ics)) await chrome.runtime.sendMessage({ type: 'moodle-ics', ics });
  } catch {
    // Network hiccup: the hourly sync or the next Moodle visit will try again.
  }
})();
