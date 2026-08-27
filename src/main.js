import './style.css';
import { KEYBOARD_LAYOUTS, DEFAULT_PRESET_COLORS } from './layouts.js';
import { HIDService } from './hidService.js';
import { RGBEngine } from './rgbEngine.js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// Application State
const state = {
  activeTab: 'rgb', // 'rgb', 'macros', 'sync', 'settings'
  selectedKey: null,
  activeEffect: 'rainbow',
  primaryColor: '#8b5cf6',
  speed: 75,
  brightness: 100,
  currentLayout: 'compact75',
  deviceConnected: false,
  deviceName: 'Rampage W-Granite (75% Türkçe Q)',
  perKeyColors: {},
  favoriteColors: JSON.parse(localStorage.getItem('aether-favorites') || '[]'),
  macros: [
    { key: 'KeyG', name: 'Hızlı Kısayol', action: 'Ctrl + C' },
    { key: 'KeyM', name: 'Müzik Başlat', action: 'MediaPlayPause' }
  ],
  systemStats: {
    cpuTemp: 42,
    cpuUsage: 28,
    ramUsage: 54
  }
};

function loadPerKeyColors() {
  try {
    const raw = JSON.parse(localStorage.getItem('aether-perkey') || '{}');
    const entries = Object.values(raw);
    if (entries.length === 0) return {};

    // Detect old broken bulk-data: if more than 15 keys share the same single color,
    // it was likely set by the old buggy WASD preset (all keys = '#1e1b4b').
    // Clear it so users start fresh.
    const colorFreq = {};
    entries.forEach(c => { colorFreq[c] = (colorFreq[c] || 0) + 1; });
    const maxFreq = Math.max(...Object.values(colorFreq));
    if (entries.length > 15 && maxFreq > 15) {
      console.log('[PerKey] Eski toplu renk verisi temizlendi (bozuk preset kalıntısı).');
      localStorage.removeItem('aether-perkey');
      return {};
    }
    return raw;
  } catch {
    return {};
  }
}

function saveFavorites() {
  localStorage.setItem('aether-favorites', JSON.stringify(state.favoriteColors));
}

function savePerKeyColors() {
  localStorage.setItem('aether-perkey', JSON.stringify(state.perKeyColors));
}

// Load and auto-clean per-key color data from localStorage
state.perKeyColors = loadPerKeyColors();

// Services
const hid = new HIDService();
window.hidService = hid;
let rgbEngine = null;
let keyElementsMap = {};

// Root Element
const app = document.getElementById('app');

// Render Complete UI Structure
function renderApp() {
  app.innerHTML = `
    <!-- Sidebar Navigation -->
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/></svg>
        </div>
        <div>
          <div class="brand-title">AetherRGB</div>
          <div class="brand-subtitle">Control Hub v1.0</div>
        </div>
      </div>

      <nav class="nav-menu">
        <div class="nav-item ${state.activeTab === 'rgb' ? 'active' : ''}" data-tab="rgb">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m12 2 a10 10 0 0 1 0 20"/></svg>
          <span>RGB Aydınlatma</span>
        </div>
        <div class="nav-item ${state.activeTab === 'macros' ? 'active' : ''}" data-tab="macros">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3z"/><path d="M6 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3z"/></svg>
          <span>Makro & Tuşlar</span>
        </div>
        <div class="nav-item ${state.activeTab === 'sync' ? 'active' : ''}" data-tab="sync">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          <span>Sistem Senkronizasyonu</span>
        </div>
        <div class="nav-item ${state.activeTab === 'settings' ? 'active' : ''}" data-tab="settings">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          <span>Cihaz Ayarları</span>
        </div>
      </nav>

      <!-- USB Status Card -->
      <div class="device-status-card">
        <div class="device-status-header">
          <span>USB Bağlantısı</span>
          <span class="status-badge ${state.deviceConnected ? 'connected' : 'disconnected'}">
            <span class="status-dot"></span>
            ${state.deviceConnected ? 'BAĞLI' : 'HAZIR'}
          </span>
        </div>
        <div class="device-name" title="${state.deviceName}">${state.deviceName}</div>
        <div id="hid-debug-log" style="font-size:0.7rem; color:var(--accent-cyan); word-break:break-all; font-family:var(--font-mono);">Hazır</div>
        <button class="btn-usb-connect" id="btn-connect-usb">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v10"/><path d="M9 12l3 3 3-3"/></svg>
          <span>USB Cihazı Bağla</span>
        </button>
        <button class="btn-secondary" id="btn-list-devices" style="width:100%; font-size:0.8rem; margin-top:6px; padding:8px;">
          🔍 HID Cihazlarını Tara
        </button>
      </div>
    </aside>

    <!-- Main Content Body -->
    <main class="main-wrapper">
      <header class="top-header">
        <div class="header-title">
          ${state.activeTab === 'rgb' ? 'RGB Aydınlatma Stüdyosu' : ''}
          ${state.activeTab === 'macros' ? 'Tuş Atamaları & Makro Yöneticisi' : ''}
          ${state.activeTab === 'sync' ? 'Sistem & Ekran Senkronizasyonu' : ''}
          ${state.activeTab === 'settings' ? 'Cihaz & Sürücü Yapılandırması' : ''}
        </div>

        <div class="header-actions">
          <div class="preset-pill" id="btn-quick-preset">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
            <span>Hızlı Profil: Oyun Modu</span>
          </div>
        </div>
      </header>

      <div class="content-area">
        <!-- Interactive 2D/3D Keyboard Simulator Canvas -->
        <section class="keyboard-stage">
          <div class="keyboard-controls-bar">
            <div style="font-weight:700; font-size:0.9rem; color:var(--text-muted); display:flex; align-items:center; gap:8px;">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/></svg>
              Klavye Canlı Önizleme & Tuş Haritası
            </div>

            <div class="layout-selector">
              <button class="layout-btn active">75% Compact (Türkçe Q)</button>
            </div>

          </div>

          <div class="keyboard-body" id="keyboard-canvas">
            ${renderKeyboardLayout()}
          </div>
        </section>

        <!-- Dynamic Tab Panel Contents -->
        <div id="tab-content">
          ${renderActiveTabContent()}
        </div>
      </div>
    </main>
  `;

  bindEvents();
  initRGBEngine();
}

function getLucideIconSvg(name) {
  const icons = {
    'sun': `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`,
    'volume-x': `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/></svg>`,
    'volume-1': `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
    'volume-2': `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`,
    'play-pause': `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 13 12 5 21 5 3"/><line x1="19" x2="19" y1="4" y2="20"/></svg>`,
    'monitor': `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>`,
    'tv': `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="20" height="15" x="2" y="7" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>`,
    'smartphone': `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="20" x="5" y="2" rx="2"/><line x1="12" x2="12.01" y1="18" y2="18"/></svg>`,
    'app-window': `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="2" x2="22" y1="9" y2="9"/><line x1="6" x2="6.01" y1="6.5" y2="6.5"/><line x1="9" x2="9.01" y1="6.5" y2="6.5"/></svg>`,
    'search': `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/></svg>`,
    'lock': `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
    'rotate-ccw': `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`,
    'delete': `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 5H9l-7 7 7 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Z"/><line x1="18" x2="12" y1="9" y2="15"/><line x1="12" x2="18" y1="9" y2="15"/></svg>`,
    'target': `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`,
    'arrow-up': `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m18 15-6-6-6 6"/></svg>`,
    'arrow-down': `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>`,
    'arrow-left': `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m15 18-6-6 6-6"/></svg>`,
    'arrow-right': `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m9 18 6-6-6-6"/></svg>`,
    'corner-down-left': `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>`
  };
  return icons[name] || '';
}

// Generate Keyboard Buttons HTML
function renderKeyboardLayout() {
  const layout = KEYBOARD_LAYOUTS[state.currentLayout] || KEYBOARD_LAYOUTS.compact75;
  return layout.map(row => `
    <div class="keyboard-row">
      ${row.map(key => {
        if (key.isIsoPlaceholder) {
          return `<div class="keycap key-iso-placeholder" data-code="EnterLower"></div>`;
        }
        return `
          <div class="keycap ${key.width || ''} ${key.isSpecial ? 'key-special' : ''} ${key.isIsoEnter ? 'key-iso-enter' : ''} ${state.selectedKey === key.code ? 'selected' : ''}" 
               data-code="${key.code}" 
               id="key-${key.code}">
            ${key.label ? `<span class="key-main">${key.label}</span>` : ''}
            ${key.icon ? `<span class="key-icon-lucide">${getLucideIconSvg(key.icon)}</span>` : ''}
            ${key.sub ? `<span class="key-sub">${key.sub}</span>` : ''}
          </div>
        `;
      }).join('')}
    </div>
  `).join('');
}




const ALL_EFFECTS = [
  { id: 'custom_per_key', name: '🎨 Tuş Bazlı Özel RGB', category: 'Özel',   desc: 'İstediğin tuşa tıkla, istediğin rengi ata!' },
  { id: 'static',         name: 'Sabit Renk',            category: 'Temel',  desc: 'Tek sabit renk' },
  { id: 'breathing',      name: 'Nefes Alma',            category: 'Dinamik',desc: 'Yavaşça sönüp parlar' },
  { id: 'spectrum',       name: 'Renk Döngüsü',          category: 'Dinamik',desc: 'Tüm spektrum döner' },
  { id: 'wave',           name: 'Dalga (Wave)',          category: 'Dalga',  desc: 'Akıcı ışık dalgaları' },
  { id: 'flow',           name: 'Akış (Flow)',           category: 'Dalga',  desc: 'Yumuşak renk akışı' },
  { id: 'ripple',         name: 'Halka (Ripple)',        category: 'Reaktif',desc: 'Merkezden yayılan dalga' },
  { id: 'radiant',        name: 'Işıma (Radiant)',       category: 'Reaktif',desc: 'Dışa doğru ışıma' },
  { id: 'loop',           name: 'Dönen Halka',           category: 'Dalga',  desc: 'Dairesel ışık dönüşü' },
  { id: 'stardots',       name: 'Yıldız Parıltısı',      category: 'Özel',   desc: 'Rastgele parıldayan tuşlar' },
  { id: 'meteor',         name: 'Meteor Yağmuru',        category: 'Özel',   desc: 'Hızlıca kayan ışık izi' },
  { id: 'snowfall',       name: 'Kar Yağışı',            category: 'Özel',   desc: 'Aşağı süzülen ışıklar' },
  { id: 'silentsnow',     name: 'Sakin Kar',             category: 'Özel',   desc: 'Yavaş kar tanesi ışıltısı' },
  { id: 'keyshadow',      name: 'Tuş İzi (Shadow)',      category: 'Reaktif',desc: 'Basılan tuş iz bırakır' },
  { id: 'layers',         name: 'Katmanlar',             category: 'Dinamik',desc: 'İç içe geçen ışık katmanları' },
  { id: 'sine',           name: 'Sinüs Dalgası',         category: 'Dalga',  desc: 'Sinüzoidal ışık hareketi' },
  { id: 'spring',         name: 'Püskürme (Spring)',     category: 'Özel',   desc: 'Patlayan ışık sıçramaları' },
  { id: 'neon',           name: 'Neon Akımı',            category: 'Dinamik',desc: 'Canlı neon renk geçişi' },
  { id: 'colorgrid',      name: 'Renk Izgarası',         category: 'Özel',   desc: 'Kare ızgara desenleri' },
  { id: 'off',            name: 'Işıkları Kapat',        category: 'Temel',  desc: 'Tüm aydınlatmayı söndürür' }
];


// Active Tab Views
function renderActiveTabContent() {
  if (state.activeTab === 'rgb') {
    return `
      <div class="control-grid">
        <!-- Effects Card -->
        <div class="glass-card">
          <div class="section-header">
            <div class="section-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
              Donanım Aydınlatma Modları (${ALL_EFFECTS.length})
            </div>
            <div class="color-mode-toggle">
              <button class="mode-pill ${state.colorType === 'rainbow' ? 'active' : ''}" id="btn-mode-rainbow">🌈 Gökkuşağı</button>
              <button class="mode-pill ${state.colorType === 'custom' ? 'active' : ''}" id="btn-mode-custom">🎨 Özel Renk</button>
            </div>
          </div>

          <div class="effect-selector-list" style="max-height: 380px; overflow-y: auto; padding-right: 4px;">
            ${ALL_EFFECTS.map(eff => `
              <button class="effect-btn ${state.activeEffect === eff.id ? 'active' : ''}" data-effect="${eff.id}" title="${eff.desc}">
                <div style="display:flex; flex-direction:column; align-items:flex-start; gap:2px; text-align:left;">
                  <span style="font-weight:700; font-size:0.86rem;">${eff.name}</span>
                  <span style="font-size:0.72rem; color:var(--text-muted); font-weight:400;">${eff.desc}</span>
                </div>
              </button>
            `).join('')}
          </div>

          <!-- Direction Selection for Wave/Flow modes -->
          <div class="form-group" style="margin-top: 14px;">
            <div class="form-label">
              <span>Efekt Yönü</span>
              <span id="lbl-dir-val">${['Sola', 'Sağa', 'Yukarı', 'Aşağı'][state.direction || 0]}</span>
            </div>
            <div class="direction-btn-group">
              <button class="btn-dir ${(state.direction || 0) === 0 ? 'active' : ''}" data-dir="0">← Sola</button>
              <button class="btn-dir ${(state.direction || 0) === 1 ? 'active' : ''}" data-dir="1">Sağa →</button>
              <button class="btn-dir ${(state.direction || 0) === 2 ? 'active' : ''}" data-dir="2">↑ Yukarı</button>
              <button class="btn-dir ${(state.direction || 0) === 3 ? 'active' : ''}" data-dir="3">↓ Aşağı</button>
            </div>
          </div>
        </div>

        <!-- Custom Color & Fine Tuning -->
        <div class="glass-card">
          <div class="section-header">
            <div class="section-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m12 2 a10 10 0 0 1 0 20"/></svg>
              Renk, Hız ve Parlaklık
            </div>
          </div>

          <div class="form-group">
            <div class="form-label">
              <span>Ana Renk Paleti</span>
              <span id="lbl-color-val" style="font-family:var(--font-mono); color:var(--primary); font-weight:700;">${state.primaryColor}</span>
            </div>
            <div class="color-picker-wrapper">
              <input type="color" class="color-input-custom" id="color-picker" value="${state.primaryColor}">
              <div class="color-palette">
                ${DEFAULT_PRESET_COLORS.map(c => `
                  <div class="color-swatch ${state.primaryColor === c ? 'active' : ''}" style="background:${c};" data-color="${c}"></div>
                `).join('')}
              </div>
            </div>
            <button class="btn-add-favorite" id="btn-add-favorite" title="Mevcut rengi favorilere ekle">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
              Favorilere Ekle
            </button>
          </div>

          ${state.favoriteColors.length > 0 ? `
          <div class="form-group" style="margin-top:16px;">
            <div class="form-label">
              <span>❤ Favori Renklerim</span>
              <span style="font-size:0.72rem; color:var(--text-muted);">${state.favoriteColors.length}/12</span>
            </div>
            <div class="color-palette" style="flex-wrap:wrap;">
              ${state.favoriteColors.map((c, i) => `
                <div class="color-swatch favorite-swatch ${state.primaryColor === c ? 'active' : ''}" style="background:${c}; position:relative;" data-color="${c}" data-fav-index="${i}" title="${c}">
                  <span class="fav-remove" data-fav-index="${i}" title="Kaldır">✕</span>
                </div>
              `).join('')}
            </div>
          </div>` : ''}

          <div class="form-group" style="margin-top:20px;">
            <div class="form-label">
              <span>Efekt Hızı</span>
              <span id="lbl-speed-val">${state.speed || 75}%</span>
            </div>
            <input type="range" min="25" max="100" step="25" value="${state.speed || 75}" class="range-slider" id="slider-speed">
          </div>


          <div class="form-group">
            <div class="form-label">
              <span>Parlaklık Seviyesi</span>
              <span id="lbl-brightness-val">${state.brightness ?? 100}%</span>
            </div>
            <input type="range" min="0" max="100" step="25" value="${state.brightness ?? 100}" class="range-slider" id="slider-brightness">
          </div>


          <!-- Custom Per-Key RGB Tools -->
          <div class="form-group" style="margin-top: 16px; padding: 12px; background: rgba(139, 92, 246, 0.08); border: 1px solid rgba(139, 92, 246, 0.2); border-radius: var(--radius-sm);">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
              <span style="font-weight:700; font-size:0.8rem; color:var(--primary-hover); display:flex; align-items:center; gap:6px;">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                Tuş Bazlı Özel RGB Modu
              </span>
              ${state.activeEffect === 'custom_per_key' ? `<span style="font-size:0.7rem; background:var(--primary); color:#fff; padding:2px 6px; border-radius:4px; font-weight:700;">AKTİF</span>` : ''}
            </div>
            <p class="per-key-selected-info" style="font-size:0.72rem; color:var(--text-muted); margin-bottom:10px; line-height:1.4;">
              ${state.selectedKey ? `Seçili Tuş: <strong style="color:var(--text-main); font-family:var(--font-mono);">${state.selectedKey}</strong> — Rengi tıklayarak bu tuşa ata!` : `Yukarıdaki klavyeden <strong>herhangi bir tuşa tıkla</strong>, ardından paletten rengini belirle.`}
            </p>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              <button class="btn-sm-tool" id="btn-apply-per-key" style="background:var(--primary); color:#fff; border:none; padding:6px 12px; border-radius:4px; font-size:0.72rem; font-weight:700; cursor:pointer;">
                ${state.activeEffect === 'custom_per_key' ? '✓ Özel RGB Modunu Uygula' : '▶ Özel RGB Moduna Geç'}
              </button>
              <button class="btn-sm-tool" id="btn-preset-wasd" style="background:#1e2330; color:var(--text-main); border:1px solid var(--border); padding:6px 10px; border-radius:4px; font-size:0.72rem; cursor:pointer;">
                🎮 WASD + Oklar
              </button>
              <button class="btn-sm-tool" id="btn-reset-per-key" style="background:#1e2330; color:var(--text-dim); border:1px solid var(--border); padding:6px 10px; border-radius:4px; font-size:0.72rem; cursor:pointer;">
                Sıfırla
              </button>
            </div>
          </div>

          <!-- Edge/Side RGB Controls -->
          <div class="form-group" style="margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--border-color);">
            <div class="form-label">
              <span>Yan / Kenar Işık (Edge Light)</span>
              <span id="lbl-side-val" style="font-size:0.75rem; color:var(--accent-cyan);">Aktif</span>
            </div>
            <div class="direction-btn-group">
              <button class="btn-side-mode ${(state.sideMode || 1) === 0 ? 'active' : ''}" data-side="0">Kapalı</button>
              <button class="btn-side-mode ${(state.sideMode || 1) === 1 ? 'active' : ''}" data-side="1">Sabit</button>
              <button class="btn-side-mode ${(state.sideMode || 1) === 2 ? 'active' : ''}" data-side="2">Nefes</button>
              <button class="btn-side-mode ${(state.sideMode || 1) === 3 ? 'active' : ''}" data-side="3">Spektrum</button>
              <button class="btn-side-mode ${(state.sideMode || 1) === 4 ? 'active' : ''}" data-side="4">Dalga</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }



  if (state.activeTab === 'macros') {
    return `
      <div class="glass-card">
        <div class="section-header">
          <div class="section-title">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3z"/></svg>
            Aktif Tuş Makroları
          </div>
          <button class="btn-primary" id="btn-add-macro">+ Yeni Makro Ekle</button>
        </div>

        <div class="macro-list">
          ${state.macros.map(m => `
            <div class="macro-item">
              <div>
                <div style="font-weight:700; font-size:0.95rem;">${m.name}</div>
                <div style="font-size:0.8rem; color:var(--text-muted); margin-top:2px;">Eylem: ${m.action}</div>
              </div>
              <div class="macro-key-badge">Tuş: ${m.key}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  if (state.activeTab === 'sync') {
    return `
      <div class="glass-card">
        <div class="section-header">
          <div class="section-title">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
            Canlı Donanım Isı & Kullanım Durumu
          </div>
        </div>

        <div style="display:flex; flex-direction:column; gap:16px;">
          <div class="sys-stat-box">
            <div style="font-weight:600; width:120px;">CPU Sıcaklığı</div>
            <div class="sys-stat-bar">
              <div class="sys-stat-progress" style="width: ${state.systemStats.cpuTemp}%;"></div>
            </div>
            <div style="font-family:var(--font-mono); font-weight:700; color:var(--accent-cyan);">${state.systemStats.cpuTemp}°C</div>
          </div>

          <div class="sys-stat-box">
            <div style="font-weight:600; width:120px;">CPU Kullanımı</div>
            <div class="sys-stat-bar">
              <div class="sys-stat-progress" style="width: ${state.systemStats.cpuUsage}%; background:linear-gradient(to right, var(--accent-green), var(--accent-amber));"></div>
            </div>
            <div style="font-family:var(--font-mono); font-weight:700; color:var(--accent-amber);">${state.systemStats.cpuUsage}%</div>
          </div>

          <div class="sys-stat-box">
            <div style="font-weight:600; width:120px;">RAM Bellek</div>
            <div class="sys-stat-bar">
              <div class="sys-stat-progress" style="width: ${state.systemStats.ramUsage}%; background:linear-gradient(to right, var(--primary), var(--accent-pink));"></div>
            </div>
            <div style="font-family:var(--font-mono); font-weight:700; color:var(--accent-pink);">${state.systemStats.ramUsage}%</div>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="glass-card">
      <div class="section-header">
        <div class="section-title">Cihaz & HID Yazılım Bilgisi</div>
      </div>
      <p style="color:var(--text-muted); font-size:0.9rem; line-height:1.6;">
        AetherRGB, standart USB HID protokollü klavyeler ile doğrudan haberleşir. Bilgisayarınıza takılı olan herhangi bir USB klavyeyi otomatik olarak algılayıp renk komutlarını donanım katmanına aktarır.
      </p>
    </div>
  `;
}

// Bind DOM Click & Input Listeners
function bindEvents() {
  // Navigation Tabs
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => {
      state.activeTab = el.getAttribute('data-tab');
      renderApp();
    });
  });

  // USB Connect Button
  const btnConnect = document.getElementById('btn-connect-usb');
  if (btnConnect) {
    btnConnect.addEventListener('click', async () => {
      const res = await hid.connectHID();
      if (res.success) {
        state.deviceConnected = true;
        state.deviceName = res.deviceName || 'USB Klavye (Sürücüsüz Otomatik Algılandı)';
        renderApp();
      }
    });
  }

  // HID Device Lister (Diagnostic)
  const btnListDevices = document.getElementById('btn-list-devices');
  if (btnListDevices) {
    btnListDevices.addEventListener('click', async () => {
      const logEl = document.getElementById('hid-debug-log');
      try {
        const devices = await invoke('list_hid_devices');
        const kbDevices = (devices || []).filter(d =>
          d.product.toLowerCase().includes('keyboard') ||
          d.product.toLowerCase().includes('2.4g') ||
          parseInt(d.usagePage) >= 0xff00
        );
        const txt = kbDevices.map(d =>
          `${d.vendorId}:${d.productId} | ${d.product} | IF:${d.interface} | UP:${d.usagePage}`
        ).join('\n') || 'Cihaz bulunamadı';
        if (logEl) logEl.textContent = txt;
        console.log('=== TÜM HID CİHAZLARI ===');
        (devices || []).forEach(d => console.log(JSON.stringify(d)));
      } catch (err) {
        if (logEl) logEl.textContent = `Hata: ${err}`;
      }
    });
  }

  // Keyboard Key Click & Hardware Keyboard Press Listener
  const keys = document.querySelectorAll('.keycap');
  keyElementsMap = {};
  keys.forEach(keyEl => {
    const code = keyEl.getAttribute('data-code');
    keyElementsMap[code] = keyEl;

    keyEl.addEventListener('click', () => {
      state.selectedKey = code;

      // If currently in custom_per_key mode, clicking the key immediately assigns the active primary color
      if (state.activeEffect === 'custom_per_key') {
        state.perKeyColors[code] = state.primaryColor;
        savePerKeyColors();
        if (rgbEngine) {
          rgbEngine.setCustomKeyColor(code, state.primaryColor);
        }
        // Update ONLY the selected-key info label — no full DOM rebuild
        const infoEl = document.querySelector('.per-key-selected-info');
        if (infoEl) {
          infoEl.innerHTML = `Seçili Tuş: <strong style="color:var(--text-main); font-family:var(--font-mono);">${code}</strong> — Rengi tıklayarak bu tuşa ata!`;
        }
        // Update selected state on keys (remove old, add new)
        document.querySelectorAll('.keycap.selected').forEach(el => el.classList.remove('selected'));
        keyEl.classList.add('selected');
      } else {
        if (rgbEngine) rgbEngine.triggerKeyRipple(code);
        renderApp();
      }
    });
  });

  // Per-Key RGB Tool Buttons
  const btnApplyPerKey = document.getElementById('btn-apply-per-key');
  if (btnApplyPerKey) {
    btnApplyPerKey.addEventListener('click', () => {
      state.activeEffect = 'custom_per_key';
      if (rgbEngine) {
        rgbEngine.setEffect('custom_per_key');
        // sync existing per key map to engine
        Object.entries(state.perKeyColors).forEach(([k, col]) => {
          rgbEngine.setCustomKeyColor(k, col);
        });
      }
      renderApp();
    });
  }

  const btnPresetWasd = document.getElementById('btn-preset-wasd');
  if (btnPresetWasd) {
    btnPresetWasd.addEventListener('click', () => {
      state.activeEffect = 'custom_per_key';

      // Clear all existing per-key colors first (unlit = dark)
      state.perKeyColors = {};

      // WASD → Cyan
      ['KeyW', 'KeyA', 'KeyS', 'KeyD'].forEach(c => state.perKeyColors[c] = '#06b6d4');
      // Arrow keys → Amber
      ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].forEach(c => state.perKeyColors[c] = '#f59e0b');
      // Space & Enter → Emerald
      ['Space', 'Enter'].forEach(c => state.perKeyColors[c] = '#10b981');
      // Escape & Delete → Red
      ['Escape', 'Delete'].forEach(c => state.perKeyColors[c] = '#ef4444');

      savePerKeyColors();

      if (rgbEngine) {
        // First clear ALL key colors in engine (reset unlit keys)
        rgbEngine.clearCustomKeyColors();
        rgbEngine.setEffect('custom_per_key');
        // Then apply only the preset colors
        Object.entries(state.perKeyColors).forEach(([k, col]) => {
          rgbEngine.setCustomKeyColor(k, col);
        });
      }
      renderApp();
    });
  }

  const btnResetPerKey = document.getElementById('btn-reset-per-key');
  if (btnResetPerKey) {
    btnResetPerKey.addEventListener('click', () => {
      state.perKeyColors = {};
      savePerKeyColors();
      if (rgbEngine) {
        rgbEngine.clearCustomKeyColors();
      }
      renderApp();
    });
  }

  // Effect Selectors
  document.querySelectorAll('.effect-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeEffect = btn.getAttribute('data-effect');
      if (rgbEngine) rgbEngine.setEffect(state.activeEffect);
      renderApp();
    });
  });

  // Rainbow / Custom Color Mode Pill Toggles
  const btnRainbow = document.getElementById('btn-mode-rainbow');
  if (btnRainbow) {
    btnRainbow.addEventListener('click', () => {
      state.colorType = 'rainbow';
      if (rgbEngine) rgbEngine.setColorType('rainbow');
      renderApp();
    });
  }

  const btnCustom = document.getElementById('btn-mode-custom');
  if (btnCustom) {
    btnCustom.addEventListener('click', () => {
      state.colorType = 'custom';
      if (rgbEngine) rgbEngine.setColorType('custom');
      renderApp();
    });
  }

  // Direction Selection
  document.querySelectorAll('.btn-dir').forEach(btn => {
    btn.addEventListener('click', () => {
      state.direction = parseInt(btn.getAttribute('data-dir'));
      if (rgbEngine) rgbEngine.setDirection(state.direction);
      renderApp();
    });
  });

  // Edge / Side Light Mode Buttons
  document.querySelectorAll('.btn-side-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      state.sideMode = parseInt(btn.getAttribute('data-side'));
      if (rgbEngine) rgbEngine.setSideMode(state.sideMode);
      renderApp();
    });
  });

  // Quick Preset Button
  const btnPreset = document.getElementById('btn-quick-preset');
  if (btnPreset) {
    btnPreset.addEventListener('click', () => {
      state.activeEffect = state.activeEffect === 'neon' ? 'wave' : 'neon';
      state.colorType = 'rainbow';
      state.speed = 80;
      state.brightness = 100;
      if (rgbEngine) {
        rgbEngine.setEffect(state.activeEffect);
        rgbEngine.setColorType('rainbow');
        rgbEngine.setSpeed(80);
        rgbEngine.setBrightness(100);
      }
      renderApp();
    });
  }

  // Color Swatches — assigns to selectedKey if custom_per_key, else sets general color
  document.querySelectorAll('.color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      state.primaryColor = sw.getAttribute('data-color');
      state.colorType = 'custom';

      if (state.activeEffect === 'custom_per_key' && state.selectedKey) {
        state.perKeyColors[state.selectedKey] = state.primaryColor;
        savePerKeyColors();
        if (rgbEngine) {
          rgbEngine.setCustomKeyColor(state.selectedKey, state.primaryColor);
        }
        // Update color label inline — no DOM rebuild
        const lbl = document.getElementById('lbl-color-val');
        if (lbl) lbl.textContent = state.primaryColor;
        // Update swatch active state inline
        document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
        sw.classList.add('active');
      } else {
        if (rgbEngine) {
          rgbEngine.setColor(state.primaryColor);
        }
        renderApp();
      }
    });
  });


  // Color Picker Input
  const colorPicker = document.getElementById('color-picker');
  if (colorPicker) {
    colorPicker.addEventListener('input', (e) => {
      state.primaryColor = e.target.value;
      const lbl = document.getElementById('lbl-color-val');
      if (lbl) lbl.textContent = state.primaryColor;
      if (state.activeEffect === 'custom_per_key' && state.selectedKey) {
        state.perKeyColors[state.selectedKey] = state.primaryColor;
        if (rgbEngine) rgbEngine.setCustomKeyColor(state.selectedKey, state.primaryColor);
      } else {
        if (rgbEngine) rgbEngine.primaryColor = state.primaryColor;
      }
    });

    colorPicker.addEventListener('change', (e) => {
      state.primaryColor = e.target.value;
      if (state.activeEffect === 'custom_per_key' && state.selectedKey) {
        state.perKeyColors[state.selectedKey] = state.primaryColor;
        savePerKeyColors();
        if (rgbEngine) rgbEngine.setCustomKeyColor(state.selectedKey, state.primaryColor);
        // No renderApp — keep DOM intact
      } else {
        state.activeEffect = 'static';
        if (rgbEngine) {
          rgbEngine.setColor(state.primaryColor);
          rgbEngine.setEffect('static');
        }
      }
      renderApp();
    });
  }



  // Add to Favorites Button
  const btnAddFav = document.getElementById('btn-add-favorite');
  if (btnAddFav) {
    btnAddFav.addEventListener('click', () => {
      const color = state.primaryColor;
      if (!state.favoriteColors.includes(color) && state.favoriteColors.length < 12) {
        state.favoriteColors.unshift(color);
        saveFavorites();
        renderApp();
      }
    });
  }

  // Favorite Swatches - click to apply
  document.querySelectorAll('.favorite-swatch').forEach(sw => {
    sw.addEventListener('click', (e) => {
      if (e.target.classList.contains('fav-remove')) return;
      state.primaryColor = sw.getAttribute('data-color');
      state.activeEffect = 'static';
      if (rgbEngine) {
        rgbEngine.setColor(state.primaryColor);
        rgbEngine.setEffect('static');
      }
      renderApp();
    });
  });

  // Favorite Remove buttons
  document.querySelectorAll('.fav-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.getAttribute('data-fav-index'));
      state.favoriteColors.splice(idx, 1);
      saveFavorites();
      renderApp();
    });
  });

  // Speed Slider
  const sliderSpeed = document.getElementById('slider-speed');
  if (sliderSpeed) {
    // input: anlık etiket güncellemesi
    sliderSpeed.addEventListener('input', (e) => {
      state.speed = parseInt(e.target.value);
      if (rgbEngine) rgbEngine.speed = state.speed; // sadece engine değeri güncelle
      const lbl = document.getElementById('lbl-speed-val');
      if (lbl) lbl.textContent = `${state.speed}%`;
    });
    // change: mouse bırakılınca klavyeye gönder
    sliderSpeed.addEventListener('change', (e) => {
      state.speed = parseInt(e.target.value);
      if (rgbEngine) rgbEngine.setSpeed(state.speed);
    });
  }

  // Brightness Slider
  const sliderBrightness = document.getElementById('slider-brightness');
  if (sliderBrightness) {
    // input: anlık etiket güncellemesi
    sliderBrightness.addEventListener('input', (e) => {
      state.brightness = parseInt(e.target.value);
      if (rgbEngine) rgbEngine.brightness = state.brightness; // sadece engine değeri güncelle
      const lbl = document.getElementById('lbl-brightness-val');
      if (lbl) lbl.textContent = `${state.brightness}%`;
    });
    // change: mouse bırakılınca klavyeye gönder
    sliderBrightness.addEventListener('change', (e) => {
      state.brightness = parseInt(e.target.value);
      if (rgbEngine) rgbEngine.setBrightness(state.brightness);
    });
  }
}


// Initialize Active RGB Engine
function initRGBEngine() {
  if (!rgbEngine) {
    rgbEngine = new RGBEngine(keyElementsMap);
    Object.entries(state.perKeyColors).forEach(([code, col]) => {
      rgbEngine.setCustomKeyColor(code, col, true); // skipHardware on init
    });
    rgbEngine.start();
  } else {
    rgbEngine.setKeysMap(keyElementsMap);
    Object.entries(state.perKeyColors).forEach(([code, col]) => {
      rgbEngine.setCustomKeyColor(code, col, true); // skipHardware on re-render
    });
  }
}


// Global Keydown Handler for Hardware Press Simulation
window.addEventListener('keydown', (e) => {
  if (rgbEngine && keyElementsMap[e.code]) {
    rgbEngine.triggerKeyRipple(e.code);
  }
});

// ─────────────────────────────────────────────────────────────
// Hardware Sync Listener (Two-Way Synchronization)
// When physical keyboard shortcut (Fn + \ or Fn + keys) changes RGB/Speed/Brightness,
// Electron sends `hardware-rgb-sync` event to update the UI immediately.
// ─────────────────────────────────────────────────────────────
const modeIdToEffect = {
  1: 'static',
  2: 'breathing',
  3: 'spectrum',
  4: 'wave',
  5: 'ripple',
  6: 'stardots',
  7: 'flow',
  8: 'keyshadow',
  9: 'layers',
  10: 'sine',
  11: 'spring',
  12: 'neon',
  14: 'radiant',
  15: 'loop',
  16: 'colorgrid',
  17: 'snowfall',
  18: 'meteor',
  19: 'silentsnow',
  0: 'off'
};

// ── Tauri Hardware Sync Listener ─────────────────────────────────────────────
try {
  // Push events from the Rust 800ms poller via Tauri event system
  listen('hardware-rgb-sync', ({ payload: hw }) => {
    // Don't override custom per-key mode with hardware sync
    if (state.activeEffect === 'custom_per_key') return;

    const effectName = modeIdToEffect[hw.mode] || 'static';
    state.activeEffect = effectName;
    state.speed = hw.speedPct;
    state.brightness = hw.brightnessPct;
    state.colorType = hw.colorType;
    state.direction = hw.direction;
    state.primaryColor = hw.primaryColor;

    if (rgbEngine) {
      rgbEngine.currentEffect = effectName;
      rgbEngine.speed = hw.speedPct;
      rgbEngine.brightness = hw.brightnessPct;
      rgbEngine.colorType = hw.colorType;
      rgbEngine.direction = hw.direction;
      rgbEngine.primaryColor = hw.primaryColor;
    }

    renderApp();
  });

  // Initial state sync on app load
  invoke('get_hardware_rgb_state').then(hw => {
    if (hw) {
      const effectName = modeIdToEffect[hw.mode] || 'static';
      state.activeEffect = effectName;
      state.speed = hw.speedPct;
      state.brightness = hw.brightnessPct;
      state.colorType = hw.colorType;
      state.direction = hw.direction;
      state.primaryColor = hw.primaryColor;
      if (rgbEngine) {
        rgbEngine.currentEffect = effectName;
        rgbEngine.speed = hw.speedPct;
        rgbEngine.brightness = hw.brightnessPct;
        rgbEngine.colorType = hw.colorType;
        rgbEngine.direction = hw.direction;
        rgbEngine.primaryColor = hw.primaryColor;
      }
      renderApp();
    }
  }).catch(() => {});
} catch (e) {
  console.log('[Sync] Tauri event listener kurulamadı:', e.message);
}

// Initial Render
renderApp();


