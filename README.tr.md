# W-Control ⚡

[English](README.md) · **Türkçe**

**Rampage W-Granite 75% (Türkçe Q)** ve uyumlu **ROYUAN / Yichip** yazılımlı klavyeler için modern bir masaüstü RGB aydınlatma ve özelleştirme uygulaması.

Hazır kurulum dosyaları [Releases](../../releases) sayfasındadır.

USB HID iletişimi için **Tauri v2 (Rust)**, arayüz için **Vanilla JS / CSS** ile geliştirilmiştir.

---

> [!WARNING]
> W-Control klavyenin belleğine (tuş matrisi, makrolar, aydınlatma) yazar. İlk değişiklikten önce özgün tuş matrisinin yedeğini alır ve yazılan her şeyi doğrular, ama bir yazılım ya da donanım sorunu tamamen dışlanamaz. Kullanım sorumluluğu size aittir. Bu bağımsız bir projedir; Rampage, Segment ya da klavyenin yazılım üreticisiyle bağlantısı yoktur.

## 📸 Ekran görüntüleri

| Aydınlatma (koyu tema) | Aydınlatma (açık tema) |
|---|---|
| ![Aydınlatma, koyu tema](docs/screenshots/aydinlatma-koyu.png) | ![Aydınlatma, açık tema](docs/screenshots/aydinlatma-acik.png) |

| Makro ve tuş atama | Ayarlar |
|---|---|
| ![Makro ve tuş atama](docs/screenshots/makro-ve-tus-atama.png) | ![Ayarlar](docs/screenshots/ayarlar.png) |

Görüntüler arayüzün klavye takılı olmadan çalışan halidir; bu yüzden bağlantı "USB" görünür ve debounce seviyesi boştur.

---

## ✨ Özellikler

- 🌈 Hız, parlaklık, yön ve renk ayarlı **19 donanım aydınlatma modu**.
- 🎨 **Tuş bazlı RGB**: tuşlara tıklayıp renklendirin. Aynı renkteki tuşa ikinci kez tıklamak o tuşun ışığını söndürür.
- 🗂 **Aydınlatma profilleri**: aydınlatma ayarları ve tuş renkleri uygulamada tutulan üç profil. Profil değişince klavyeye gönderilir.
- ⌨ **Klavyeye gömülü makrolar**: zamanlamalı tuş dizilerini kaydedip klavyenin belleğine yazın. Uygulama kapalıyken de çalışır.
- 🔁 **Tuş atama**: bir tuşa başka bir tuşu ya da en fazla üç tuşluk bir kombinasyonu atayın. Atama klavyede saklanır.
- 🎚 Klavyeye yazılan **debounce seviyesi** ve yazılım sürümü okuma.
- 📡 **Kablo, 2.4G alıcı ve Bluetooth**: alıcı için ara bir el sıkışma, Bluetooth için kendine özgü bir rapor biçimi gerekir; uygulama ikisini de yönetir. Klavye uyanık olmalıdır.
- 🔋 **Pil**: 2.4G ve Bluetooth'ta pil seviyesi (kablo pil bilgisi vermez), seçtiğiniz seviyede düşük pil uyarısı ve tepsi simgesinin üzerine gelince bağlantı ve pil bilgisi.
- 🔄 **Donanım eşitleme**: klavyedeki değişiklikler (`Fn` kısayolları) arayüze yansıtılır.
- 🖥 **Tepsi, Windows ile başlatma, tek örnek**: pencere kapatılınca uygulama tepside çalışmaya devam edebilir.
- 💾 **Yedek**: profilleri, makroları, tuş atamalarını ve ayarları tek bir JSON dosyası olarak dışa/içe aktarın.

Bu klavyenin yazılımı şunları desteklemez (üreticinin kendi sürücüsü de bunları boş bırakır): uyku süresi, rapor hızı değişimi ve yan ışık ayarı. Uygulamadaki "Uyku" ayarı bir uygulama özelliğidir: uygulama çalışırken bilgisayar boşta kalınca ışıkları kapatır.

---

## 🔒 İndirmeyi doğrulama

Kurulum dosyaları kod imzalı değildir; bu yüzden Windows SmartScreen ve bazı antivirüs motorları uyarı verebilir. VirusTotal'da `W-Control_1.0.0_x64-setup.exe` dosyası 70 motordan 4'ünde, yeni ve imzasız yazılımlarda sık görülen genel makine öğrenmesi tespitleriyle işaretlendi. İndirdiğiniz dosyanın yayınlanan dosya olduğunu SHA-256 değerini (PowerShell: `Get-FileHash .W-Control_1.0.0_x64-setup.exe`) [release sayfasındaki](../../releases) değerle karşılaştırarak doğrulayabilirsiniz. İsterseniz kurulum dosyasını hiç kullanmayıp uygulamayı aşağıda anlatıldığı gibi kaynak koddan derleyebilirsiniz.

---

## 🧱 Kendiniz derleyin

İndirilmiş bir kurulum dosyası çalıştırmak istemezseniz, burada okuyabildiğiniz kaynak koddan uygulamayı kendiniz derleyebilirsiniz. Node.js, Rust ve Visual Studio C++ araçları gerekir ([Gereksinimler](#-gereksinimler-geliştirme-için)), sonra:

```powershell
git clone https://github.com/BilalK61/rampage-w-granite-control.git
cd rampage-w-granite-control
npm install
npx tauri build
```

Kurulum dosyaları `src-tauri/target/release/bundle/` klasöründe, düz program ise `src-tauri/target/release/W-Control.exe` olarak oluşur. Kaynaktan yaptığınız derleme de imzalı değildir, ama içine tam olarak neyin girdiğini bilirsiniz. Rampage logoları depoda olmadığı için kendi derlemenizde de logo bulunmaz.

---

## 🛠 Gereksinimler (geliştirme için)

| Gereksinim | Önerilen sürüm | İndirme |
|---|---|---|
| **Node.js** | `v20+` veya `v22+` | [nodejs.org](https://nodejs.org) |
| **Rust** | `1.77+` | [rustup.rs](https://rustup.rs) |
| **Visual Studio C++ araçları** | 2022+ Community veya Build Tools | **"C++ ile masaüstü geliştirme"** iş yükünü kurun |
| **Windows 10/11 SDK** | `10.0.18362+` | VS C++ iş yüküyle gelir |

---

## 🚀 Çalıştırma

```powershell
git clone https://github.com/BilalK61/rampage-w-granite-control.git
cd rampage-w-granite-control
npm install
```

**Geliştirme modu** (Vite + yerel Tauri penceresi, USB HID aktif):
```powershell
npx tauri dev
```

**Sadece arayüz önizlemesi** (tarayıcıda, klavye yerine benzetim kullanır):
```powershell
npm run dev
```
Chrome veya Edge'de [http://localhost:5173](http://localhost:5173) adresini açın.

---

## 📦 Derleme

Kurulum dosyalarını (`.exe` ve `.msi`) üretir:
```powershell
npx tauri build
```

Çıktılar:
```
src-tauri/target/release/aether-rgb.exe
src-tauri/target/release/bundle/nsis/W-Control_1.0.0_x64-setup.exe
src-tauri/target/release/bundle/msi/W-Control_1.0.0_x64_en-US.msi
```

Yalnızca Rust tarafını test etmek için:
```powershell
cd src-tauri
cargo test --lib
```

---

## ⌨ Desteklenen donanım ve protokol

| Cihaz | VID | PID | Arayüz | Usage Page |
|---|---|---|---|---|
| Rampage W-Granite 75% (USB kablo) | `0x3151` | `0x4015` | `2` | `0xFFFF` |
| Rampage W-Granite 75% (2.4G alıcı) | `0x3151` | `0x4011` | `2` | `0xFFFF` |
| Rampage W-Granite 75% (Bluetooth) | `0x3151` | `0x4013` | - | `0xFF55` |

### Paket yapısı (65 bayt, 0. bayt Report ID `0`)
Komutlar feature report olarak gönderilir. Çoğunda sağlama toplamı `0xFF - toplam(bayt[1..=7])` değeridir ve 8. bayttadır (LED parametrelerinde 1..=8 baytı kapsar, sağlama 9. bayttadır).

| Komut | Amaç |
|---|---|
| `0x07` / `0x87` | Aydınlatma modu, hız, parlaklık, renk yaz / oku |
| `0x0C` | Tuş bazlı resim yükleme (7 sayfa, sonra mod 13'ü etkinleştirme) |
| `0x09` / `0x89` | Tuş matrisini yaz (9 sayfa) / oku (8 sayfa): tuş başına 4 bayt |
| `0x0B` / `0x8B` | Klavye makrosunu yaz / oku (5 / 4 sayfa) |
| `0x11` / `0x91` | Debounce seviyesini yaz / oku (1 ile 10) |
| `0x80`, `0x85` | Yazılım sürümü, geçerli profil |

### 2.4G alıcı aktarımı
Alıcı komutları kendiliğinden iletmez. Göndermek için `0xF7` ile "gönderebilir" durumu beklenir, `0xF6 0x0A` ile klavye seçilir, sonra komut gönderilir. Okumak için `0xF7` ile "okuyabilir" durumu beklenir, `0xFC` gönderilir, sonra feature report okunur. Cevaplar eski olabileceğinden, geri yazılacak her veri iki kez okunup karşılaştırılır.

### Bluetooth
Bluetooth'ta klavye, feature report arayüzü yerine bir üretici koleksiyonu (usage page `0xFF55`) sunar. Komut, `0x55` ön ekiyle ve bildiğimiz pakette output report `6` olarak gider. Cevap aynı ön ekle input report `6` olarak gelir (tuş matrisi ve makro sayfaları komut kodu olmadan ham veri olarak gelir). Pil seviyesi `0x77` raporuyla sorulur, `[6, 0x77, seviye]` olarak cevaplanır.

### Tuş atamalarının güvenliği
Klavyenin yazılımı tek tuş yazmayı desteklemez; her atama tüm tuş matrisini yeniden yazar. Uygulama matrisin eksiksiz okunduğunu denetler, ilk değişiklikten önce özgün matrisi `%APPDATA%\aether-rgb\keymap-backup-p0.bin` dosyasına yedekler ve yazılan her şeyi geri okuyup doğrular. "Tüm tuşları ilk haline döndür" yedeği geri yazar.

Protokol, üreticinin herkese açık web sürücüsünden çıkarılmış ve klavye üzerinde doğrulanmıştır.

---

## 🔧 Sorun giderme (Windows C++ bağlayıcı)

`cargo build` sırasında `linker link.exe not found` ya da `LNK1181: cannot open input file 'kernel32.lib'` hatası alırsanız projeyi **Developer Command Prompt for VS 2022** içinde açın ya da `src-tauri/.cargo/config.toml` dosyasında Visual Studio ve Windows SDK yollarını kendi kurulumunuza göre düzenleyin.

---

## 📜 Lisans
[MIT Lisansı](LICENSE) ile yayımlanmıştır.

Bu bağımsız bir projedir; Rampage, Segment ya da klavyenin yazılım üreticisiyle bağlantısı yoktur. Ürün adları ve logolar ilgili sahiplerine aittir. Kullanım sorumluluğu size aittir: uygulama klavyenin belleğine (tuş matrisi, makrolar, aydınlatma) yazar; özgün tuş matrisinin yedeği alınsa da bir yazılım ya da donanım sorunu tamamen dışlanamaz. Yazarın kendi derlemesinde kullandığı marka logoları bu depoya dahil değildir; logolar olmadan kenar çubuğunda yalnızca "W-Control" başlığı görünür.
