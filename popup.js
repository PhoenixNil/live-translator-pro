const $ = (id) => document.getElementById(id);

const deepgramKey = $('deepgramKey');
const translationProvider = $('translationProvider');
const dashscopeKey = $('dashscopeKey');
const deeplKey = $('deeplKey');
const dashscopeSection = $('dashscopeSection');
const deeplSection = $('deeplSection');
const srcLang = $('srcLang');
const tgtLang = $('tgtLang');
const statusDot = $('statusDot');
const statusText = $('statusText');

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
  if (res?.capturing) setStatus('active', 'Capturing...');
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

deepgramKey.addEventListener('input', save);
dashscopeKey.addEventListener('input', save);
deeplKey.addEventListener('input', save);
srcLang.addEventListener('change', save);
tgtLang.addEventListener('change', save);
translationProvider.addEventListener('change', () => {
  updateProviderUI();
  save();
});

$('showOverlayBtn').addEventListener('click', () => {
  save();
  chrome.runtime.sendMessage({ type: 'show-overlay' });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'capture-status') return;

  setStatus(msg.status, msg.message);
});

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
