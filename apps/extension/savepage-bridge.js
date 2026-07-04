// Save Page WE bridge — handles SPWE message protocol and capture orchestration
// Only uses Chrome APIs (scripting, tabs, fetch). No deps back to background.js.
import { logDebug } from './logger.js';

const captureSessions = new Map();
let nextCaptureId = 1;

const CAPTURE_TIMEOUT_MS = 60_000;
const CAPTURE_CLEANUP_TIMEOUT_MS = 15_000;
const RESOURCE_TIMEOUT_MS = 10_000;
const MAX_RESOURCE_SIZE = 50 * 1024 * 1024;
const VIDEO_URL_PATTERN = /\.(mp4|webm|ogg|mov|avi|m4v)(\?|#|$)/i;

function matchingCaptureSession(tabId, captureId) {
  const session = captureSessions.get(tabId);
  return session?.id === captureId ? session : null;
}

function settleCaptureSession(
  tabId,
  session,
  { html = null, error = null, keepSession = false } = {},
) {
  if (captureSessions.get(tabId) !== session) return;

  clearTimeout(session.timeoutId);
  if (!keepSession) {
    clearTimeout(session.cleanupTimeoutId);
    captureSessions.delete(tabId);
  }
  if (session.settled) return;

  session.settled = true;
  if (error) session.reject(error);
  else {
    session.resolve({
      html,
      warnings: [...session.warnings.values()],
    });
  }
}

async function injectSavepageScripts(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['savepage/content-frame.js'],
  });
  logDebug('[savepage] content-frame.js injected, now injecting content.js');

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['savepage/content.js'],
  });
  logDebug('[savepage] content.js injected, waiting for scriptLoaded message');
}

export function captureSavePage(tabId, settings = {}) {
  if (captureSessions.has(tabId)) {
    return Promise.reject(
      new Error('Snapshot capture is already in progress for this tab'),
    );
  }

  return new Promise((resolve, reject) => {
    const session = {
      id: nextCaptureId++,
      cleanupTimeoutId: null,
      reject,
      resolve,
      settings: settings || {},
      settled: false,
      started: false,
      timeoutId: null,
      warnings: new Map(),
    };
    captureSessions.set(tabId, session);
    logDebug('[savepage] injecting scripts into tab', tabId);

    injectSavepageScripts(tabId).catch((error) => {
      logDebug('[savepage] injection error:', error.message);
      settleCaptureSession(tabId, session, { error });
    });

    session.timeoutId = setTimeout(() => {
      if (captureSessions.get(tabId) !== session || session.settled) return;
      chrome.tabs
        .sendMessage(tabId, {
          type: 'cancelSave',
          captureId: session.id,
        })
        .catch(() => {});
      settleCaptureSession(tabId, session, {
        error: new Error('Save Page WE capture timed out'),
        keepSession: true,
      });
      session.cleanupTimeoutId = setTimeout(() => {
        if (captureSessions.get(tabId) === session) {
          captureSessions.delete(tabId);
        }
      }, CAPTURE_CLEANUP_TIMEOUT_MS);
    }, CAPTURE_TIMEOUT_MS);
  });
}

function sendResourceFailure(tabId, captureId, index, reason) {
  chrome.tabs.sendMessage(tabId, {
    type: 'loadFailure',
    captureId,
    index,
    reason,
  });
}

function isSupportedResourceType(mimetype) {
  return (
    mimetype === 'text/css' ||
    mimetype === 'image/vnd.microsoft.icon' ||
    mimetype.startsWith('image/') ||
    mimetype.startsWith('audio/') ||
    mimetype.startsWith('video/') ||
    mimetype.startsWith('font/') ||
    mimetype.startsWith('application/font') ||
    mimetype === 'application/octet-stream'
  );
}

function arrayBufferToBinaryString(buffer) {
  const bytes = new Uint8Array(buffer);
  let binaryString = '';
  for (const byte of bytes) binaryString += String.fromCharCode(byte);
  return binaryString;
}

async function loadSavepageResource(
  tabId,
  captureId,
  index,
  location,
  referrer,
  referrerPolicy,
) {
  const session = matchingCaptureSession(tabId, captureId);
  if (!session) return;

  // Skip video URLs before fetching (SPWE treats loadFailure as "skip resource")
  if (
    VIDEO_URL_PATTERN.test(location) &&
    session.settings.captureSnapshotVideo !== true
  ) {
    sendResourceFailure(tabId, captureId, index, 'blocked*');
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESOURCE_TIMEOUT_MS);

  try {
    const response = await fetch(location, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-cache',
      referrer: referrer,
      referrerPolicy: referrerPolicy,
      signal: controller.signal,
    });
    if (response.status === 200) {
      const contentType = response.headers.get('Content-Type') || '';
      const contentLength = +(response.headers.get('Content-Length') || 0);

      if (contentLength > MAX_RESOURCE_SIZE) {
        sendResourceFailure(tabId, captureId, index, 'maxsize*');
        return;
      }

      const matches = contentType.match(/([^;]+)/i);
      const mimetype = matches ? matches[1].toLowerCase() : '';
      const charsetMatch = contentType.match(/;charset=([^;]+)/i);
      const charset = charsetMatch ? charsetMatch[1].toLowerCase() : '';

      if (!isSupportedResourceType(mimetype)) {
        sendResourceFailure(tabId, captureId, index, 'blocked*');
        return;
      }

      // Also catch videos by MIME type (URL extension check above may miss some)
      if (
        mimetype.startsWith('video/') &&
        session.settings.captureSnapshotVideo !== true
      ) {
        sendResourceFailure(tabId, captureId, index, 'blocked*');
        return;
      }

      chrome.tabs.sendMessage(tabId, {
        type: 'loadSuccess',
        captureId,
        index,
        reason: '*',
        content: arrayBufferToBinaryString(await response.arrayBuffer()),
        mimetype,
        charset,
      });
    } else {
      sendResourceFailure(tabId, captureId, index, `load:${response.status}*`);
    }
  } catch (e) {
    const reason = e.name === 'AbortError' ? 'maxtime*' : 'fetcherr*';
    sendResourceFailure(tabId, captureId, index, reason);
  } finally {
    clearTimeout(timeout);
  }
}

// Register the onMessage listener for Save Page WE type-based messages
export function initSavepageBridge() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message.type) return false; // Not a Save Page WE message

    const tabId = sender.tab?.id;

    switch (message.type) {
      case 'scriptLoaded':
        // Reply with performAction to kick off the save
        logDebug('[savepage] scriptLoaded received from tab', tabId);
        if (tabId != null) {
          const session = captureSessions.get(tabId);
          if (!session || session.settled || session.started) break;
          session.started = true;
          chrome.tabs.sendMessage(tabId, {
            type: 'performAction',
            captureId: session.id,
            menuaction: 0,
            saveditems: 1,
            togglelazy: false,
            extractsrcurl: null,
            externalsave: false,
            swapdevices: false,
            multiplesaves: false,
            csprestriction: false,
          });
        }
        break;

      case 'resourceFailure': {
        if (tabId == null) break;
        const session = matchingCaptureSession(tabId, message.captureId);
        if (
          !session ||
          session.settled ||
          !message.location ||
          !message.reason
        ) {
          break;
        }
        const warning = {
          location: String(message.location),
          reason: String(message.reason),
        };
        session.warnings.set(
          `${warning.reason}\u0000${warning.location}`,
          warning,
        );
        break;
      }

      case 'setDelay':
        setTimeout(() => {
          sendResponse({});
        }, message.milliseconds);
        return true; // async response

      case 'requestFrames':
        if (tabId != null) {
          chrome.tabs.sendMessage(tabId, { type: 'requestFrames' });
        }
        break;

      case 'replyFrame':
        if (tabId != null) {
          chrome.tabs.sendMessage(tabId, {
            type: 'replyFrame',
            key: message.key,
            url: message.url,
            html: message.html,
            fonts: message.fonts,
          });
        }
        break;

      case 'loadResource':
        if (tabId != null) {
          loadSavepageResource(
            tabId,
            message.captureId,
            message.index,
            message.location,
            message.referrer,
            message.referrerPolicy,
          );
        }
        break;

      case 'stateChanged':
        break;

      case 'savepageDone': {
        logDebug(
          '[savepage] savepageDone from tab',
          tabId,
          'html length:',
          message.html?.length,
        );
        const session = matchingCaptureSession(tabId, message.captureId);
        if (session) {
          settleCaptureSession(tabId, session, { html: message.html });
        } else {
          logDebug(
            '[savepage] savepageDone but no matching session for tab',
            tabId,
          );
        }
        break;
      }

      case 'saveExit': {
        logDebug('[savepage] saveExit from tab', tabId);
        const session = matchingCaptureSession(tabId, message.captureId);
        if (session) {
          settleCaptureSession(tabId, session, {
            error: new Error('Save Page WE exited without producing HTML'),
          });
        }
        break;
      }

      default:
        return false; // Unknown type — don't hold the channel
    }
  });
}
