// Runs on the Dueboard site: tells the page the extension is installed and relays connect/sync requests.
document.documentElement.dataset.dueboardExtension = chrome.runtime.getManifest().version;

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const msg = event.data;
  if (!msg || msg.source !== 'dueboard-page' || !['connect', 'sync'].includes(msg.type)) return;
  chrome.runtime.sendMessage({ type: msg.type, key: msg.key }, (result) => {
    window.postMessage({ source: 'dueboard-extension', id: msg.id, result }, location.origin);
  });
});
