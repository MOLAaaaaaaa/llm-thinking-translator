'use strict';

(() => {
  if (window.__LLM_THINKING_TRANSLATOR__) return;
  window.__LLM_THINKING_TRANSLATOR__ = true;

  const runtime = typeof chrome !== 'undefined' ? chrome : browser;

  const STATE = {
    settings: null,
    host: location.hostname.replace(/^www\./, ''),
    url: location.href,
    observer: null,
    scanTimer: null,
    scanInFlight: false,
    pendingScanReason: '',
    pendingStreamScan: false,
    lastStreamScanAt: 0,
    panel: null,
    launcher: null,
    panelBody: null,
    statusEl: null,
    lastCandidates: [],
    logs: [],
    translatedHashes: new Set(),
    candidateSeq: 0,
    pickerEnabled: false,
    hoveredElement: null,
    version: '0.5.3'
  };

  const ACTIONABLE_MESSAGES = new Set([
    'GET_SETTINGS_RESULT',
    'TRANSLATE_TEXT_RESULT'
  ]);

  init();

  async function init() {
    try {
      STATE.settings = await sendMessage({ type: 'GET_SETTINGS' }).then(r => r.settings);
      log('init', 'Extension content script loaded.', {
        host: STATE.host,
        url: STATE.url,
        settings: sanitizeSettingsForLog(STATE.settings)
      });
      injectPanel();
      bindRuntimeMessages();
      bindKeyboardShortcuts();
      bindThoughtExpansionTriggers();
      scheduleScan('init');
      installObserver();
      setStatus('已启动，等待扫描页面。');
    } catch (error) {
      console.error('[LLM Thinking Translator] init failed', error);
    }
  }

  function bindRuntimeMessages() {
    runtime.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      (async () => {
        try {
          if (!message || !message.type || ACTIONABLE_MESSAGES.has(message.type)) {
            sendResponse({ ok: false, error: 'No-op message.' });
            return;
          }
          if (message.type === 'POPUP_GET_STATE') {
            sendResponse({
              ok: true,
              state: {
                host: STATE.host,
                enabled: Boolean(STATE.settings?.enabled),
                autoTranslate: Boolean(STATE.settings?.autoTranslate),
                debug: Boolean(STATE.settings?.debug),
                candidateCount: STATE.lastCandidates.length,
                translatedCount: document.querySelectorAll('.llmtt-translation-card').length,
                pickerEnabled: STATE.pickerEnabled,
                version: STATE.version
              }
            });
            return;
          }
          if (message.type === 'POPUP_TOGGLE') {
            await updateSettings({ [message.key]: message.value });
            scheduleScan('popup-toggle');
            sendResponse({ ok: true });
            return;
          }
          if (message.type === 'POPUP_RESCAN') {
            await fullRescan('popup');
            sendResponse({ ok: true });
            return;
          }
          if (message.type === 'POPUP_TOGGLE_PANEL') {
            togglePanel();
            sendResponse({ ok: true });
            return;
          }
          if (message.type === 'POPUP_TOGGLE_PICKER') {
            setPicker(!STATE.pickerEnabled);
            sendResponse({ ok: true, pickerEnabled: STATE.pickerEnabled });
            return;
          }
          if (message.type === 'POPUP_EXPORT_DEBUG') {
            const data = buildDebugDump();
            await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
            log('export', 'Debug dump copied by popup.', { bytes: JSON.stringify(data).length });
            sendResponse({ ok: true });
            return;
          }
          sendResponse({ ok: false, error: `Unknown content message type: ${message.type}` });
        } catch (error) {
          sendResponse({ ok: false, error: normalizeError(error) });
        }
      })();
      return true;
    });
  }

  function bindKeyboardShortcuts() {
    document.addEventListener('keydown', event => {
      if (event.altKey && event.shiftKey && event.code === 'KeyL') {
        event.preventDefault();
        togglePanel();
      }
      if (event.altKey && event.shiftKey && event.code === 'KeyR') {
        event.preventDefault();
        fullRescan('shortcut');
      }
      if (event.altKey && event.shiftKey && event.code === 'KeyT') {
        event.preventDefault();
        setPicker(!STATE.pickerEnabled);
      }
    }, true);
  }

  function bindThoughtExpansionTriggers() {
    document.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest('.llmtt-panel, .llmtt-launcher, .llmtt-translation-card, .llmtt-toast')) return;
      const trigger = target.closest('button, [role="button"], summary, model-thoughts');
      if (!trigger || !isThoughtExpansionTrigger(trigger)) return;
      log('expand-trigger', 'User opened a thought/reasoning panel; scheduling rescan.', {
        descriptor: buildElementDescriptor(trigger),
        textPreview: getVisibleText(trigger).slice(0, 160)
      });
      schedulePostExpansionScans();
    }, true);
  }

  function isThoughtExpansionTrigger(element) {
    if (!(element instanceof Element)) return false;
    if (element.closest('model-thoughts')) return true;
    const text = getVisibleText(element);
    const aria = [
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || '',
      element.getAttribute('data-testid') || ''
    ].join(' ');
    return /\b(Thought for|Reasoned for)\b/i.test(`${text} ${aria}`);
  }

  function schedulePostExpansionScans() {
    [80, 280, 900].forEach((delayMs, index) => {
      setTimeout(() => {
        scheduleScan(`thought-expanded-${index + 1}`);
      }, delayMs);
    });
  }

  function installObserver() {
    if (STATE.observer) STATE.observer.disconnect();
    STATE.observer = new MutationObserver(mutations => {
      const relevant = mutations.some(mutation => {
        if (mutation.type === 'characterData') return true;
        if (!mutation.addedNodes || mutation.addedNodes.length === 0) return false;
        return Array.from(mutation.addedNodes).some(node => {
          if (node.nodeType !== Node.ELEMENT_NODE) return false;
          const element = /** @type {Element} */ (node);
          return !element.closest?.('.llmtt-panel, .llmtt-translation-card');
        });
      });
      if (relevant) {
        scheduleScan(isStreamingSurface() ? 'mutation-stream' : 'mutation');
      }
    });
    STATE.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
    log('observer', 'MutationObserver installed.');
  }

  function scheduleScan(reason) {
    const streaming = String(reason || '').includes('stream');
    const urgent = /thought-expanded|popup|panel|shortcut|manual|picker/i.test(String(reason || ''));
    STATE.pendingScanReason = reason;
    if (STATE.scanInFlight) {
      if (streaming) STATE.pendingStreamScan = true;
      return;
    }
    if (streaming) {
      STATE.pendingStreamScan = true;
      if (STATE.scanTimer || STATE.scanInFlight) return;
      const throttleMs = 650;
      const waitMs = Math.max(80, throttleMs - (Date.now() - STATE.lastStreamScanAt));
      STATE.scanTimer = setTimeout(runScheduledScan, waitMs);
      return;
    }
    clearTimeout(STATE.scanTimer);
    STATE.scanTimer = setTimeout(runScheduledScan, reason === 'init' ? 600 : urgent ? 90 : 420);
  }

  async function runScheduledScan() {
    clearTimeout(STATE.scanTimer);
    STATE.scanTimer = null;
    if (STATE.scanInFlight) {
      if (STATE.pendingScanReason || STATE.pendingStreamScan) {
        STATE.scanTimer = setTimeout(runScheduledScan, 250);
      }
      return;
    }
    const reason = STATE.pendingScanReason || 'scheduled';
    STATE.pendingScanReason = '';
    const wasStreaming = STATE.pendingStreamScan || String(reason).includes('stream');
    STATE.pendingStreamScan = false;
    STATE.scanInFlight = true;
    if (wasStreaming) STATE.lastStreamScanAt = Date.now();
    try {
      await scanAndMaybeTranslate(reason);
    } finally {
      STATE.scanInFlight = false;
      if (STATE.pendingStreamScan || STATE.pendingScanReason) {
        scheduleScan(STATE.pendingScanReason || 'followup-stream');
      }
    }
  }

  async function fullRescan(reason) {
    document.querySelectorAll('[data-llmtt-candidate="1"]').forEach(el => {
      el.removeAttribute('data-llmtt-candidate');
      el.classList.remove('llmtt-candidate', 'llmtt-candidate-strong');
    });
    document.querySelectorAll('.llmtt-busy').forEach(el => el.classList.remove('llmtt-busy'));
    STATE.lastCandidates = [];
    await scanAndMaybeTranslate(reason || 'full-rescan');
  }

  async function scanAndMaybeTranslate(reason) {
    if (!STATE.settings) return;
    if (!STATE.settings.enabled) {
      setStatus('插件已停用。');
      return;
    }
    const started = performance.now();
    const candidates = discoverCandidates();
    STATE.lastCandidates = candidates;
    renderPanelCandidates(candidates);
    markCandidates(candidates);
    log('scan', `Scan finished: ${candidates.length} candidates.`, {
      reason,
      ms: Math.round(performance.now() - started),
      candidates: candidates.slice(0, 10).map(c => serializeCandidate(c))
    });
    setStatus(`扫描到 ${candidates.length} 个候选节点。`);
    if (STATE.settings.autoTranslate) {
      markPendingTranslationCandidates(candidates);
      await translateCandidates(candidates, 'auto');
    }
  }

  function discoverCandidates() {
    const settings = STATE.settings || {};
    const profile = getSiteProfile();
    const blacklist = Array.isArray(settings.blacklistSelectors) ? settings.blacklistSelectors : [];
    const customSelectors = getCustomSelectorsForHost();
    const builtInSelectors = getBuiltInProfileSelectors(profile.platform || detectPlatformFromHost());
    const profileSelectors = uniqueStrings([...(profile.selectors || []), ...builtInSelectors]);
    const rawCandidates = [];

    const addStructuralMatch = (element, context) => {
      const targets = getStructuralTargets(element, context);
      for (const target of targets) {
        const record = evaluateCandidate(target, context);
        if (record) rawCandidates.push(record);
      }
    };

    for (const selector of customSelectors) {
      safeQueryAll(selector).forEach(element => {
        addStructuralMatch(element, { source: 'custom-selector', selector, profile, blacklist });
      });
    }

    for (const selector of profileSelectors) {
      safeQueryAll(selector).forEach(element => {
        addStructuralMatch(element, { source: 'profile-selector', selector, profile, blacklist });
      });
    }

    const deduped = dedupeCandidates(rawCandidates);
    const filtered = removeAncestorNoise(deduped);
    filtered.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
    return filtered.slice(0, Number(settings.candidateLimit || 40));
  }

  function getStructuralTargets(element, context) {
    if (!(element instanceof Element)) return [];
    const profile = context.profile || {};
    const platform = profile.platform || detectPlatformFromHost();
    const targets = new Set();

    if (platform === 'chatgpt') {
      const exactSelector = 'div.text-token-text-secondary.origin-start > div.relative.flex, div.text-token-text-secondary.origin-start div.relative.flex.w-full.items-start.gap-2.overflow-clip';
      if (element.matches(exactSelector)) targets.add(element);
      element.querySelectorAll?.(exactSelector).forEach(child => targets.add(child));
    } else if (platform === 'gemini') {
      const root = getGeminiThoughtRoot(element);
      if (root) {
        const expandedContent = getGeminiExpandedContent(root);
        if (expandedContent) {
          targets.add(expandedContent);
        } else if (isMeaningfulGeminiThoughtNode(element, root)) {
          targets.add(element);
        }
      }
    } else if (platform === 'claude') {
      targets.add(element);
    } else {
      targets.add(element);
    }

    return Array.from(targets).filter(target => target instanceof Element);
  }

  function detectPlatformFromHost() {
    if (/chatgpt\.com$|chat\.openai\.com$/.test(STATE.host)) return 'chatgpt';
    if (/claude\.ai$/.test(STATE.host)) return 'claude';
    if (/gemini\.google\.com$/.test(STATE.host)) return 'gemini';
    return 'generic';
  }

  function getGeminiThoughtRoot(element) {
    if (!(element instanceof Element)) return null;
    if (element.tagName?.toLowerCase() === 'model-thoughts') return element;
    return element.closest('model-thoughts');
  }

  function getGeminiExpandedContent(root) {
    if (!(root instanceof Element)) return null;
    const expanded = root.querySelector('[data-test-id="thoughts-header-button"][aria-expanded="true"], button[aria-expanded="true"]');
    if (!expanded) return null;
    const candidates = [
      ...root.querySelectorAll('div, section, article')
    ].filter(node => {
      if (!(node instanceof Element)) return false;
      if (node.closest('.llmtt-translation-card')) return false;
      if (node.matches('[data-test-id="thoughts-header-button"], .thoughts-header, .thoughts-header-button')) return false;
      if (node.querySelector('[data-test-id="thoughts-header-button"], .thoughts-header-button')) return false;
      const text = normalizeText(node.innerText || node.textContent || '');
      return text.length >= 80 && !/^(显示思路|show thoughts?)$/i.test(text);
    });
    candidates.sort((a, b) => (b.innerText || b.textContent || '').length - (a.innerText || a.textContent || '').length);
    return candidates[0] || root;
  }

  function isMeaningfulGeminiThoughtNode(element, root) {
    if (!(element instanceof Element) || !(root instanceof Element)) return false;
    if (element === root) return false;
    if (element.closest('.llmtt-translation-card')) return false;
    if (element.matches('[data-test-id="thoughts-header-button"], .thoughts-header, .thoughts-header-button')) return false;
    if (element.querySelector('[data-test-id="thoughts-header-button"], .thoughts-header-button')) return false;
    const text = normalizeText(element.innerText || element.textContent || '');
    if (!text || /^(显示思路|show thoughts?)$/i.test(text)) return false;
    return text.length >= 24 && shouldTranslateEnglishFragment(text);
  }

  function getBuiltInProfileSelectors(platform) {
    if (platform === 'chatgpt') {
      return [
        'section[data-testid^="conversation-turn"] div.text-token-text-secondary.origin-start > div.relative.flex.w-full.items-start.gap-2.overflow-clip',
        'section[data-testid^="conversation-turn"] div.text-token-text-secondary.origin-start > div.relative.flex',
        'div.text-token-text-secondary.origin-start > div.relative.flex.w-full.items-start.gap-2.overflow-clip',
        'div.text-token-text-secondary.origin-start > div.relative.flex'
      ];
    }
    if (platform === 'gemini') {
      return [
        'model-thoughts > div',
        'model-thoughts div.model-thoughts',
        'model-thoughts'
      ];
    }
    if (platform === 'claude') {
      return [
        'div.px-2\\.5.text-text-300',
        'div.text-text-300[class*="px-2"]',
        '.transition-colors.rounded-lg .text-text-300'
      ];
    }
    return [];
  }

  function uniqueStrings(values) {
    return Array.from(new Set((values || []).filter(value => typeof value === 'string' && value.trim())));
  }

  function evaluateCandidate(element, context) {
    if (!(element instanceof Element)) return null;
    if (!document.documentElement.contains(element)) return null;
    if (context.source !== 'profile-selector' && context.source !== 'custom-selector') return null;
    if (element.closest('.llmtt-panel, .llmtt-translation-card, .llmtt-toast')) return null;
    if (!element.closest('model-thoughts') && matchesAny(element, context.blacklist)) return null;
    if (isNavigationOrSidebar(element)) return null;
    if (isBadContainer(element)) return null;
    if (!isVisible(element)) return null;

    const structuralReason = getStructuralBlockReason(element, context);
    if (structuralReason) {
      log('exclude', `Candidate excluded: ${structuralReason}`, {
        selector: context.selector || buildCssPath(element),
        source: context.source,
        descriptor: buildElementDescriptor(element),
        textPreview: getVisibleText(element).slice(0, 320)
      });
      return null;
    }

    const text = getVisibleText(element);
    const min = Number(STATE.settings?.minTextLength || 8);
    const max = Number(STATE.settings?.maxTextLength || 6000);
    if (text.length < min || text.length > max) return null;
    if (!shouldTranslateText(text)) return null;
    if (looksLikeUserInputOrPrompt(element, text)) return null;
    if (looksLikeChromeUi(element, text)) return null;
    const exclusionReason = getHardExclusionReason(element, text);
    if (exclusionReason) {
      log('exclude', `Candidate excluded: ${exclusionReason}`, {
        selector: context.selector || buildCssPath(element),
        source: context.source,
        textPreview: text.slice(0, 320)
      });
      return null;
    }
    if (element.querySelector('.llmtt-translation-card')) return null;

    const selfDescriptor = buildElementDescriptor(element);
    let score = 0;
    const reasons = ['structural-only'];

    if (context.source === 'custom-selector') {
      score += 70;
      reasons.push('custom-selector');
    }
    if (context.source === 'profile-selector') {
      score += 90;
      reasons.push(`profile-selector:${context.selector}`);
    }

    const platformReason = getPlatformStructuralReason(element, context);
    if (platformReason) {
      score += 20;
      reasons.push(platformReason);
    }
    if (isLikelyAssistantMessage(element)) {
      score += 5;
      reasons.push('assistant-structure');
    }
    if (text.length > 40 && text.length < 2400) {
      score += 4;
      reasons.push('reasonable-length');
    }

    const requiredScore = context.source === 'custom-selector' ? 40 : 80;
    if (score < requiredScore) return null;

    const id = element.getAttribute('data-llmtt-id') || `llmtt-${++STATE.candidateSeq}`;
    element.setAttribute('data-llmtt-id', id);
    return {
      id,
      element,
      text,
      score,
      reasons,
      source: context.source,
      selector: context.selector || buildCssPath(element),
      xpath: buildXPath(element),
      descriptor: selfDescriptor,
      hash: hashString(`${STATE.host}|${text}`),
      translated: element.getAttribute('data-llmtt-translated') === '1'
    };
  }

  function getStructuralBlockReason(element, context) {
    const profile = context.profile || {};
    const platform = profile.platform || detectPlatformFromHost();
    if (isNavigationOrSidebar(element)) return '导航/侧边栏结构';

    if (platform === 'chatgpt') {
      const valid = element.matches('div.text-token-text-secondary.origin-start > div.relative.flex, div.text-token-text-secondary.origin-start div.relative.flex.w-full.items-start.gap-2.overflow-clip');
      if (context.source === 'profile-selector' && !valid) return '未命中 ChatGPT 思考结构白名单';
      if (!element.closest('div.text-token-text-secondary.origin-start')) return '缺少 ChatGPT 思考外层结构';
      if (element.closest('pre, code') || element.querySelector('pre, code')) return 'ChatGPT 代码/工具输出结构';
    }

    if (platform === 'gemini') {
      if (!element.closest('model-thoughts')) return '缺少 Gemini model-thoughts 结构';
      if (!element.closest('model-thoughts') && element.closest('bard-sidenav, side-navigation-v2, nav, [role="navigation"]')) return 'Gemini 导航结构';
    }

    if (platform === 'claude') {
      const valid = element.matches('div.px-2\\.5.text-text-300, div.text-text-300[class*="px-2"], .transition-colors.rounded-lg .text-text-300') || Boolean(element.closest('.transition-colors.rounded-lg'));
      if (context.source === 'profile-selector' && !valid) return '未命中 Claude 思考结构白名单';
    }

    return '';
  }

  function getPlatformStructuralReason(element, context) {
    const profile = context.profile || {};
    const platform = profile.platform || detectPlatformFromHost();
    if (platform === 'chatgpt' && element.closest('div.text-token-text-secondary.origin-start')) return 'chatgpt-thought-structure';
    if (platform === 'gemini' && element.closest('model-thoughts')) return 'gemini-model-thoughts';
    if (platform === 'claude' && (element.matches('div.text-text-300[class*="px-2"], div.px-2\\.5.text-text-300') || element.closest('.transition-colors.rounded-lg'))) return 'claude-thought-structure';
    return '';
  }

  function isNavigationOrSidebar(element) {
    if (!(element instanceof Element)) return false;
    if (element.closest('model-thoughts')) return false;
    return Boolean(element.closest('nav, [role="navigation"], aside, bard-sidenav, side-navigation-v2, mat-sidenav, [class*="sidebar" i], [class*="side-nav" i], [data-testid*="sidebar" i]'));
  }

  async function translateCandidates(candidates, trigger) {
    const settings = STATE.settings || {};
    let translatedCount = 0;
    for (const candidate of candidates) {
      if (!candidate.element || !document.documentElement.contains(candidate.element)) continue;
      ensureCandidateTranslationState(candidate);
      const needsUpdate = shouldRetranslateCandidate(candidate);
      if (candidate.element.getAttribute('data-llmtt-translated') === '1' && !needsUpdate) continue;
      if (STATE.translatedHashes.has(candidate.hash) && !needsUpdate) continue;
      if (candidate.element.closest('.llmtt-translation-card')) continue;
      if (!shouldTranslateText(candidate.text)) {
        log('skip-language', 'Skipped candidate because it is not primarily English.', serializeCandidate(candidate));
        continue;
      }
      try {
        setCandidateBusy(candidate, true);
        if (needsUpdate && candidate.sourceHash) STATE.translatedHashes.delete(candidate.sourceHash);
        const translation = await translateCandidateText(candidate, trigger);
        if (translation.text) {
          candidate.translatedSections = translation.sections;
          insertTranslation(candidate, translation.text, settings.preserveOriginal !== false);
          translatedCount += 1;
          log(needsUpdate ? 'translate-update' : 'translate', needsUpdate ? 'Updated translated candidate.' : 'Translated candidate.', serializeCandidate(candidate));
        }
      } catch (error) {
        log('translate-error', normalizeError(error), serializeCandidate(candidate));
        showToast(`翻译失败：${String(error.message || error).slice(0, 120)}`);
      } finally {
        setCandidateBusy(candidate, false);
      }
    }
    if (translatedCount) setStatus(`本次翻译 ${translatedCount} 个节点。`);
    renderPanelCandidates(STATE.lastCandidates);
  }

  async function translateCandidateText(candidate, trigger) {
    const sections = buildThinkingSourceSections(candidate.text);
    const meta = {
      host: STATE.host,
      url: location.href,
      selector: candidate.selector,
      trigger
    };
    if (sections.length) {
      const translatedSections = [];
      for (const section of sections) {
        const translatedTitle = section.title && shouldTranslateEnglishFragment(section.title)
          ? await requestTranslation(section.title, meta)
          : section.title;
        const translatedBody = section.text && shouldTranslateEnglishFragment(section.text)
          ? await requestTranslation(section.text, meta)
          : section.text;
        translatedSections.push({ title: translatedTitle, text: translatedBody });
      }
      return {
        text: translatedSections.map(section => [section.title, section.text].filter(Boolean).join('\n\n')).join('\n\n'),
        sections: translatedSections
      };
    }
    return { text: await requestTranslation(candidate.text, meta), sections: [] };
  }

  async function requestTranslation(text, meta) {
    return sendMessage({
      type: 'TRANSLATE_TEXT',
      text,
      meta
    }).then(response => {
      if (!response.ok) throw new Error(response.error || 'Translate failed.');
      return response.translatedText;
    });
  }

  function insertTranslation(candidate, translatedText, preserveOriginal) {
    const element = candidate.element;
    const platform = detectPlatformFromHost();
    const insertionTarget = getTranslationInsertionTarget(candidate);
    insertionTarget.parentElement?.classList?.add('llmtt-translation-host');
    const existing = insertionTarget.nextElementSibling?.classList?.contains('llmtt-translation-card')
      ? insertionTarget.nextElementSibling
      : null;
    const card = existing || document.createElement('section');
    card.className = `llmtt-translation-card llmtt-${platform}-translation-card`;
    card.setAttribute('data-llmtt-source-id', candidate.id);
    card.setAttribute('data-llmtt-source-hash', candidate.hash);
    card.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'llmtt-translation-header';
    const headerTitle = document.createElement('strong');
    headerTitle.textContent = '中文翻译';
    header.appendChild(headerTitle);

    const actions = document.createElement('div');
    actions.className = 'llmtt-card-actions';

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.textContent = '复制';
    copyButton.addEventListener('click', async event => {
      event.stopPropagation();
      await navigator.clipboard.writeText(translatedText);
      showToast('已复制翻译文本。');
    });

    const retranslateButton = document.createElement('button');
    retranslateButton.type = 'button';
    retranslateButton.textContent = '重译';
    retranslateButton.addEventListener('click', async event => {
      event.stopPropagation();
      clearTranslationState(element, candidate.hash);
      card.remove();
      await translateCandidates([candidate], 'manual-retranslate');
    });

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.textContent = '移除';
    removeButton.addEventListener('click', event => {
      event.stopPropagation();
      card.remove();
      clearTranslationState(element, candidate.hash);
    });

    actions.append(copyButton, retranslateButton, removeButton);
    header.appendChild(actions);

    const body = document.createElement('div');
    body.className = 'llmtt-translation-body';
    renderTranslationBody(body, translatedText, candidate, platform);

    const meta = document.createElement('details');
    meta.className = 'llmtt-translation-meta';
    const summary = document.createElement('summary');
    summary.textContent = '调试信息';
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(serializeCandidate(candidate), null, 2);
    meta.append(summary, pre);

    card.append(header, body);
    if (STATE.settings?.debug) card.appendChild(meta);

    if (preserveOriginal) {
      insertionTarget.insertAdjacentElement('afterend', card);
    } else {
      element.innerHTML = '';
      element.appendChild(card);
    }
    element.setAttribute('data-llmtt-translated', '1');
    element.setAttribute('data-llmtt-source-hash', candidate.hash);
    element.setAttribute('data-llmtt-source-length', String(candidate.text.length));
    element.setAttribute('data-llmtt-last-translate-at', String(Date.now()));
    STATE.translatedHashes.add(candidate.hash);
    syncPanelChrome();
  }

  function shouldRetranslateCandidate(candidate) {
    const element = candidate?.element;
    if (!element || element.getAttribute('data-llmtt-translated') !== '1') return false;
    const previousHash = element.getAttribute('data-llmtt-source-hash') || '';
    if (!previousHash || previousHash === candidate.hash) return false;
    const previousLength = Number(element.getAttribute('data-llmtt-source-length') || 0);
    const lastTranslateAt = Number(element.getAttribute('data-llmtt-last-translate-at') || 0);
    const growth = candidate.text.length - previousLength;
    const cooldownMs = isStreamingSurface() ? 1800 : 600;
    if (Date.now() - lastTranslateAt < cooldownMs) return false;
    return growth >= 32 || candidate.text.length >= previousLength * 1.2;
  }

  function ensureCandidateTranslationState(candidate) {
    const element = candidate?.element;
    if (!element) return;
    const hasCard = hasRenderedTranslation(candidate.hash);
    if (!hasCard) {
      if (STATE.translatedHashes.has(candidate.hash)) STATE.translatedHashes.delete(candidate.hash);
      if (element.getAttribute('data-llmtt-source-hash') === candidate.hash) {
        element.removeAttribute('data-llmtt-translated');
        element.removeAttribute('data-llmtt-source-hash');
        element.removeAttribute('data-llmtt-source-length');
        element.removeAttribute('data-llmtt-last-translate-at');
      }
    }
  }

  function hasRenderedTranslation(hash) {
    if (!hash) return false;
    return Boolean(document.querySelector(`.llmtt-translation-card[data-llmtt-source-hash="${cssAttrEscape(hash)}"]`));
  }

  function clearTranslationState(element, hash) {
    if (!element) return;
    const previousHash = element.getAttribute('data-llmtt-source-hash') || '';
    element.removeAttribute('data-llmtt-translated');
    element.removeAttribute('data-llmtt-source-hash');
    element.removeAttribute('data-llmtt-source-length');
    element.removeAttribute('data-llmtt-last-translate-at');
    if (previousHash) STATE.translatedHashes.delete(previousHash);
    if (hash) STATE.translatedHashes.delete(hash);
  }

  function getTranslationInsertionTarget(candidate) {
    const element = candidate.element;
    const platform = detectPlatformFromHost();
    if (platform === 'chatgpt') {
      return element;
    }
    if (platform === 'gemini') {
      return element.closest('model-thoughts') || element;
    }
    return element;
  }

  function renderTranslationBody(body, translatedText, candidate, platform) {
    const structured = Array.isArray(candidate.translatedSections) ? candidate.translatedSections : [];
    if (platform !== 'gemini' && platform !== 'chatgpt') {
      body.textContent = translatedText;
      return;
    }
    const sections = structured.length ? structured : buildThinkingDisplaySections(candidate.text, translatedText);
    if (!sections.length) {
      body.textContent = translatedText;
      return;
    }
    body.classList.add('llmtt-structured-translation-body');
    if (platform === 'gemini') body.classList.add('llmtt-gemini-translation-body');
    if (platform === 'chatgpt') body.classList.add('llmtt-chatgpt-translation-body');
    for (const section of sections) {
      const block = document.createElement('section');
      block.className = 'llmtt-thinking-section';
      if (section.title) {
        const title = document.createElement('div');
        title.className = 'llmtt-thinking-section-title';
        title.textContent = section.title;
        block.appendChild(title);
      }
      if (section.text) {
        const text = document.createElement('div');
        text.className = 'llmtt-thinking-section-text';
        text.textContent = section.text;
        block.appendChild(text);
      }
      body.appendChild(block);
    }
  }

  function buildThinkingDisplaySections(sourceText, translatedText) {
    const translatedParts = normalizeText(translatedText).split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
    if (translatedParts.length <= 1) return [];
    const sections = [];
    let index = /^(显示思路|show thoughts?)$/i.test(translatedParts[0] || '') ? 1 : 0;
    while (index < translatedParts.length) {
      const maybeTitle = translatedParts[index];
      const titleLike = maybeTitle.length <= 80 && !/[。！？.!?]\s*$/.test(maybeTitle);
      if (titleLike && index + 1 < translatedParts.length) {
        sections.push({ title: maybeTitle, text: translatedParts[index + 1] });
        index += 2;
      } else {
        sections.push({ title: '', text: maybeTitle });
        index += 1;
      }
    }
    return sections;
  }

  function buildThinkingSourceSections(sourceText) {
    const parts = normalizeText(sourceText).split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
    if (/^(显示思路|show thoughts?)$/i.test(parts[0] || '')) parts.shift();
    const searchOnly = buildSearchOnlySection(parts);
    if (searchOnly) return [searchOnly];
    if (parts.length < 2) {
      const compact = splitCompactedThinkingTitle(parts[0] || '');
      return compact ? [compact] : [];
    }
    const sections = [];
    let index = 0;
    while (index < parts.length) {
      const title = parts[index];
      const titleLike = title.length <= 96 && !/[。！？.!?]\s*$/.test(title);
      if (titleLike && index + 1 < parts.length) {
        const bodyParts = [];
        index += 1;
        while (index < parts.length) {
          const next = parts[index];
          const nextLooksLikeTitle = next.length <= 96 && !/[。！？.!?]\s*$/.test(next) && index + 1 < parts.length;
          if (nextLooksLikeTitle && bodyParts.length) break;
          bodyParts.push(next);
          index += 1;
          if (index < parts.length) {
            const maybeTitle = parts[index];
            if (maybeTitle.length <= 96 && !/[。！？.!?]\s*$/.test(maybeTitle) && index + 1 < parts.length) break;
          }
        }
        const text = bodyParts.join('\n\n');
        if (shouldTranslateText(title) || shouldTranslateText(text)) sections.push({ title, text });
      } else {
        if (shouldTranslateText(title)) sections.push({ title: '', text: title });
        index += 1;
      }
    }
    return sections;
  }

  function buildSearchOnlySection(parts) {
    const joined = normalizeText((parts || []).join('\n\n'));
    const compact = joined.replace(/\s+/g, ' ').trim();
    if (!/^(Searching|Browsing|Looking up|Checking|Fetching|Reading|Opening)\b/i.test(compact)) return null;
    if (!hasDomainList(compact) && !/再显示\s*\d+\s*个/.test(compact)) return null;
    const domainMatch = compact.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/i);
    const moreMatch = compact.match(/再显示\s*\d+\s*个/);
    const cutAt = [domainMatch?.index, moreMatch?.index]
      .filter(index => typeof index === 'number' && index > 0)
      .sort((a, b) => a - b)[0];
    const title = normalizeText(cutAt ? compact.slice(0, cutAt) : parts[0] || '');
    if (!title || !shouldTranslateEnglishFragment(title)) return null;
    return { title, text: '' };
  }

  function hasDomainList(text) {
    const domains = String(text || '').match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi) || [];
    return domains.length > 0;
  }

  function splitCompactedThinkingTitle(text) {
    const normalized = normalizeText(text);
    if (!shouldTranslateText(normalized)) return null;
    const bodyStart = "(?:The\\s|I\\s+(?:am|need|will|have|should|can|want|must|may|might|plan|found|confirmed|now|am\\s+now)|I(?:'|’)?m\\s|I(?:'|’)?ve\\s|I(?:'|’)?ll\\s|We\\s|This\\s|Need\\s|Let(?:'|’)?s\\s|Searching\\s|Building\\s|Creating\\s|Implementing\\s|Analyzing\\s|Assessing\\s|Evaluating\\s|Researching\\s|Verifying\\s|Refining\\s|Confirming\\s)";
    const match = normalized.match(new RegExp(`^(.{12,120}?)(?=${bodyStart})`, 'i'));
    if (!match) return null;
    const title = match[1].trim();
    const body = normalized.slice(title.length).trim();
    if (!title || !body || title.length > 120 || body.length < 30) return null;
    return { title, text: body };
  }

  function injectPanel() {
    if (STATE.panel) return;
    const launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.className = 'llmtt-launcher';
    launcher.setAttribute('aria-label', '打开思考翻译面板');
    launcher.setAttribute('title', '思考翻译');
    launcher.innerHTML = '<span>译</span><small>0</small>';
    launcher.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      togglePanel();
    }, true);

    const panel = document.createElement('aside');
    panel.className = 'llmtt-panel llmtt-hidden';
    panel.innerHTML = `
      <div class="llmtt-panel-header">
        <div>
          <strong>思考翻译</strong>
          <span class="llmtt-version">v${STATE.version}</span>
        </div>
        <div class="llmtt-panel-buttons">
          <button type="button" data-action="picker">选取</button>
          <button type="button" data-action="rescan">重扫</button>
          <button type="button" data-action="export" class="llmtt-debug-only">导出</button>
          <button type="button" data-action="hide" aria-label="隐藏面板">×</button>
        </div>
      </div>
      <div class="llmtt-panel-status"></div>
      <div class="llmtt-panel-body"></div>
      <div class="llmtt-panel-footer">
        <span>Alt+Shift+L 面板，Alt+Shift+R 重扫，Alt+Shift+T 选取</span>
      </div>
    `;
    document.documentElement.appendChild(launcher);
    document.documentElement.appendChild(panel);
    STATE.launcher = launcher;
    STATE.panel = panel;
    STATE.panelBody = panel.querySelector('.llmtt-panel-body');
    STATE.statusEl = panel.querySelector('.llmtt-panel-status');

    panel.addEventListener('click', async event => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const action = button.getAttribute('data-action');
      if (action === 'hide') togglePanel(false);
      if (action === 'rescan') await fullRescan('panel');
      if (action === 'export') {
        await navigator.clipboard.writeText(JSON.stringify(buildDebugDump(), null, 2));
        showToast('调试信息已复制到剪贴板。');
      }
      if (action === 'picker') setPicker(!STATE.pickerEnabled);
      if (action === 'translate-one') {
        const id = button.getAttribute('data-id');
        const candidate = STATE.lastCandidates.find(item => item.id === id);
        if (candidate) await translateCandidates([candidate], 'panel');
      }
      if (action === 'highlight-one') {
        const id = button.getAttribute('data-id');
        const candidate = STATE.lastCandidates.find(item => item.id === id);
        if (candidate) flashElement(candidate.element);
      }
      if (action === 'copy-selector') {
        const id = button.getAttribute('data-id');
        const candidate = STATE.lastCandidates.find(item => item.id === id);
        if (candidate) {
          await navigator.clipboard.writeText(candidate.selector || candidate.xpath || '');
          showToast('选择器已复制。');
        }
      }
    }, true);

    syncPanelChrome();
  }

  function renderPanelCandidates(candidates) {
    if (!STATE.panelBody) return;
    const debug = Boolean(STATE.settings?.debug);
    const displayCandidates = debug ? candidates : candidates.slice(0, 12);
    const rows = displayCandidates.map(candidate => {
      const previewLength = debug ? 180 : 120;
      const preview = escapeHtml(candidate.text.slice(0, previewLength)).replace(/\n/g, ' ');
      const reasons = escapeHtml(candidate.reasons.join(', '));
      const translated = candidate.element?.getAttribute('data-llmtt-translated') === '1' ? '已译' : '未译';
      return `
        <div class="llmtt-candidate-row" data-id="${candidate.id}">
          <div class="llmtt-candidate-top">
            <strong>#${candidate.id}</strong>
            ${debug ? `<span>score ${candidate.score}</span>` : ''}
            <span>${translated}</span>
          </div>
          <div class="llmtt-candidate-preview">${preview}</div>
          ${debug ? `<div class="llmtt-candidate-reasons">${reasons}</div>` : ''}
          <div class="llmtt-candidate-actions">
            <button type="button" data-action="translate-one" data-id="${candidate.id}">翻译</button>
            <button type="button" data-action="highlight-one" data-id="${candidate.id}">定位</button>
            ${debug ? `<button type="button" data-action="copy-selector" data-id="${candidate.id}">复制 selector</button>` : ''}
          </div>
        </div>
      `;
    }).join('');
    const more = !debug && candidates.length > displayCandidates.length
      ? `<div class="llmtt-more">还有 ${candidates.length - displayCandidates.length} 个候选节点，开启调试后显示完整列表。</div>`
      : '';
    STATE.panelBody.innerHTML = rows
      ? rows + more
      : '<div class="llmtt-empty">暂时没有候选节点。展开网页端的“思考”区域后会自动扫描。</div>';
    syncPanelChrome();
  }

  function markCandidates(candidates) {
    document.querySelectorAll('[data-llmtt-candidate="1"]').forEach(el => {
      el.classList.remove('llmtt-candidate', 'llmtt-candidate-strong');
      el.removeAttribute('data-llmtt-candidate');
    });
    if (!STATE.settings?.debug) return;
    for (const candidate of candidates) {
      candidate.element.setAttribute('data-llmtt-candidate', '1');
      candidate.element.classList.add('llmtt-candidate');
      if (candidate.score >= 35) candidate.element.classList.add('llmtt-candidate-strong');
    }
  }

  function togglePanel(force) {
    if (!STATE.panel) injectPanel();
    const shouldShow = typeof force === 'boolean' ? force : STATE.panel.classList.contains('llmtt-hidden');
    STATE.panel.classList.toggle('llmtt-hidden', !shouldShow);
    syncPanelChrome();
  }

  function setStatus(text) {
    if (STATE.statusEl) STATE.statusEl.textContent = text;
    syncPanelChrome();
  }

  function syncPanelChrome() {
    if (STATE.panel) {
      STATE.panel.classList.toggle('llmtt-debug-enabled', Boolean(STATE.settings?.debug));
    }
    if (!STATE.launcher) return;
    const translatedCount = document.querySelectorAll('.llmtt-translation-card').length;
    const badge = STATE.launcher.querySelector('small');
    if (badge) badge.textContent = String(translatedCount || STATE.lastCandidates.length || 0);
    const expanded = Boolean(STATE.panel && !STATE.panel.classList.contains('llmtt-hidden'));
    STATE.launcher.classList.toggle('llmtt-launcher-active', expanded);
    STATE.launcher.setAttribute('aria-expanded', String(expanded));
  }

  function isStreamingSurface() {
    const platform = detectPlatformFromHost();
    if (platform === 'chatgpt') {
      if (document.querySelector('[data-testid="stop-button"]')) return true;
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      const text = buttons.map(button => `${button.innerText || ''} ${button.getAttribute('aria-label') || ''}`.trim()).join('\n');
      return /stop|continue generating/i.test(text) || (!document.querySelector('[data-testid="send-button"]') && Boolean(document.querySelector('section[data-testid^="conversation-turn"]')));
    }
    if (platform === 'gemini') {
      return Boolean(document.querySelector(
        'model-response[thinking], model-thoughts[open], model-thoughts [data-test-id="thoughts-header-button"][aria-expanded="true"], model-thoughts button[aria-expanded="true"], message-content .loading'
      ));
    }
    return false;
  }

  function setPicker(enabled) {
    STATE.pickerEnabled = Boolean(enabled);
    document.documentElement.classList.toggle('llmtt-picker-active', STATE.pickerEnabled);
    if (STATE.pickerEnabled) {
      document.addEventListener('mousemove', pickerMove, true);
      document.addEventListener('click', pickerClick, true);
      showToast('节点选取已开启。移动鼠标并点击网页中的思考区域即可强制翻译。');
    } else {
      document.removeEventListener('mousemove', pickerMove, true);
      document.removeEventListener('click', pickerClick, true);
      if (STATE.hoveredElement) STATE.hoveredElement.classList.remove('llmtt-picker-hover');
      STATE.hoveredElement = null;
      showToast('节点选取已关闭。');
    }
  }

  function pickerMove(event) {
    if (!STATE.pickerEnabled) return;
    const element = event.target instanceof Element ? event.target : null;
    if (!element || element.closest('.llmtt-panel, .llmtt-launcher, .llmtt-translation-card')) return;
    if (STATE.hoveredElement && STATE.hoveredElement !== element) {
      STATE.hoveredElement.classList.remove('llmtt-picker-hover');
    }
    STATE.hoveredElement = element;
    element.classList.add('llmtt-picker-hover');
  }

  async function pickerClick(event) {
    if (!STATE.pickerEnabled) return;
    const element = event.target instanceof Element ? event.target : null;
    if (!element || element.closest('.llmtt-panel, .llmtt-launcher, .llmtt-translation-card')) return;
    event.preventDefault();
    event.stopPropagation();
    const text = getVisibleText(element);
    const exclusionReason = getHardExclusionReason(element, text);
    if (exclusionReason) {
      log('manual-exclude', `Manual picker blocked this node: ${exclusionReason}`, {
        selector: buildCssPath(element),
        xpath: buildXPath(element),
        descriptor: buildElementDescriptor(element),
        textPreview: text.slice(0, 500)
      });
      showToast(`已排除：${exclusionReason}`);
      setPicker(false);
      return;
    }
    const candidate = makeManualCandidate(element, text);
    STATE.lastCandidates.unshift(candidate);
    renderPanelCandidates(STATE.lastCandidates);
    await translateCandidates([candidate], 'picker');
    setPicker(false);
  }

  function makeManualCandidate(element, precomputedText) {
    const text = precomputedText || getVisibleText(element);
    const id = element.getAttribute('data-llmtt-id') || `llmtt-${++STATE.candidateSeq}`;
    element.setAttribute('data-llmtt-id', id);
    return {
      id,
      element,
      text,
      score: 999,
      reasons: ['manual-picker'],
      source: 'manual-picker',
      selector: buildCssPath(element),
      xpath: buildXPath(element),
      descriptor: buildElementDescriptor(element),
      hash: hashString(`${STATE.host}|manual|${text}`),
      translated: element.getAttribute('data-llmtt-translated') === '1'
    };
  }

  function setCandidateBusy(candidate, busy) {
    if (!candidate?.element) return;
    if (!STATE.settings?.debug) return;
    candidate.element.classList.toggle('llmtt-busy', Boolean(busy));
  }

  function markPendingTranslationCandidates(candidates) {
    for (const candidate of candidates) {
      if (!candidate?.element || !document.documentElement.contains(candidate.element)) continue;
      if (candidate.element.getAttribute('data-llmtt-translated') === '1') continue;
      if (STATE.translatedHashes.has(candidate.hash)) continue;
      if (candidate.element.closest('.llmtt-translation-card')) continue;
      if (!shouldTranslateText(candidate.text)) continue;
      setCandidateBusy(candidate, true);
    }
  }

  function showToast(text) {
    const toast = document.createElement('div');
    toast.className = 'llmtt-toast';
    toast.textContent = text;
    document.documentElement.appendChild(toast);
    setTimeout(() => toast.classList.add('llmtt-toast-visible'), 10);
    setTimeout(() => {
      toast.classList.remove('llmtt-toast-visible');
      setTimeout(() => toast.remove(), 220);
    }, 2600);
  }

  function buildDebugDump() {
    return {
      extension: 'LLM Thinking Translator',
      version: STATE.version,
      generatedAt: new Date().toISOString(),
      host: STATE.host,
      url: location.href,
      userAgent: navigator.userAgent,
      settings: sanitizeSettingsForLog(STATE.settings),
      candidates: STATE.lastCandidates.map(serializeCandidate),
      translatedCards: Array.from(document.querySelectorAll('.llmtt-translation-card')).map(card => ({
        sourceId: card.getAttribute('data-llmtt-source-id'),
        textPreview: card.innerText.slice(0, 500)
      })),
      logs: STATE.logs.slice(-120)
    };
  }

  function log(type, message, payload = {}) {
    const debug = Boolean(STATE.settings?.debug);
    const important = new Set(['init', 'settings', 'translate-error', 'export']);
    if (!debug && !important.has(type)) return;
    const record = {
      time: new Date().toISOString(),
      type,
      message,
      payload
    };
    STATE.logs.push(record);
    const limit = debug ? 500 : 80;
    while (STATE.logs.length > limit) STATE.logs.shift();
    if (debug) console.debug('[LLMTT]', record);
  }

  async function updateSettings(patch) {
    STATE.settings = { ...STATE.settings, ...patch };
    await sendMessage({ type: 'SAVE_SETTINGS', settings: patch });
    if (Object.prototype.hasOwnProperty.call(patch, 'debug')) {
      syncPanelChrome();
      document.querySelectorAll('[data-llmtt-candidate="1"]').forEach(el => {
        el.classList.toggle('llmtt-candidate', Boolean(patch.debug));
      });
      if (!patch.debug) document.querySelectorAll('.llmtt-busy').forEach(el => el.classList.remove('llmtt-busy'));
      markCandidates(STATE.lastCandidates);
    }
    log('settings', 'Settings updated.', patch);
  }

  function getSiteProfile() {
    const profiles = STATE.settings?.siteProfiles || {};
    const host = STATE.host;
    if (profiles[host]) return profiles[host];
    const matchedKey = Object.keys(profiles).find(key => host.endsWith(key));
    return matchedKey ? profiles[matchedKey] : { anchors: ['main', 'body'], hints: [] };
  }

  function getCustomSelectorsForHost() {
    const map = STATE.settings?.customSelectorsByHost || {};
    const host = STATE.host;
    const selectors = [];
    for (const [key, value] of Object.entries(map)) {
      if (host === key || host.endsWith(`.${key}`) || key === '*') {
        if (Array.isArray(value)) selectors.push(...value);
        else if (typeof value === 'string') selectors.push(value);
      }
    }
    return selectors.filter(Boolean);
  }

  function walkVisibleElements(root, callback) {
    if (!root) return;
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const node = stack.pop();
      if (!node || seen.has(node)) continue;
      seen.add(node);
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const element = /** @type {Element} */ (node);
      callback(element);
      const shadow = element.shadowRoot;
      if (shadow) Array.from(shadow.children).forEach(child => stack.push(child));
      const children = element.children;
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
    }
  }

  function safeQueryAll(selector) {
    try {
      return Array.from(document.querySelectorAll(selector));
    } catch (error) {
      log('selector-error', `Bad selector: ${selector}`, { error: normalizeError(error) });
      return [];
    }
  }

  function dedupeCandidates(candidates) {
    const result = [];
    const byHash = new Map();
    for (const candidate of candidates) {
      const key = candidate.hash;
      const previous = byHash.get(key);
      if (!previous || candidate.score > previous.score) byHash.set(key, candidate);
    }
    for (const candidate of byHash.values()) result.push(candidate);
    return result;
  }

  function removeAncestorNoise(candidates) {
    const sorted = [...candidates].sort((a, b) => a.text.length - b.text.length);
    const kept = [];
    for (const candidate of sorted) {
      const hasBetterDescendant = kept.some(existing => {
        if (!candidate.element.contains(existing.element)) return false;
        const scoreClose = existing.score + 8 >= candidate.score;
        const textRatio = existing.text.length / Math.max(candidate.text.length, 1);
        return scoreClose && textRatio > 0.35;
      });
      if (!hasBetterDescendant) kept.push(candidate);
    }
    return kept;
  }

  function getVisibleText(element) {
    if (element instanceof Element && element.closest('model-thoughts')) {
      const root = getGeminiThoughtRoot(element);
      if (root && element === root) {
        const expandedContent = getGeminiExpandedContent(root);
        if (expandedContent) return normalizeText(expandedContent.innerText || expandedContent.textContent || '');
      }
      return normalizeText(element.innerText || element.textContent || '');
    }
    const clone = element.cloneNode(true);
    clone.querySelectorAll?.('.llmtt-translation-card, .llmtt-panel, .llmtt-launcher, script, style, noscript, svg, canvas').forEach(node => node.remove());
    return normalizeText(clone.innerText || clone.textContent || '');
  }

  function getNearText(element) {
    const parts = [];
    const parent = element.parentElement;
    if (parent) parts.push(parent.getAttribute('aria-label') || '', parent.getAttribute('title') || '');
    const previous = element.previousElementSibling;
    const next = element.nextElementSibling;
    if (previous) parts.push((previous.innerText || previous.textContent || '').slice(0, 160));
    if (next) parts.push((next.innerText || next.textContent || '').slice(0, 160));
    return parts.join('\n');
  }

  function normalizeText(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function shouldTranslateText(text) {
    const normalized = normalizeText(text)
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g, ' ');
    const latinLetters = (normalized.match(/[A-Za-z]/g) || []).length;
    const cjkChars = (normalized.match(/[\u3400-\u9fff]/g) || []).length;
    const latinWords = (normalized.match(/\b[A-Za-z][A-Za-z'-]{2,}\b/g) || []).length;
    if (latinLetters < 24 || latinWords < 4) return false;
    return latinLetters >= Math.max(24, cjkChars * 1.5);
  }

  function shouldTranslateEnglishFragment(text) {
    const normalized = normalizeText(text)
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g, ' ');
    const latinLetters = (normalized.match(/[A-Za-z]/g) || []).length;
    const cjkChars = (normalized.match(/[\u3400-\u9fff]/g) || []).length;
    const latinWords = (normalized.match(/\b[A-Za-z][A-Za-z'-]{1,}\b/g) || []).length;
    if (latinLetters < 6 || latinWords < 1) return false;
    return latinLetters > cjkChars * 1.5;
  }

  function isLikelyAssistantMessage(element) {
    const chain = [];
    let current = element;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      chain.push(buildElementDescriptor(current));
      const role = current.getAttribute('data-message-author-role') || current.getAttribute('data-testid') || current.getAttribute('aria-label') || '';
      if (/assistant|model|bot|response|claude|gemini/i.test(role)) return true;
    }
    return /assistant|model|bot|response|claude|gemini/i.test(chain.join(' '));
  }

  function isBadContainer(element) {
    const tag = element.tagName.toLowerCase();
    if (['html', 'body', 'main'].includes(tag)) return true;
    const rect = element.getBoundingClientRect();
    const area = rect.width * rect.height;
    const viewportArea = window.innerWidth * window.innerHeight;
    if (area > viewportArea * 0.72 && getVisibleText(element).length > 1500) return true;
    if (element.children.length > 25 && getVisibleText(element).length > 1000) return true;
    return false;
  }

  function getHardExclusionReason(element, text) {
    const descriptor = buildElementDescriptor(element).toLowerCase();
    const normalized = normalizeText(text);
    const compact = normalized.slice(0, 16000);

    if (isNavigationOrSidebar(element)) return '导航/侧边栏结构';
    if (element.closest('pre, code, kbd, samp')) return 'code/pre 节点';
    if (/\b(Python|bash|zsh|powershell|cmd)\s*(bash|zsh|-lc|python\b|node\b)/i.test(compact)) return '疑似沙盒命令输出';
    if (/\b(cat|python3?|node|npm|pnpm|yarn|unzip|zip|sed|grep|awk)\s+[^\n]{0,120}(\/mnt\/data|EOF|node --check|bash -lc)/i.test(compact)) return '疑似终端执行日志';
    if (/(\/mnt\/data|\/tmp\/|C:\\\\Users\\\\|Traceback \(most recent call last\)|SyntaxError:|ReferenceError:|TypeError:|Archive:\s+\/|Length\s+Date\s+Time\s+Name)/i.test(compact)) return '疑似代码/文件执行结果';
    if (/```[\s\S]{0,2000}```/.test(compact) && /(function|const|let|class|import|export|<script|manifest_version|chrome\.runtime)/i.test(compact)) return '疑似代码块内容';
    if (/\b(manifest_version|service_worker|content_scripts|host_permissions|chrome\.runtime|browser\.runtime)\b/i.test(compact) && compact.length > 1200) return '疑似扩展源码/配置输出';
    if (/\b(Creating|Writing|Generating|Running|Executing)\b.{0,80}\b(background\.js|contentScript\.js|manifest\.json|icon files|zip file|extension package)\b/i.test(compact)) return '疑似构建过程输出';
    if (/\b(Python|bash|JavaScript|TypeScript|JSON|HTML|CSS)\b.{0,80}\b(cat >|EOF|node --check|python - <<|python3 - <<)/i.test(compact)) return '疑似代码执行片段';
    if (/\bcopy code\b|\bstdout\b|\bstderr\b|\bexit code\b/i.test(descriptor + '\n' + compact.slice(0, 1000))) return '疑似工具输出区域';
    return '';
  }

  function looksLikeUserInputOrPrompt(element, text) {
    const descriptor = buildElementDescriptor(element).toLowerCase();
    if (/prompt|composer|input|textarea|editor|search|query/.test(descriptor)) return true;
    const role = element.closest('[data-message-author-role]')?.getAttribute('data-message-author-role');
    if (role === 'user') return true;
    if (/^(send|stop generating|regenerate|copy|share|edit|delete|new chat|settings)$/i.test(text.trim())) return true;
    return false;
  }

  function looksLikeChromeUi(element, text) {
    if (isNavigationOrSidebar(element)) return true;
    const descriptor = buildElementDescriptor(element).toLowerCase();
    if (/menu|popover|dialog|tooltip|account|profile/.test(descriptor) && text.length < 240) return true;
    return false;
  }

  function matchesAny(element, selectors) {
    for (const selector of selectors || []) {
      try {
        if (element.matches(selector) || element.closest(selector)) return true;
      } catch (_error) {}
    }
    return false;
  }

  function isVisible(element) {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return false;
    if (rect.bottom < -200 || rect.top > window.innerHeight + 2000) return false;
    return true;
  }

  function buildElementDescriptor(element) {
    if (!(element instanceof Element)) return '';
    const attrs = [
      element.tagName.toLowerCase(),
      element.id ? `#${element.id}` : '',
      element.className && typeof element.className === 'string' ? `.${element.className.replace(/\s+/g, '.')}` : '',
      element.getAttribute('role') ? `[role=${element.getAttribute('role')}]` : '',
      element.getAttribute('data-testid') ? `[data-testid=${element.getAttribute('data-testid')}]` : '',
      element.getAttribute('data-message-author-role') ? `[data-message-author-role=${element.getAttribute('data-message-author-role')}]` : '',
      element.getAttribute('aria-label') ? `[aria-label=${element.getAttribute('aria-label')}]` : '',
      element.getAttribute('title') ? `[title=${element.getAttribute('title')}]` : ''
    ];
    return attrs.filter(Boolean).join(' ').slice(0, 600);
  }

  function buildCssPath(element) {
    if (!(element instanceof Element)) return '';
    const parts = [];
    let current = element;
    for (let depth = 0; current && current.nodeType === Node.ELEMENT_NODE && depth < 7; depth += 1) {
      let part = current.tagName.toLowerCase();
      const testId = current.getAttribute('data-testid');
      const role = current.getAttribute('role');
      const messageRole = current.getAttribute('data-message-author-role');
      if (current.id && !/^[:\d]|[\s.#>+~\[\]]/.test(current.id)) {
        part += `#${cssEscape(current.id)}`;
        parts.unshift(part);
        break;
      }
      if (testId) part += `[data-testid="${cssAttrEscape(testId)}"]`;
      else if (messageRole) part += `[data-message-author-role="${cssAttrEscape(messageRole)}"]`;
      else if (role) part += `[role="${cssAttrEscape(role)}"]`;
      else {
        const classList = Array.from(current.classList || [])
          .filter(cls => cls && !/^css-|^sc-|^_/.test(cls))
          .slice(0, 2);
        if (classList.length) part += classList.map(cls => `.${cssEscape(cls)}`).join('');
      }
      const parent = current.parentElement;
      if (parent) {
        const sameTagSiblings = Array.from(parent.children).filter(child => child.tagName === current.tagName);
        if (sameTagSiblings.length > 1 && !part.includes('[') && !part.includes('.')) {
          part += `:nth-of-type(${sameTagSiblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function buildXPath(element) {
    if (!(element instanceof Element)) return '';
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children).filter(child => child.tagName === current.tagName);
      const index = siblings.indexOf(current) + 1;
      parts.unshift(`${tag}[${index}]`);
      current = parent;
      if (parts.length > 10) break;
    }
    return `/html/${parts.join('/')}`;
  }

  function serializeCandidate(candidate) {
    return {
      id: candidate.id,
      score: candidate.score,
      source: candidate.source,
      reasons: candidate.reasons,
      selector: candidate.selector,
      xpath: candidate.xpath,
      descriptor: candidate.descriptor,
      hash: candidate.hash,
      textLength: candidate.text.length,
      textPreview: candidate.text.slice(0, 500),
      translated: candidate.element?.getAttribute('data-llmtt-translated') === '1'
    };
  }

  function sanitizeSettingsForLog(settings) {
    const clone = JSON.parse(JSON.stringify(settings || {}));
    if (clone.customHeaders) clone.customHeaders = '[redacted customHeaders]';
    if (clone.aiApiKey) clone.aiApiKey = '[redacted aiApiKey]';
    return clone;
  }

  function flashElement(element) {
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.classList.add('llmtt-flash');
    setTimeout(() => element.classList.remove('llmtt-flash'), 1700);
  }

  function escapeHtml(text) {
    return String(text || '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[char]));
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function cssAttrEscape(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function hashString(input) {
    let hash = 2166136261;
    const str = String(input || '');
    for (let i = 0; i < str.length; i += 1) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        runtime.runtime.sendMessage(message, response => {
          const lastError = runtime.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message));
            return;
          }
          if (!response) {
            reject(new Error('Empty extension response.'));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function normalizeError(error) {
    return error?.stack || error?.message || String(error || 'Unknown error.');
  }
})();
