const statusEl = document.getElementById('status');
const detailsEl = document.getElementById('details');
const button = document.getElementById('sync');

async function show() {
  const { server, status, lastOkAt } = await chrome.storage.local.get(['server', 'status', 'lastOkAt']);
  if (!server) {
    statusEl.textContent = 'Ще не під’єднано. Відкрийте Dueboard → Налаштування → «Під’єднати розширення».';
    detailsEl.textContent = '';
    button.disabled = true;
    return;
  }
  button.disabled = false;
  statusEl.textContent = status ? status.message : 'Чекаю першої синхронізації.';
  statusEl.className = status && !status.ok ? 'bad' : '';
  const when = lastOkAt ? `Остання вдала синхронізація: ${new Date(lastOkAt).toLocaleString('uk-UA')}` : 'Вдалих синхронізацій ще не було';
  detailsEl.textContent = `${when}. Syncs every hour and when you open Moodle. Dueboard: ${server}`;
}

button.addEventListener('click', async () => {
  button.disabled = true;
  statusEl.textContent = 'Синхронізую…';
  await chrome.runtime.sendMessage({ type: 'sync' });
  await show();
});

show();
