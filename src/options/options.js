'use strict';

const runtime = typeof chrome !== 'undefined' ? chrome : browser;
const DEFAULTS = {
  enabled: true,
  autoTranslate: true,
  debug: false,
  preserveOriginal: true,
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
    'nav',
    'header',
    'footer'
  ]
};

const ids = [
  'enabled', 'autoTranslate', 'debug', 'preserveOriginal', 'minTextLength', 'maxTextLength',
  'candidateLimit', 'targetLanguage', 'translateProvider', 'customEndpoint', 'customHeaders',
  'customBodyTemplate', 'aiEndpoint', 'aiApiKey', 'aiModel', 'aiSystemPrompt',
  'customSelectorsByHost', 'blacklistSelectors'
];
const el = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
const statusEl = document.getElementById('status');

document.getElementById('save').addEventListener('click', save);
document.getElementById('reset').addEventListener('click', reset);
el.translateProvider.addEventListener('change', updateProviderPanels);
load();

async function load() {
  const response = await send({ type: 'GET_SETTINGS', includeSecrets: true });
  const settings = { ...DEFAULTS, ...(response.settings || {}) };
  el.enabled.checked = Boolean(settings.enabled);
  el.autoTranslate.checked = Boolean(settings.autoTranslate);
  el.debug.checked = Boolean(settings.debug);
  el.preserveOriginal.checked = Boolean(settings.preserveOriginal);
  el.minTextLength.value = settings.minTextLength;
  el.maxTextLength.value = settings.maxTextLength;
  el.candidateLimit.value = settings.candidateLimit;
  el.targetLanguage.value = settings.targetLanguage;
  el.translateProvider.value = settings.translateProvider;
  el.customEndpoint.value = settings.customEndpoint || '';
  el.customHeaders.value = settings.customHeaders || '';
  el.customBodyTemplate.value = settings.customBodyTemplate || DEFAULTS.customBodyTemplate;
  el.aiEndpoint.value = settings.aiEndpoint || DEFAULTS.aiEndpoint;
  el.aiApiKey.value = settings.aiApiKey || '';
  el.aiModel.value = settings.aiModel || DEFAULTS.aiModel;
  el.aiSystemPrompt.value = settings.aiSystemPrompt || DEFAULTS.aiSystemPrompt;
  el.customSelectorsByHost.value = JSON.stringify(settings.customSelectorsByHost || {}, null, 2);
  el.blacklistSelectors.value = (settings.blacklistSelectors || DEFAULTS.blacklistSelectors).join('\n');
  updateProviderPanels();
}

function updateProviderPanels() {
  const selected = el.translateProvider.value;
  document.querySelectorAll('[data-provider-panel]').forEach(panel => {
    panel.hidden = panel.getAttribute('data-provider-panel') !== selected;
  });
}

async function save() {
  try {
    const settings = collect();
    await send({ type: 'SAVE_SETTINGS', settings });
    status('已保存。刷新或重新扫描目标网页后生效。');
  } catch (error) {
    status(`保存失败：${error.message || error}`);
  }
}

async function reset() {
  await send({ type: 'SAVE_SETTINGS', settings: DEFAULTS });
  await load();
  status('已恢复默认设置。');
}

function collect() {
  let customSelectorsByHost = {};
  try {
    customSelectorsByHost = JSON.parse(el.customSelectorsByHost.value || '{}');
  } catch (error) {
    throw new Error(`自定义选择器 JSON 不合法：${error.message}`);
  }
  if (el.customHeaders.value.trim()) {
    try { JSON.parse(el.customHeaders.value); }
    catch (error) { throw new Error(`customHeaders JSON 不合法：${error.message}`); }
  }
  return {
    enabled: el.enabled.checked,
    autoTranslate: el.autoTranslate.checked,
    debug: el.debug.checked,
    preserveOriginal: el.preserveOriginal.checked,
    minTextLength: Number(el.minTextLength.value || DEFAULTS.minTextLength),
    maxTextLength: Number(el.maxTextLength.value || DEFAULTS.maxTextLength),
    candidateLimit: Number(el.candidateLimit.value || DEFAULTS.candidateLimit),
    targetLanguage: el.targetLanguage.value.trim() || 'zh-CN',
    translateProvider: el.translateProvider.value,
    customEndpoint: el.customEndpoint.value.trim(),
    customHeaders: el.customHeaders.value.trim(),
    customBodyTemplate: el.customBodyTemplate.value || DEFAULTS.customBodyTemplate,
    aiEndpoint: el.aiEndpoint.value.trim(),
    aiApiKey: el.aiApiKey.value.trim(),
    aiModel: el.aiModel.value.trim(),
    aiSystemPrompt: el.aiSystemPrompt.value || DEFAULTS.aiSystemPrompt,
    customSelectorsByHost,
    blacklistSelectors: el.blacklistSelectors.value.split('\n').map(v => v.trim()).filter(Boolean)
  };
}

function status(text) {
  statusEl.textContent = text;
  setTimeout(() => { if (statusEl.textContent === text) statusEl.textContent = ''; }, 4200);
}

function send(message) {
  return new Promise((resolve, reject) => {
    runtime.runtime.sendMessage(message, response => {
      const err = runtime.runtime.lastError;
      if (err) reject(new Error(err.message));
      else if (response && response.ok === false) reject(new Error(response.error || 'Extension error.'));
      else resolve(response);
    });
  });
}
