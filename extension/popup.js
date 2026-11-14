const statusEl = document.getElementById('status');
const detailsEl = document.getElementById('details');
const button = document.getElementById('sync');

async function show() {
  const { server, status, lastOkAt } = await chrome.storage.local.get(['server', 'status', 'lastOkAt']);
  if (!server) {
    statusEl.textContent = 'Not connected yet. Open Dueboard → Settings → Connect extension.';
    detailsEl.textContent = '';
    button.disabled = true;
    return;
  }
  button.disabled = false;
  statusEl.textContent = status ? status.message : 'Waiting for the first sync.';
  statusEl.className = status && !status.ok ? 'bad' : '';
  const when = lastOkAt ? `Last successful sync: ${new Date(lastOkAt).toLocaleString()}` : 'No successful sync yet';
  detailsEl.textContent = `${when}. Syncs every hour and when you open Moodle. Dueboard: ${server}`;
}

button.addEventListener('click', async () => {
  button.disabled = true;
  statusEl.textContent = 'Syncing…';
  await chrome.runtime.sendMessage({ type: 'sync' });
  await show();
});

show();
