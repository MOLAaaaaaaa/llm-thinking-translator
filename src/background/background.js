'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  autoTranslate: true,
  debug: false,
  preserveOriginal: true,
  settingsVersion: 5,
  minTextLength: 8,
  maxTextLength: 12000,
  candidateLimit: 40,
  translateProvider: 'google_gtx',
  targetLanguage: 'zh-CN',
  customEndpoint: '',
  customHeaders: '',
  customBodyTemplate: '{"text":"{{text}}","source":"auto","target":"{{target}}"}',
  aiEndpoint: 'https://api.openai.com/v1/chat/completions',
  aiApiKey: '',
  aiModel: 'gpt-4o-mini',
  aiSystemPrompt: 'Translate the user text into natural Simplified Chinese. Preserve heading/body structure when present. Return only the translation.',
  customSelectorsByHost: {},
  blacklistSelectors: [
    'textarea',
    'input',
    'pre',
    'code',
    '[contenteditable="true"]',
    '[aria-label*="sidebar" i]',
    '[data-testid*="sidebar" i]',
    '[class*="sidebar" i]',
    '[class*="side-nav" i]',
    '[role="navigation"]',
    'bard-sidenav',
    'side-navigation-v2',
    'mat-sidenav',
    'nav',
    'header',
    'footer'
  ],
  siteProfiles: {
    'chatgpt.com': {
      platform: 'chatgpt',
      selectors: [
        'section[data-testid^="conversation-turn"] div.text-token-text-secondary.origin-start > div.relative.flex.w-full.items-start.gap-2.overflow-clip',
        'section[data-testid^="conversation-turn"] div.text-token-text-secondary.origin-start > div.relative.flex',
        'div.text-token-text-secondary.origin-start > div.relative.flex.w-full.items-start.gap-2.overflow-clip',
        'div.text-token-text-secondary.origin-start > div.relative.flex'
      ],
      anchors: []
    },
    'chat.openai.com': {
      platform: 'chatgpt',
      selectors: [
        'section[data-testid^="conversation-turn"] div.text-token-text-secondary.origin-start > div.relative.flex.w-full.items-start.gap-2.overflow-clip',
        'section[data-testid^="conversation-turn"] div.text-token-text-secondary.origin-start > div.relative.flex',
        'div.text-token-text-secondary.origin-start > div.relative.flex.w-full.items-start.gap-2.overflow-clip',
        'div.text-token-text-secondary.origin-start > div.relative.flex'
      ],
      anchors: []
    },
    'claude.ai': {
      platform: 'claude',
      selectors: [
        'div.px-2\\.5.text-text-300',
        'div.text-text-300[class*="px-2"]',
        '.transition-colors.rounded-lg .text-text-300'
      ],
      anchors: []
    },
    'gemini.google.com': {
      platform: 'gemini',
      selectors: [
        'model-thoughts > div',
        'model-thoughts div.model-thoughts',
        'model-thoughts'
      ],
      anchors: []
    }
  }
});

const runtime = typeof chrome !== 'undefined' ? chrome : browser;
const memCache = new Map();
const SYNC_SETTING_KEYS = Object.keys(DEFAULT_SETTINGS).filter(key => key !== 'aiApiKey');

runtime.runtime.onInstalled.addListener(async () => {
  const stored = await runtime.storage.sync.get(SYNC_SETTING_KEYS);
  const patch = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (key === 'aiApiKey') continue;
    if (typeof stored[key] === 'undefined') patch[key] = value;
  }
  if (!stored.settingsVersion || Number(stored.settingsVersion) < 3) {
    patch.settingsVersion = 3;
    patch.siteProfiles = DEFAULT_SETTINGS.siteProfiles;
    patch.blacklistSelectors = DEFAULT_SETTINGS.blacklistSelectors;
    if (typeof stored.maxTextLength === 'undefined' || Number(stored.maxTextLength) === 6000) {
      patch.maxTextLength = 12000;
    }
  }
  if (!stored.settingsVersion || Number(stored.settingsVersion) < 4) {
    patch.settingsVersion = 4;
    patch.debug = false;
    if (typeof stored.aiEndpoint === 'undefined') patch.aiEndpoint = DEFAULT_SETTINGS.aiEndpoint;
    if (typeof stored.aiModel === 'undefined') patch.aiModel = DEFAULT_SETTINGS.aiModel;
    if (typeof stored.aiSystemPrompt === 'undefined') patch.aiSystemPrompt = DEFAULT_SETTINGS.aiSystemPrompt;
  }
  if (!stored.settingsVersion || Number(stored.settingsVersion) < 5) {
    patch.settingsVersion = 5;
    const supportedHosts = new Set(Object.keys(DEFAULT_SETTINGS.siteProfiles));
    patch.siteProfiles = DEFAULT_SETTINGS.siteProfiles;
    patch.customSelectorsByHost = Object.fromEntries(
      Object.entries(stored.customSelectorsByHost || {}).filter(([host]) => supportedHosts.has(host))
    );
  }
  if (Object.keys(patch).length) await runtime.storage.sync.set(patch);
});

runtime.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (!message || !message.type) {
        sendResponse({ ok: false, error: 'Empty message.' });
        return;
      }

      if (message.type === 'GET_SETTINGS') {
        const settings = await getSettings();
        if (!message.includeSecrets) delete settings.aiApiKey;
        sendResponse({ ok: true, settings });
        return;
      }

      if (message.type === 'SAVE_SETTINGS') {
        const settings = { ...(message.settings || {}) };
        if (Object.prototype.hasOwnProperty.call(settings, 'aiApiKey')) {
          await runtime.storage.local.set({ aiApiKey: settings.aiApiKey || '' });
          delete settings.aiApiKey;
        }
        if (Object.keys(settings).length) await runtime.storage.sync.set(settings);
        sendResponse({ ok: true });
        return;
      }

      if (message.type === 'TRANSLATE_TEXT') {
        const settings = await getSettings();
        const translatedText = await translateText(String(message.text || ''), settings, message.meta || {});
        sendResponse({ ok: true, translatedText });
        return;
      }

      if (message.type === 'TRANSLATE_BATCH') {
        const settings = await getSettings();
        const texts = Array.isArray(message.texts) ? message.texts : [];
        const translated = [];
        for (const item of texts) {
          translated.push(await translateText(String(item || ''), settings, message.meta || {}));
        }
        sendResponse({ ok: true, translated });
        return;
      }

      sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
    } catch (error) {
      sendResponse({ ok: false, error: normalizeError(error) });
    }
  })();
  return true;
});

async function getSettings() {
  const [stored, localSecrets] = await Promise.all([
    runtime.storage.sync.get(SYNC_SETTING_KEYS),
    runtime.storage.local.get(['aiApiKey'])
  ]);
  return deepMerge(DEFAULT_SETTINGS, { ...(stored || {}), aiApiKey: localSecrets.aiApiKey || '' });
}

async function translateText(text, settings, meta) {
  const clean = normalizeText(text);
  if (!clean) return '';
  const target = settings.targetLanguage || 'zh-CN';
  const cacheKey = [
    settings.translateProvider,
    target,
    settings.customEndpoint,
    settings.aiEndpoint,
    settings.aiModel,
    clean
  ].join('|');
  if (memCache.has(cacheKey)) return memCache.get(cacheKey);

  const chunks = splitText(clean, 1200);
  const translatedChunks = [];
  for (const chunk of chunks) {
    let result = '';
    if (settings.translateProvider === 'custom_http') {
      result = await translateWithCustomEndpoint(chunk, settings, target, meta);
    } else if (settings.translateProvider === 'openai_compatible') {
      result = await translateWithOpenAICompatible(chunk, settings, target, meta);
    } else {
      result = await translateWithGoogleGtx(chunk, target);
    }
    translatedChunks.push(result);
    await delay(120);
  }
  const translated = translatedChunks.join('\n\n').trim();
  memCache.set(cacheKey, translated);
  if (memCache.size > 500) memCache.delete(memCache.keys().next().value);
  return translated;
}

async function translateWithGoogleGtx(text, target) {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: 'auto',
    tl: target,
    dt: 't',
    q: text
  });
  const url = `https://translate.googleapis.com/translate_a/single?${params.toString()}`;
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'omit',
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`Google GTX translate failed: HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
    throw new Error('Google GTX translate failed: unexpected response shape.');
  }
  return payload[0].map(part => Array.isArray(part) ? (part[0] || '') : '').join('').trim();
}

async function translateWithCustomEndpoint(text, settings, target, meta) {
  if (!settings.customEndpoint) throw new Error('Custom endpoint is empty.');
  let headers = { 'Content-Type': 'application/json' };
  if (settings.customHeaders) {
    try {
      headers = { ...headers, ...JSON.parse(settings.customHeaders) };
    } catch (error) {
      throw new Error(`Invalid customHeaders JSON: ${error.message}`);
    }
  }
  const body = renderTemplate(settings.customBodyTemplate || DEFAULT_SETTINGS.customBodyTemplate, {
    text,
    target,
    host: meta.host || '',
    url: meta.url || ''
  });
  const response = await fetch(settings.customEndpoint, {
    method: 'POST',
    headers,
    body,
    credentials: 'omit',
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`Custom translate failed: HTTP ${response.status}`);
  const responseText = await response.text();
  try {
    const json = JSON.parse(responseText);
    return String(json.translatedText || json.translation || json.text || json.result || '').trim();
  } catch (error) {
    return responseText.trim();
  }
}

async function translateWithOpenAICompatible(text, settings, target, meta) {
  const endpoint = String(settings.aiEndpoint || '').trim();
  if (!endpoint) throw new Error('AI endpoint is empty.');
  const model = String(settings.aiModel || '').trim();
  if (!model) throw new Error('AI model is empty.');

  const headers = { 'Content-Type': 'application/json' };
  if (settings.aiApiKey) headers.Authorization = `Bearer ${String(settings.aiApiKey).trim()}`;

  const systemPrompt = String(settings.aiSystemPrompt || DEFAULT_SETTINGS.aiSystemPrompt)
    .replace(/\{\{target\}\}/g, target)
    .replace(/\{\{host\}\}/g, meta.host || '')
    .replace(/\{\{url\}\}/g, meta.url || '');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    credentials: 'omit',
    cache: 'no-store',
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ]
    })
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`AI translate failed: HTTP ${response.status}${errorText ? ` ${errorText.slice(0, 180)}` : ''}`);
  }
  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content
    || json?.choices?.[0]?.text
    || json?.output_text
    || json?.translatedText
    || json?.translation
    || json?.text
    || json?.result;
  if (!content) throw new Error('AI translate failed: empty response.');
  return String(content).trim();
}

function renderTemplate(template, vars) {
  return String(template).replace(/\{\{(text|target|host|url)\}\}/g, (_m, key) => {
    return JSON.stringify(String(vars[key] || '')).slice(1, -1);
  });
}

function splitText(text, maxLen) {
  const normalized = normalizeText(text);
  if (normalized.length <= maxLen) return [normalized];
  const parts = [];
  let buffer = '';
  const lines = normalized.split(/(?<=[.!?。！？])\s+|\n{2,}/g);
  for (const line of lines) {
    const next = buffer ? `${buffer}\n${line}` : line;
    if (next.length > maxLen && buffer) {
      parts.push(buffer);
      buffer = line;
    } else if (line.length > maxLen) {
      for (let i = 0; i < line.length; i += maxLen) parts.push(line.slice(i, i + maxLen));
      buffer = '';
    } else {
      buffer = next;
    }
  }
  if (buffer) parts.push(buffer);
  return parts;
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function deepMerge(base, override) {
  const result = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      result[key] = deepMerge(base[key], value);
    } else if (typeof value !== 'undefined') {
      result[key] = value;
    }
  }
  return result;
}

function normalizeError(error) {
  if (!error) return 'Unknown error.';
  return error.stack || error.message || String(error);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
