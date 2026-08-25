/**
 * Royuan Profile + Userpic Slot Testi
 */
const HID = require('node-hid');
const TARGET_VID = 0x3151;
const TARGET_PIDS = [0x4015, 0x4011];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function bit7checksum(buf) {
  let sum = 0;
  for (let i = 0; i <= 6; i++) sum += buf[i];
  return (0xFF - (sum & 0xFF)) & 0xFF;
}

function bit8checksum(buf) {
  let sum = 0;
  for (let i = 0; i <= 7; i++) sum += buf[i];
  return (0xFF - (sum & 0xFF)) & 0xFF;
}

function findDevice() {
  const all = HID.devices();
  for (const pid of TARGET_PIDS)
    for (const d of all)
      if (d.vendorId === TARGET_VID && d.productId === pid && d.interface === 2 && d.usagePage === 0xffff)
        return d;
}

async function feat(path, buf, label = '') {
  try {
    const d = new HID.HID(path);
    d.sendFeatureReport(buf);
    d.close();
    if (label) console.log(`  ✅ ${label}`);
    return true;
  } catch (e) {
    if (label) console.log(`  ❌ ${label}: ${e.message.split('\n')[0]}`);
    return false;
  }
}

async function main() {
  const dev = findDevice();
  if (!dev) { console.error('Klavye bulunamadı!'); process.exit(1); }
  const p = dev.path;

  // 1. Önce Profile 0'a geç (0x05 / 0x04)
  console.log('1. Profile 0 aktif ediliyor...');
  const pBuf1 = new Array(65).fill(0);
  pBuf1[0] = 0x00; pBuf1[1] = 0x05; pBuf1[2] = 0; pBuf1[7] = bit7checksum(pBuf1);
  await feat(p, pBuf1, 'SET_PROFILE (0x05) -> 0');

  const pBuf2 = new Array(65).fill(0);
  pBuf2[0] = 0x00; pBuf2[1] = 0x04; pBuf2[2] = 0; pBuf2[7] = bit7checksum(pBuf2);
  await feat(p, pBuf2, 'SET_PROFILE (0x04) -> 0');

  await sleep(100);

  // 2. 384 byte'lık saf KIRMIZI userpic yükle (tüm tuşlar kırmızı olsun)
  console.log('2. Saf Kırmızı Userpic yükleniyor (128 tuş kırmızı)...');
  const rgbData = new Array(384).fill(0);
  for (let i = 0; i < 128; i++) {
    rgbData[i * 3] = 255;   // R
    rgbData[i * 3 + 1] = 0;   // G
    rgbData[i * 3 + 2] = 0;   // B
  }

  for (let page = 0; page < 7; page++) {
    const buf = new Array(65).fill(0);
    buf[0] = 0x00;
    buf[1] = 0x0C;
    buf[2] = 384 & 0xFF;         // 0x80
    buf[3] = (384 >> 8) & 0xFF;  // 0x01
    buf[4] = page;
    buf[7] = bit7checksum(buf);

    const offset = page * 56;
    for (let i = 0; i < 56; i++) {
      buf[8 + i] = rgbData[offset + i] || 0;
    }
    await feat(p, buf, `Userpic Sayfa ${page}`);
    await sleep(60);
  }

  await sleep(400);

  // 3. Mode 13'ü farklı flags/option varyantlarıyla dene
  // Dokümanda: "Mode 13 puts its pattern slot in the option nibble and forces RGB (0,200,200)"
  console.log('\n3. Mode 13 çağrılıyor (slot 0..3 deneniyor)...');

  for (let slot = 0; slot <= 3; slot++) {
    const buf = new Array(65).fill(0);
    buf[0] = 0x00;
    buf[1] = 0x07;                // SET_LEDPARAM
    buf[2] = 13;                  // Mode 13 (Userpic)
    buf[3] = 1;                   // Speed
    buf[4] = 4;                   // Brightness max
    buf[5] = (slot << 4) | 0x07;  // Option nibble = slot, flags = 0x07
    buf[6] = 0;
    buf[7] = 200;
    buf[8] = 200;
    buf[9] = bit8checksum(buf);

    await feat(p, buf, `Mode 13 with slot=${slot}`);
    await sleep(2000);
  }

  // 4. Alternatif: Mode 21, 22, 23 (Host-side / Custom modes)
  console.log('\n4. Alternatif Custom Modlar (21, 22, 23) deneniyor...');
  for (const m of [21, 22, 23]) {
    const buf = new Array(65).fill(0);
    buf[0] = 0x00;
    buf[1] = 0x07;
    buf[2] = m;
    buf[3] = 1;
    buf[4] = 4;
    buf[5] = 0x07;
    buf[6] = 255;
    buf[7] = 0;
    buf[8] = 0;
    buf[9] = bit8checksum(buf);
    await feat(p, buf, `Mode ${m} (Kırmızı)`);
    await sleep(2000);
  }

  console.log('\nTest bitti.');
}

main().catch(console.error);
