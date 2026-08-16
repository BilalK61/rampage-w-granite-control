/**
 * HID RGB Brute-Force Protocol Tester
 * Run: node hid-bruteforce.cjs
 */
const HID = require('node-hid');
const TARGET_VID = 0x3151;
const TARGET_PID = 0x4011;
const R = 0xFF, G = 0x00, B = 0x00;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const KEYS_TKL = [
  0x0022,0x0024,0x0026,0x0027,0x0029,0x002B,0x002D,0x002E,0x002F,
  0x0030,0x0031,0x0032,0x0037,0x0039,0x003B,0x003C,0x003E,
  0x0040,0x0042,0x0043,0x0044,0x0045,0x0046,0x0047,0x004C,0x004E,
  0x0050,0x0051,0x0053,0x0055,0x0057,0x0058,0x0059,0x005A,0x005B,0x005C,
  0x0061,0x0063,0x0065,0x0066,0x0068,0x006A,0x006C,0x006D,0x006E,0x006F,
  0x0070,0x0071,0x0076,0x0078,0x007A,0x007B,0x007D,0x007F,
  0x0081,0x0082,0x0083,0x0084,0x0085,0x0086,0x008B,0x008D,0x008F,
  0x0090,0x0092,0x0094,0x0096,0x0097,0x0098,0x0099,0x009A,0x009B,
];

function buildPackets() {
  const pkts = [];

  // 1) Sinowealth 1032-byte SetStaticColor
  { const b = new Array(1033).fill(0); b[0]=0x06;b[2]=0x08;b[3]=0xB8;b[5]=0x40;
    b[0x1E]=R;b[0x1F]=G;b[0x20]=B;
    for(const i of KEYS_TKL) if(i+1<b.length) b[i+1]=0xFF;
    pkts.push({name:'Sinowealth 1032-byte Static (06 08 B8)',b}); }

  // 2) Sinowealth 1032-byte Direct 
  { const b = new Array(1033).fill(0); b[0]=0x06;b[2]=0x09;b[3]=0xBC;b[5]=0x40;
    for(let i=0;i<104;i++){b[9+i*3]=R;b[9+i*3+1]=G;b[9+i*3+2]=B;}
    pkts.push({name:'Sinowealth 1032-byte Direct (06 09 BC)',b}); }

  // 3) 520-byte 10c format
  { const b = new Array(521).fill(0); b[0]=0x06;b[2]=0x08;b[5]=0x01;b[7]=0x7A;b[8]=0x01;
    for(let i=0;i<104;i++){b[9+i*3]=R;b[9+i*3+1]=G;b[9+i*3+2]=B;}
    pkts.push({name:'520-byte 10c Direct (06 08 01 7A 01)',b}); }

  // 4) EVISION 64-byte no report ID
  { const b = new Array(65).fill(0); b[0]=0x00;b[1]=0x5A;b[2]=0xA5;b[3]=0x05;b[4]=0x01;b[5]=R;b[6]=G;b[7]=B;b[8]=0xFF;
    pkts.push({name:'EVISION 64-byte 5AA5 0501 (no RID)',b}); }

  // 5) EVISION 64-byte report ID 0x05
  { const b = new Array(65).fill(0); b[0]=0x05;b[1]=0x5A;b[2]=0xA5;b[3]=0x05;b[4]=0x01;b[5]=R;b[6]=G;b[7]=B;b[8]=0xFF;
    pkts.push({name:'EVISION 64-byte 5AA5 0501 (RID 0x05)',b}); }

  // 6) Simple 9-byte vendor commands with various report IDs
  for(const rid of [0x00,0x01,0x04,0x05,0x08,0x0A,0x10,0xCC]) {
    const b = new Array(9).fill(0); b[0]=rid;b[1]=0x05;b[2]=0x01;b[3]=R;b[4]=G;b[5]=B;b[6]=0xFF;
    pkts.push({name:`Simple 9-byte (RID 0x${rid.toString(16).padStart(2,'0')})`,b});
  }

  return pkts;
}

async function tryPkt(path, label, name, b, method) {
  try {
    const d = new HID.HID(path);
    const r = method==='feature' ? d.sendFeatureReport(b) : d.write(b);
    d.close();
    console.log(`  ✅ ${method.toUpperCase()} [${label}] ${name} (${b.length}b, r=${r})`);
  } catch(e) {
    console.log(`  ❌ ${method.toUpperCase()} [${label}] ${name}: ${e.message.split('\n')[0]}`);
  }
}

async function main() {
  console.log('\n=== HID RGB Brute-Force Tester ===');
  console.log('KIRMIZI renk gönderiliyor. Değişim görürsen HEMEN Ctrl+C bas!\n');
  const all = HID.devices();
  const targets = all.filter(d=>d.vendorId===TARGET_VID && d.productId===TARGET_PID);
  if(!targets.length){ console.error('Klavye bulunamadı!'); process.exit(1); }
  console.log(`${targets.length} arayüz bulundu:`);
  targets.forEach((d,i)=>console.log(`  [${i}] IF:${d.interface} UP:0x${d.usagePage.toString(16)} path:${d.path}`));
  console.log('');
  const pkts = buildPackets();
  let n=0;
  for(const pkt of pkts) {
    for(const dev of targets) {
      const lbl = `IF:${dev.interface} UP:0x${dev.usagePage.toString(16)}`;
      n++;
      console.log(`[${n}] ${pkt.name}`);
      await tryPkt(dev.path,lbl,pkt.name,pkt.b,'feature'); await sleep(700);
      await tryPkt(dev.path,lbl,pkt.name,pkt.b,'write');   await sleep(700);
    }
  }
  console.log('\n✅ Bitti.');
}
main().catch(console.error);
