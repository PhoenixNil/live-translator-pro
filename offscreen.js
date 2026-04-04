let mediaStream = null;
let monitorAudioEl = null;
let audioContext = null;
let deepgramSocket = null;
let isCapturing = false;
let config = {};

let keepAliveInterval = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;

let pendingFinalFragments = [];
let pendingSentenceText = '';
let pendingFlushTimer = null;
let recentSourceContext = [];
let revisableEntry = null;
let nextEntryId = 1;
let translationQueue = [];
let translationInFlight = false;
let activeTranslationAbortController = null;
let activeTranslationJob = null;
let stoppingCapture = false;

const SOFT_FLUSH_IDLE_MS = 1200;
const MAX_SENTENCE_CHARS = 120;
const DEEPGRAM_ENDPOINTING_MS = 700;
const DEEPGRAM_UTTERANCE_END_MS = 1000;
const CONTEXT_WINDOW_SIZE = 5;
const MAX_SENTENCE_CHARS_HARD = 180;
const CLAUSE_BOUNDARY_RE = /[,;:\u3001\uff0c\uff1b]/;
const SENTENCE_END_RE = /(?:[.!?]|\u3002|\uff01|\uff1f|\u2026)$/;
const NO_SPACE_BEFORE_RE = /^(?:[\s,.;:!?%)\]}]|\u3001|\u3002|\uff0c|\uff01|\uff1f|\uff1b|\uff1a|\u2026)/;
const NO_SPACE_AFTER_RE = /(?:[\s([{'"-]|\u201c|\u2018)$/;
const ASCII_WORD_CHAR_RE = /[A-Za-z0-9]/;
const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const QWEN_TARGET_LANGUAGE_MAP = {
  ZH: 'zh',
  EN: 'en',
  JA: 'ja',
  KO: 'ko',
  DE: 'de',
  FR: 'fr',
  ES: 'es',
  RU: 'ru'
};

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'offscreen-start-capture') {
    startCapture(message.streamId, message.config);
  } else if (message.type === 'offscreen-stop-capture') {
    stopCapture();
  }
});

async function startCapture(streamId, captureConfig) {
  if (isCapturing || stoppingCapture) {
    await stopCapture();
  }

  config = normalizeConfig(captureConfig);
  isCapturing = true;
  stoppingCapture = false;
  reconnectAttempts = 0;
  resetTranslationState();

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    });

    setupAudioProcessing();
    connectDeepgram();
  } catch (err) {
    console.error('[LTP] Capture error:', err);
    sendStatus('error', `Audio capture failed: ${err.message}`, { fatal: true });
    isCapturing = false;
  }
}

async function stopCapture() {
  if (!isCapturing && !stoppingCapture && !hasPendingSentenceWork() && !translationInFlight) {
    cleanupCaptureResources();
    return;
  }

  stoppingCapture = true;
  isCapturing = false;
  reconnectAttempts = 0;

  clearPendingFlushTimer();
  stopKeepAlive();

  if (deepgramSocket) {
    try {
      if (deepgramSocket.readyState === WebSocket.OPEN) {
        deepgramSocket.send(JSON.stringify({ type: 'CloseStream' }));
      }

      deepgramSocket.close();
    } catch (_) {
      // Ignore socket cleanup errors.
    }

    deepgramSocket = null;
  }

  if (isTranslationEnabled() && hasPendingSentenceWork()) {
    flushPendingSentence({ lockEntry: true });
    await waitForTranslationsToSettle(1000);
  }

  if (activeTranslationAbortController) {
    activeTranslationAbortController.abort();
    activeTranslationAbortController = null;
  }

  translationQueue = [];
  translationInFlight = false;
  activeTranslationJob = null;
  resetTranslationState();
  cleanupCaptureResources();
  stoppingCapture = false;
}

function cleanupCaptureResources() {
  stopKeepAlive();

  if (audioContext) {
    try {
      audioContext.close();
    } catch (_) {
      // Ignore audio context cleanup errors.
    }

    audioContext = null;
  }

  if (monitorAudioEl) {
    try {
      monitorAudioEl.pause();
      monitorAudioEl.srcObject = null;
    } catch (_) {
      // Ignore audio element cleanup errors.
    }

    monitorAudioEl = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
}

function normalizeConfig(captureConfig = {}) {
  const deepgramKey = captureConfig.deepgramKey?.trim() || '';
  const dashscopeKey = captureConfig.dashscopeKey?.trim() || '';
  const deeplKey = captureConfig.deeplKey?.trim() || '';
  const translationProvider = captureConfig.translationProvider || (deeplKey ? 'deepl' : 'qwen-mt-plus');

  return {
    deepgramKey,
    dashscopeKey,
    deeplKey,
    translationProvider,
    sourceLanguage: captureConfig.sourceLanguage || 'multi',
    targetLanguage: captureConfig.targetLanguage || 'ZH'
  };
}

function setupAudioProcessing() {
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(mediaStream);

  monitorAudioEl = document.createElement('audio');
  monitorAudioEl.srcObject = mediaStream;
  monitorAudioEl.play().catch(() => {});

  const processor = audioContext.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (e) => {
    if (!isCapturing || !deepgramSocket || deepgramSocket.readyState !== WebSocket.OPEN) {
      return;
    }

    const raw = e.inputBuffer.getChannelData(0);
    const down = downsample(raw, audioContext.sampleRate, 16000);
    deepgramSocket.send(float32ToInt16(down).buffer);
  };

  source.connect(processor);

  const silence = audioContext.createGain();
  silence.gain.value = 0;
  processor.connect(silence);
  silence.connect(audioContext.destination);
}

function downsample(buf, from, to) {
  if (from === to) return buf;

  const ratio = from / to;
  const len = Math.round(buf.length / ratio);
  const out = new Float32Array(len);

  for (let i = 0; i < len; i++) {
    out[i] = buf[Math.min(Math.round(i * ratio), buf.length - 1)];
  }

  return out;
}

function float32ToInt16(f32) {
  const i16 = new Int16Array(f32.length);

  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  return i16;
}

function connectDeepgram() {
  const apiKey = config.deepgramKey;

  if (!apiKey) {
    sendStatus('error', 'Please set a Deepgram API key.', { fatal: true });
    isCapturing = false;
    return;
  }

  const params = new URLSearchParams({
    model: 'nova-3',
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'true',
    vad_events: 'true',
    utterance_end_ms: String(DEEPGRAM_UTTERANCE_END_MS),
    endpointing: String(DEEPGRAM_ENDPOINTING_MS),
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    language: config.sourceLanguage || 'multi'
  });

  deepgramSocket = new WebSocket(
    `wss://api.deepgram.com/v1/listen?${params}`,
    ['token', apiKey]
  );

  deepgramSocket.onopen = () => {
    console.log('[LTP] Deepgram connected');
    reconnectAttempts = 0;
    startKeepAlive();
    sendStatus('capturing', buildCaptureStatusMessage('Capturing audio.'));
  };

  deepgramSocket.onmessage = (event) => {
    try {
      handleDeepgramResult(JSON.parse(event.data));
    } catch (err) {
      console.error('[LTP] Deepgram parse error:', err);
    }
  };

  deepgramSocket.onerror = (err) => {
    console.error('[LTP] Deepgram WebSocket error:', err);
  };

  deepgramSocket.onclose = (event) => {
    console.log('[LTP] Deepgram closed:', event.code, event.reason);
    stopKeepAlive();

    if (!isCapturing) return;

    if (reconnectAttempts < MAX_RECONNECT) {
      reconnectAttempts++;
      const delay = Math.min(1000 * 2 ** reconnectAttempts, 30000);

      console.log(`[LTP] Reconnecting in ${delay}ms (${reconnectAttempts}/${MAX_RECONNECT})`);
      sendStatus(
        'capturing',
        buildCaptureStatusMessage(`Reconnecting Deepgram (${reconnectAttempts}/${MAX_RECONNECT})...`)
      );

      setTimeout(() => {
        if (isCapturing) connectDeepgram();
      }, delay);

      return;
    }

    stopCapture();
    sendStatus('error', 'Deepgram connection failed. Please retry.', { fatal: true });
  };
}

function startKeepAlive() {
  stopKeepAlive();
  keepAliveInterval = setInterval(() => {
    if (deepgramSocket?.readyState === WebSocket.OPEN) {
      deepgramSocket.send(JSON.stringify({ type: 'KeepAlive' }));
    }
  }, 10000);
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

function handleDeepgramResult(data) {
  if (data.type === 'UtteranceEnd') {
    if (pendingSentenceText) {
      flushPendingSentence({ lockEntry: true });
    }

    return;
  }

  if (data.type !== 'Results') return;

  const transcript = data.channel?.alternatives?.[0]?.transcript || '';
  const trimmedTranscript = transcript.trim();
  const isFinal = Boolean(data.is_final);

  if (trimmedTranscript) {
    chrome.runtime.sendMessage({
      type: 'transcript-result',
      transcript,
      isFinal
    }).catch(() => {});
  }

  if (!isTranslationEnabled()) return;

  if (isFinal && trimmedTranscript) {
    appendFinalFragment(trimmedTranscript);
  }

  if (shouldHardFlush(data, trimmedTranscript)) {
    flushPendingSentence({ lockEntry: true });
    return;
  }

  if (pendingSentenceText.length >= MAX_SENTENCE_CHARS) {
    splitAtClauseBoundary();
    return;
  }

  if (isFinal && trimmedTranscript && pendingSentenceText) {
    scheduleSoftFlush();
  }
}

function appendFinalFragment(fragment) {
  pendingFinalFragments.push(fragment);
  pendingSentenceText = joinTranscriptFragments(pendingSentenceText, fragment);
}

function scheduleSoftFlush() {
  clearPendingFlushTimer();

  pendingFlushTimer = setTimeout(() => {
    flushPendingSentence({ lockEntry: false });
  }, SOFT_FLUSH_IDLE_MS);
}

function clearPendingFlushTimer() {
  if (pendingFlushTimer) {
    clearTimeout(pendingFlushTimer);
    pendingFlushTimer = null;
  }
}

function splitAtClauseBoundary() {
  const text = pendingSentenceText;

  if (text.length >= MAX_SENTENCE_CHARS_HARD) {
    flushPendingSentence({ lockEntry: true });
    return;
  }

  let splitIndex = -1;
  for (let i = text.length - 1; i >= Math.floor(text.length * 0.4); i--) {
    if (CLAUSE_BOUNDARY_RE.test(text[i])) {
      splitIndex = i + 1;
      break;
    }
  }

  if (splitIndex === -1) {
    scheduleSoftFlush();
    return;
  }

  const firstPart = text.slice(0, splitIndex).trim();
  const remainder = text.slice(splitIndex).trim();

  pendingSentenceText = firstPart;
  pendingFinalFragments = [];
  flushPendingSentence({ lockEntry: true });

  if (remainder) {
    pendingSentenceText = remainder;
    pendingFinalFragments = [remainder];
  }
}

function flushPendingSentence({ lockEntry }) {
  clearPendingFlushTimer();

  const text = pendingSentenceText.trim();
  if (!text || !isTranslationEnabled()) {
    if (lockEntry) {
      clearPendingSentence();
      revisableEntry = null;
    }

    return;
  }

  const entryId = revisableEntry?.entryId ?? nextEntryId++;
  const job = {
    entryId,
    originalText: text,
    replaceLast: Boolean(revisableEntry),
    provisional: !lockEntry,
    lockEntry,
    contextText: buildDeepLContext()
  };

  if (lockEntry) {
    rememberLockedSourceText(text);
    clearPendingSentence();
    revisableEntry = null;
  } else {
    revisableEntry = { entryId };
  }

  enqueueTranslation(job);
}

function clearPendingSentence() {
  pendingFinalFragments = [];
  pendingSentenceText = '';
}

function resetTranslationState() {
  clearPendingFlushTimer();
  pendingFinalFragments = [];
  pendingSentenceText = '';
  recentSourceContext = [];
  revisableEntry = null;
  nextEntryId = 1;
}

function buildDeepLContext() {
  return recentSourceContext.join('\n');
}

function rememberLockedSourceText(text) {
  if (!text) return;

  recentSourceContext.push(text);

  while (recentSourceContext.length > CONTEXT_WINDOW_SIZE) {
    recentSourceContext.shift();
  }
}

function shouldHardFlush(data, transcript) {
  if (!pendingSentenceText) return false;

  if (data.speech_final) {
    return true;
  }

  if (transcript && SENTENCE_END_RE.test(transcript)) {
    return true;
  }

  return false;
}

function joinTranscriptFragments(currentText, nextFragment) {
  const nextText = nextFragment.trim();

  if (!nextText) return currentText;
  if (!currentText) return nextText;
  if (/\s$/.test(currentText)) return `${currentText}${nextText}`;
  if (NO_SPACE_BEFORE_RE.test(nextText)) return `${currentText}${nextText}`;
  if (NO_SPACE_AFTER_RE.test(currentText)) return `${currentText}${nextText}`;

  const prevChar = currentText[currentText.length - 1];
  const nextChar = nextText[0];

  if (isCjkChar(prevChar) || isCjkChar(nextChar)) {
    return `${currentText}${nextText}`;
  }

  if (ASCII_WORD_CHAR_RE.test(prevChar) && ASCII_WORD_CHAR_RE.test(nextChar)) {
    return `${currentText} ${nextText}`;
  }

  if (SENTENCE_END_RE.test(currentText)) {
    return `${currentText} ${nextText}`;
  }

  return `${currentText} ${nextText}`;
}

function isCjkChar(char) {
  return CJK_CHAR_RE.test(char);
}

function hasPendingSentenceWork() {
  return Boolean(pendingSentenceText || pendingFinalFragments.length || translationQueue.length);
}

function waitForTranslationsToSettle(timeoutMs) {
  if (!translationInFlight && translationQueue.length === 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;

    const poll = () => {
      if ((!translationInFlight && translationQueue.length === 0) || Date.now() >= deadline) {
        resolve();
        return;
      }

      setTimeout(poll, 50);
    };

    poll();
  });
}

function enqueueTranslation(job) {
  translationQueue = translationQueue.filter((queuedJob) => queuedJob.entryId !== job.entryId);

  if (activeTranslationJob?.entryId === job.entryId && activeTranslationAbortController) {
    activeTranslationAbortController.abort();
  }

  translationQueue.push(job);
  processTranslationQueue();
}

async function processTranslationQueue() {
  if (translationInFlight || (!isCapturing && !stoppingCapture) || !isTranslationEnabled()) {
    return;
  }

  const job = translationQueue.shift();
  if (!job) return;

  const provider = getActiveTranslationProvider();
  const controller = new AbortController();

  translationInFlight = true;
  activeTranslationAbortController = controller;
  activeTranslationJob = job;

  try {
    let translated = '';

    if (provider === 'deepl') {
      translated = await translateWithDeepL(job.originalText, job.contextText, controller.signal);
    } else {
      translated = await translateWithQwenMtFlash(job.originalText, job.contextText, controller.signal);
    }

    if (
      translated &&
      (isCapturing || stoppingCapture) &&
      !controller.signal.aborted &&
      activeTranslationAbortController === controller
    ) {
      sendFinalTranslation(job, translated);
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('[LTP] Translation error:', err);
      notifyTranslationError(provider, err);
    }
  } finally {
    if (activeTranslationAbortController === controller) {
      activeTranslationAbortController = null;
    }

    translationInFlight = false;
    activeTranslationJob = null;

    if (isCapturing || stoppingCapture) {
      processTranslationQueue();
    }
  }
}

async function translateWithDeepL(text, context, signal) {
  const apiKey = config.deeplKey;
  const baseUrl = apiKey.endsWith(':fx')
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';
  const body = {
    text: [text],
    target_lang: config.targetLanguage || 'ZH',
    model_type: 'prefer_quality_optimized'
  };

  if (config.sourceLanguage && config.sourceLanguage !== 'multi') {
    body.source_lang = config.sourceLanguage.toUpperCase();
  }

  if (context) {
    body.context = context;
  }

  const resp = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal
  });

  if (!resp.ok) {
    throw await createHttpError('DeepL', resp);
  }

  const result = await resp.json();
  return result.translations?.[0]?.text || '';
}

async function translateWithQwenMtFlash(text, context, signal) {
  const body = {
    model: 'qwen-mt-plus',
    input: {
      messages: [{ role: 'user', content: text }]
    },
    parameters: {
      result_format: 'message',
      translation_options: {
        source_lang: mapQwenSourceLanguage(config.sourceLanguage),
        target_lang: mapQwenTargetLanguage(config.targetLanguage)
      }
    }
  };

  if (context) {
    body.parameters.translation_options.context = context;
  }

  const resp = await fetch(
    'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.dashscopeKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal
    }
  );

  if (!resp.ok) {
    throw await createHttpError('DashScope', resp);
  }

  const result = await resp.json();
  return extractDashScopeTranslation(result);
}

function getActiveTranslationProvider() {
  return config.translationProvider === 'deepl' ? 'deepl' : 'qwen-mt-plus';
}

function isTranslationEnabled() {
  return getActiveTranslationProvider() === 'deepl'
    ? Boolean(config.deeplKey)
    : Boolean(config.dashscopeKey);
}

function buildCaptureStatusMessage(prefix) {
  const provider = getActiveTranslationProvider();

  if (!isTranslationEnabled()) {
    const credential = provider === 'deepl' ? 'DeepL' : 'DashScope';
    return `${prefix} Translation disabled: missing ${credential} API key.`;
  }

  const label = provider === 'deepl' ? 'DeepL' : 'Qwen-MT-plus';
  return `${prefix} Translation provider: ${label}.`;
}

function mapQwenSourceLanguage(sourceLanguage) {
  return sourceLanguage === 'multi' ? 'auto' : (sourceLanguage || 'auto').toLowerCase();
}

function mapQwenTargetLanguage(targetLanguage) {
  return QWEN_TARGET_LANGUAGE_MAP[targetLanguage] || 'zh';
}

async function createHttpError(provider, response) {
  const details = await safeReadText(response);
  const error = new Error(`${provider} HTTP ${response.status}`);
  error.status = response.status;
  error.details = details;
  return error;
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch (_) {
    return '';
  }
}

function extractDashScopeTranslation(payload) {
  const messageContent = payload.output?.choices?.[0]?.message?.content;
  if (typeof messageContent === 'string') {
    return messageContent;
  }

  const choiceText = payload.output?.choices?.[0]?.text;
  if (typeof choiceText === 'string') {
    return choiceText;
  }

  const outputText = payload.output?.text;
  if (typeof outputText === 'string') {
    return outputText;
  }

  return '';
}

function notifyTranslationError(provider, err) {
  const status = err.status;

  if (provider === 'deepl') {
    if (status === 429) {
      sendStatus('warning', 'DeepL rate limited the request. Translation will resume on the next segment.', {
        fatal: false
      });
      return;
    }

    if (status === 456) {
      sendStatus('warning', 'DeepL quota exceeded. Transcription will continue without translation.', {
        fatal: false
      });
      return;
    }

    sendStatus('warning', 'DeepL translation failed. Transcription is still running.', { fatal: false });
    return;
  }

  if (status === 429) {
    sendStatus('warning', 'DashScope rate limited the request. Translation will resume on the next segment.', {
      fatal: false
    });
    return;
  }

  if (status === 401 || status === 403) {
    sendStatus('warning', 'DashScope authentication failed. Transcription is still running.', {
      fatal: false
    });
    return;
  }

  sendStatus('warning', 'Qwen-MT-plus translation failed. Transcription is still running.', {
    fatal: false
  });
}

function sendFinalTranslation(job, translation) {
  chrome.runtime.sendMessage({
    type: 'transcript-result',
    originalText: job.originalText,
    translation,
    isFinal: true,
    entryId: job.entryId,
    replaceLast: job.replaceLast,
    provisional: job.provisional
  }).catch(() => {});
}

function sendStatus(status, message, extra = {}) {
  chrome.runtime.sendMessage({
    type: 'capture-status',
    status,
    message,
    ...extra
  }).catch(() => {});
}
