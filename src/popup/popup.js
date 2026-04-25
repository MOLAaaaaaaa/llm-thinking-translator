'use strict';

const runtime = typeof chrome !== 'undefined' ? chrome : browser;
const els = {
  host: document.getElementById('host'),
  versionLink: document.getElementById('versionLink'),
  enabled: document.getElementById('enabled'),
  autoTranslate: document.getElementById('autoTranslate'),
  debug: document.getElementById('debug'),
  candidateCount: document.getElementById('candidateCount'),
  translatedCount: document.getElementById('translatedCount'),
  status: document.getElementById('status'),
  rescan: document.getElementById('rescan'),
  panel: document.getElementById('panel'),
  picker: document.getElementById('picker'),
  export: document.getElementById('export')
};

init();

async function init() {
  const manifestVersion = runtime.runtime?.getManifest?.().version;
  if (manifestVersion && els.versionLink) {
    els.versionLink.textContent = `v${manifestVersion}`;
  }

  const settings = await sendRuntime({ type: 'GET_SETTINGS' }).then(r => r.settings);
  els.enabled.checked = Boolean(settings.enabled);
  els.autoTranslate.checked = Boolean(settings.autoTranslate);
  els.debug.checked = Boolean(settings.debug);
  await refreshState();
  els.enabled.addEventListener('change', () => toggle('enabled', els.enabled.checked));
  els.autoTranslate.addEventListener('change', () => toggle('autoTranslate', els.autoTranslate.checked));
  els.debug.addEventListener('change', () => toggle('debug', els.debug.checked));
  els.rescan.addEventListener('click', () => sendToActive({ type: 'POPUP_RESCAN' }, '已请求重扫'));
  els.panel.addEventListener('click', () => sendToActive({ type: 'POPUP_TOGGLE_PANEL' }, '已切换面板'));
  els.picker.addEventListener('click', () => sendToActive({ type: 'POPUP_TOGGLE_PICKER' }, '已切换选取'));
  els.export.addEventListener('click', () => sendToActive({ type: 'POPUP_EXPORT_DEBUG' }, '已复制诊断包'));
}

async function refreshState() {
  try {
    const response = await sendToActive({ type: 'POPUP_GET_STATE' });
    if (!response?.ok) throw new Error(response?.error || '当前页面没有 content script。');
    const state = response.state;
    els.host.textContent = state.host || '当前页面';
    els.candidateCount.textContent = String(state.candidateCount ?? 0);
    els.translatedCount.textContent = String(state.translatedCount ?? 0);
    els.enabled.checked = Boolean(state.enabled);
    els.autoTranslate.checked = Boolean(state.autoTranslate);
    els.debug.checked = Boolean(state.debug);
    els.status.textContent = state.pickerEnabled ? '选取中' : '';
  } catch (error) {
    els.host.textContent = '当前页面未注入脚本';
    els.status.textContent = '打开支持的网站后使用';
  }
}

async function toggle(key, value) {
  await sendRuntime({ type: 'SAVE_SETTINGS', settings: { [key]: value } });
  await sendToActive({ type: 'POPUP_TOGGLE', key, value }, '已更新');
  await refreshState();
}

async function sendToActive(message, okText) {
  const [tab] = await runtime.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab.');
  return new Promise((resolve, reject) => {
    runtime.tabs.sendMessage(tab.id, message, response => {
      const err = runtime.runtime.lastError;
      if (err) {
        els.status.textContent = '页面未注入';
        reject(new Error(err.message));
        return;
      }
      if (okText) els.status.textContent = okText;
      setTimeout(refreshState, 350);
      resolve(response);
    });
  });
}

function sendRuntime(message) {
  return new Promise((resolve, reject) => {
    runtime.runtime.sendMessage(message, response => {
      const err = runtime.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(response);
    });
  });
}
