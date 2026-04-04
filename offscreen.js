let mediaStream = null;
let monitorAudioEl = null;
let audioContext = null;
let deepgramSocket = null;
let isCapturing = false;
let config = {};

let keepAliveInterval = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;

let translationBuffer = [];
let translationTimer = null;
let translationQueue = [];
let translationInFlight = false;
let activeTranslationAbortController = null;

const TRANSLATION_DEBOUNCE_MS = 800;
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
  if (isCapturing) stopCapture();

  config = normalizeConfig(captureConfig);
  isCapturing = true;
  reconnectAttempts = 0;

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

function stopCapture() {
  isCapturing = false;
  reconnectAttempts = 0;

  if (translationTimer) {
    clearTimeout(translationTimer);
    translationTimer = null;
  }

  translationBuffer = [];
  translationQueue = [];
  translationInFlight = false;

  if (activeTranslationAbortController) {
    activeTranslationAbortController.abort();
    activeTranslationAbortController = null;
  }

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
  const translationProvider = captureConfig.translationProvider || (deeplKey ? 'deepl' : 'qwen-mt-flash');

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
    interim_results: 'true',
    endpointing: '300',
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
  if (data.type !== 'Results') return;

  const transcript = data.channel?.alternatives?.[0]?.transcript || '';
  if (!transcript.trim()) return;

  const isFinal = data.is_final;

  chrome.runtime.sendMessage({
    type: 'transcript-result',
    transcript,
    isFinal
  }).catch(() => {});

  if (isFinal && isTranslationEnabled()) {
    translationBuffer.push(transcript);

    if (translationTimer) clearTimeout(translationTimer);

    translationTimer = setTimeout(() => {
      const text = translationBuffer.join(' ').trim();
      translationBuffer = [];

      if (text) {
        enqueueTranslation(text);
      }
    }, TRANSLATION_DEBOUNCE_MS);
  }
}

function enqueueTranslation(text) {
  translationQueue.push(text);
  processTranslationQueue();
}

async function processTranslationQueue() {
  if (translationInFlight || !isCapturing || !isTranslationEnabled()) {
    return;
  }

  const text = translationQueue.shift();
  if (!text) return;

  const provider = getActiveTranslationProvider();
  const controller = new AbortController();

  translationInFlight = true;
  activeTranslationAbortController = controller;

  try {
    let translated = '';

    if (provider === 'deepl') {
      translated = await translateWithDeepL(text, controller.signal);
    } else {
      translated = await translateWithQwenMtFlash(text, controller.signal);
    }

    if (
      translated &&
      isCapturing &&
      !controller.signal.aborted &&
      activeTranslationAbortController === controller
    ) {
      sendFinalTranslation(text, translated);
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

    if (isCapturing) {
      processTranslationQueue();
    }
  }
}

async function translateWithDeepL(text, signal) {
  const apiKey = config.deeplKey;
  const baseUrl = apiKey.endsWith(':fx')
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';

  const resp = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text: [text],
      target_lang: config.targetLanguage || 'ZH'
    }),
    signal
  });

  if (!resp.ok) {
    throw await createHttpError('DeepL', resp);
  }

  const result = await resp.json();
  return result.translations?.[0]?.text || '';
}

async function translateWithQwenMtFlash(text, signal) {
  const resp = await fetch(
    'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.dashscopeKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'qwen-mt-flash',
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
      }),
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
  return config.translationProvider === 'deepl' ? 'deepl' : 'qwen-mt-flash';
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

  const label = provider === 'deepl' ? 'DeepL' : 'Qwen-MT-flash';
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

  sendStatus('warning', 'Qwen-MT-flash translation failed. Transcription is still running.', {
    fatal: false
  });
}

function sendFinalTranslation(originalText, translation) {
  chrome.runtime.sendMessage({
    type: 'transcript-result',
    originalText,
    translation,
    isFinal: true
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
