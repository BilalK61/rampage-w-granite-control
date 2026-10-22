import { KEYBOARD_LAYOUTS } from './layouts.js';

/**
 * High-Fidelity 2D RGB Animation Engine
 * Accurately simulates firmware lighting algorithms for 75% mechanical keyboards
 */
export class RGBEngine {
  constructor(keyElementsMap) {
    this.keyElementsMap = keyElementsMap || {};
    this.currentEffect = 'rainbow';
    this.colorType = 'rainbow'; // 'custom' or 'rainbow'
    this.direction = 0; // 0: Left, 1: Right, 2: Up, 3: Down
    this.primaryColor = '#e50914';
    this.speed = 75; // 25, 50, 75, 100
    this.brightness = 100; // 0..100
    this.sideMode = 1;
    this.animationFrameId = null;
    this.tick = 0;
    this.customKeyColors = {}; // code -> hex color

    // Interactive Keypress Ripples & Trails
    this.activeRipples = []; // { x, y, startTime, color }
    this.keyTrails = {}; // code -> { intensity, color, decayTime }

    // Precompute precise 2D spatial coordinates (x, y) for all keys
    this.keyPositions = this.computeKeyPositions();
  }

  // Precompute physical 2D layout geometry for Turkish Q 75%
  computeKeyPositions() {
    const positions = {};
    const layout = KEYBOARD_LAYOUTS.compact75;
    if (!layout) return positions;

    layout.forEach((row, rowIdx) => {
      let currentX = 0;
      row.forEach(key => {
        let width = 1.0;
        if (key.width === 'u-1-25') width = 1.25;
        else if (key.width === 'u-1-5') width = 1.5;
        else if (key.width === 'u-1-75') width = 1.75;
        else if (key.width === 'u-2-0') width = 2.0;
        else if (key.width === 'u-6-25') width = 6.25;
        else if (key.isIsoEnter) width = 1.5;
        else if (key.isIsoPlaceholder) width = 1.25;

        if (key.isIsoPlaceholder) {
          currentX += width;
          return;
        }

        const centerX = currentX + width / 2;
        const centerY = key.isIsoEnter ? rowIdx + 0.5 : rowIdx;
        positions[key.code] = { x: centerX, y: centerY, width };
        currentX += width;
      });
    });

    return positions;
  }

  setKeysMap(map) {
    this.keyElementsMap = map;
    this.keyPositions = this.computeKeyPositions();
  }

  sendHardwareReport() {
    if (this.currentEffect === 'custom_per_key') {
      this.sendPerKeyReport();
      return;
    }
    if (window.hidService) {
      window.hidService.sendRGBReport(
        this.currentEffect,
        this.speed,
        this.brightness,
        this.primaryColor,
        {
          colorType: this.colorType,
          direction: this.direction
        }
      );
    }
  }

  sendPerKeyReport() {
    if (window.hidService) {
      window.hidService.sendPerKeyRGBReport(this.customKeyColors);
    }
  }

  sendSideReport() {
    if (window.hidService) {
      window.hidService.sendSideRGBReport(
        this.sideMode,
        this.speed,
        this.brightness,
        this.primaryColor,
        this.colorType === 'rainbow' ? 0x08 : 0x07
      );
    }
  }

  setColor(hex) {
    this.primaryColor = hex;
    this.colorType = 'custom';
    this.sendHardwareReport();
  }

  setColorType(type) {
    this.colorType = type;
    this.sendHardwareReport();
  }

  setDirection(dir) {
    this.direction = dir;
    this.sendHardwareReport();
  }

  setEffect(effectName) {
    // Per-key colors are inline styles that other effects never overwrite.
    if (this.currentEffect === 'custom_per_key' && effectName !== 'custom_per_key') {
      Object.values(this.keyElementsMap).forEach(el => this.unpaintKey(el));
    }
    this.currentEffect = effectName;
    this.sendHardwareReport();
  }

  paintKey(el, hex) {
    const r = parseInt(hex.slice(1, 3), 16) || 0;
    const g = parseInt(hex.slice(3, 5), 16) || 0;
    const b = parseInt(hex.slice(5, 7), 16) || 0;
    el.style.setProperty('--key-rgb', hex);
    el.style.background = `rgba(${r}, ${g}, ${b}, 0.22)`;
    el.style.borderColor = `rgba(${r}, ${g}, ${b}, 0.55)`;
    el.style.boxShadow = `0 0 8px 1px rgba(${r}, ${g}, ${b}, 0.25), inset 0 0 4px rgba(${r}, ${g}, ${b}, 0.15)`;
  }

  unpaintKey(el) {
    el.style.removeProperty('--key-rgb');
    el.style.background = '';
    el.style.borderColor = '';
    el.style.boxShadow = '';
  }

  setSpeed(val) {
    this.speed = val;
    this.sendHardwareReport();
  }

  setBrightness(val) {
    this.brightness = val;
    this.sendHardwareReport();
  }

  setSideMode(mode) {
    this.sideMode = mode;
    this.sendSideReport();
  }

  setCustomKeyColor(code, hex, skipHardware = false) {
    this.customKeyColors[code] = hex;
    // Only paint while per-key mode is shown; other effects keep the stored color for later.
    const el = this.keyElementsMap[code];
    if (el && hex && this.currentEffect === 'custom_per_key') {
      this.paintKey(el, hex);
    }

    if (!skipHardware) this.schedulePerKeySend();
  }

  // Turn one key's light off (it stays unlit in the keyboard's per-key map).
  removeCustomKeyColor(code) {
    delete this.customKeyColors[code];
    const el = this.keyElementsMap[code];
    if (el) this.unpaintKey(el);
    this.schedulePerKeySend();
  }

  // Clicks come in quick bursts; send the final map once they stop.
  schedulePerKeySend() {
    if (this.currentEffect !== 'custom_per_key') return;
    if (this.perKeyDebounce) clearTimeout(this.perKeyDebounce);
    this.perKeyDebounce = setTimeout(() => {
      this.sendPerKeyReport();
    }, 600);
  }

  clearCustomKeyColors() {
    this.customKeyColors = {};
    Object.values(this.keyElementsMap).forEach(el => this.unpaintKey(el));
    if (this.currentEffect === 'custom_per_key') {
      this.sendPerKeyReport();
    }
  }

  start() {
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    let lastTime = performance.now();

    const render = (now) => {
      const delta = (now - lastTime) / 1000;
      lastTime = now;

      // Speed scale (speed 25..100)
      const speedMultiplier = (this.speed / 50) * 1.5;
      this.tick += delta * speedMultiplier;

      // Clean up old active ripples
      this.activeRipples = this.activeRipples.filter(r => (now - r.startTime) < 1800);

      this.applyCurrentEffect(now);
      this.animationFrameId = requestAnimationFrame(render);
    };
    render(performance.now());
  }

  stop() {
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
  }

  // ─────────────────────────────────────────────────────────────
  // 2D Spatial Lighting Formulas (True Hardware Simulation)
  // ─────────────────────────────────────────────────────────────
  applyCurrentEffect(now = performance.now()) {
    const globalBrightness = Math.max(0.05, this.brightness / 100);
    const keys = Object.entries(this.keyElementsMap);
    const isRainbow = this.colorType === 'rainbow';
    const primaryHex = this.primaryColor || '#e50914';

    // 1. Custom Per-Key Mode
    if (this.currentEffect === 'custom_per_key') {
      keys.forEach(([code, el]) => {
        const keyColor = this.customKeyColors[code] || null;
        el.style.opacity = globalBrightness;
        if (keyColor) {
          this.paintKey(el, keyColor);
        } else {
          this.unpaintKey(el);
        }
      });
      return;
    }

    // 2. Dynamic Hardware Effects with 2D (X, Y) Coordinates
    const t = this.tick;
    const centerX = 8.0; // center of 16.0u keyboard width
    const centerY = 2.5; // center of 5 rows

    keys.forEach(([code, el]) => {
      const pos = this.keyPositions[code] || { x: 8, y: 2.5 };
      const x = pos.x;
      const y = pos.y;

      let color = primaryHex;
      let alpha = globalBrightness;

      switch (this.currentEffect) {
        // ── Sabit Renk (Mode 1) ──────────────────────────────────
        case 'static': {
          color = isRainbow ? `hsl(${(x * 22) % 360}, 95%, 55%)` : primaryHex;
          alpha = globalBrightness;
          break;
        }

        // ── Nefes Alma (Mode 2) ──────────────────────────────────
        case 'breathing': {
          const breath = (Math.sin(t * 2.2) + 1) / 2; // 0..1 smooth curve
          alpha = (breath * 0.85 + 0.15) * globalBrightness;
          color = isRainbow ? `hsl(${(t * 40) % 360}, 95%, 55%)` : primaryHex;
          break;
        }

        // ── Spektrum Döngüsü (Mode 3) ────────────────────────────
        // All keys synchronously cycle through entire color wheel at once
        case 'spectrum': {
          const hue = (t * 55) % 360;
          color = `hsl(${hue}, 95%, 55%)`;
          alpha = globalBrightness;
          break;
        }

        // ── Dalga / Wave (Mode 4) ────────────────────────────────
        // Flowing spatial rainbow wave according to selected direction
        case 'wave': {
          let spatialOffset = 0;
          if (this.direction === 0) spatialOffset = x * 22.5;         // Sola (Left)
          else if (this.direction === 1) spatialOffset = (16 - x) * 22.5; // Sağa (Right)
          else if (this.direction === 2) spatialOffset = y * 60;          // Yukarı (Up)
          else if (this.direction === 3) spatialOffset = (5 - y) * 60;   // Aşağı (Down)

          if (isRainbow) {
            const hue = (spatialOffset + t * 75) % 360;
            color = `hsl(${hue}, 95%, 55%)`;
            alpha = globalBrightness;
          } else {
            color = primaryHex;
            const waveA = (Math.sin((spatialOffset * 0.05) + t * 3.5) + 1) / 2;
            alpha = (waveA * 0.85 + 0.15) * globalBrightness;
          }
          break;
        }

        // ── Akış / Flow (Mode 7) ─────────────────────────────────
        // Diagonal smooth gradient stream
        case 'flow': {
          const diag = x * 0.8 + y * 1.6;
          if (isRainbow) {
            const hue = (diag * 24 + t * 70) % 360;
            color = `hsl(${hue}, 95%, 55%)`;
            alpha = globalBrightness;
          } else {
            color = primaryHex;
            const flowA = (Math.sin(diag * 0.6 + t * 3) + 1) / 2;
            alpha = (flowA * 0.85 + 0.15) * globalBrightness;
          }
          break;
        }

        // ── Halka / Ripple (Mode 5) ──────────────────────────────
        // Concentric circular ripples from user presses or periodic center pulse
        case 'ripple': {
          let highestRipple = 0;
          if (this.activeRipples.length > 0) {
            this.activeRipples.forEach(rip => {
              const elapsed = (now - rip.startTime) / 1000;
              const radius = elapsed * 10.0; // expands outward
              const dist = Math.hypot(x - rip.x, (y - rip.y) * 1.8);
              const waveDist = Math.abs(dist - radius);
              if (waveDist < 1.8) {
                const fade = Math.max(0, 1 - (elapsed / 1.5));
                const intensity = (1 - (waveDist / 1.8)) * fade;
                highestRipple = Math.max(highestRipple, intensity);
              }
            });
          }

          // Idle ambient pulse if no keys pressed
          if (highestRipple === 0) {
            const dist = Math.hypot(x - centerX, (y - centerY) * 1.6);
            const idleWave = (Math.sin(dist * 0.8 - t * 4) + 1) / 2;
            highestRipple = idleWave * 0.7;
          }

          if (isRainbow) {
            const dist = Math.hypot(x - centerX, (y - centerY) * 1.6);
            const hue = (dist * 25 + t * 60) % 360;
            color = `hsl(${hue}, 95%, 55%)`;
          } else {
            color = primaryHex;
          }
          alpha = (highestRipple * 0.85 + 0.15) * globalBrightness;
          break;
        }

        // ── Işıma / Radiant / Blossom (Mode 14) ───────────────────
        // Expanding geometric diamond waves from keyboard center
        case 'radiant': {
          const dist = Math.abs(x - centerX) + Math.abs(y - centerY) * 1.8;
          const radiantWave = (Math.sin(dist * 0.75 - t * 4.5) + 1) / 2;
          if (isRainbow) {
            const hue = (dist * 20 + t * 65) % 360;
            color = `hsl(${hue}, 95%, 55%)`;
          } else {
            color = primaryHex;
          }
          alpha = (radiantWave * 0.85 + 0.15) * globalBrightness;
          break;
        }

        // ── Dönen Halka / Loop / Windmill (Mode 15) ───────────────
        // Rotational angular sweep around keyboard center
        case 'loop': {
          const angle = Math.atan2((y - centerY) * 1.5, x - centerX);
          const angleDeg = (angle * (180 / Math.PI) + 360) % 360;
          if (isRainbow) {
            const hue = (angleDeg + t * 90) % 360;
            color = `hsl(${hue}, 95%, 55%)`;
            alpha = globalBrightness;
          } else {
            color = primaryHex;
            const loopA = (Math.sin((angleDeg * Math.PI / 180) + t * 3) + 1) / 2;
            alpha = (loopA * 0.85 + 0.15) * globalBrightness;
          }
          break;
        }

        // ── Yıldız Parıltısı / Stardots (Mode 6) ──────────────────
        // Random individual keys sparkle and fade gently
        case 'stardots': {
          const seed = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
          const phase = (t * (1.5 + (Math.abs(seed) % 2)) + Math.abs(seed) % 10);
          const sparkle = Math.max(0, (Math.sin(phase) - 0.4) / 0.6); // sharp peaks

          if (isRainbow) {
            const hue = (Math.abs(seed) * 100 + t * 20) % 360;
            color = `hsl(${hue}, 95%, 65%)`;
          } else {
            color = primaryHex;
          }
          alpha = (sparkle > 0 ? sparkle : 0.04) * globalBrightness;
          break;
        }

        // ── Meteor Yağmuru / Meteor (Mode 18) ─────────────────────
        // Diagonal shooting stars with bright head and glowing fading tail
        case 'meteor': {
          const meteorPos = (t * 8.0) % 24.0;
          const diagPos = (x * 0.6 + y * 1.5);
          const distM = (diagPos - meteorPos + 24) % 24;

          if (distM < 3.5) {
            const headIntensity = Math.pow(1 - (distM / 3.5), 1.5);
            alpha = headIntensity * globalBrightness;
            color = isRainbow ? `hsl(${((x * 20) + t * 40) % 360}, 95%, 60%)` : primaryHex;
          } else {
            alpha = 0.05 * globalBrightness;
            color = primaryHex;
          }
          break;
        }

        // ── Kar Yağışı / Snowfall (Mode 17) ───────────────────────
        // Cascading drops falling vertically down columns
        case 'snowfall': {
          const col = Math.floor(x);
          const colPhase = (t * 3.2 + col * 1.1) % 8.0;
          const dropDist = (y - colPhase + 8.0) % 8.0;

          if (dropDist < 2.0) {
            const dropAlpha = 1 - (dropDist / 2.0);
            alpha = (dropAlpha * 0.9 + 0.1) * globalBrightness;
            color = isRainbow ? `hsl(${(col * 24 + t * 30) % 360}, 90%, 65%)` : '#e0f2fe';
          } else {
            alpha = 0.04 * globalBrightness;
            color = primaryHex;
          }
          break;
        }

        // ── Sakin Kar / Silent Snow (Mode 19) ─────────────────────
        // Ultra-slow, gentle soft ice-crystal twinkles on dark chassis
        case 'silentsnow': {
          const seed = Math.sin(x * 37.123 + y * 91.456) * 12345.678;
          const slowPhase = (t * 0.8 + Math.abs(seed) % (Math.PI * 2));
          const glow = (Math.sin(slowPhase) + 1) / 2;
          const isGlowing = glow > 0.7;

          if (isGlowing) {
            const intensity = (glow - 0.7) / 0.3;
            alpha = (intensity * 0.85 + 0.1) * globalBrightness;
            color = isRainbow ? `hsl(${(Math.abs(seed) * 50) % 360}, 85%, 70%)` : '#f0f9ff';
          } else {
            alpha = 0.03 * globalBrightness;
            color = '#101420';
          }
          break;
        }

        // ── Tuş İzi / Touch Fade (Mode 8) ─────────────────────────
        // Keys illuminate when touched and slowly fade away
        case 'keyshadow': {
          const trail = this.keyTrails[code];
          if (trail && (now - trail.time) < 1200) {
            const decay = 1 - ((now - trail.time) / 1200);
            alpha = (decay * 0.9 + 0.1) * globalBrightness;
            color = trail.color || primaryHex;
          } else {
            // Ambient faint base
            alpha = 0.05 * globalBrightness;
            color = primaryHex;
          }
          break;
        }

        // ── Katmanlar / Layers (Mode 9) ───────────────────────────
        // Horizontal and vertical scanning radar beams crossing each other
        case 'layers': {
          const scanX = (Math.sin(t * 3 + x * 0.5) + 1) / 2;
          const scanY = (Math.sin(t * 2.5 + y * 0.8) + 1) / 2;
          const combined = (scanX * 0.5 + scanY * 0.5);

          if (isRainbow) {
            const hue = (x * 15 + y * 30 + t * 50) % 360;
            color = `hsl(${hue}, 95%, 55%)`;
          } else {
            color = primaryHex;
          }
          alpha = (combined * 0.85 + 0.15) * globalBrightness;
          break;
        }

        // ── Sinüs Dalgası / Sine (Mode 10) ────────────────────────
        // Undulating 2D wave surface
        case 'sine': {
          const sineVal = (Math.sin(x * 0.6 + t * 3.5) * Math.cos(y * 0.9 + t * 2.5) + 1) / 2;
          if (isRainbow) {
            const hue = (x * 20 + t * 60) % 360;
            color = `hsl(${hue}, 95%, 55%)`;
          } else {
            color = primaryHex;
          }
          alpha = (sineVal * 0.85 + 0.15) * globalBrightness;
          break;
        }

        // ── Püskürme / Spring (Mode 11) ───────────────────────────
        // Vertical fountain erupting from spacebar area upwards
        case 'spring': {
          const fountain = (Math.sin((5 - y) * 0.8 - t * 4.5) + 1) / 2;
          const spread = Math.max(0, 1 - (Math.abs(x - centerX) / 8.0));
          const springAlpha = fountain * spread;

          if (isRainbow) {
            const hue = (y * 40 + t * 60) % 360;
            color = `hsl(${hue}, 95%, 55%)`;
          } else {
            color = primaryHex;
          }
          alpha = (springAlpha * 0.85 + 0.12) * globalBrightness;
          break;
        }

        // ── Neon Akımı / Neon (Mode 12) ───────────────────────────
        // Cyberpunk Neon palette blend: Cyan, Magenta, Purple, Orange
        case 'neon': {
          const neonHue = ((x * 18 - t * 60) % 360 + 360) % 360;
          // Map to neon range (Cyan 180..Magenta 300..Sunset 30)
          color = `hsl(${neonHue}, 100%, 55%)`;
          alpha = globalBrightness;
          break;
        }

        // ── Renk Izgarası / Color Grid (Mode 16) ──────────────────
        // Checkerboard block steps
        case 'colorgrid': {
          const gridBlock = (Math.floor(x / 2) + Math.floor(y)) % 2;
          const gridPhase = (Math.sin(t * 3 + gridBlock * Math.PI) + 1) / 2;
          if (isRainbow) {
            const hue = (gridBlock * 120 + t * 40) % 360;
            color = `hsl(${hue}, 95%, 55%)`;
          } else {
            color = primaryHex;
          }
          alpha = (gridPhase * 0.85 + 0.15) * globalBrightness;
          break;
        }

        // ── Kapalı / Off (Mode 0) ────────────────────────────────
        case 'off': {
          alpha = 0.04;
          color = '#151720';
          break;
        }

        default: {
          color = primaryHex;
          alpha = globalBrightness;
          break;
        }
      }

      el.style.opacity = alpha.toFixed(3);
      el.style.setProperty('--key-rgb', color);
    });
  }

  // Interactive Key Ripple Trigger (on physical or virtual keydown)
  triggerKeyRipple(code) {
    const el = this.keyElementsMap[code];
    if (!el) return;

    el.classList.add('active-pressed');
    setTimeout(() => el.classList.remove('active-pressed'), 120);

    const pos = this.keyPositions[code] || { x: 8, y: 2.5 };
    const now = performance.now();

    // Register active ripple wave
    this.activeRipples.push({
      x: pos.x,
      y: pos.y,
      startTime: now,
      color: this.colorType === 'rainbow' ? `hsl(${Math.random() * 360}, 95%, 55%)` : this.primaryColor
    });

    // Register key shadow trail
    this.keyTrails[code] = {
      time: now,
      color: this.colorType === 'rainbow' ? `hsl(${Math.random() * 360}, 95%, 60%)` : this.primaryColor
    };
  }
}
