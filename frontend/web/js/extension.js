// Talking to the Dueboard Sync browser extension.
import { act, api, appState, h, toast } from './core.js';
import { render } from './router.js';

// The Dueboard Sync extension marks the page when installed and answers window messages.
const extensionInstalled = () => Boolean(document.documentElement.dataset.dueboardExtension);

let extensionCallId = 0;
function extensionCall(type, extra = {}) {
  return new Promise((resolve, reject) => {
    const id = ++extensionCallId;
    const done = () => { clearTimeout(timer); window.removeEventListener('message', onMessage); };
    const timer = setTimeout(() => {
      done();
      reject(new Error('Розширення Dueboard Sync не відповіло. Перезавантажте сторінку й спробуйте ще раз.'));
    }, 30_000);
    function onMessage(event) {
      if (event.source !== window || event.data?.source !== 'dueboard-extension' || event.data.id !== id) return;
      done();
      const result = event.data.result;
      if (!result) reject(new Error('Розширення не відповіло. Перезавантажте розширення й цю сторінку.'));
      else if (result.ok) resolve(result);
      else reject(new Error(result.error));
    }
    window.addEventListener('message', onMessage);
    window.postMessage({ source: 'dueboard-page', type, id, ...extra }, location.origin);
  });
}

// Sync through the extension when it is connected (needed for Moodles behind a bot check), else via the server.
export function syncMoodle() {
  if (appState.me.extension.connected && extensionInstalled()) return extensionCall('sync');
  return api('POST', '/api/sync', {});
}

export function extensionCard() {
  const steps = h('ol', { class: 'small' },
    h('li', {}, 'Відкрийте ', h('span', { class: 'code' }, 'chrome://extensions'), ' і ввімкніть режим розробника (праворуч угорі).'),
    h('li', {}, 'Натисніть «Load unpacked» і виберіть папку ', h('span', { class: 'code' }, 'frontend/extension'), ' цього проєкту.'),
    h('li', {}, 'Перезавантажте цю сторінку й натисніть «Під’єднати розширення».'));
  const intro = h('p', { class: 'muted small' },
    'Moodle УКУ блокує сервери перевіркою на бота, тож Dueboard не може сам завантажити ваш календар. '
    + 'Розширення Dueboard Sync завантажує його з вашого браузера щогодини й щоразу, коли ви відкриваєте Moodle.');

  if (!extensionInstalled()) {
    return [intro, steps, appState.me.extension.connected
      ? h('p', { class: 'small' }, 'Під’єднано в іншому браузері. Встановіть розширення і тут, щоб синхронізувати з цього.')
      : null];
  }
  if (!appState.me.extension.connected) {
    return [intro, h('button', {
      type: 'button',
      onclick: async (e) => {
        e.target.disabled = true;
        const { key } = (await act(() => api('POST', '/api/extension/key', {}))) || {};
        if (key) {
          const r = await act(() => extensionCall('connect', { key }));
          // The extension did not take the key: take it back, so Settings does not claim a connection that is not there.
          if (r) toast(`Розширення під’єднано, синхронізовано подій Moodle: ${r.imported}`);
          else await api('DELETE', '/api/extension/key').catch(() => {});
        }
        render();
      },
    }, 'Під’єднати розширення')];
  }
  return [
    h('p', {}, h('span', { class: 'status-ok' }, 'Під’єднано'), ' Дедлайни оновлюються щогодини й щоразу, коли ви відкриваєте Moodle.'),
    h('div', { class: 'row' },
      h('button', {
        type: 'button', class: 'shrink',
        onclick: async (e) => {
          e.target.disabled = true;
          const r = await act(() => extensionCall('sync'));
          if (r) toast(`Синхронізовано подій Moodle: ${r.imported}`);
          render();
        },
      }, 'Синхронізувати'),
      h('button', {
        type: 'button', class: 'secondary shrink',
        onclick: async () => {
          if (await act(() => api('DELETE', '/api/extension/key'))) render();
        },
      }, 'Від’єднати')),
  ];
}
