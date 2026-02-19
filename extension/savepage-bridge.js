// Save Page WE bridge — handles SPWE message protocol and capture orchestration
// Only uses Chrome APIs (scripting, tabs, fetch). No deps back to background.js.

const savepageResolvers = new Map();

export function captureSavePage(tabId) {
  return new Promise((resolve, reject) => {
    savepageResolvers.set(tabId, { resolve, reject });
    console.log('[savepage] injecting scripts into tab', tabId);

    // Inject content-frame.js into all frames, then content.js into main frame
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['savepage/content-frame.js']
    }).then(() => {
      console.log('[savepage] content-frame.js injected, now injecting content.js');
      return chrome.scripting.executeScript({
        target: { tabId },
        files: ['savepage/content.js']
      });
    }).then(() => {
      console.log('[savepage] content.js injected, waiting for scriptLoaded message');
    }).catch(err => {
      console.warn('[savepage] injection error:', err.message);
      savepageResolvers.delete(tabId);
      reject(err);
    });

    // Timeout after 60s
    setTimeout(() => {
      if (savepageResolvers.has(tabId)) {
        savepageResolvers.delete(tabId);
        reject(new Error('Save Page WE capture timed out'));
      }
    }, 60000);
  });
}

async function loadSavepageResource(tabId, index, location, referrer, referrerPolicy) {
  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(); }, 10 * 1000); // maxResourceTime

  try {
    const response = await fetch(location, {
      method: 'GET', mode: 'cors', cache: 'no-cache',
      referrer: referrer, referrerPolicy: referrerPolicy,
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (response.status === 200) {
      const contentType = response.headers.get('Content-Type') || '';
      const contentLength = +(response.headers.get('Content-Length') || 0);

      if (contentLength > 50 * 1024 * 1024) { // maxResourceSize
        chrome.tabs.sendMessage(tabId, { type: 'loadFailure', index, reason: 'maxsize*' });
        return;
      }

      const matches = contentType.match(/([^;]+)/i);
      const mimetype = matches ? matches[1].toLowerCase() : '';
      const charsetMatch = contentType.match(/;charset=([^;]+)/i);
      const charset = charsetMatch ? charsetMatch[1].toLowerCase() : '';

      if (mimetype !== 'text/css' && mimetype !== 'image/vnd.microsoft.icon' &&
          !mimetype.startsWith('image/') && !mimetype.startsWith('audio/') && !mimetype.startsWith('video/') &&
          !mimetype.startsWith('font/') && !mimetype.startsWith('application/font') &&
          mimetype !== 'application/octet-stream') {
        chrome.tabs.sendMessage(tabId, { type: 'loadFailure', index, reason: 'blocked*' });
        return;
      }

      const buffer = await response.arrayBuffer();
      const byteArray = new Uint8Array(buffer);
      let binaryString = '';
      for (let i = 0; i < byteArray.byteLength; i++) binaryString += String.fromCharCode(byteArray[i]);

      chrome.tabs.sendMessage(tabId, { type: 'loadSuccess', index, reason: '*', content: binaryString, mimetype, charset });
    } else {
      chrome.tabs.sendMessage(tabId, { type: 'loadFailure', index, reason: 'load:' + response.status + '*' });
    }
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') {
      chrome.tabs.sendMessage(tabId, { type: 'loadFailure', index, reason: 'maxtime*' });
    } else {
      chrome.tabs.sendMessage(tabId, { type: 'loadFailure', index, reason: 'fetcherr*' });
    }
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
        console.log('[savepage] scriptLoaded received from tab', tabId);
        if (tabId != null) {
          chrome.tabs.sendMessage(tabId, {
            type: 'performAction',
            menuaction: 0,
            saveditems: 1,
            togglelazy: false,
            extractsrcurl: null,
            externalsave: false,
            swapdevices: false,
            multiplesaves: false,
            csprestriction: false
          });
        }
        break;

      case 'setDelay':
        setTimeout(() => { sendResponse({}); }, message.milliseconds);
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
            fonts: message.fonts
          });
        }
        break;

      case 'loadResource':
        if (tabId != null) {
          loadSavepageResource(tabId, message.index, message.location, message.referrer, message.referrerPolicy);
        }
        break;

      case 'stateChanged':
        break;

      case 'savepageDone': {
        console.log('[savepage] savepageDone from tab', tabId, 'html length:', message.html?.length);
        const resolver = savepageResolvers.get(tabId);
        if (resolver) {
          savepageResolvers.delete(tabId);
          resolver.resolve(message.html);
        } else {
          console.warn('[savepage] savepageDone but no resolver for tab', tabId);
        }
        break;
      }

      case 'saveExit': {
        console.warn('[savepage] saveExit from tab', tabId);
        const resolver = savepageResolvers.get(tabId);
        if (resolver) {
          savepageResolvers.delete(tabId);
          resolver.reject(new Error('Save Page WE exited without producing HTML'));
        }
        break;
      }

      default:
        return false; // Unknown type — don't hold the channel
    }
  });
}
