// Key remapping: make one key press another key or a combination (up to 3 keys).
// Stored on the keyboard itself, so it works without the app.

import { invoke, isTauri } from '@tauri-apps/api/core';
import { KEYBOARD_LAYOUTS } from './layouts.js';
import { codeToHid, hidToCode, keyLabel } from './hidCodes.js';

const STORAGE_KEY = 'rampage-remaps';
const MAX_KEYS = 3;

const ui = {
  remaps: loadRemaps(),
  editing: null,
  // null | 'source' (choosing the key to remap) | 'target' (entering what it should press)
  mode: null,
  busy: false,
  message: null
};

let rerender = () => {};
let beforeOpen = () => {};
let takenByOthers = () => [];

// Keys captured while entering the target
let captured = [];

function loadRemaps() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ui.remaps));
  } catch (e) { /* storage unavailable: remaps stay in memory */ }
}

export function initRemap(options) {
  rerender = options.rerender;
  beforeOpen = options.beforeOpen || beforeOpen;
  takenByOthers = options.takenKeys || takenByOthers;
}

export function remapKeys() {
  return ui.remaps.map(r => r.key);
}

export function markRemapsUnsynced() {
  ui.remaps.forEach(r => { r.synced = false; });
  persist();
}

export function cancelRemapEdit() {
  ui.editing = null;
  ui.mode = null;
  captured = [];
  clearTimeout(captureTimer);
}

function allLayoutCodes() {
  return Object.values(KEYBOARD_LAYOUTS).flat(2).map(k => k.code);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function comboLabel(codes) {
  return codes.map(keyLabel).join(' + ');
}

function say(ok, text) {
  ui.message = { ok, text };
}

function errorText(e, fallback) {
  return typeof e === 'string' ? e : (e && e.message) || fallback;
}

function validate(r) {
  if (!r.key) return 'Atanacak tuşu seçin.';
  if (r.keys.length === 0) return 'Tuşun yapacağı işlevi girin.';
  if (r.keys.length === 1 && r.keys[0] === r.key) return 'Tuş kendisine atanamaz.';
  if (takenByOthers().includes(r.key)) return `${keyLabel(r.key)} tuşuna makro atanmış; önce makroyu silin.`;
  if (ui.remaps.some(o => o.id !== r.id && o.key === r.key)) return `${keyLabel(r.key)} tuşu için zaten bir atama var.`;
  return null;
}

// ── Key clicks from the on-screen keyboard ───────────────────────────────────

/** Returns true when the click was used by the remap editor. */
export function handleRemapKeyClick(code) {
  if (!ui.editing || !ui.mode) return false;
  if (ui.mode === 'source') {
    ui.editing.key = code;
    ui.mode = null;
    rerender();
    return true;
  }
  if (codeToHid(code) === undefined) {
    say(false, `${keyLabel(code)} tuşu atama hedefi olamaz (Fn/medya tuşu).`);
    rerender();
    return true;
  }
  addTargetKey(code);
  rerender();
  return true;
}

function addTargetKey(code) {
  const keys = ui.editing.keys;
  if (keys.includes(code) || keys.length >= MAX_KEYS) return;
  keys.push(code);
}

// ── Physical-key capture for the target ──────────────────────────────────────
// Keys pressed together become the combo. The entry ends when the first key is
// released, or 1.2 s after the last press in case a release is never seen.

const CAPTURE_TIMEOUT_MS = 1200;
let captureTimer = null;

function finishCapture() {
  clearTimeout(captureTimer);
  captureTimer = null;
  if (ui.mode !== 'target' || !ui.editing) return;
  if (captured.length > 0) ui.editing.keys = captured.slice();
  captured = [];
  ui.mode = null;
  rerender();
}

function showCaptured() {
  const box = document.querySelector('.remap-keys');
  if (box) box.innerHTML = chips(captured);
}

function onKeyDown(e) {
  if (!ui.mode || !ui.editing || e.repeat) return;
  if (e.target.matches?.('input, select, textarea')) return;
  if (codeToHid(e.code) === undefined) return;
  e.preventDefault();
  e.stopPropagation();
  if (ui.mode === 'source') {
    // Only keys that exist on the board can be remapped.
    if (allLayoutCodes().includes(e.code)) {
      ui.editing.key = e.code;
      ui.mode = null;
      rerender();
    }
    return;
  }
  if (!captured.includes(e.code) && captured.length < MAX_KEYS) captured.push(e.code);
  showCaptured();
  clearTimeout(captureTimer);
  captureTimer = setTimeout(finishCapture, CAPTURE_TIMEOUT_MS);
}

function onKeyUp(e) {
  if (ui.mode !== 'target' || !ui.editing || !captured.includes(e.code)) return;
  e.preventDefault();
  e.stopPropagation();
  finishCapture();
}

window.addEventListener('keydown', onKeyDown, true);
window.addEventListener('keyup', onKeyUp, true);

// ── Rendering ────────────────────────────────────────────────────────────────

function chips(codes) {
  if (codes.length === 0) return '<span class="remap-placeholder">Henüz girilmedi</span>';
  return codes.map(c => `<span class="remap-chip">${escapeHtml(keyLabel(c))}</span>`).join('<span class="remap-plus">+</span>');
}

function editorHtml(r) {
  return `
    <div class="macro-editor">
      <div class="macro-editor-row">
        <div class="form-group">
          <div class="form-label"><span>Atanacak tuş</span></div>
          <button class="btn-secondary macro-pick ${ui.mode === 'source' ? 'picking' : ''}" id="btn-remap-source">
            ${ui.mode === 'source' ? 'Bir tuşa tıklayın veya basın…' : (r.key ? escapeHtml(keyLabel(r.key)) : 'Tuş seç')}
          </button>
        </div>
        <div class="form-group remap-target">
          <div class="form-label"><span>Yapacağı işlev</span><span>${r.keys.length} / ${MAX_KEYS} tuş</span></div>
          <div class="remap-keys ${ui.mode === 'target' ? 'picking' : ''}">${chips(r.keys)}</div>
        </div>
      </div>
      <div class="macro-toolbar">
        <button class="btn-secondary macro-rec ${ui.mode === 'target' ? 'recording' : ''}" id="btn-remap-target">
          ${ui.mode === 'target' ? 'Girişi bitir' : 'İşlevi gir'}
        </button>
        <button class="btn-secondary" id="btn-remap-clear-keys">Temizle</button>
      </div>
      <div class="macro-item-sub">${ui.mode === 'target'
        ? 'Klavyede tuşa ya da tuş kombinasyonuna basın veya ekrandaki tuşlara tıklayın.'
        : ui.mode === 'source'
          ? 'Daha önce atanmış bir tuşa basarsanız yeni işlevi algılanır; o durumda ekrandan tıklayın.'
          : 'Örnek: Caps → Ctrl, F9 → Ctrl + C.'}</div>
      <div class="macro-actions">
        <button class="btn-primary" id="btn-remap-save" ${ui.busy ? 'disabled' : ''}>Kaydet ve klavyeye yaz</button>
        <button class="btn-secondary" id="btn-remap-cancel" ${ui.busy ? 'disabled' : ''}>Vazgeç</button>
      </div>
    </div>
  `;
}

function listHtml() {
  if (ui.remaps.length === 0) {
    return `<div class="macro-empty">Henüz atama yok. Bir tuşu başka bir tuşa ya da kombinasyona çevirebilirsiniz.</div>`;
  }
  return `
    <div class="macro-list">
      ${ui.remaps.map(r => `
        <div class="macro-item">
          <div class="macro-item-main">
            <div class="macro-item-name">${escapeHtml(keyLabel(r.key))} → ${escapeHtml(comboLabel(r.keys))}</div>
          </div>
          <span class="macro-state ${r.synced ? 'on' : ''}">${r.synced ? 'Klavyede' : 'Yazılmadı'}</span>
          <div class="macro-item-actions">
            ${r.synced ? '' : `<button class="btn-secondary" data-remap-sync="${r.id}" ${ui.busy ? 'disabled' : ''}>Yaz</button>`}
            <button class="btn-secondary" data-remap-edit="${r.id}" ${ui.busy ? 'disabled' : ''}>Düzenle</button>
            <button class="btn-secondary" data-remap-delete="${r.id}" ${ui.busy ? 'disabled' : ''}>Sil</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

export function renderRemapCard() {
  const msg = ui.message
    ? `<div class="macro-message ${ui.message.ok ? 'ok' : 'error'}">${escapeHtml(ui.message.text)}</div>` : '';
  return `
    <div class="glass-card">
      <div class="section-header">
        <div class="section-title">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3l4 4-4 4M3 7h18M7 21l-4-4 4-4M21 17H3"/></svg>
          Tuş Atama
        </div>
        ${ui.editing ? '' : `
          <div class="macro-item-actions">
            <button class="btn-secondary" id="btn-remap-read" ${ui.busy ? 'disabled' : ''}>Klavyeden oku</button>
            <button class="btn-primary" id="btn-add-remap" ${ui.busy ? 'disabled' : ''}>+ Atama Ekle</button>
          </div>`}
      </div>
      ${ui.busy ? `<div class="macro-message info">Klavyeyle konuşuluyor, yaklaşık 15 saniye sürer. Klavyeye dokunmayın.</div>` : msg}
      ${ui.editing ? editorHtml(ui.editing) : listHtml()}
    </div>
  `;
}

// ── Actions ──────────────────────────────────────────────────────────────────

function toHidList(codes) {
  return codes.map(codeToHid);
}

async function writeToKeyboard(r, previous) {
  if (!isTauri()) {
    say(false, 'Tarayıcı önizlemesinde klavyeye yazılamaz. Atama yalnızca kaydedildi.');
    persist();
    rerender();
    return;
  }
  ui.busy = true;
  rerender();
  try {
    if (previous && previous.synced && previous.key !== r.key) {
      const cleared = await invoke('clear_key_remap', { keyCode: previous.key });
      if (!cleared.success) throw new Error(cleared.message);
    }
    const result = await invoke('assign_key', { payload: { keyCode: r.key, keys: toHidList(r.keys) } });
    r.synced = !!result.success;
    say(result.success, result.message);
  } catch (e) {
    r.synced = false;
    say(false, errorText(e, 'Klavyeye yazılamadı.'));
  }
  ui.busy = false;
  persist();
  rerender();
}

async function saveEditing() {
  const r = ui.editing;
  const error = validate(r);
  if (error) {
    say(false, error);
    rerender();
    return;
  }
  const index = ui.remaps.findIndex(o => o.id === r.id);
  const previous = index >= 0 ? { ...ui.remaps[index] } : null;
  r.synced = false;
  if (index >= 0) ui.remaps[index] = r; else ui.remaps.push(r);
  persist();
  cancelRemapEdit();
  await writeToKeyboard(r, previous);
}

async function deleteRemap(id) {
  const r = ui.remaps.find(o => o.id === id);
  if (!r || !confirm(`${keyLabel(r.key)} tuşu ilk işlevine dönsün mü?`)) return;
  if (r.synced && isTauri()) {
    ui.busy = true;
    rerender();
    try {
      const result = await invoke('clear_key_remap', { keyCode: r.key });
      if (!result.success) throw new Error(result.message);
    } catch (e) {
      ui.busy = false;
      say(false, `Tuş eski haline döndürülemedi, atama silinmedi: ${errorText(e, '')}`);
      rerender();
      return;
    }
    ui.busy = false;
  }
  ui.remaps = ui.remaps.filter(o => o.id !== id);
  persist();
  say(true, 'Atama silindi.');
  rerender();
}

// Add remaps found on the keyboard that the app does not know about, and
// refresh which known ones are really there.
async function readFromKeyboard() {
  if (!isTauri()) {
    say(false, 'Klavyeden okumak için masaüstü uygulaması gerekir.');
    rerender();
    return;
  }
  ui.busy = true;
  rerender();
  try {
    const found = await invoke('read_remapped_keys', { keyCodes: allLayoutCodes() });
    const onKeyboard = new Map(found.map(f => [f.keyCode, f.keys.map(h => hidToCode(h)).filter(Boolean)]));
    ui.remaps.forEach(r => {
      const keys = onKeyboard.get(r.key);
      r.synced = !!keys && keys.join() === r.keys.join();
    });
    let added = 0;
    onKeyboard.forEach((keys, key) => {
      if (keys.length > 0 && !ui.remaps.some(r => r.key === key)) {
        ui.remaps.push({ id: crypto.randomUUID(), key, keys, synced: true });
        added++;
      }
    });
    say(true, `Klavyede ${found.length} atama var${added ? `, ${added} tanesi listeye eklendi` : ''}.`);
  } catch (e) {
    say(false, errorText(e, 'Klavyeden okunamadı.'));
  }
  ui.busy = false;
  persist();
  rerender();
}

export function bindRemapCard() {
  const on = (id, handler) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', handler);
  };

  on('btn-add-remap', () => {
    beforeOpen();
    ui.editing = { id: crypto.randomUUID(), key: null, keys: [], synced: false };
    ui.mode = 'source';
    ui.message = null;
    rerender();
  });

  on('btn-remap-cancel', () => {
    cancelRemapEdit();
    rerender();
  });

  on('btn-remap-save', saveEditing);
  on('btn-remap-read', readFromKeyboard);

  on('btn-remap-source', () => {
    ui.mode = ui.mode === 'source' ? null : 'source';
    rerender();
  });

  on('btn-remap-target', () => {
    ui.mode = ui.mode === 'target' ? null : 'target';
    captured = [];
    clearTimeout(captureTimer);
    rerender();
  });

  on('btn-remap-clear-keys', () => {
    ui.editing.keys = [];
    rerender();
  });

  document.querySelectorAll('[data-remap-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = ui.remaps.find(o => o.id === btn.dataset.remapEdit);
      if (!r) return;
      beforeOpen();
      ui.editing = JSON.parse(JSON.stringify(r));
      ui.mode = null;
      ui.message = null;
      rerender();
    });
  });

  document.querySelectorAll('[data-remap-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteRemap(btn.dataset.remapDelete));
  });

  document.querySelectorAll('[data-remap-sync]').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = ui.remaps.find(o => o.id === btn.dataset.remapSync);
      if (r) writeToKeyboard(r, null);
    });
  });
}
