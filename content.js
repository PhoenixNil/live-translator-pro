(() => {
  let host = null;
  let shadow = null;
  let box = null;
  let historyEl = null;
  let liveTranscriptEl = null;
  let manuallyHidden = false;
  let historyEntries = [];

  const MAX_HISTORY = 4;

  const CSS = `
    :host {
      all: initial !important;
      display: block !important;
      position: fixed !important;
      inset: 0 !important;
      z-index: 2147483647 !important;
      pointer-events: none !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                   "Noto Sans SC", "Microsoft YaHei", sans-serif !important;
    }

    .ltp-box {
      position: fixed;
      left: 50%;
      bottom: 60px;
      transform: translateX(-50%);
      pointer-events: auto;
      background: rgba(0, 0, 0, 0.82);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 10px 22px 12px;
      min-width: 360px;
      max-width: 72vw;
      cursor: move;
      user-select: none;
      transition: opacity 0.25s ease;
    }

    .ltp-box.hidden {
      opacity: 0;
      pointer-events: none;
    }

    .ltp-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
      cursor: move;
    }

    .ltp-label {
      font-size: 10px;
      color: rgba(255, 255, 255, 0.3);
      letter-spacing: 1.5px;
      text-transform: uppercase;
    }

    .ltp-close {
      all: unset;
      color: rgba(255, 255, 255, 0.3);
      font-size: 14px;
      cursor: pointer;
      padding: 2px 4px;
      line-height: 1;
    }

    .ltp-close:hover {
      color: #fff;
    }

    .ltp-entry {
      margin-bottom: 6px;
      opacity: 0.6;
      transition: opacity 0.3s;
    }

    .ltp-entry:last-child {
      opacity: 1;
    }

    .ltp-entry.provisional .ltp-trans {
      color: #90caf9;
    }

    .ltp-orig {
      font-size: 13px;
      line-height: 1.5;
      color: rgba(255, 255, 255, 0.55);
      word-break: break-word;
    }

    .ltp-trans {
      font-size: 16px;
      line-height: 1.5;
      color: #64b5f6;
      font-weight: 500;
      word-break: break-word;
    }

    .ltp-div {
      height: 1px;
      background: rgba(255, 255, 255, 0.1);
      margin: 6px 0 10px;
    }

    .ltp-live-block {
      display: grid;
      gap: 4px;
    }

    .ltp-live-label {
      font-size: 10px;
      color: rgba(255, 255, 255, 0.35);
      letter-spacing: 1.2px;
      text-transform: uppercase;
    }

    .ltp-live {
      font-size: 15px;
      line-height: 1.6;
      color: #ffffff;
      min-height: 22px;
      word-break: break-word;
    }

    .ltp-live.interim {
      color: rgba(255, 255, 255, 0.45);
    }
  `;

  function ensureOverlay() {
    if (host) return;

    host = document.createElement('div');
    host.id = 'live-translator-pro-host';
    shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    box = document.createElement('div');
    box.className = 'ltp-box hidden';

    const head = document.createElement('div');
    head.className = 'ltp-head';

    const label = document.createElement('span');
    label.className = 'ltp-label';
    label.textContent = 'Live Translator';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ltp-close';
    closeBtn.textContent = 'x';
    closeBtn.onclick = () => {
      manuallyHidden = true;
      hide();
    };

    head.append(label, closeBtn);

    historyEl = document.createElement('div');
    historyEl.className = 'ltp-history';

    const divider = document.createElement('div');
    divider.className = 'ltp-div';

    const transcriptBlock = document.createElement('div');
    transcriptBlock.className = 'ltp-live-block';

    const transcriptLabel = document.createElement('div');
    transcriptLabel.className = 'ltp-live-label';
    transcriptLabel.textContent = 'Live Transcript';

    liveTranscriptEl = document.createElement('div');
    liveTranscriptEl.className = 'ltp-live interim';

    transcriptBlock.append(transcriptLabel, liveTranscriptEl);

    box.append(head, historyEl, divider, transcriptBlock);
    shadow.appendChild(box);
    document.documentElement.appendChild(host);

    makeDraggable(head, box);
  }

  function createHistoryEntry() {
    ensureOverlay();

    const entry = document.createElement('div');
    entry.className = 'ltp-entry';

    const origDiv = document.createElement('div');
    origDiv.className = 'ltp-orig';
    origDiv.textContent = '';

    const transDiv = document.createElement('div');
    transDiv.className = 'ltp-trans';

    entry.append(origDiv, transDiv);
    return { entry, origDiv, transDiv };
  }

  function addOrUpdateHistoryEntry(message) {
    ensureOverlay();

    let record = historyEntries.find((item) => item.entryId === message.entryId);

    if (!record) {
      record = { entryId: message.entryId, ...createHistoryEntry() };
      historyEntries.push(record);
      historyEl.appendChild(record.entry);

      while (historyEntries.length > MAX_HISTORY) {
        const oldest = historyEntries.shift();
        oldest.entry.remove();
      }
    }

    record.origDiv.textContent = message.originalText || '';
    record.transDiv.textContent = message.translation || '';
    record.entry.classList.toggle('provisional', Boolean(message.provisional));
  }

  function resetOverlayContent() {
    ensureOverlay();
    historyEntries = [];
    if (historyEl) historyEl.innerHTML = '';
    liveTranscriptEl.textContent = '';
    liveTranscriptEl.classList.add('interim');
  }

  function makeDraggable(handle, target) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.classList?.contains('ltp-close')) return;

      const rect = target.getBoundingClientRect();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;

      target.style.setProperty('left', `${rect.left}px`);
      target.style.setProperty('top', `${rect.top}px`);
      target.style.setProperty('bottom', 'auto');
      target.style.setProperty('transform', 'none');
      handle.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;

      target.style.setProperty('left', `${startLeft + e.clientX - startX}px`);
      target.style.setProperty('top', `${startTop + e.clientY - startY}px`);
    });

    const stopDragging = (e) => {
      if (!dragging) return;

      dragging = false;
      handle.releasePointerCapture?.(e.pointerId);
    };

    handle.addEventListener('pointerup', stopDragging);
    handle.addEventListener('pointercancel', stopDragging);
  }

  function show() {
    ensureOverlay();
    if (manuallyHidden) return;
    box.classList.remove('hidden');
  }

  function hide() {
    if (box) box.classList.add('hidden');
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'transcript-result') {
      if (msg.translation && msg.originalText) {
        show();
        addOrUpdateHistoryEntry(msg);
        return;
      }

      if (msg.transcript !== undefined) {
        show();
        liveTranscriptEl.textContent = msg.transcript || '';
        liveTranscriptEl.classList.toggle('interim', !msg.isFinal);
      }

      return;
    }

    if (msg.type === 'capture-status') {
      if (msg.status === 'stopped') {
        manuallyHidden = false;
        resetOverlayContent();
        hide();
        return;
      }

      if (msg.status === 'error' && msg.fatal !== false) {
        manuallyHidden = false;
        resetOverlayContent();
        hide();
        return;
      }

      if (msg.status === 'capturing') {
        if (msg.resetSession) {
          manuallyHidden = false;
        }

        show();

        if (msg.resetSession) {
          resetOverlayContent();
          liveTranscriptEl.textContent = 'Waiting for audio...';
        }
      }
    }
  });
})();
