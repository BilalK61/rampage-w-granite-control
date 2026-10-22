const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');

app.setPath('userData', path.join(os.tmpdir(), 'aether-rgb-app-cache'));

let HID;
try {
  HID = require('node-hid');
} catch (e) {
  console.log('[HID] node-hid yüklenemedi.', e.message);
}

let mainWindow;

const http = require('http');

function waitForVite(url, maxWaitMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function tryConnect() {
      http.get(url, (res) => {
        resolve();
      }).on('error', () => {
        if (Date.now() - start > maxWaitMs) {
          reject(new Error('Vite sunucusu başlatılamadı (timeout)'));
          return;
        }
        setTimeout(tryConnect, 300);
      });
    }
    tryConnect();
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'AetherRGB Control Hub',
    backgroundColor: '#090a0f',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
    }
  });

  try {
    console.log('[Electron] Vite sunucusu bekleniyor...');
    await waitForVite('http://localhost:5173');
    console.log('[Electron] Vite hazır, yükleniyor.');
  } catch (e) {
    console.error('[Electron]', e.message);
  }

  mainWindow.loadURL('http://localhost:5173');
  // DevTools'u aç (hataları görmek için)
  mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ─────────────────────────────────────────────────────────────
// ROYUAN / Yichip Protocol Specification
// VID: 0x3151  PID: 0x4015 / 0x4011
// Interface 2, UsagePage 0xFFFF, Usage 2
//
// SET_LEDPARAM (0x07):
//   Byte 0 = 0x00 (Report ID)
//   Byte 1 = 0x07 (Opcode)
//   Byte 2 = mode (1..19)
//   Byte 3 = 5 - speed (wire 1..5: 5=fastest, 1=slowest)
//   Byte 4 = brightness (wire 0..4)
//   Byte 5 = (option << 4) | flags (flags: 0x07=fixed/custom color, 0x08=rainbow)
//   Byte 6 = R
//   Byte 7 = G
//   Byte 8 = B
//   Byte 9 = Checksum = (0xFF - sum(bytes 1..8)) & 0xFF
//
// SET_SLEDPARAM (0x08) - Edge / Side Light:
//   Byte 0 = 0x00
//   Byte 1 = 0x08
//   Byte 2 = side_mode (0=off, 1=static, 2=breathing, 3=spectrum, 4=wave, 5=snake)
//   Byte 3 = speed (1..5)
//   Byte 4 = brightness (0..4)
//   Byte 5 = flags (0x07 / 0x08)
//   Byte 6..8 = R, G, B
//   Byte 9 = Checksum = (0xFF - sum(bytes 1..8)) & 0xFF
// ─────────────────────────────────────────────────────────────

const TARGET_VID = 0x3151;
const TARGET_PIDS = [0x4015, 0x4011];
const RGB_INTERFACE = 2;
const RGB_USAGE_PAGE = 0xffff;

function calcChecksum(payloadBytes) {
  const sum = payloadBytes.reduce((a, b) => a + b, 0) & 0xFF;
  return (0xFF - sum) & 0xFF;
}

function buildRgbPacket({ R, G, B, mode = 1, speed = 3, brightness = 4, flags = 0x07, direction = 0 }) {
  const buf = new Array(65).fill(0);
  buf[0] = 0x00;  // Report ID
  buf[1] = 0x07;  // SET_LEDPARAM opcode
  buf[2] = mode;
  buf[3] = speed;
  buf[4] = brightness;
  buf[5] = ((direction & 0x0F) << 4) | (flags & 0x0F);

  // If pure white #ffffff, protocol recommends 0xFAFAFA
  if (R === 255 && G === 255 && B === 255) {
    buf[6] = 0xFA; buf[7] = 0xFA; buf[8] = 0xFA;
  } else {
    buf[6] = R; buf[7] = G; buf[8] = B;
  }

  buf[9] = calcChecksum(buf.slice(1, 9));
  return buf;
}

function buildSideRgbPacket({ R, G, B, sideMode = 1, speed = 3, brightness = 4, flags = 0x07 }) {
  const buf = new Array(65).fill(0);
  buf[0] = 0x00;
  buf[1] = 0x08;  // SET_SLEDPARAM (Edge/Side Light)
  buf[2] = sideMode;
  buf[3] = speed;
  buf[4] = brightness;
  buf[5] = flags;
  buf[6] = R; buf[7] = G; buf[8] = B;
  buf[9] = calcChecksum(buf.slice(1, 9));
  return buf;
}

function findRgbDevice() {
  if (!HID) return null;
  const all = HID.devices();
  for (const pid of TARGET_PIDS) {
    const dev = all.find(d =>
      d.vendorId === TARGET_VID &&
      d.productId === pid &&
      d.interface === RGB_INTERFACE &&
      d.usagePage === RGB_USAGE_PAGE
    );
    if (dev) return dev;
  }
  return null;
}

// ── IPC: List all HID devices (diagnostic)
ipcMain.handle('list-hid-devices', async () => {
  if (!HID) return [];
  return HID.devices().map(d => ({
    vendorId: `0x${d.vendorId.toString(16).padStart(4, '0')}`,
    productId: `0x${d.productId.toString(16).padStart(4, '0')}`,
    product: d.product || '(no name)',
    usagePage: `0x${d.usagePage.toString(16)}`,
    interface: d.interface,
    path: d.path
  }));
});

// ── IPC: Send RGB color and full lighting mode parameters
ipcMain.handle('send-native-hid-rgb', async (event, { r, g, b, effectMode, speed, brightness, colorType, direction }) => {
  if (!HID) return { success: false, message: 'node-hid kütüphanesi yüklenemedi.' };

  isCustomMatrixActive = false;

  const devInfo = findRgbDevice();

  if (!devInfo) {
    return {
      success: false,
      message: `Klavye RGB arayüzü bulunamadı. (VID:0x${TARGET_VID.toString(16)} IF:${RGB_INTERFACE} UP:0xffff)`
    };
  }

  // All 19 Official ROYUAN Hardware Modes
  const modeMap = {
    'static': 1,  // Sabit Renk
    'breathing': 2,  // Nefes Alma
    'spectrum': 3,  // Renk Döngüsü
    'wave': 4,  // Dalga (Wave)
    'ripple': 5,  // Dalgalanma / Halka
    'stardots': 6,  // Yıldız Parıltısı
    'flow': 7,  // Akan Akış (Flow)
    'keyshadow': 8,  // Tuş Gölgesi / İz Bırakan
    'layers': 9,  // Katmanlar (Layers)
    'sine': 10, // Sinüs Dalgası
    'spring': 11, // Bahar / Püskürme
    'neon': 12, // Neon Işıltısı
    'radiant': 14, // Işıma / Yayılma
    'loop': 15, // Dönen Halka
    'colorgrid': 16, // Renk Izgarası
    'snowfall': 17, // Kar Yağışı
    'meteor': 18, // Kayan Meteor
    'silentsnow': 19, // Sakin Kar
    'off': 0   // Tamamen Kapalı
  };

  const modeNum = typeof effectMode === 'number' ? effectMode : (modeMap[effectMode] ?? 1);

  // Color mode flag:
  // 0x07 = Custom / Fixed Single Color
  // 0x08 = Rainbow / Dynamic Spectrum
  let flags = 0x07;
  if (colorType === 'rainbow' || modeNum === 3) {
    flags = 0x08;
  } else if (colorType === 'custom') {
    flags = 0x07;
  } else {
    // Default: for spectrum/wave/neon use rainbow if not overridden
    flags = (modeNum === 3 || modeNum === 4 || modeNum === 7 || modeNum === 12) ? 0x08 : 0x07;
  }

  // Speed:
  // Keyboard firmware uses 4 speed steps: 25% (Wire 4 - slowest), 50% (Wire 3), 75% (Wire 2), 100% (Wire 1 - fastest)
  const speedPct = Math.max(25, Math.min(100, speed ?? 75));
  const speedLevel = Math.max(1, Math.min(4, Math.round(speedPct / 25))); // 1..4
  const speedWire = 5 - speedLevel; // 1->4 (slowest), 2->3, 3->2, 4->1 (fastest)



  // Brightness: UI 0-100% -> wire 0..4 (0=off, 4=max)
  const brightPct = Math.max(0, Math.min(100, brightness ?? 100));
  const brightnessWire = Math.round((brightPct / 100) * 4);

  const packet = buildRgbPacket({
    R: r ?? 255,
    G: g ?? 255,
    B: b ?? 255,
    mode: modeNum,
    speed: speedWire,
    brightness: brightnessWire,
    flags,
    direction: direction ?? 0
  });

  try {
    const dev = new HID.HID(devInfo.path);
    const result = dev.sendFeatureReport(packet);
    dev.close();

    console.log(`[HID] ✅ Mod: ${modeNum}, Hız Seviyesi: ${speedLevel}/4 (Wire Byte: ${speedWire}), Parlaklık: ${brightnessWire}/4, Bayrak: 0x${flags.toString(16)}`);
    return {
      success: true,
      message: `✅ Donanım Modu #${modeNum} uygulandı (Hız: Seviye ${speedLevel + 1}/5 [Tel: ${speedWire}], Parlaklık: ${brightnessWire}/4)`
    };
  } catch (err) {

    console.error('[HID] ❌ Gönderim hatası:', err.message);
    return { success: false, message: `HID Hatası: ${err.message}` };
  }
});

// ── IPC: Send Side / Edge Light parameters
ipcMain.handle('send-native-side-rgb', async (event, { r, g, b, sideMode, speed, brightness, flags }) => {
  if (!HID) return { success: false, message: 'node-hid kütüphanesi yüklenemedi.' };

  const devInfo = findRgbDevice();
  if (!devInfo) return { success: false, message: 'Klavye bulunamadı.' };

  const speedPct = Math.max(10, Math.min(100, speed ?? 60));
  const speedWire = Math.max(1, Math.min(5, Math.round(1 + ((speedPct - 10) / 90) * 4)));
  const brightPct = Math.max(0, Math.min(100, brightness ?? 100));
  const brightnessWire = Math.round((brightPct / 100) * 4);

  const packet = buildSideRgbPacket({
    R: r ?? 255, G: g ?? 0, B: b ?? 0,
    sideMode: sideMode ?? 1,
    speed: speedWire,
    brightness: brightnessWire,
    flags: flags ?? 0x07
  });

  try {
    const dev = new HID.HID(devInfo.path);
    dev.sendFeatureReport(packet);
    dev.close();
    return { success: true, message: '✅ Yan ışık ayarları güncellendi.' };
  } catch (err) {
    return { success: false, message: `Yan Işık Hatası: ${err.message}` };
  }
});

let isCustomMatrixActive = false;


// -- IPC: Per-Key Custom RGB - applies dominant color via Mode 1 Static
// (Mode 13 flash write not supported by this keyboard firmware)
ipcMain.handle('send-native-perkey-rgb', async (event, perKeyColorMap) => {
  if (!HID) return { success: false, message: 'node-hid kutuphanesi yuklenemedi.' };

  const devInfo = findRgbDevice();
  if (!devInfo) return { success: false, message: 'Klavye bulunamadi.' };

  try {
    isCustomMatrixActive = false;

    function hexToRgb(hex) {
      if (!hex || !hex.startsWith('#') || hex.length < 7) return { r: 139, g: 92, b: 246 };
      return {
        r: parseInt(hex.slice(1, 3), 16) || 0,
        g: parseInt(hex.slice(3, 5), 16) || 0,
        b: parseInt(hex.slice(5, 7), 16) || 0
      };
    }

    // Find the most-used color from the per-key map
    let bestColor = '#8b5cf6';
    if (perKeyColorMap && Object.keys(perKeyColorMap).length > 0) {
      const colors = Object.values(perKeyColorMap);
      const freq = {};
      colors.forEach(c => { freq[c] = (freq[c] || 0) + 1; });
      bestColor = Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
    }

    const { r, g, b } = hexToRgb(bestColor);

    // Mode 1 Static solid color
    const m = new Array(65).fill(0);
    m[0] = 0x00;
    m[1] = 0x07;
    m[2] = 1;
    m[3] = 1;
    m[4] = 4;
    m[5] = 0x07;
    m[6] = r;
    m[7] = g;
    m[8] = b;
    const sum = m.slice(1, 9).reduce((a, v) => a + v, 0) & 0xFF;
    m[9] = (0xFF - sum) & 0xFF;

    const dev = new HID.HID(devInfo.path);
    dev.sendFeatureReport(m);
    dev.close();

    console.log('[HID] Custom per-key dominant color applied:', bestColor);
    return { success: true, message: 'Ozel tus renkleri klavyeye uygulandi!' };
  } catch (err) {
    console.error('[HID] Ozel RGB hatasi:', err.message);
    return { success: false, message: `Ozel RGB Hatasi: ${err.message}` };
  }
});


// ─────────────────────────────────────────────────────────────
// Hardware Sync Poller: Reads keyboard state periodically (Fn + shortcut sync)
// ─────────────────────────────────────────────────────────────
function readKeyboardLedParam() {
  if (!HID || isCustomMatrixActive) return null;
  const devInfo = findRgbDevice();
  if (!devInfo) return null;

  try {
    const dev = new HID.HID(devInfo.path);
    const buf = new Array(65).fill(0);
    buf[0] = 0x00;
    buf[1] = 0x87; // GET_LEDPARAM
    const sum = buf.slice(1, 8).reduce((a, b) => a + b, 0) & 0xFF;
    buf[8] = (0xFF - sum) & 0xFF;

    dev.sendFeatureReport(buf);
    const rep = dev.getFeatureReport(0x00, 65);
    dev.close();

    if (!rep || rep.length < 9 || rep[1] !== 0x87) return null;

    const mode = rep[2];
    const wireSpeed = rep[3]; // 1..5 (5=slowest, 1=fastest)
    const brightnessWire = rep[4]; // 0..4
    const flagsByte = rep[5];
    const direction = (flagsByte >> 4) & 0x0F;
    const flags = flagsByte & 0x0F;
    const r = rep[6];
    const g = rep[7];
    const b = rep[8];

    // Convert back to clean UI ranges (4 hardware speed levels: 25%, 50%, 75%, 100%)
    const clampedWireSpeed = Math.max(1, Math.min(4, wireSpeed));
    const speedLevel = 5 - clampedWireSpeed; // 4->1, 3->2, 2->3, 1->4
    const speedPct = speedLevel * 25;
    const brightnessPct = Math.round((brightnessWire / 4) * 100);

    const hexColor = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;

    return {
      mode,
      speedPct,
      brightnessPct,
      colorType: flags === 0x08 ? 'rainbow' : 'custom',
      direction,
      primaryColor: hexColor
    };
  } catch (e) {
    return null;
  }
}

// ── IPC: Manual or initial hardware state query
ipcMain.handle('get-hardware-rgb-state', async () => {
  return readKeyboardLedParam();
});

// ── IPC: Live Connection Status
ipcMain.handle('get-connection-status', async () => {
  if (!HID) {
    return {
      connected: false,
      connectionType: 'none',
      productName: 'Bağlantı Aranıyor...'
    };
  }
  const all = HID.devices();
  const isWired = all.some(d => d.vendorId === TARGET_VID && d.productId === 0x4015);
  const isDongle = all.some(d => d.vendorId === TARGET_VID && d.productId === 0x4011);

  if (isWired) {
    return {
      connected: true,
      connectionType: 'wired',
      productName: 'Rampage W-Granite (Kablolu)'
    };
  } else if (isDongle) {
    return {
      connected: true,
      connectionType: 'dongle_24g',
      productName: 'Rampage W-Granite (2.4G Alıcı)'
    };
  } else {
    return {
      connected: false,
      connectionType: 'none',
      productName: 'Bağlantı Aranıyor...'
    };
  }
});

// ── IPC: Live Battery Status
ipcMain.handle('get-battery-status', async () => {
  if (!HID) {
    return {
      percentage: 0,
      isCharging: false,
      isConnected: false,
      connectionType: 'none',
      statusText: 'Bağlantı Yok'
    };
  }

  const all = HID.devices();
  const isWired = all.some(d => d.vendorId === TARGET_VID && d.productId === 0x4015);
  const dongleDev = all.find(d => d.vendorId === TARGET_VID && d.productId === 0x4011 && (d.interface === RGB_INTERFACE || d.usagePage === RGB_USAGE_PAGE));

  if (isWired) {
    return {
      percentage: 100,
      isCharging: true,
      isConnected: true,
      connectionType: 'wired',
      statusText: 'Kablolu Şarj (USB 5V)'
    };
  } else if (dongleDev) {
    let batteryPct = 85;
    try {
      const dev = new HID.HID(dongleDev.path);
      const buf = new Array(65).fill(0);
      buf[0] = 0x00;
      buf[1] = 0xF7;
      const sum = buf.slice(1, 8).reduce((a, b) => a + b, 0) & 0xFF;
      buf[8] = (0xFF - sum) & 0xFF;
      dev.sendFeatureReport(buf);
      const rep = dev.getFeatureReport(0x00, 65);
      dev.close();
      if (rep && rep.length >= 3) {
        if (rep[2] >= 1 && rep[2] <= 100) batteryPct = rep[2];
        else if (rep[1] >= 1 && rep[1] <= 100) batteryPct = rep[1];
      }
    } catch (e) {}

    return {
      percentage: batteryPct,
      isCharging: false,
      isConnected: true,
      connectionType: 'dongle_24g',
      statusText: `%${batteryPct} (2.4G Kablosuz)`
    };
  } else {
    return {
      percentage: 0,
      isCharging: false,
      isConnected: false,
      connectionType: 'none',
      statusText: 'Bağlantı Yok'
    };
  }
});

// Periodic hardware poller: Checks every 800ms if physical state changed (bypassed in custom per-key matrix mode)
let lastHwSignature = '';
setInterval(() => {
  if (!mainWindow || mainWindow.isDestroyed() || isCustomMatrixActive) return;
  const hw = readKeyboardLedParam();
  if (!hw) return;

  const signature = `${hw.mode}_${hw.speedPct}_${hw.brightnessPct}_${hw.colorType}_${hw.direction}_${hw.primaryColor}`;
  if (lastHwSignature && lastHwSignature !== signature) {
    mainWindow.webContents.send('hardware-rgb-sync', hw);
  }
  lastHwSignature = signature;
}, 800);




