# AetherRGB Control Hub

A desktop keyboard RGB lighting controller for the **Rampage W-Granite 75% (Turkish Q)** and compatible ROYUAN/Yichip firmware keyboards.

## Features

- 19 hardware lighting modes (Static, Breathing, Wave, Ripple, Neon, Meteor, …)
- Per-key custom RGB assignment
- Edge/side light control
- Two-way hardware sync (Fn+shortcut changes reflected in UI instantly)
- Favorite colors palette with localStorage → JSON persistence
- Dark glassmorphism UI

---

## Architecture

```
┌─────────────────────────────────────┐
│  Tauri v2 (Rust backend)            │
│  ├── hid/protocol.rs  packet logic  │
│  ├── hid/device.rs    USB I/O       │
│  ├── hid/poller.rs    800ms sync    │
│  ├── commands/rgb.rs  IPC handlers  │
│  └── store/mod.rs     JSON state    │
│                                     │
│  Vite SPA (renderer)                │
│  ├── src/main.js      UI / state    │
│  ├── src/rgbEngine.js rAF anim      │
│  ├── src/hidService.js Tauri bridge │
│  └── src/layouts.js   key data      │
└─────────────────────────────────────┘
```

### HID Protocol (ROYUAN/Yichip)

| Command | Opcode | Description |
|---|---|---|
| `SET_LEDPARAM` | `0x07` | Set main lighting mode |
| `SET_SLEDPARAM` | `0x08` | Set edge/side light |
| `GET_LEDPARAM` | `0x87` | Read current hardware state |
| `SET_USERPIC` | `0x0C` | Per-key matrix upload (firmware-dependent) |

Checksum: `(0xFF - sum(bytes[1..8])) & 0xFF` placed in `byte[9]`.

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Rust | ≥ 1.77 | Install via [rustup.rs](https://rustup.rs) |
| Node.js | ≥ 20 | |
| Visual Studio / Build Tools | 2022+ | With **Desktop development with C++** workload |
| Windows SDK | 10.0.18362+ | Needed for `kernel32.lib` |
| Tauri CLI | v2 | `npm install -g @tauri-apps/cli` |

---

## Development

```bash
# Install JS dependencies
npm install

# Run in dev mode (Vite + Tauri)
npm run tauri dev

# Run Rust unit tests only (no hardware needed)
cd src-tauri
cargo test --lib

# Build production installer
npm run tauri build
```

> **Note**: Open the terminal from a **VS Developer Command Prompt** (or let
> `.cargo/config.toml` handle the linker paths automatically).

---

## Migration Status

This project is being migrated from **Electron + node-hid (JavaScript)** → **Tauri + hidapi (Rust)**.

See [`implementation_plan.md`](docs/implementation_plan.md) for the full migration plan.

| Phase | Status |
|---|---|
| Phase 1 — Analysis | ✅ Complete |
| Phase 2 — Architecture Mapping | ✅ Complete |
| Phase 3 — Migration Plan | ✅ Complete |
| Phase 4 — Execution (Steps 1–7) | ✅ Code written, pending `cargo test` |
| Phase 4 — Step 8 (Electron cutover) | ⏳ After tests pass |
| Phase 5 — Verification | ⏳ Hardware testing |

### Legacy files (kept during migration)
- `electron-main.cjs` — original Electron main process (reference only)
- `hid-bruteforce.cjs` — HID diagnostic script
- `perkey-test.cjs` — per-key protocol exploration script

---

## Supported Hardware

| Device | VID | PID | Interface | UsagePage |
|---|---|---|---|---|
| Rampage W-Granite 75% | `0x3151` | `0x4015` | 2 | `0xFFFF` |
| Rampage W-Granite 75% (alt) | `0x3151` | `0x4011` | 2 | `0xFFFF` |
