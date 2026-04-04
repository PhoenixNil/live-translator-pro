let activeTabId = null;

// Restore state on service worker wake-up (MV3 can kill service workers at any time)
chrome.storage.session.get('activeTabId', (result) => {
  if (result.activeTabId) {
    activeTabId = result.activeTabId;
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
  }
});

function persistActiveTabId(tabId) {
  activeTabId = tabId;
  chrome.storage.session.set({ activeTabId: tabId });
}

// Stop capture when the captured tab is closed or navigated away
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) {
    stopCapture();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && changeInfo.url) {
    stopCapture();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'start-capture':
      startCapture(message.config);
      sendResponse({ status: 'starting' });
      break;

    case 'stop-capture':
      stopCapture();
      sendResponse({ status: 'stopping' });
      break;

    case 'transcript-result':
      if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, message).catch(() => {});
      }
      break;

    case 'capture-status':
      const fatalCaptureError = message.status === 'error' && message.fatal !== false;

      chrome.runtime.sendMessage(message).catch(() => {});
      if (activeTabId) {
        chrome.tabs.sendMessage(activeTabId, message).catch(() => {});
      }

      if (fatalCaptureError) {
        chrome.action.setBadgeText({ text: 'ERR' });
        chrome.action.setBadgeBackgroundColor({ color: '#F44336' });
        persistActiveTabId(null);
      }
      break;

    case 'get-status':
      sendResponse({ capturing: activeTabId !== null, tabId: activeTabId });
      break;
  }

  return true;
});

async function startCapture(config) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      broadcastStatus('error', 'No active tab found.', { fatal: true });
      return;
    }

    persistActiveTabId(tab.id);

    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id
    });

    await ensureOffscreenDocument();

    chrome.runtime.sendMessage({
      type: 'offscreen-start-capture',
      streamId,
      config
    }).catch(() => {});

    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
    broadcastStatus('capturing', 'Connecting to Deepgram...', { resetSession: true });
  } catch (err) {
    console.error('[LTP] startCapture error:', err);
    broadcastStatus('error', err.message || 'Failed to start capture.', { fatal: true });
    chrome.action.setBadgeText({ text: 'ERR' });
    chrome.action.setBadgeBackgroundColor({ color: '#F44336' });
    persistActiveTabId(null);
  }
}

async function stopCapture() {
  chrome.runtime.sendMessage({ type: 'offscreen-stop-capture' }).catch(() => {});

  setTimeout(async () => {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
      });

      if (contexts.length > 0) {
        await chrome.offscreen.closeDocument();
      }
    } catch (_) {
      // Ignore cleanup errors.
    }
  }, 500);

  broadcastStatus('stopped', 'Capture stopped.');
  chrome.action.setBadgeText({ text: '' });
  persistActiveTabId(null);
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Capture tab audio for real-time transcription and translation'
  });
}

function broadcastStatus(status, message, extra = {}) {
  const msg = { type: 'capture-status', status, message, ...extra };
  chrome.runtime.sendMessage(msg).catch(() => {});

  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, msg).catch(() => {});
  }
}
