const $ = (id) => document.getElementById(id);

const deepgramKey = $('deepgramKey');
const translationProvider = $('translationProvider');
const dashscopeKey = $('dashscopeKey');
const deeplKey = $('deeplKey');
const dashscopeSection = $('dashscopeSection');
const deeplSection = $('deeplSection');
const srcLang = $('srcLang');
const tgtLang = $('tgtLang');
const toggleBtn = $('toggleBtn');
const statusDot = $('statusDot');
const statusText = $('statusText');

let capturing = false;

chrome.storage.local.get(
  [
    'deepgramKey',
    'deeplKey',
    'dashscopeKey',
    'translationProvider',
    'sourceLanguage',
    'targetLanguage'
  ],
  (data) => {
    if (data.deepgramKey) deepgramKey.value = data.deepgramKey;
    if (data.deeplKey) deeplKey.value = data.deeplKey;
    if (data.dashscopeKey) dashscopeKey.value = data.dashscopeKey;
    if (data.sourceLanguage) srcLang.value = data.sourceLanguage;
    if (data.targetLanguage) tgtLang.value = data.targetLanguage;

    translationProvider.value = resolveInitialProvider(data);
    updateProviderUI();
  }
);

chrome.runtime.sendMessage({ type: 'get-status' }, (res) => {
  if (chrome.runtime.lastError) return;
  if (res?.capturing) setUI(true);
});

function resolveInitialProvider(data) {
  if (data.translationProvider) {
    return data.translationProvider;
  }

  return data.deeplKey ? 'deepl' : 'qwen-mt-plus';
}

function save() {
  chrome.storage.local.set({
    deepgramKey: deepgramKey.value.trim(),
    dashscopeKey: dashscopeKey.value.trim(),
    deeplKey: deeplKey.value.trim(),
    translationProvider: translationProvider.value,
    sourceLanguage: srcLang.value,
    targetLanguage: tgtLang.value
  });
}

function updateProviderUI() {
  const usingQwen = translationProvider.value === 'qwen-mt-plus';
  dashscopeSection.classList.toggle('hidden', !usingQwen);
  deeplSection.classList.toggle('hidden', usingQwen);
}

function getSelectedProviderLabel() {
  return translationProvider.value === 'deepl' ? 'DeepL' : 'Qwen-MT-plus';
}

function hasTranslationKey() {
  return translationProvider.value === 'deepl'
    ? Boolean(deeplKey.value.trim())
    : Boolean(dashscopeKey.value.trim());
}

deepgramKey.addEventListener('input', save);
dashscopeKey.addEventListener('input', save);
deeplKey.addEventListener('input', save);
srcLang.addEventListener('change', save);
tgtLang.addEventListener('change', save);
translationProvider.addEventListener('change', () => {
  updateProviderUI();
  save();
});

toggleBtn.addEventListener('click', () => {
  if (capturing) {
    chrome.runtime.sendMessage({ type: 'stop-capture' });
    setUI(false);
    return;
  }

  if (!deepgramKey.value.trim()) {
    setStatus('error', 'Deepgram API key is required.');
    return;
  }

  save();

  chrome.runtime.sendMessage({
    type: 'start-capture',
    config: {
      deepgramKey: deepgramKey.value.trim(),
      dashscopeKey: dashscopeKey.value.trim(),
      deeplKey: deeplKey.value.trim(),
      translationProvider: translationProvider.value,
      sourceLanguage: srcLang.value,
      targetLanguage: tgtLang.value
    }
  });

  setUI(true);

  if (!hasTranslationKey()) {
    setStatus(
      'warning',
      `Starting in transcription-only mode. Missing ${getSelectedProviderLabel()} API key.`
    );
    return;
  }

  setStatus('active', `Starting translation with ${getSelectedProviderLabel()}...`);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'capture-status') return;

  setStatus(msg.status, msg.message);

  if (msg.status === 'stopped') {
    setUI(false);
  } else if (msg.status === 'error' && msg.fatal !== false) {
    setUI(false);
  }
});

function setUI(on) {
  capturing = on;
  toggleBtn.textContent = on ? 'Stop Translation' : 'Start Translation';
  toggleBtn.className = on ? 'btn-stop' : 'btn-start';

  if (on) {
    setStatus('active', 'Connecting...');
  } else {
    setStatus('idle', 'Idle');
  }
}

function setStatus(level, text) {
  statusDot.className = 'status-dot';

  if (level === 'active' || level === 'capturing') {
    statusDot.classList.add('active');
  } else if (level === 'warning') {
    statusDot.classList.add('warning');
  } else if (level === 'error') {
    statusDot.classList.add('error');
  }

  statusText.textContent = text || '';
}
