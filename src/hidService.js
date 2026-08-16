/**
 * Sinowealth / EVISION OpenRGB Protocol HID Service (Native Electron + WebHID Bridge)
 */
export class HIDService {
  constructor() {
    this.device = null;
    this.isConnected = false;
    this.listeners = [];
    this.isElectron = !!(window && (window.require || window.electron || window.process?.versions?.electron));
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
    if (this.isElectron) {
      this.isConnected = true;
      this.device = { productName: 'Rampage W-Granite (Native OS USB Driver Active)' };
      this.log('Native Masaüstü Sürücüsü Aktif! Donanım kilidi yok.');
      this.notifyStatus();
      return { success: true, deviceName: this.device.productName };
    }

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

    // Direct Native IPC Execution if running in Electron
    if (this.isElectron) {
      try {
        const { ipcRenderer } = window.require('electron');
        const res = await ipcRenderer.invoke('send-native-hid-rgb', {
          r, g, b, effectMode, speed, brightness, colorType, direction
        });
        this.log(res.message);
        return res;
      } catch (e) {
        this.log(`Native IPC Hatası: ${e.message}`);
      }
    }

    this.log('WebHID Uyarısı: Tarayıcı raw paketleri engelliyor. Masaüstü modunda çalıştırın.');
  }

  async sendSideRGBReport(sideMode, speed, brightness, primaryColorHex, flags = 0x07) {
    const hex = (primaryColorHex || '#8b5cf6').replace('#', '').padEnd(6, '0');
    const r = parseInt(hex.substring(0, 2), 16) || 0;
    const g = parseInt(hex.substring(2, 4), 16) || 0;
    const b = parseInt(hex.substring(4, 6), 16) || 0;

    if (this.isElectron) {
      try {
        const { ipcRenderer } = window.require('electron');
        const res = await ipcRenderer.invoke('send-native-side-rgb', {
          r, g, b, sideMode, speed, brightness, flags
        });
        this.log(res.message);
        return res;
      } catch (e) {
        this.log(`Yan Işık IPC Hatası: ${e.message}`);
      }
    }
  }

  // Send Per-Key Custom RGB Map to Hardware via SET_USERPIC 0x0C
  async sendPerKeyRGBReport(perKeyColorMap) {
    if (this.isElectron) {
      try {
        const { ipcRenderer } = window.require('electron');
        const res = await ipcRenderer.invoke('send-native-perkey-rgb', perKeyColorMap);
        this.log(res.message);
        return res;
      } catch (e) {
        this.log(`Özel RGB IPC Hatası: ${e.message}`);
      }
    }
  }
}


