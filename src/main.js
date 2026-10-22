import './style.css';
import { KEYBOARD_LAYOUTS, DEFAULT_PRESET_COLORS } from './layouts.js';
import { HIDService } from './hidService.js';
import { RGBEngine } from './rgbEngine.js';
import { initMacros, isPickingKey, pickKey, renderMacrosTab, bindMacrosTab, macroKeys, cancelMacroEdit } from './macros.js';
import { exportBackup, importBackup } from './backup.js';
import { initRemap, handleRemapKeyClick, renderRemapCard, bindRemapCard, remapKeys, cancelRemapEdit, markRemapsUnsynced } from './remap.js';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// Application State
const state = {
  theme: localStorage.getItem('rampage-theme') || 'dark', // 'dark' | 'light'
  activeTab: 'rgb', // 'rgb', 'macros', 'settings'
  activeProfile: 1, // 1, 2, 3
  selectedKey: null,
  activeEffect: 'wave',
  colorType: 'rainbow', // 'rainbow' | 'custom'
  primaryColor: '#e50914',
  direction: 0,
  speed: 75,
  brightness: 100,
  currentLayout: 'compact75',
  deviceConnected: true,
  connectionType: 'wired', // 'wired' | 'dongle_24g' | 'bluetooth' | 'none'
  deviceName: 'Rampage W-Granite',
  perKeyColors: {},
  favoriteColors: JSON.parse(localStorage.getItem('rampage-favorites') || '["#e50914", "#00e5ff", "#ff9100", "#00e676"]'),
  deviceSettings: JSON.parse(localStorage.getItem('rampage-settings') || JSON.stringify({
    sleepMinutes: 5,
    sleepEnabled: true,
    closeToTray: true,
    osMode: 'win'
  })),
  isSleeping: false,
  // Read from the keyboard (null until the first successful read)
  hw: { debounce: null, firmware: null, message: null },
  // Windows start-up entry (null until read) and the last backup message
  app: { autostart: null, message: null },
  battery: {
    percentage: 0,
    isCharging: false,
    isConnected: false,
    connectionType: 'none',
    statusText: 'Bağlantı Yok'
  }
};

// The keyboard cannot report its battery over the cable, so the last level read
// through the 2.4G dongle is remembered and shown as "last known".
function lastKnownBattery() {
  try {
    const v = Number(localStorage.getItem('rampage-last-battery'));
    return Number.isFinite(v) && v > 0 ? Math.min(100, v) : null;
  } catch { return null; }
}
function rememberBattery(pct) {
  try { if (pct > 0) localStorage.setItem('rampage-last-battery', String(pct)); } catch { /* optional */ }
}

// Presses of one key closer together than this count as a double press (chatter).
const CHATTER_MS = 30;

// Switch Tester State
const switchTester = {
  lastKey: '--',
  latency: '--',
  totalPresses: 0,
  chatterFiltered: 0,
  lastPressTimeByKey: {}
};

// Activity Tracker for Sleep Engine
let lastActivityTimestamp = Date.now();

function saveSettings() {
  localStorage.setItem('rampage-settings', JSON.stringify(state.deviceSettings));
}

// Apply Active Theme to Document Root
function applyTheme(theme) {
  state.theme = theme;
  localStorage.setItem('rampage-theme', theme);
  document.documentElement.setAttribute('data-theme', theme);
}
applyTheme(state.theme);

function loadPerKeyColors() {
  try {
    const raw = JSON.parse(localStorage.getItem('rampage-perkey') || '{}');
    return raw;
  } catch {
    return {};
  }
}

function saveFavorites() {
  localStorage.setItem('rampage-favorites', JSON.stringify(state.favoriteColors));
}

function savePerKeyColors() {
  localStorage.setItem('rampage-perkey', JSON.stringify(state.perKeyColors));
}

// Load per-key colors
state.perKeyColors = loadPerKeyColors();

// Services
const hid = new HIDService();
window.hidService = hid;
let rgbEngine = null;
let keyElementsMap = {};

// ── Lighting profiles ─────────────────────────────────────────────────────────
// The keyboard has a single layer, so profiles live in the app: each one keeps
// the lighting settings and per-key colors and is sent to the keyboard on switch.
const PROFILE_STORAGE = 'rampage-profiles';
const LIGHTING_FIELDS = ['activeEffect', 'speed', 'brightness', 'colorType', 'primaryColor', 'direction'];

function loadProfileStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROFILE_STORAGE) || 'null');
    if (parsed && parsed.profiles) return parsed;
  } catch (e) { /* fall through to an empty store */ }
  return { active: 1, profiles: {} };
}

const profileStore = loadProfileStore();
state.activeProfile = [1, 2, 3].includes(profileStore.active) ? profileStore.active : 1;
const savedLighting = profileStore.profiles[state.activeProfile];
if (savedLighting) {
  LIGHTING_FIELDS.forEach(key => { if (savedLighting[key] !== undefined) state[key] = savedLighting[key]; });
}

function snapshotLighting() {
  const snap = {};
  LIGHTING_FIELDS.forEach(key => { snap[key] = state[key]; });
  snap.perKeyColors = { ...state.perKeyColors };
  return snap;
}

function saveProfileStore() {
  profileStore.active = state.activeProfile;
  profileStore.profiles[state.activeProfile] = snapshotLighting();
  try {
    localStorage.setItem(PROFILE_STORAGE, JSON.stringify(profileStore));
  } catch (e) { /* storage unavailable: profiles stay in memory */ }
}

// Keep the active profile current without hooking every control.
setInterval(saveProfileStore, 3000);

function switchProfile(n) {
  if (n === state.activeProfile) return;
  saveProfileStore();
  state.activeProfile = n;
  const saved = profileStore.profiles[n];
  // A profile that was never used starts from the current settings.
  if (saved) {
    LIGHTING_FIELDS.forEach(key => { if (saved[key] !== undefined) state[key] = saved[key]; });
    state.perKeyColors = { ...(saved.perKeyColors || {}) };
    savePerKeyColors();
  }
  saveProfileStore();
  if (state.isSleeping) {
    // Lights are off until activity; wake-up restores whatever profile is active.
    state.savedEffectBeforeSleep = {
      effect: state.activeEffect, speed: state.speed, brightness: state.brightness,
      colorType: state.colorType, direction: state.direction, primaryColor: state.primaryColor
    };
  } else {
    applyLightingState();
  }
  renderApp();
}

// Generate Hardware Battery Indicator Widget
function renderBatteryIndicator() {
  const b = state.battery || { percentage: 100, isCharging: true, isConnected: true, connectionType: 'wired', statusText: 'Şarj Oluyor' };
  const isConnected = state.deviceConnected;
  const pct = isConnected ? b.percentage : 0;
  const isCharging = isConnected && b.isCharging;

  // Color tier based on percentage:
  let tierClass = 'battery-tier-high';
  if (!isConnected) {
    tierClass = 'battery-tier-disconnected';
  } else if (isCharging) {
    tierClass = 'battery-tier-charging';
  } else if (pct < 20) {
    tierClass = 'battery-tier-critical';
  } else if (pct < 50) {
    tierClass = 'battery-tier-medium';
  }

  const fillWidth = isConnected ? Math.max(8, Math.min(100, pct)) : 0;

  return `
    <div class="battery-widget ${tierClass}" id="header-battery-widget">
      <div class="battery-icon-container">
        <div class="battery-shell">
          <div class="battery-fill" style="width: ${fillWidth}%"></div>
          ${isCharging ? `
            <svg class="battery-lightning" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
            </svg>
          ` : ''}
        </div>
        <div class="battery-nipple"></div>
      </div>

      <div class="battery-info">
        <span class="battery-pct">${isConnected ? (isCharging ? 'USB' : `${pct}%`) : '--'}</span>
        <span class="battery-label">${isConnected ? (isCharging ? (lastKnownBattery() ? `Kablolu · son %${lastKnownBattery()}` : 'Kablolu') : (pct < 20 ? 'Pil düşük' : (state.connectionType === 'bluetooth' ? 'Bluetooth' : '2.4G'))) : 'Bağlı değil'}</span>
      </div>
    </div>
  `;
}

// Render Complete UI Structure
function renderApp() {
  const isLight = state.theme === 'light';
  const logoSrc = isLight ? '/rampage-seeklogo.png' : '/rampage-seeklogo-beyaz.png';

  app.innerHTML = `
    <!-- Sidebar Navigation -->
    <aside class="sidebar">
      <!-- Rampage Official Brand Header (Aligned with Top Navbar) -->
      <div class="brand-container">
        <img src="${logoSrc}" alt="Rampage" class="rampage-brand-img" />
      </div>

      <nav class="nav-menu">
        <div class="nav-item ${state.activeTab === 'rgb' ? 'active' : ''}" data-tab="rgb">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m12 2 a10 10 0 0 1 0 20"/></svg>
          <span>Aydınlatma</span>
        </div>
        <div class="nav-item ${state.activeTab === 'macros' ? 'active' : ''}" data-tab="macros">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          <span>Makro & Tuşlar</span>
        </div>
        <div class="nav-item ${state.activeTab === 'settings' ? 'active' : ''}" data-tab="settings">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          <span>Ayarlar</span>
        </div>
      </nav>

      <!-- Hardware Connection Status & Connect Button -->
      <div class="sidebar-bottom-status">
        <div class="device-status-badge">
          <span class="device-status-dot ${state.deviceConnected ? '' : 'disconnected'}"></span>
          <span>${state.deviceConnected ? 'Bağlandı' : 'Bağlantı Yok'}</span>
        </div>
        <div class="device-info-name" title="${state.deviceName}">
          ${state.deviceName}
        </div>

        <!-- Sidebar Mini Battery Gauge -->
        <div class="sidebar-battery-bar-container">
          <div class="sidebar-battery-header">
            <span class="sidebar-battery-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect width="16" height="10" x="2" y="7" rx="2" ry="2"/><line x1="22" x2="22" y1="11" y2="13"/></svg>
              ${state.deviceConnected && state.battery.isCharging ? (lastKnownBattery() ? `Kablolu · son %${lastKnownBattery()}` : 'Kablolu') : 'Pil'}
            </span>
            <span class="sidebar-battery-pct-val">${state.deviceConnected ? (state.battery.isCharging ? 'USB' : `%${state.battery.percentage}`) : '--'}</span>
          </div>
          <div class="sidebar-battery-track">
            <div class="sidebar-battery-fill ${state.battery.isCharging ? 'charging' : ''}" style="width: ${state.deviceConnected ? (state.battery.isCharging ? (lastKnownBattery() ?? 100) : state.battery.percentage) : 0}%"></div>
          </div>
        </div>

        <button class="btn-sidebar-connect" id="btn-reconnect-device">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
          <span>Klavyeyi Bağla</span>
        </button>
      </div>
    </aside>

    <!-- Main Content Body -->
    <main class="main-wrapper">
      <!-- Top Header -->
      <header class="top-header">
        <div class="header-title">
          ${state.activeTab === 'rgb' ? 'Aydınlatma' : ''}
          ${state.activeTab === 'macros' ? 'Makro & Tuşlar' : ''}
          ${state.activeTab === 'settings' ? 'Ayarlar' : ''}
        </div>

        <div class="header-actions">
          <!-- Live Sleep Status Indicator -->
          ${state.isSleeping ? `
            <div class="sleep-active-badge">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
              Uyku Modu
            </div>
          ` : ''}

          <!-- Live Hardware Battery & Charging Indicator Widget -->
          ${renderBatteryIndicator()}

          <!-- Profile Switcher -->
          <div class="profile-picker">
            <button class="profile-btn ${state.activeProfile === 1 ? 'active' : ''}" data-profile="1">Profil 1</button>
            <button class="profile-btn ${state.activeProfile === 2 ? 'active' : ''}" data-profile="2">Profil 2</button>
            <button class="profile-btn ${state.activeProfile === 3 ? 'active' : ''}" data-profile="3">Profil 3</button>
          </div>

          <!-- Theme Toggle Button -->
          <button class="btn-theme-toggle" id="btn-toggle-theme" title="${isLight ? 'Koyu Temaya Geç' : 'Beyaz Temaya Geç'}">
            ${isLight ? `
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
            ` : `
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>
            `}
          </button>
        </div>
      </header>

      <div class="content-area">
        <!-- Keyboard Stage -->
        <section class="keyboard-stage">
          <div class="keyboard-controls-bar">
            <div class="keyboard-title-badge">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/></svg>
              ${state.deviceName || 'Rampage W-Granite'}
            </div>
          </div>

          <div class="keyboard-body" id="keyboard-canvas">
            ${renderKeyboardLayout()}
          </div>
        </section>

        <!-- Dynamic Tab Panel -->
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
    'sun': `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`,
    'volume-x': `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/></svg>`,
    'volume-1': `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`,
    'volume-2': `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`,
    'play-pause': `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 13 12 5 21 5 3"/><line x1="19" x2="19" y1="4" y2="20"/></svg>`,
    'monitor': `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>`,
    'tv': `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="20" height="15" x="2" y="7" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>`,
    'smartphone': `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="20" x="5" y="2" rx="2"/><line x1="12" x2="12.01" y1="18" y2="18"/></svg>`,
    'app-window': `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="2" x2="22" y1="9" y2="9"/><line x1="6" x2="6.01" y1="6.5" y2="6.5"/><line x1="9" x2="9.01" y1="6.5" y2="6.5"/></svg>`,
    'search': `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/></svg>`,
    'lock': `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
    'rotate-ccw': `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`,
    'delete': `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 5H9l-7 7 7 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Z"/><line x1="18" x2="12" y1="9" y2="15"/><line x1="12" x2="18" y1="9" y2="15"/></svg>`,
    'target': `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`,
    'arrow-up': `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m18 15-6-6-6 6"/></svg>`,
    'arrow-down': `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m6 9 6 6 6-6"/></svg>`,
    'arrow-left': `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m15 18-6-6 6-6"/></svg>`,
    'arrow-right': `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m9 18 6-6-6-6"/></svg>`,
    'corner-down-left': `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>`
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
          return `<div class="key-iso-placeholder"></div>`;
        }
        if (key.isIsoEnter) {
          return `
            <div class="keycap key-iso-enter ${state.selectedKey === key.code ? 'selected' : ''}" 
                 data-code="${key.code}" 
                 id="key-${key.code}"
                 title="Enter">
              <svg class="iso-enter-shape" viewBox="0 0 90 87.5" preserveAspectRatio="none">
                <path class="iso-path-base" d="M 4,0.5 L 86,0.5 Q 89.5,0.5 89.5,4 L 89.5,83.5 Q 89.5,87 86,87 L 18.5,87 Q 15,87 15,83.5 L 15,45.5 Q 15,42 11.5,42 L 4,42 Q 0.5,42 0.5,38.5 L 0.5,4 Q 0.5,0.5 4,0.5 Z" />
                <path class="iso-path-tint" d="M 4,0.5 L 86,0.5 Q 89.5,0.5 89.5,4 L 89.5,83.5 Q 89.5,87 86,87 L 18.5,87 Q 15,87 15,83.5 L 15,45.5 Q 15,42 11.5,42 L 4,42 Q 0.5,42 0.5,38.5 L 0.5,4 Q 0.5,0.5 4,0.5 Z" />
              </svg>
              <div class="iso-enter-label">
                ${key.label ? `<span class="key-main">${key.label}</span>` : ''}
                ${key.icon ? `<span class="key-icon-lucide">${getLucideIconSvg(key.icon)}</span>` : ''}
              </div>
              <div class="iso-enter-beam"></div>
            </div>
          `;
        }
        return `
          <div class="keycap ${key.width || ''} ${key.isSpecial ? 'key-special' : ''} ${state.selectedKey === key.code ? 'selected' : ''}" 
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
  { id: 'static',     name: 'Sabit',       desc: 'Tek sabit renk' },
  { id: 'breathing',  name: 'Nefes',       desc: 'Yavaşça sönüp parlar' },
  { id: 'spectrum',   name: 'Spektrum',    desc: 'Tüm renk spektrumu' },
  { id: 'wave',       name: 'Dalga',       desc: 'Akıcı ışık dalgaları' },
  { id: 'flow',       name: 'Akış',        desc: 'Yumuşak renk akışı' },
  { id: 'ripple',     name: 'Halka',       desc: 'Merkezden dışa dalga' },
  { id: 'radiant',    name: 'Işıma',       desc: 'Dışa doğru ışıma' },
  { id: 'loop',       name: 'Fırıldak',    desc: 'Dairesel ışık dönüşü' },
  { id: 'stardots',   name: 'Yıldız',      desc: 'Rastgele parıldayan tuşlar' },
  { id: 'meteor',     name: 'Meteor',      desc: 'Kayan ışık izi' },
  { id: 'snowfall',   name: 'Kar Yağışı',  desc: 'Aşağı süzülen ışıklar' },
  { id: 'silentsnow', name: 'Sakin Kar',   desc: 'Yavaş kar tanesi ışıltısı' },
  { id: 'keyshadow',  name: 'Tuş İzi',     desc: 'Basılan tuş iz bırakır' },
  { id: 'layers',     name: 'Katmanlar',   desc: 'İç içe geçen ışık katmanları' },
  { id: 'sine',       name: 'Sinüs',       desc: 'Sinüzoidal ışık hareketi' },
  { id: 'spring',     name: 'Püskürme',    desc: 'Işık sıçramaları' },
  { id: 'neon',       name: 'Neon',        desc: 'Canlı neon renk akışı' },
  { id: 'colorgrid',  name: 'Izgara',      desc: 'Kare ızgara desenleri' },
  { id: 'off',        name: 'Kapat',       desc: 'Tüm ışıkları söndürür' }
];

// Active Tab Views (Optimized for Single-Screen No Scrollbar)
function renderActiveTabContent() {
  if (state.activeTab === 'rgb') {
    return `
      <div class="control-grid">
        <!-- Left: Lighting Modes & Flow Direction -->
        <div class="glass-card">
          <div class="section-header">
            <div class="section-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
              Aydınlatma Modları
            </div>
            <div class="color-mode-toggle">
              <button class="mode-pill ${state.colorType === 'rainbow' ? 'active' : ''}" id="btn-mode-rainbow">Gökkuşağı</button>
              <button class="mode-pill ${state.colorType === 'custom' ? 'active' : ''}" id="btn-mode-custom">Özel Renk</button>
            </div>
          </div>

          <div class="effect-selector-list">
            ${ALL_EFFECTS.map(eff => `
              <button class="effect-btn ${state.activeEffect === eff.id ? 'active' : ''}" data-effect="${eff.id}" title="${eff.name} - ${eff.desc}">
                ${eff.name}
              </button>
            `).join('')}
          </div>

          <!-- Direction Selection -->
          <div class="form-group" style="margin-top: 2px;">
            <div class="form-label">
              <span>Akış Yönü</span>
              <span id="lbl-dir-val" style="color:var(--rampage-red); font-weight:600;">${['Sola', 'Sağa', 'Yukarı', 'Aşağı'][state.direction || 0]}</span>
            </div>
            <div class="direction-btn-group">
              <button class="btn-dir ${(state.direction || 0) === 0 ? 'active' : ''}" data-dir="0">Sola</button>
              <button class="btn-dir ${(state.direction || 0) === 1 ? 'active' : ''}" data-dir="1">Sağa</button>
              <button class="btn-dir ${(state.direction || 0) === 2 ? 'active' : ''}" data-dir="2">Yukarı</button>
              <button class="btn-dir ${(state.direction || 0) === 3 ? 'active' : ''}" data-dir="3">Aşağı</button>
            </div>
          </div>
        </div>

        <!-- Right: Color, Speed, Brightness & Per-Key RGB -->
        <div class="glass-card">
          <div class="section-header">
            <div class="section-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m12 2 a10 10 0 0 1 0 20"/></svg>
              Renk ve Parametreler
            </div>
            <span id="lbl-color-val" style="font-family:var(--font-mono); color:var(--rampage-red); font-weight:600; font-size:0.75rem;">${state.primaryColor}</span>
          </div>

          <!-- Color Picker Row -->
          <div class="color-picker-wrapper">
            <input type="color" class="color-input-custom" id="color-picker" value="${state.primaryColor}">
            <div class="color-palette">
              ${DEFAULT_PRESET_COLORS.map(c => `
                <div class="color-swatch ${state.primaryColor === c ? 'active' : ''}" style="background:${c};" data-color="${c}"></div>
              `).join('')}
            </div>
            <button class="btn-add-favorite" id="btn-add-favorite" title="Favorilere ekle">
              + Ekle
            </button>
          </div>

          ${state.favoriteColors.length > 0 ? `
          <div style="display:flex; align-items:center; gap:5px; margin-top:-2px;">
            <div class="color-palette" style="flex-wrap:nowrap; overflow:hidden;">
              ${state.favoriteColors.slice(0, 8).map((c, i) => `
                <div class="color-swatch favorite-swatch ${state.primaryColor === c ? 'active' : ''}" style="background:${c}; position:relative; width:17px; height:17px;" data-color="${c}" data-fav-index="${i}" title="${c}">
                  <span class="fav-remove" data-fav-index="${i}" title="Kaldır">✕</span>
                </div>
              `).join('')}
            </div>
          </div>` : ''}

          <!-- Speed & Brightness Side-by-Side -->
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-top:2px;">
            <div class="form-group">
              <div class="form-label">
                <span>Efekt Hızı</span>
                <span id="lbl-speed-val" style="color:var(--rampage-red); font-weight:600;">${state.speed || 75}%</span>
              </div>
              <input type="range" min="25" max="100" step="25" value="${state.speed || 75}" class="range-slider" id="slider-speed">
            </div>

            <div class="form-group">
              <div class="form-label">
                <span>Parlaklık</span>
                <span id="lbl-brightness-val" style="color:var(--rampage-red); font-weight:600;">${state.brightness ?? 100}%</span>
              </div>
              <input type="range" min="0" max="100" step="25" value="${state.brightness ?? 100}" class="range-slider" id="slider-brightness">
            </div>
          </div>

          <!-- Per-Key RGB Compact Box -->
          <div style="margin-top: 3px; padding: 8px 10px; background: var(--rampage-red-soft); border: 1px solid rgba(229, 9, 20, 0.2); border-radius: var(--radius-xs);">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">
              <span style="font-weight:600; font-size:0.76rem; color:var(--rampage-red); display:flex; align-items:center; gap:5px;">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
                Tuş Bazlı Özel RGB
              </span>
              ${state.activeEffect === 'custom_per_key' ? `<span style="font-size:0.62rem; background:var(--rampage-red); color:#fff; padding:1px 5px; border-radius:2px; font-weight:600;">Aktif</span>` : ''}
            </div>
            <div style="display:flex; gap:4px; flex-wrap:wrap;">
              <button class="btn-primary" id="btn-apply-per-key" style="font-size:0.68rem; padding:4px 8px;">
                ${state.activeEffect === 'custom_per_key' ? 'Haritayı Güncelle' : 'Özel Moda Geç'}
              </button>
              <button class="btn-secondary" id="btn-preset-wasd" style="font-size:0.68rem; padding:4px 7px;">
                WASD
              </button>
              <button class="btn-secondary" id="btn-preset-moba" style="font-size:0.68rem; padding:4px 7px;">
                MOBA
              </button>
              <button class="btn-secondary" id="btn-preset-all-red" style="font-size:0.68rem; padding:4px 7px; color:var(--rampage-red);">
                Kırmızı
              </button>
              <button class="btn-secondary" id="btn-reset-per-key" style="font-size:0.68rem; padding:4px 7px; color:var(--text-dim);">
                Sıfırla
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  if (state.activeTab === 'macros') {
    return `<div class="macro-stack">${renderMacrosTab()}${renderRemapCard()}</div>`;
  }

  if (state.activeTab === 'settings') {
    const debounceLevel = state.hw.debounce ?? 1;
    const sleepMins = state.deviceSettings.sleepMinutes || 5;

    return `
      <div class="control-grid">
        <!-- Mechanical Debounce & Latency Card -->
        <div class="glass-card">
          <div class="section-header">
            <div class="section-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
              Debounce
            </div>
          </div>

          <div class="form-group">
            <div class="form-label">
              <span>Seviye</span>
              <span id="lbl-debounce-val" style="color:var(--rampage-red); font-weight:600;">${state.hw.debounce === null ? '--' : debounceLevel} / 10</span>
            </div>
            <p style="color:var(--text-muted); font-size:0.72rem; line-height:1.3;">
              Tuş çift basıyorsa artırın; yüksek değer tepkiyi biraz yavaşlatır. Klavyeye yazılır.
            </p>
            <input type="range" min="1" max="10" step="1" value="${debounceLevel}" class="range-slider" id="slider-debounce">
            <p id="debounce-status" class="debounce-status ${state.hw.message ? (state.hw.message.ok ? 'ok' : 'error') : ''}">${state.hw.message ? state.hw.message.text : ''}</p>
          </div>

          <!-- Live Switch Tester / Chatter Inspector -->
          <div class="switch-tester-box">
            <div style="font-size:0.74rem; font-weight:600; color:var(--text-main); display:flex; align-items:center; justify-content:space-between;">
              <span>Switch testi</span>
              <span class="switch-chatter-badge" id="badge-chatter-status">Çift basma yok</span>
            </div>
            <div class="switch-test-row">
              <span style="color:var(--text-muted);">Son tuş</span>
              <span class="switch-key-display" id="tester-last-key">${switchTester.lastKey}</span>
            </div>
            <div class="switch-test-row">
              <span style="color:var(--text-muted);">Basış aralığı</span>
              <span style="font-family:var(--font-mono); color:var(--text-main); font-weight:600;" id="tester-latency">${switchTester.latency}</span>
            </div>
          </div>
        </div>

        <!-- Smart Sleep & Device Management Card -->
        <div class="glass-card">
          <div class="section-header">
            <div class="section-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
              Uyku
            </div>
          </div>

          <div class="form-group">
            <div class="form-label">
              <span>Işıkları kapat</span>
              <span id="lbl-sleep-val" style="color:var(--rampage-red); font-weight:600;">${sleepMins} dk sonra</span>
            </div>
            <p style="color:var(--text-muted); font-size:0.72rem; line-height:1.3;">
              Bilgisayar bu süre boşta kalınca. Bir tuşa basınca geri açılır.
            </p>
            <input type="range" min="1" max="30" step="1" value="${sleepMins}" class="range-slider" id="slider-sleep">
          </div>

          <!-- Live Battery Health & Power Card -->
          <div class="settings-battery-card">
            <div class="settings-battery-header">
              <div class="settings-battery-title">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="16" height="10" x="2" y="7" rx="2" ry="2"/><line x1="22" x2="22" y1="11" y2="13"/></svg>
                Pil
              </div>
              <span class="settings-battery-badge ${state.deviceConnected ? 'badge-normal' : ''}">
                ${state.deviceConnected ? (state.battery.isCharging ? 'Kablolu' : `%${state.battery.percentage}`) : 'Bağlı değil'}
              </span>
            </div>

            <div class="settings-battery-meter">
              <div class="settings-battery-meter-fill" style="width: ${state.deviceConnected && !state.battery.isCharging ? state.battery.percentage : 0}%"></div>
            </div>

            <div class="settings-battery-details-grid">
              <div class="battery-metric-box">
                <span class="metric-label">Bağlantı</span>
                <span class="metric-value">${!state.deviceConnected ? '--' : ({ dongle_24g: '2.4G alıcı', bluetooth: 'Bluetooth' }[state.connectionType] || 'USB kablo')}</span>
              </div>
              <div class="battery-metric-box">
                <span class="metric-label">Pil</span>
                <span class="metric-value">${state.deviceConnected && !state.battery.isCharging ? `%${state.battery.percentage}` : '--'}</span>
              </div>
            </div>
          </div>

          <!-- Device Info & Factory Reset -->
          <div style="margin-top:4px; padding-top:6px; border-top:1px solid var(--border); display:flex; flex-direction:column; gap:4px; font-size:0.74rem; color:var(--text-muted);">
            <div><strong style="color:var(--text-main); font-weight:600;">Cihaz:</strong> Rampage W-Granite</div>
            ${state.hw.firmware ? `<div><strong style="color:var(--text-main); font-weight:600;">Sürüm:</strong> ${state.hw.firmware}</div>` : ''}
          </div>

          <div style="margin-top:6px;">
            <button class="btn-secondary" id="btn-factory-reset" style="color:var(--rampage-red); width:100%; padding:6px; font-weight:600; font-size:0.70rem;">
              Ayarları Sıfırla
            </button>
          </div>
        </div>

        <!-- App behavior and backup -->
        <div class="glass-card" style="grid-column: 1 / -1;">
          <div class="section-header">
            <div class="section-title">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="14" x="3" y="3" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
              Uygulama
            </div>
          </div>
          <div class="app-settings">
            <label class="toggle-row">
              <input type="checkbox" id="chk-autostart" ${state.app.autostart ? 'checked' : ''} ${state.app.autostart === null ? 'disabled' : ''}>
              <span>Windows ile başlat <small>Tepside açılır, pencere gelmez.</small></span>
            </label>
            <label class="toggle-row">
              <input type="checkbox" id="chk-close-tray" ${closeToTrayEnabled() ? 'checked' : ''}>
              <span>Pencereyi kapatınca tepside çalışsın <small>Işık kuralları ve uyku çalışmaya devam eder. Tamamen kapatmak için tepsi simgesinden Çık.</small></span>
            </label>
            <label class="toggle-row">
              <select id="sel-low-battery">
                ${[0, 10, 15, 20, 25, 30].map(v => `<option value="${v}" ${lowBatteryLevel() === v ? 'selected' : ''}>${v === 0 ? 'Kapalı' : '%' + v}</option>`).join('')}
              </select>
              <span>Düşük pil uyarısı <small>Pil bu seviyeye düşünce sağ altta uyarı çıkar.</small></span>
            </label>
            <div class="backup-row">
              <button class="btn-secondary" id="btn-backup-export">Yedek al</button>
              <button class="btn-secondary" id="btn-backup-import">Yedekten yükle</button>
              <input type="file" id="file-backup-import" accept=".json,application/json" hidden>
              <span id="backup-status" class="debounce-status ${state.app.message ? (state.app.message.ok ? 'ok' : 'error') : ''}">${state.app.message ? state.app.message.text : ''}</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  return '';
}

// Bind DOM Click & Input Listeners
function bindEvents() {
  bindMacrosTab();
  bindRemapCard();

  // Navigation Tabs
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => {
      state.activeTab = el.getAttribute('data-tab');
      renderApp();
    });
  });

  // Profile Selector
  document.querySelectorAll('.profile-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchProfile(parseInt(btn.getAttribute('data-profile')));
    });
  });

  // Theme Toggle Button
  const btnToggleTheme = document.getElementById('btn-toggle-theme');
  if (btnToggleTheme) {
    btnToggleTheme.addEventListener('click', () => {
      const nextTheme = state.theme === 'light' ? 'dark' : 'light';
      applyTheme(nextTheme);
      renderApp();
    });
  }

  // Reconnect / Scan Hardware Button
  const btnReconnect = document.getElementById('btn-reconnect-device');
  if (btnReconnect) {
    btnReconnect.addEventListener('click', async () => {
      btnReconnect.innerHTML = `<svg class="spin-anim" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Bağlanıyor...`;

      try {
        await hid.connectHID();
        if (rgbEngine) {
          if (state.activeEffect === 'custom_per_key') {
            rgbEngine.sendPerKeyReport();
          } else {
            rgbEngine.sendHardwareReport();
          }
        }
        state.deviceConnected = true;
      } catch (e) {
        console.warn('[Connect] Reconnect error:', e);
      }

      setTimeout(() => {
        renderApp();
      }, 400);
    });
  }

  // Keyboard Key Click Listener
  const keys = document.querySelectorAll('.keycap');
  keyElementsMap = {};
  keys.forEach(keyEl => {
    const code = keyEl.getAttribute('data-code');
    keyElementsMap[code] = keyEl;

    keyEl.addEventListener('click', () => {
      if (handleRemapKeyClick(code)) return;
      if (isPickingKey()) {
        pickKey(code);
        return;
      }
      wakeUpFromSleep();
      state.selectedKey = code;

      // In custom_per_key mode, clicking immediately colors that key
      if (state.activeEffect === 'custom_per_key') {
        const current = state.perKeyColors[code];
        if (current && current.toLowerCase() === state.primaryColor.toLowerCase()) {
          // Same color again: switch that key's light off.
          delete state.perKeyColors[code];
          savePerKeyColors();
          if (rgbEngine) rgbEngine.removeCustomKeyColor(code);
          keyEl.classList.remove('selected');
        } else {
          state.perKeyColors[code] = state.primaryColor;
          savePerKeyColors();
          if (rgbEngine) {
            rgbEngine.setCustomKeyColor(code, state.primaryColor);
          }
          document.querySelectorAll('.keycap.selected').forEach(el => el.classList.remove('selected'));
          keyEl.classList.add('selected');
        }
      } else {
        if (rgbEngine) rgbEngine.triggerKeyRipple(code);
        renderApp();
      }
    });
  });

  // Settings Sliders: Debounce
  const sliderDebounce = document.getElementById('slider-debounce');
  if (sliderDebounce) {
    sliderDebounce.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      const lbl = document.getElementById('lbl-debounce-val');
      if (lbl) lbl.textContent = `${val} / 10`;
    });
    sliderDebounce.addEventListener('change', (e) => applyDebounce(parseInt(e.target.value)));
  }

  // Settings Sliders: Sleep Timer
  const sliderSleep = document.getElementById('slider-sleep');
  if (sliderSleep) {
    sliderSleep.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      state.deviceSettings.sleepMinutes = val;
      saveSettings();
      const lbl = document.getElementById('lbl-sleep-val');
      if (lbl) {
        lbl.textContent = `${val} dk sonra`;
      }
    });
  }


  // App behavior toggles
  const chkAutostart = document.getElementById('chk-autostart');
  if (chkAutostart) {
    chkAutostart.addEventListener('change', async () => {
      const want = chkAutostart.checked;
      try {
        const result = await invoke('set_autostart', { enabled: want });
        if (result.success) state.app.autostart = want;
        setBackupStatus(result.success, result.message);
        chkAutostart.checked = !!state.app.autostart;
      } catch (e) {
        chkAutostart.checked = !!state.app.autostart;
        setBackupStatus(false, 'Ayar yazılamadı.');
      }
    });
  }

  const selLowBattery = document.getElementById('sel-low-battery');
  if (selLowBattery) {
    selLowBattery.addEventListener('change', () => {
      state.deviceSettings.lowBattery = Number(selLowBattery.value);
      saveSettings();
      sendLowBatteryAlert();
    });
  }

  const chkCloseTray = document.getElementById('chk-close-tray');
  if (chkCloseTray) {
    chkCloseTray.addEventListener('change', () => {
      state.deviceSettings.closeToTray = chkCloseTray.checked;
      saveSettings();
      sendCloseToTray();
    });
  }

  // Backup
  const btnExport = document.getElementById('btn-backup-export');
  if (btnExport) {
    btnExport.addEventListener('click', async () => {
      try {
        const where = await exportBackup(saveProfileStore);
        setBackupStatus(true, where ? `Yedek kaydedildi: ${where}` : '');
      } catch (e) {
        setBackupStatus(false, typeof e === 'string' ? e : (e.message || 'Yedek alınamadı.'));
      }
    });
  }

  const fileImport = document.getElementById('file-backup-import');
  const btnImport = document.getElementById('btn-backup-import');
  if (btnImport && fileImport) {
    btnImport.addEventListener('click', () => fileImport.click());
    fileImport.addEventListener('change', async () => {
      const file = fileImport.files[0];
      if (!file) return;
      if (!confirm('Mevcut profiller, makrolar, tuş atamaları ve ayarlar yedekteki ile değiştirilsin mi? Makro ve atamalar klavyeye yeniden yazılmalıdır.')) {
        fileImport.value = '';
        return;
      }
      try {
        await importBackup(file);
        location.reload();
      } catch (e) {
        fileImport.value = '';
        setBackupStatus(false, e.message || 'Yedek yüklenemedi.');
      }
    });
  }

  // Factory Reset
  const btnFactoryReset = document.getElementById('btn-factory-reset');
  if (btnFactoryReset) {
    btnFactoryReset.addEventListener('click', () => {
      if (confirm('Uygulama ayarları varsayılana dönsün mü?')) {
        state.activeEffect = 'wave';
        state.speed = 75;
        state.brightness = 100;
        state.direction = 0;
        state.colorType = 'rainbow';
        state.primaryColor = '#e50914';
        state.perKeyColors = {};
        state.deviceSettings.sleepMinutes = 5;
        savePerKeyColors();
        saveSettings();

        if (rgbEngine) {
          rgbEngine.clearCustomKeyColors();
          rgbEngine.setEffect('wave');
          rgbEngine.setSpeed(75);
          rgbEngine.setBrightness(100);
        }
        renderApp();
      }
    });
  }

  // Per-Key Apply Button
  const btnApplyPerKey = document.getElementById('btn-apply-per-key');
  if (btnApplyPerKey) {
    btnApplyPerKey.addEventListener('click', () => {
      state.activeEffect = 'custom_per_key';
      if (rgbEngine) {
        rgbEngine.setEffect('custom_per_key');
        Object.entries(state.perKeyColors).forEach(([k, col]) => {
          rgbEngine.setCustomKeyColor(k, col);
        });
      }
      renderApp();
    });
  }

  // Preset WASD
  const btnPresetWasd = document.getElementById('btn-preset-wasd');
  if (btnPresetWasd) {
    btnPresetWasd.addEventListener('click', () => {
      state.activeEffect = 'custom_per_key';
      state.perKeyColors = {};
      ['KeyW', 'KeyA', 'KeyS', 'KeyD'].forEach(c => state.perKeyColors[c] = '#00e5ff');
      ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].forEach(c => state.perKeyColors[c] = '#ff9100');
      ['Space', 'Enter'].forEach(c => state.perKeyColors[c] = '#00e676');
      ['Escape', 'Delete'].forEach(c => state.perKeyColors[c] = '#e50914');
      savePerKeyColors();

      if (rgbEngine) {
        rgbEngine.clearCustomKeyColors();
        rgbEngine.setEffect('custom_per_key');
        Object.entries(state.perKeyColors).forEach(([k, col]) => {
          rgbEngine.setCustomKeyColor(k, col);
        });
      }
      renderApp();
    });
  }

  // Preset MOBA
  const btnPresetMoba = document.getElementById('btn-preset-moba');
  if (btnPresetMoba) {
    btnPresetMoba.addEventListener('click', () => {
      state.activeEffect = 'custom_per_key';
      state.perKeyColors = {};
      ['KeyQ', 'KeyW', 'KeyE', 'KeyR'].forEach(c => state.perKeyColors[c] = '#00e5ff');
      ['KeyD', 'KeyF'].forEach(c => state.perKeyColors[c] = '#ff9100');
      ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'].forEach(c => state.perKeyColors[c] = '#d500f9');
      ['KeyB'].forEach(c => state.perKeyColors[c] = '#00e676');
      ['Space'].forEach(c => state.perKeyColors[c] = '#e50914');
      savePerKeyColors();

      if (rgbEngine) {
        rgbEngine.clearCustomKeyColors();
        rgbEngine.setEffect('custom_per_key');
        Object.entries(state.perKeyColors).forEach(([k, col]) => {
          rgbEngine.setCustomKeyColor(k, col);
        });
      }
      renderApp();
    });
  }

  // Preset All Red (Rampage signature)
  const btnPresetRed = document.getElementById('btn-preset-all-red');
  if (btnPresetRed) {
    btnPresetRed.addEventListener('click', () => {
      state.activeEffect = 'custom_per_key';
      state.perKeyColors = {};
      Object.keys(keyElementsMap).forEach(code => {
        state.perKeyColors[code] = '#e50914';
      });
      savePerKeyColors();

      if (rgbEngine) {
        rgbEngine.setEffect('custom_per_key');
        Object.entries(state.perKeyColors).forEach(([k, col]) => {
          rgbEngine.setCustomKeyColor(k, col);
        });
      }
      renderApp();
    });
  }

  // Reset Per Key
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
      wakeUpFromSleep();
      state.activeEffect = btn.getAttribute('data-effect');
      if (rgbEngine) rgbEngine.setEffect(state.activeEffect);
      renderApp();
    });
  });

  // Rainbow / Custom Mode Toggles
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

  // Color Swatches
  document.querySelectorAll('.color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      wakeUpFromSleep();
      state.primaryColor = sw.getAttribute('data-color');
      state.colorType = 'custom';

      if (state.activeEffect === 'custom_per_key' && state.selectedKey) {
        state.perKeyColors[state.selectedKey] = state.primaryColor;
        savePerKeyColors();
        if (rgbEngine) {
          rgbEngine.setCustomKeyColor(state.selectedKey, state.primaryColor);
        }
        const lbl = document.getElementById('lbl-color-val');
        if (lbl) lbl.textContent = state.primaryColor;
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
      wakeUpFromSleep();
      state.primaryColor = e.target.value;
      const lbl = document.getElementById('lbl-color-val');
      if (lbl) lbl.textContent = state.primaryColor;
      if (state.activeEffect === 'custom_per_key' && state.selectedKey) {
        state.perKeyColors[state.selectedKey] = state.primaryColor;
        if (rgbEngine) rgbEngine.setCustomKeyColor(state.selectedKey, state.primaryColor);
      }
    });

    colorPicker.addEventListener('change', (e) => {
      wakeUpFromSleep();
      state.primaryColor = e.target.value;
      if (state.activeEffect === 'custom_per_key' && state.selectedKey) {
        state.perKeyColors[state.selectedKey] = state.primaryColor;
        savePerKeyColors();
        if (rgbEngine) rgbEngine.setCustomKeyColor(state.selectedKey, state.primaryColor);
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

  // Add to Favorites
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

  // Speed Slider
  const sliderSpeed = document.getElementById('slider-speed');
  if (sliderSpeed) {
    sliderSpeed.addEventListener('input', (e) => {
      wakeUpFromSleep();
      state.speed = parseInt(e.target.value);
      if (rgbEngine) rgbEngine.speed = state.speed;
      const lbl = document.getElementById('lbl-speed-val');
      if (lbl) lbl.textContent = `${state.speed}%`;
    });
    sliderSpeed.addEventListener('change', (e) => {
      state.speed = parseInt(e.target.value);
      if (rgbEngine) rgbEngine.setSpeed(state.speed);
    });
  }

  // Brightness Slider
  const sliderBrightness = document.getElementById('slider-brightness');
  if (sliderBrightness) {
    sliderBrightness.addEventListener('input', (e) => {
      wakeUpFromSleep();
      state.brightness = parseInt(e.target.value);
      if (rgbEngine) rgbEngine.brightness = state.brightness;
      const lbl = document.getElementById('lbl-brightness-val');
      if (lbl) lbl.textContent = `${state.brightness}%`;
    });
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
      rgbEngine.setCustomKeyColor(code, col, true);
    });
    rgbEngine.start();
  } else {
    rgbEngine.setKeysMap(keyElementsMap);
    Object.entries(state.perKeyColors).forEach(([code, col]) => {
      rgbEngine.setCustomKeyColor(code, col, true);
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Intelligent Sleep & Energy Management Engine
// ─────────────────────────────────────────────────────────────
state.savedEffectBeforeSleep = {
  effect: 'wave',
  speed: 75,
  brightness: 100,
  colorType: 'rainbow',
  direction: 0,
  primaryColor: '#e50914'
};

function registerActivity() {
  lastActivityTimestamp = Date.now();
  if (state.isSleeping) {
    wakeUpFromSleep();
  }
}

// Send the current lighting state to the keyboard and the on-screen preview.
function applyLightingState() {
  // Restore hardware RGB lighting
  if (window.hidService) {
    if (state.activeEffect === 'custom_per_key') {
      window.hidService.sendPerKeyRGBReport(state.perKeyColors);
    } else {
      window.hidService.sendRGBReport(
        state.activeEffect,
        state.speed,
        state.brightness,
        state.primaryColor,
        {
          colorType: state.colorType,
          direction: state.direction
        }
      );
    }
  }

  if (rgbEngine) {
    rgbEngine.currentEffect = state.activeEffect;
    rgbEngine.speed = state.speed;
    rgbEngine.brightness = state.brightness;
    rgbEngine.colorType = state.colorType;
    rgbEngine.direction = state.direction;
    rgbEngine.primaryColor = state.primaryColor;
    if (state.activeEffect === 'custom_per_key') {
      // Drop the previous profile's colors; the keyboard already got the new map above.
      rgbEngine.customKeyColors = {};
      Object.entries(state.perKeyColors).forEach(([code, col]) => {
        rgbEngine.setCustomKeyColor(code, col, true);
      });
    } else {
      rgbEngine.clearCustomKeyColors();
      rgbEngine.setEffect(state.activeEffect);
    }
  }
}

function wakeUpFromSleep() {
  if (!state.isSleeping) return;
  state.isSleeping = false;

  // Restore saved active lighting effect and brightness
  if (state.savedEffectBeforeSleep) {
    state.activeEffect = state.savedEffectBeforeSleep.effect || 'wave';
    state.speed = state.savedEffectBeforeSleep.speed || 75;
    state.brightness = state.savedEffectBeforeSleep.brightness || 100;
    state.colorType = state.savedEffectBeforeSleep.colorType || 'rainbow';
    state.direction = state.savedEffectBeforeSleep.direction || 0;
    state.primaryColor = state.savedEffectBeforeSleep.primaryColor || '#e50914';
  }

  applyLightingState();

  renderApp();
}

function enterSleepMode() {
  if (state.isSleeping) return;

  // Save current active state before turning off LEDs
  if (state.activeEffect !== 'off') {
    state.savedEffectBeforeSleep = {
      effect: state.activeEffect,
      speed: state.speed,
      brightness: state.brightness,
      colorType: state.colorType,
      direction: state.direction,
      primaryColor: state.primaryColor
    };
  }

  state.isSleeping = true;

  // Send power-down (Mode 0: off) to keyboard hardware
  if (window.hidService) {
    window.hidService.sendRGBReport('off', 50, 0, '#000000', {
      colorType: 'custom',
      direction: 0
    });
  }

  renderApp();
}

// Check OS-Wide Physical Keyboard & Mouse Activity every 500ms
setInterval(async () => {
  if (!state.deviceSettings.sleepEnabled) return;
  const sleepThresholdMs = (state.deviceSettings.sleepMinutes || 5) * 60 * 1000;

  try {
    const osIdleMs = await invoke('get_system_idle_ms');
    
    if (state.isSleeping) {
      // If sleeping and user pressed ANY physical key or moved mouse anywhere on the PC
      if (osIdleMs < 1500) {
        lastActivityTimestamp = Date.now();
        wakeUpFromSleep();
      }
    } else {
      // If idle across the entire operating system for >= sleepThresholdMs
      if (osIdleMs >= sleepThresholdMs) {
        enterSleepMode();
      }
    }
  } catch (e) {
    // Fallback to webview DOM idle tracking
    const domIdleMs = Date.now() - lastActivityTimestamp;
    if (!state.isSleeping && domIdleMs >= sleepThresholdMs) {
      enterSleepMode();
    }
  }
}, 500);

// Global User Activity Listeners
['mousemove', 'mousedown', 'wheel', 'touchstart', 'pointerdown', 'pointermove'].forEach(evt => {
  window.addEventListener(evt, registerActivity, { passive: true });
});
window.addEventListener('focus', registerActivity);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) registerActivity();
});

// Global Keydown Handler for Hardware Press Simulation & Switch Tester
window.addEventListener('keydown', (e) => {
  registerActivity();

  const now = performance.now();
  const lastPress = switchTester.lastPressTimeByKey[e.code] || 0;
  const timeSinceLastPress = now - lastPress;
  switchTester.lastPressTimeByKey[e.code] = now;

  // Time between two presses of the same key & chatter check
  switchTester.lastKey = e.key.length === 1 ? e.key.toUpperCase() : e.code;
  switchTester.latency = lastPress && !e.repeat ? `${Math.round(timeSinceLastPress)} ms` : '--';
  switchTester.totalPresses++;

  if (timeSinceLastPress > 0 && timeSinceLastPress < CHATTER_MS) {
    switchTester.chatterFiltered++;
  }

  // Update switch tester UI if on Settings tab
  const testerKeyEl = document.getElementById('tester-last-key');
  if (testerKeyEl) {
    testerKeyEl.textContent = switchTester.lastKey;
  }
  const testerLatEl = document.getElementById('tester-latency');
  if (testerLatEl) {
    testerLatEl.textContent = switchTester.latency;
  }
  const badgeChatter = document.getElementById('badge-chatter-status');
  if (badgeChatter) {
    badgeChatter.innerHTML = switchTester.chatterFiltered === 0
      ? 'Çift basma yok'
      : `<span style="color:var(--accent-amber);">${switchTester.chatterFiltered} çift basma</span>`;
  }

  if (rgbEngine && keyElementsMap[e.code]) {
    rgbEngine.triggerKeyRipple(e.code);
  }
});

// Hardware Sync Map
const modeIdToEffect = {
  1: 'static', 2: 'breathing', 3: 'spectrum', 4: 'wave',
  5: 'ripple', 6: 'stardots', 7: 'flow', 8: 'keyshadow',
  9: 'layers', 10: 'sine', 11: 'spring', 12: 'neon',
  14: 'radiant', 15: 'loop', 16: 'colorgrid', 17: 'snowfall',
  18: 'meteor', 19: 'silentsnow', 0: 'off'
};

// Tauri Hardware Sync Listener
try {
  listen('hardware-rgb-sync', ({ payload: hw }) => {
    state.deviceConnected = true;

    // If device was sleeping and hardware mode changes (e.g. user pressed Fn shortcut), wake up!
    if (state.isSleeping) {
      if (hw.mode !== 0) {
        state.isSleeping = false;
      } else {
        // Mode is 0 because we commanded sleep -> don't overwrite saved settings
        return;
      }
    }

    const effectName = hw.mode === 13 ? 'custom_per_key' : (modeIdToEffect[hw.mode] || 'static');
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
      if (effectName === 'custom_per_key') {
        Object.entries(state.perKeyColors).forEach(([code, col]) => {
          rgbEngine.setCustomKeyColor(code, col, true);
        });
      } else {
        rgbEngine.clearCustomKeyColors();
        rgbEngine.setEffect(effectName);
      }
    }
    renderApp();
  });

  // Initial state sync on app load
  invoke('get_hardware_rgb_state').then(hw => {
    if (hw) {
      state.deviceConnected = true;
      const effectName = hw.mode === 13 ? 'custom_per_key' : (modeIdToEffect[hw.mode] || 'static');
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
        if (effectName === 'custom_per_key') {
          Object.entries(state.perKeyColors).forEach(([code, col]) => {
            rgbEngine.setCustomKeyColor(code, col, true);
          });
        }
      }
    } else {
      state.deviceConnected = false;
    }
    renderApp();
  }).catch(() => {
    state.deviceConnected = false;
    renderApp();
  });
} catch (e) {
  console.log('[Sync] Tauri event listener kurulamadı:', e.message);
}

// Initial Battery and Connection Check
function setBackupStatus(ok, text) {
  state.app.message = text ? { ok, text } : null;
  const el = document.getElementById('backup-status');
  if (el) {
    el.textContent = text || '';
    el.className = 'debounce-status ' + (text ? (ok ? 'ok' : 'error') : '');
  }
}

// Settings saved before this option existed have no value: that means on.
function closeToTrayEnabled() {
  return state.deviceSettings.closeToTray !== false;
}

function lowBatteryLevel() {
  const v = state.deviceSettings.lowBattery;
  return Number.isFinite(v) ? v : 20;
}

function sendLowBatteryAlert() {
  if (isTauri()) invoke('set_low_battery_alert', { percent: lowBatteryLevel() }).catch(() => {});
}

function sendCloseToTray() {
  if (isTauri()) invoke('set_close_to_tray', { enabled: closeToTrayEnabled() }).catch(() => {});
}

async function loadAutostart() {
  if (!isTauri()) return;
  try {
    state.app.autostart = await invoke('get_autostart');
    if (state.activeTab === 'settings') renderApp();
  } catch (e) { /* leave the toggle disabled */ }
}

function setDebounceStatus(ok, text) {
  state.hw.message = text ? { ok, text } : null;
  const el = document.getElementById('debounce-status');
  if (el) {
    el.textContent = text || '';
    el.className = 'debounce-status ' + (text ? (ok ? 'ok' : 'error') : '');
  }
}

// Write the debounce level to the keyboard (takes a few seconds over the dongle).
async function applyDebounce(level) {
  if (!isTauri()) {
    setDebounceStatus(false, 'Tarayıcı önizlemesinde klavyeye yazılamaz.');
    return;
  }
  setDebounceStatus(true, 'Klavyeye yazılıyor…');
  try {
    const result = await invoke('set_debounce', { level });
    if (result.success) state.hw.debounce = level;
    setDebounceStatus(result.success, result.message);
  } catch (e) {
    setDebounceStatus(false, typeof e === 'string' ? e : (e.message || 'Yazılamadı.'));
  }
}

// Read debounce level and firmware version from the keyboard.
let hwSettingsRequested = false;
async function loadDeviceSettings() {
  if (!isTauri()) return;
  hwSettingsRequested = true;
  try {
    const settings = await invoke('read_device_settings');
    state.hw.debounce = settings.debounce ?? state.hw.debounce;
    state.hw.firmware = settings.firmware ?? state.hw.firmware;
    if (state.activeTab === 'settings') renderApp();
  } catch (e) {
    // Keyboard asleep or busy: retry later, not on every status check.
    setTimeout(() => { hwSettingsRequested = false; }, 15000);
  }
}

async function refreshHardwareStatus() {
  try {
    let connStatus = null;
    let batStatus = null;

    // Tauri v2 only defines window.__TAURI__ with `withGlobalTauri`; isTauri() always works.
    if (isTauri()) {
      [connStatus, batStatus] = await Promise.all([
        invoke('get_connection_status').catch(() => null),
        invoke('get_battery_status').catch(() => null)
      ]);
    }

    let changed = false;

    if (connStatus) {
      if (state.deviceConnected !== connStatus.connected || state.connectionType !== connStatus.connectionType) {
        state.deviceConnected = connStatus.connected;
        state.connectionType = connStatus.connectionType;
        state.deviceName = connStatus.productName;
        changed = true;
      }
      if (!connStatus.connected) hwSettingsRequested = false;
      else if (!hwSettingsRequested) loadDeviceSettings();
    } else {
      // Browser preview: no keyboard access, show a simulated wired device.
      // (navigator.getBattery() would report the PC's battery, not the keyboard's.)
      if (!isTauri() && !state.deviceConnected) {
        state.deviceConnected = true;
        batStatus = {
          percentage: 100,
          isCharging: true,
          isConnected: true,
          connectionType: 'wired',
          statusText: 'Kablolu Şarj (USB 5V)'
        };
        changed = true;
      }
    }

    if (batStatus) {
      if (batStatus.connectionType !== 'wired' && batStatus.isConnected) rememberBattery(batStatus.percentage);
      if (state.battery.percentage !== batStatus.percentage ||
          state.battery.isCharging !== batStatus.isCharging ||
          state.battery.connectionType !== batStatus.connectionType) {
        state.battery = batStatus;
        changed = true;
      }
    }

    if (changed) {
      renderApp();
    }
  } catch (e) {}
}

initMacros({ rerender: renderApp, beforeOpen: cancelRemapEdit, takenKeys: remapKeys, onRestored: markRemapsUnsynced });
initRemap({ rerender: renderApp, beforeOpen: cancelMacroEdit, takenKeys: macroKeys });

sendCloseToTray();
sendLowBatteryAlert();
loadAutostart();

// Initial Render and Hardware Query
refreshHardwareStatus();
renderApp();

// Periodic Live Connection & Battery Poller (Every 1500ms)
setInterval(refreshHardwareStatus, 1500);

