import fs from 'node:fs';
import path from 'node:path';

export const POPUP_STARTUP_ERROR =
  'The recording state could not be loaded because the extension context was invalidated. Reload the extension and reopen this popup. If the problem continues, reconnect Browser Recall Desktop.';

export const POPUP_LONG_STARTUP_ERROR = `${POPUP_STARTUP_ERROR}\n${'recording-state/'.repeat(600)}`;

// Inject only into disposable test extensions. Fail the actual startup message
// before the production popup handles the error; production bundles omit this.
export function installPopupStartupFailure(extensionDir) {
  fs.writeFileSync(
    path.join(extensionDir, 'popup-startup-failure.js'),
    `
const failure = new URL(location.href).searchParams.get('startupFailure');
if (failure) {
  if (new URL(location.href).searchParams.get('scrollbars') === 'classic') {
    const style = document.createElement('style');
    style.textContent = '.fatal-error-message { scrollbar-color: auto; scrollbar-width: auto; } .fatal-error-message::-webkit-scrollbar { width: 16px; }';
    document.head.append(style);
  }
  const runtime = (globalThis.browser || globalThis.chrome).runtime;
  const send = runtime.sendMessage.bind(runtime);
  runtime.sendMessage = (request, ...args) => {
    if (request?.action !== 'getRecordingState') return send(request, ...args);
    globalThis.popupStartupFailureCalls = (globalThis.popupStartupFailureCalls || 0) + 1;
    return Promise.resolve({success:false, error:failure === 'long' ? ${JSON.stringify(POPUP_LONG_STARTUP_ERROR)} : ${JSON.stringify(POPUP_STARTUP_ERROR)}});
  };
}
`,
  );
  const popup = path.join(extensionDir, 'popup.html');
  fs.writeFileSync(
    popup,
    fs
      .readFileSync(popup, 'utf8')
      .replace(
        '</head>',
        '<script src="popup-startup-failure.js"></script></head>',
      ),
  );
}
