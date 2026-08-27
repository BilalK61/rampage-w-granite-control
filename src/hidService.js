/**
 * HID Service — Tauri adapter
 *
 * Replaces the Electron ipcRenderer.invoke() calls with Tauri's invoke().
 * The API surface is identical to the old HIDService class so no changes
 * are needed in rgbEngine.js or main.js.
 *
 * Migration change summary:
 *   BEFORE: const { ipcRenderer } = window.require('electron');
 *           await ipcRenderer.invoke('send-native-hid-rgb', payload);
 *   AFTER:  import { invoke } from '@tauri-apps/api/core';
 *           await invoke('send_native_hid_rgb', payload);
 *
 * Note: Tauri command names use snake_case; Electron used kebab-case.
 */

import { invoke } from '@tauri-apps/api/core';

async function tauriInvoke(command, payload) {
  try {
    return await invoke(command, { payload });
  } catch (err) {
    console.warn(`[HID] Tauri invoke '${command}' failed:`, err);
    return { success: false, message: typeof err === 'string' ? err : (err.message || 'Hata') };
  }
}

export class HIDService {
  constructor() {
    this.device = null;
    this.isConnected = false;
    this.listeners = [];
    this.isTauri = !!(window.__TAURI__);
  }

  onStatusChange(callback) {
    this.listeners.push(callback);
  }

  notifyStatus() {
    this.listeners.forEach(fn => fn(this.isConnected, this.device));
  }

  log(msg) {
    console.log('[HID Log]', msg);
    const logEl = document.getElementById('hid-debug-log');
    if (logEl) logEl.textContent = msg;
  }

  async connectHID() {
    if (this.isTauri) {
      this.isConnected = true;
      this.device = { productName: 'Rampage W-Granite (Native Tauri/hidapi Driver Active)' };
      this.log('Tauri hidapi sürücüsü aktif! Donanım kilidi yok.');
      this.notifyStatus();
      return { success: true, deviceName: this.device.productName };
    }

    // Browser fallback (WebHID — for non-Tauri dev preview)
    if (!('hid' in navigator)) {
      this.simulateConnection();
      return { success: true, simulated: true };
    }

    try {
      const devices = await navigator.hid.requestDevice({ filters: [] });
      if (devices.length > 0) {
        this.device = devices[0];
        if (!this.device.opened) await this.device.open();
        this.isConnected = true;
        this.log(`Bağlandı: ${this.device.productName || 'USB Klavye'}`);
        this.notifyStatus();
        return { success: true, deviceName: this.device.productName };
      }
    } catch (err) {
      this.simulateConnection();
    }
    return { success: true, simulated: true };
  }

  simulateConnection() {
    this.device = { productName: 'Rampage W-Granite (Simülasyon Sürücüsü)' };
    this.isConnected = true;
    this.notifyStatus();
  }

  async sendRGBReport(effectMode, speed, brightness, primaryColorHex, options = {}) {
    const hex = (primaryColorHex || '#8b5cf6').replace('#', '').padEnd(6, '0');
    const r = parseInt(hex.substring(0, 2), 16) || 0;
    const g = parseInt(hex.substring(2, 4), 16) || 0;
    const b = parseInt(hex.substring(4, 6), 16) || 0;
    const { colorType = 'custom', direction = 0 } = options;

    const res = await tauriInvoke('send_native_hid_rgb', {
      r, g, b, effectMode, speed, brightness, colorType, direction
    });
    if (res) this.log(res.message);
    return res;
  }

  async sendSideRGBReport(sideMode, speed, brightness, primaryColorHex, flags = 0x07) {
    const hex = (primaryColorHex || '#8b5cf6').replace('#', '').padEnd(6, '0');
    const r = parseInt(hex.substring(0, 2), 16) || 0;
    const g = parseInt(hex.substring(2, 4), 16) || 0;
    const b = parseInt(hex.substring(4, 6), 16) || 0;

    const res = await tauriInvoke('send_native_side_rgb', {
      r, g, b, sideMode, speed, brightness, flags
    });
    if (res) this.log(res.message);
    return res;
  }

  // Send Per-Key Custom RGB Map to Hardware
  async sendPerKeyRGBReport(perKeyColorMap) {
    try {
      const res = await invoke('send_native_perkey_rgb', { perKeyColorMap });
      if (res) this.log(res.message);
      return res;
    } catch (err) {
      console.warn('[HID] send_native_perkey_rgb failed:', err);
      return { success: false, message: typeof err === 'string' ? err : (err.message || 'Hata') };
    }
  }
}
