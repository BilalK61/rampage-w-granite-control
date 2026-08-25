# AetherRGB Control Hub ⚡

A modern, high-performance desktop keyboard RGB lighting manager and customization suite for the **Rampage W-Granite 75% (Turkish Q)** and compatible **ROYUAN / Yichip** firmware keyboards.

Built with **Tauri v2 (Rust)** for native USB HID communication and a **Vanilla JS / CSS** glassmorphic frontend.

---

## 📋 Table of Contents
1. [Features](#-features)
2. [Prerequisites](#-prerequisites)
3. [Quick Start & Running the App](#-quick-start--running-the-app)
   - [Development (Tauri + Vite)](#1-development-mode-recommended)
   - [Legacy Dev Mode (Electron)](#2-legacy-dev-mode-electron)
   - [Web-Only UI Preview (Vite)](#3-web-only-ui-preview-browser)
4. [Building the App for Production](#-building-the-app-for-production)
   - [Tauri Production Build (.exe / Installer)](#1-tauri-production-executable-installer)
   - [Rust Backend Only (Cargo Build / Test)](#2-rust-backend-tests--cli-build)
5. [Architecture & Communication](#-architecture--communication)
6. [Supported Hardware & Protocol](#-supported-hardware--protocol)
7. [Troubleshooting & Linker Setup](#-troubleshooting--windows-c-linker-setup)

---

## ✨ Features

- 🌈 **19 Hardware Lighting Modes**: Static, Breathing, Wave, Ripple, Neon, Meteor, Snowfall, and more.
- 🎨 **Per-Key Custom RGB**: Interactive on-screen key selector with hex palette and WASD presets.
- 💡 **Edge / Side Light Controls**: Full side-LED speed, brightness, and effect customization.
- 🔄 **Two-Way Hardware Sync**: Live 800ms background polling captures physical keyboard shortcuts (`Fn + \`, etc.) and mirrors them in the UI.
- 📁 **JSON Configuration Store**: Saves favorite colors and key maps to your OS config directory (`state.json`).
- ⚡ **Lightweight & Fast**: Rust-native USB HID communication (`hidapi` crate) without Electron overhead.

---

## 🛠 Prerequisites

Ensure you have the following installed on Windows:

| Requirement | Recommended Version | Download / Installation |
|---|---|---|
| **Node.js** | `v20+` or `v22+` | [nodejs.org](https://nodejs.org) |
| **Rust Toolchain** | `1.77+` | [rustup.rs](https://rustup.rs) (`rustup default stable-x86_64-pc-windows-msvc`) |
| **Visual Studio / C++ Tools** | 2022+ Community or Build Tools | Install with **"Desktop development with C++"** workload |
| **Windows 10/11 SDK** | `10.0.18362+` | Included in VS C++ workload (provides `kernel32.lib`) |

---

## 🚀 Quick Start & Running the App

### First-Time Setup
Clone and install JavaScript dependencies:
```powershell
git clone https://github.com/your-username/keyboard-rgb-app.git
cd keyboard-rgb-app
npm install
```

---

### 1. Development Mode (Tauri + Vite) — *Recommended*
Spawns the Vite frontend dev server and attaches the native Rust Tauri window with live-reload and active USB HID drivers:

```powershell
# Using npm script:
npm run tauri dev

# Or directly with npx:
npx tauri dev
```

---

### 2. Legacy Dev Mode (Electron)
If you wish to test with the original Electron runtime:
```powershell
# Terminal 1: Start Vite
npm run dev

# Terminal 2: Start Electron
npm run electron
```

---

### 3. Web-Only UI Preview (Browser)
To inspect and test UI animations or layouts in a standard web browser (uses simulated HID fallback):
```powershell
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in Chrome or Edge.

---

## 📦 Building the App for Production

### 1. Tauri Production Executable / Installer
Builds the optimized frontend bundle and compiles the release binary into a standalone Windows installer (`.msi` / `.exe`):

```powershell
# Using npm:
npm run tauri build

# Or directly via npx:
npx tauri build
```

**Output location:**
```
src-tauri/target/release/aether-rgb.exe
src-tauri/target/release/bundle/msi/AetherRGB_1.0.0_x64_en-US.msi
```

---

### 2. Rust Backend Tests & CLI Build
To compile and test only the Rust engine without bundling the UI:

```powershell
cd src-tauri

# Run all 40+ unit tests (protocol checksums, byte encoders, math conversions):
cargo test --lib

# Build debug binary:
cargo build

# Build optimized release binary:
cargo build --release
```

---

## 🏗 Architecture & Communication

```
┌────────────────────────────────────────────────────────────┐
│                    Tauri v2 Host (Rust)                    │
│                                                            │
│  ┌──────────────────────┐   invoke('send_native_hid_rgb')  │
│  │ Commands Layer       │◄────────────────────────────┐   │
│  │ (commands/rgb.rs)    │   listen('hardware-rgb-sync')   │
│  │ (commands/device.rs) │────────────────────────────►│   │
│  └──────────┬───────────┘                             │   │
│             │                                         │   │
│  ┌──────────▼───────────┐  ┌──────────────────────────┴┐  │
│  │ HID Protocol Engine  │  │ WebView Renderer (Vite)   │  │
│  │ - Checksum builder   │  │ - src/main.js             │  │
│  │ - 800ms Poller task  │  │ - src/rgbEngine.js        │  │
│  │ - hidapi device I/O  │  │ - src/hidService.js       │  │
│  └──────────┬───────────┘  │ - src/layouts.js          │  │
│             │              └───────────────────────────┘  │
│             ▼                                             │
│      USB HID Subsystem (OS driver)                        │
└─────────────┬──────────────────────────────────────────────┘
              │
              ▼
    Rampage W-Granite (ROYUAN VID:0x3151 PID:0x4015/0x4011)
```

---

## ⌨ Supported Hardware & Protocol

| Device | VID | PID | Interface | Usage Page |
|---|---|---|---|---|
| Rampage W-Granite 75% | `0x3151` | `0x4015` | `2` | `0xFFFF` |
| Rampage W-Granite 75% (Alt FW) | `0x3151` | `0x4011` | `2` | `0xFFFF` |

### Packet Specification (65 Bytes)
- **SET_LEDPARAM (`0x07`)**: Main keyboard RGB lighting modes.
- **SET_SLEDPARAM (`0x08`)**: Edge & side RGB strip parameters.
- **GET_LEDPARAM (`0x87`)**: Hardware status query.
- **Checksum Calculation**: `(0xFF - sum(bytes[1..8])) & 0xFF` at index `9`.

---

## 🔧 Troubleshooting (Windows C++ Linker Setup)

If `cargo build` throws `error: linker link.exe not found` or `LNK1181: cannot open input file 'kernel32.lib'`:

1. **Option A (Automatic)**: Open the project inside **Developer Command Prompt for VS 2022** or **x64 Native Tools Command Prompt**.
2. **Option B (Project Config)**: Ensure `src-tauri/.cargo/config.toml` points to your installed Visual Studio & Windows SDK paths:
   ```toml
   [target.x86_64-pc-windows-msvc]
   linker = "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Tools\\MSVC\\<version>\\bin\\HostX64\\x64\\link.exe"
   rustflags = [
       "-L", "C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\<sdk-version>\\um\\x64",
       "-L", "C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\<sdk-version>\\ucrt\\x64",
   ]
   ```

---

## 📜 License
Private project. All rights reserved.
