// Macro tab: build macros, store them on the keyboard and bind them to a key.
// The keyboard runs the macro itself, so it works with the app closed.

import { invoke, isTauri } from '@tauri-apps/api/core';
import { codeToHid, keyLabel } from './hidCodes.js';

const STORAGE_KEY = 'rampage-macros';
const MACRO_SLOTS = 50;
const MAX_BYTES = 255;
const DEFAULT_DELAY_MS = 20;
const MODES = {
  repeat: 'Tekrarla',
  toggle: 'Aç / kapat',
  hold: 'Basılı tutarken'
};

const ui = {
  macros: loadMacros(),
  editing: null,
  recording: false,
  pickingKey: false,
  busy: false,
  message: null
};

let rerender = () => {};
let beforeOpen = () => {};
let takenByOthers = () => [];
let onRestored = () => {};
let lastEventAt = 0;

function loadMacros() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ui.macros));
  } catch (e) { /* storage unavailable: macros stay in memory */ }
}

export function initMacros(options) {
  rerender = options.rerender;
  beforeOpen = options.beforeOpen || beforeOpen;
  takenByOthers = options.takenKeys || takenByOthers;
  onRestored = options.onRestored || onRestored;
}

export function macroKeys() {
  return ui.macros.map(m => m.key);
}

export function cancelMacroEdit() {
  ui.editing = null;
  ui.recording = false;
  ui.pickingKey = false;
}

// ── Key picking (the main keyboard view forwards clicks here) ────────────────

export function isPickingKey() {
  return ui.pickingKey && ui.editing !== null;
}

export function pickKey(code) {
  ui.editing.key = code;
  ui.pickingKey = false;
  rerender();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function byteSize(events) {
  return 2 + events.reduce((n, e) => n + (e.delay <= 127 ? 2 : 4), 0);
}

function summary(events) {
  const downs = events.filter(e => e.down).map(e => keyLabel(e.code));
  const text = downs.slice(0, 6).join(' ');
  return downs.length > 6 ? `${text} …` : text;
}

function freeSlot(ownId) {
  const used = new Set(ui.macros.filter(m => m.id !== ownId && m.slot !== undefined).map(m => m.slot));
  for (let i = 0; i < MACRO_SLOTS; i++) {
    if (!used.has(i)) return i;
  }
  return null;
}

function validate(m) {
  if (!m.name.trim()) return 'Makroya bir ad verin.';
  if (!m.key) return 'Makroyu tetikleyecek tuşu seçin.';
  if (takenByOthers().includes(m.key)) {
    return `${keyLabel(m.key)} tuşuna tuş ataması yapılmış; önce atamayı silin.`;
  }
  if (ui.macros.some(o => o.id !== m.id && o.key === m.key)) {
    return `${keyLabel(m.key)} tuşu başka bir makroya atanmış.`;
  }
  if (m.events.length === 0) return 'Makroya en az bir tuş kaydedin.';
  const held = {};
  for (const e of m.events) held[e.code] = (held[e.code] || 0) + (e.down ? 1 : -1);
  const stuck = Object.keys(held).find(code => held[code] > 0);
  if (stuck) return `${keyLabel(stuck)} tuşu basılı kalıyor; bırakma olayı yok.`;
  if (byteSize(m.events) > MAX_BYTES) return 'Makro çok uzun. Bazı olayları silin ya da gecikmeleri 127 ms altında tutun.';
  if (m.mode === 'repeat' && !(m.repeat >= 1 && m.repeat <= 65535)) return 'Tekrar sayısı 1 ile 65535 arasında olmalı.';
  if (freeSlot(m.id) === null && m.slot === undefined) return 'Klavyedeki 50 makro yuvası dolu.';
  return null;
}

function toPayload(m) {
  return {
    keyCode: m.key,
    slot: m.slot,
    mode: m.mode,
    repeatCount: m.mode === 'repeat' ? m.repeat : 1,
    events: m.events.map(e => ({ hid: codeToHid(e.code), down: e.down, delayMs: e.delay }))
  };
}

function say(ok, text) {
  ui.message = { ok, text };
}

// ── Rendering ────────────────────────────────────────────────────────────────

function eventsHtml(events) {
  if (events.length === 0) {
    return `<div class="macro-empty">Henüz olay yok. "Kaydı başlat"a basıp tuşlara basın.</div>`;
  }
  return events.map((e, i) => `
    <div class="macro-event">
      <span class="macro-event-key ${e.down ? '' : 'up'}">${e.down ? '↓' : '↑'} ${escapeHtml(keyLabel(e.code))}</span>
      <input type="number" class="macro-input macro-delay" min="1" max="65535" value="${e.delay}" data-event-delay="${i}">
      <span class="macro-unit">ms</span>
      <button class="macro-event-del" data-event-del="${i}" title="Sil">✕</button>
    </div>
  `).join('');
}

function editorHtml(m) {
  const size = byteSize(m.events);
  return `
    <div class="macro-editor">
      <div class="form-group">
        <div class="form-label"><span>Ad</span></div>
        <input type="text" class="macro-input" id="macro-name" maxlength="40" value="${escapeHtml(m.name)}" placeholder="Örn. Hızlı kopyala">
      </div>

      <div class="macro-editor-row">
        <div class="form-group">
          <div class="form-label"><span>Tetikleyen tuş</span></div>
          <button class="btn-secondary macro-pick ${ui.pickingKey ? 'picking' : ''}" id="btn-macro-pick">
            ${ui.pickingKey ? 'Bir tuşa tıklayın veya basın…' : (m.key ? escapeHtml(keyLabel(m.key)) : 'Tuş seç')}
          </button>
        </div>
        <div class="form-group">
          <div class="form-label"><span>Çalışma şekli</span></div>
          <select class="macro-input" id="macro-mode">
            ${Object.entries(MODES).map(([k, v]) => `<option value="${k}" ${m.mode === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
        ${m.mode === 'repeat' ? `
          <div class="form-group">
            <div class="form-label"><span>Tekrar</span></div>
            <input type="number" class="macro-input" id="macro-repeat" min="1" max="65535" value="${m.repeat}">
          </div>` : ''}
      </div>

      <div class="form-group">
        <div class="form-label">
          <span>Olaylar</span>
          <span id="macro-size" class="${size > MAX_BYTES ? 'macro-size-over' : ''}">${size} / ${MAX_BYTES} bayt</span>
        </div>
        <div class="macro-toolbar">
          <button class="btn-secondary macro-rec ${ui.recording ? 'recording' : ''}" id="btn-macro-record">
            ${ui.recording ? 'Kaydı durdur' : 'Kaydı başlat'}
          </button>
          <button class="btn-secondary" id="btn-macro-clear-events">Olayları temizle</button>
        </div>
        <div class="macro-events" id="macro-events">${eventsHtml(m.events)}</div>
      </div>

      <div class="macro-actions">
        <button class="btn-primary" id="btn-macro-save" ${ui.busy ? 'disabled' : ''}>Kaydet ve klavyeye yaz</button>
        <button class="btn-secondary" id="btn-macro-cancel" ${ui.busy ? 'disabled' : ''}>Vazgeç</button>
      </div>
    </div>
  `;
}

function listHtml() {
  if (ui.macros.length === 0) {
    return `<div class="macro-empty">Henüz makro yok. Makro klavyenin belleğine yazılır ve uygulama kapalıyken de çalışır.</div>`;
  }
  return `
    <div class="macro-list">
      ${ui.macros.map(m => `
        <div class="macro-item">
          <div class="macro-item-main">
            <div class="macro-item-name">${escapeHtml(m.name)}</div>
            <div class="macro-item-sub">${MODES[m.mode]}${m.mode === 'repeat' && m.repeat > 1 ? ` × ${m.repeat}` : ''} · <code>${escapeHtml(summary(m.events))}</code></div>
          </div>
          <span class="macro-state ${m.synced ? 'on' : ''}">${m.synced ? 'Klavyede' : 'Yazılmadı'}</span>
          <div class="macro-key-badge">${escapeHtml(keyLabel(m.key))}</div>
          <div class="macro-item-actions">
            ${m.synced ? '' : `<button class="btn-secondary" data-macro-sync="${m.id}" ${ui.busy ? 'disabled' : ''}>Yaz</button>`}
            <button class="btn-secondary" data-macro-edit="${m.id}" ${ui.busy ? 'disabled' : ''}>Düzenle</button>
            <button class="btn-secondary" data-macro-delete="${m.id}" ${ui.busy ? 'disabled' : ''}>Sil</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

export function renderMacrosTab() {
  const msg = ui.message
    ? `<div class="macro-message ${ui.message.ok ? 'ok' : 'error'}">${escapeHtml(ui.message.text)}</div>` : '';
  return `
    <div class="glass-card">
      <div class="section-header">
        <div class="section-title">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          Makrolar
        </div>
        ${ui.editing ? '' : `<button class="btn-primary" id="btn-add-macro" ${ui.busy ? 'disabled' : ''}>+ Makro Ekle</button>`}
      </div>
      ${ui.busy ? `<div class="macro-message info">Klavyeye yazılıyor, yaklaşık 15 saniye sürer. Klavyeye dokunmayın.</div>` : msg}
      ${ui.editing ? editorHtml(ui.editing) : listHtml()}
      ${ui.editing ? '' : `
        <div class="macro-footer">
          <span>Bir tuşa atanan makro, tuşun eski işlevinin yerini alır. Silince tuş eski haline döner.</span>
          <button class="btn-secondary" id="btn-macro-restore" ${ui.busy ? 'disabled' : ''}>Tüm tuşları ilk haline döndür</button>
        </div>`}
    </div>
  `;
}

// ── Actions ──────────────────────────────────────────────────────────────────

function newMacro() {
  return { id: crypto.randomUUID(), name: '', key: null, mode: 'repeat', repeat: 1, events: [], synced: false };
}

async function writeToKeyboard(m, previous) {
  if (!isTauri()) {
    say(false, 'Tarayıcı önizlemesinde klavyeye yazılamaz. Makro yalnızca kaydedildi.');
    persist();
    rerender();
    return;
  }
  ui.busy = true;
  rerender();
  try {
    if (previous && previous.synced && previous.key !== m.key) {
      const cleared = await invoke('clear_macro_key', { keyCode: previous.key });
      if (!cleared.success) throw new Error(cleared.message);
    }
    const result = await invoke('assign_macro', { payload: toPayload(m) });
    m.synced = !!result.success;
    say(result.success, result.message);
  } catch (e) {
    m.synced = false;
    say(false, typeof e === 'string' ? e : (e.message || 'Klavyeye yazılamadı.'));
  }
  ui.busy = false;
  persist();
  rerender();
}

async function saveEditing() {
  const m = ui.editing;
  const error = validate(m);
  if (error) {
    say(false, error);
    rerender();
    return;
  }
  if (m.slot === undefined) m.slot = freeSlot(m.id);
  const index = ui.macros.findIndex(o => o.id === m.id);
  const previous = index >= 0 ? { ...ui.macros[index] } : null;
  m.synced = false;
  if (index >= 0) ui.macros[index] = m; else ui.macros.push(m);
  persist();
  ui.editing = null;
  ui.recording = false;
  ui.pickingKey = false;
  await writeToKeyboard(m, previous);
}

async function deleteMacro(id) {
  const m = ui.macros.find(o => o.id === id);
  if (!m || !confirm(`"${m.name}" makrosu silinsin mi?`)) return;
  if (m.synced && isTauri()) {
    ui.busy = true;
    rerender();
    try {
      const result = await invoke('clear_macro_key', { keyCode: m.key });
      if (!result.success) throw new Error(result.message);
    } catch (e) {
      ui.busy = false;
      say(false, `Tuş eski haline döndürülemedi, makro silinmedi: ${typeof e === 'string' ? e : e.message}`);
      rerender();
      return;
    }
    ui.busy = false;
  }
  ui.macros = ui.macros.filter(o => o.id !== id);
  persist();
  say(true, 'Makro silindi.');
  rerender();
}

async function restoreDefaults() {
  if (!isTauri()) return;
  if (!confirm('Klavyedeki tüm tuş atamaları uygulamayı ilk kullandığınızdaki haline dönsün mü?')) return;
  ui.busy = true;
  rerender();
  try {
    const result = await invoke('restore_key_defaults');
    if (result.success) {
      ui.macros.forEach(m => { m.synced = false; });
      onRestored();
    }
    say(result.success, result.message);
  } catch (e) {
    say(false, typeof e === 'string' ? e : (e.message || 'Geri yüklenemedi.'));
  }
  ui.busy = false;
  persist();
  rerender();
}

function refreshEvents() {
  const m = ui.editing;
  const list = document.getElementById('macro-events');
  if (!list) return;
  list.innerHTML = eventsHtml(m.events);
  bindEventRows();
  const size = document.getElementById('macro-size');
  if (size) {
    const bytes = byteSize(m.events);
    size.textContent = `${bytes} / ${MAX_BYTES} bayt`;
    size.className = bytes > MAX_BYTES ? 'macro-size-over' : '';
  }
  list.scrollTop = list.scrollHeight;
}

function bindEventRows() {
  document.querySelectorAll('[data-event-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      ui.editing.events.splice(Number(btn.dataset.eventDel), 1);
      refreshEvents();
    });
  });
  document.querySelectorAll('[data-event-delay]').forEach(input => {
    input.addEventListener('change', () => {
      const value = Math.round(Number(input.value));
      const delay = Math.min(65535, Math.max(1, Number.isFinite(value) ? value : DEFAULT_DELAY_MS));
      ui.editing.events[Number(input.dataset.eventDelay)].delay = delay;
      refreshEvents();
    });
  });
}

// Keys pressed while recording become events; the gap before the next event is
// stored as the delay of the previous one.
function onRecordKey(e, down) {
  if (ui.pickingKey && ui.editing && !ui.recording) {
    if (down && !e.repeat && codeToHid(e.code) !== undefined && !e.target.matches?.('input, select, textarea')) {
      e.preventDefault();
      e.stopPropagation();
      pickKey(e.code);
    }
    return;
  }
  if (!ui.recording || !ui.editing) return;
  const hid = codeToHid(e.code);
  if (hid === undefined) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return;
  const now = performance.now();
  const events = ui.editing.events;
  if (events.length > 0) {
    events[events.length - 1].delay = Math.min(65535, Math.max(1, Math.round(now - lastEventAt)));
  }
  events.push({ code: e.code, down, delay: DEFAULT_DELAY_MS });
  lastEventAt = now;
  refreshEvents();
}

window.addEventListener('keydown', e => onRecordKey(e, true), true);
window.addEventListener('keyup', e => onRecordKey(e, false), true);

export function bindMacrosTab() {
  const on = (id, handler) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', handler);
  };

  on('btn-add-macro', () => {
    beforeOpen();
    ui.editing = newMacro();
    ui.pickingKey = true;
    ui.message = null;
    rerender();
  });

  on('btn-macro-cancel', () => {
    ui.editing = null;
    ui.recording = false;
    ui.pickingKey = false;
    rerender();
  });

  on('btn-macro-save', saveEditing);
  on('btn-macro-restore', restoreDefaults);

  on('btn-macro-pick', () => {
    ui.pickingKey = !ui.pickingKey;
    ui.recording = false;
    rerender();
  });

  on('btn-macro-record', () => {
    ui.recording = !ui.recording;
    ui.pickingKey = false;
    lastEventAt = performance.now();
    if (ui.recording && document.activeElement) document.activeElement.blur();
    rerender();
  });

  on('btn-macro-clear-events', () => {
    ui.editing.events = [];
    refreshEvents();
  });

  const name = document.getElementById('macro-name');
  if (name) name.addEventListener('input', () => { ui.editing.name = name.value; });

  const mode = document.getElementById('macro-mode');
  if (mode) {
    mode.addEventListener('change', () => {
      ui.editing.mode = mode.value;
      rerender();
    });
  }

  const repeat = document.getElementById('macro-repeat');
  if (repeat) repeat.addEventListener('input', () => { ui.editing.repeat = Math.round(Number(repeat.value)) || 1; });

  bindEventRows();

  document.querySelectorAll('[data-macro-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = ui.macros.find(o => o.id === btn.dataset.macroEdit);
      if (!m) return;
      beforeOpen();
      ui.editing = JSON.parse(JSON.stringify(m));
      ui.message = null;
      rerender();
    });
  });

  document.querySelectorAll('[data-macro-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteMacro(btn.dataset.macroDelete));
  });

  document.querySelectorAll('[data-macro-sync]').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = ui.macros.find(o => o.id === btn.dataset.macroSync);
      if (m) writeToKeyboard(m, null);
    });
  });
}
