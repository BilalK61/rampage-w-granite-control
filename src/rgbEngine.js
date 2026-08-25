/**
 * RGB Animation Engine - Handles active lighting effects on the UI & Keyboard Hardware
 */
export class RGBEngine {
  constructor(keyElementsMap) {
    this.keyElementsMap = keyElementsMap; // key code -> DOM element
    this.currentEffect = 'rainbow';
    this.colorType = 'rainbow'; // 'custom' or 'rainbow'
    this.direction = 0; // 0..3 (Left, Right, Up, Down)
    this.primaryColor = '#8b5cf6';
    this.secondaryColor = '#06b6d4';
    this.speed = 60; // 10-100
    this.brightness = 90; // 0-100
    this.sideMode = 1; // 0: off, 1: static, 2: breathing, 3: spectrum, 4: wave, 5: snake
    this.animationFrameId = null;
    this.tick = 0;
    this.customKeyColors = {}; // code -> hex color
  }

  setKeysMap(map) {
    this.keyElementsMap = map;
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
    this.currentEffect = effectName;
    this.sendHardwareReport();
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

    // Immediately update the DOM element for instant visual feedback
    const el = this.keyElementsMap[code];
    if (el && hex) {
      const r = parseInt(hex.slice(1, 3), 16) || 0;
      const g = parseInt(hex.slice(3, 5), 16) || 0;
      const b = parseInt(hex.slice(5, 7), 16) || 0;
      el.style.setProperty('--key-rgb', hex);
      el.style.background = `rgba(${r}, ${g}, ${b}, 0.22)`;
      el.style.borderColor = `rgba(${r}, ${g}, ${b}, 0.5)`;
      el.style.boxShadow = `0 0 8px 1px rgba(${r}, ${g}, ${b}, 0.25), inset 0 0 6px rgba(${r}, ${g}, ${b}, 0.1)`;
    }

    if (this.currentEffect === 'custom_per_key' && !skipHardware) {
      if (this.perKeyDebounce) clearTimeout(this.perKeyDebounce);
      this.perKeyDebounce = setTimeout(() => {
        this.sendPerKeyReport();
      }, 800);
    }
  }

  clearCustomKeyColors() {
    this.customKeyColors = {};
    // Also reset all key DOM styles to default dark state
    Object.values(this.keyElementsMap).forEach(el => {
      el.style.removeProperty('--key-rgb');
      el.style.background = '';
      el.style.borderColor = '';
      el.style.boxShadow = '';
    });
    if (this.currentEffect === 'custom_per_key') {
      this.sendPerKeyReport();
    }
  }

  setAllCustomKeys(hex) {
    Object.keys(this.keyElementsMap).forEach(code => {
      this.customKeyColors[code] = hex;
    });
    if (this.currentEffect === 'custom_per_key') {
      this.sendPerKeyReport();
    }
  }


  start() {
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    const render = () => {
      this.tick += (this.speed / 50) * 0.05;
      this.applyCurrentEffect();
      this.animationFrameId = requestAnimationFrame(render);
    };
    render();
  }

  stop() {
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
  }

  applyCurrentEffect() {
    const opacity = Math.max(0.1, this.brightness / 100);
    const keys = Object.entries(this.keyElementsMap);
    const totalKeys = keys.length;

    // Özel Tuş Bazlı RGB Modu (Per-Key Custom Lighting)
    if (this.currentEffect === 'custom_per_key') {
      keys.forEach(([code, el]) => {
        const keyColor = this.customKeyColors[code] || null;
        el.style.opacity = opacity;
        if (keyColor) {
          el.style.setProperty('--key-rgb', keyColor);
          // Parse hex to rgba for direct background tint (fallback if color-mix not supported)
          const r = parseInt(keyColor.slice(1, 3), 16) || 0;
          const g = parseInt(keyColor.slice(3, 5), 16) || 0;
          const b = parseInt(keyColor.slice(5, 7), 16) || 0;
          el.style.background = `rgba(${r}, ${g}, ${b}, 0.22)`;
          el.style.borderColor = `rgba(${r}, ${g}, ${b}, 0.5)`;
          el.style.boxShadow = `0 0 8px 1px rgba(${r}, ${g}, ${b}, 0.25), inset 0 0 6px rgba(${r}, ${g}, ${b}, 0.1)`;
        } else {
          // Key not assigned — reset to default dark
          el.style.removeProperty('--key-rgb');
          el.style.background = '';
          el.style.borderColor = '';
          el.style.boxShadow = '';
        }
      });
      return;
    }

    keys.forEach(([code, el], index) => {
      let color = this.primaryColor;
      let elOpacity = opacity;

      switch (this.currentEffect) {
        case 'static':
          color = this.primaryColor;
          break;


        case 'breathing': {
          const alpha = (Math.sin(this.tick * 2) + 1) / 2;
          elOpacity = (alpha * opacity).toFixed(2);
          color = this.colorType === 'rainbow'
            ? `hsl(${(this.tick * 40) % 360}, 90%, 55%)`
            : this.primaryColor;
          break;
        }

        case 'spectrum': {
          const hue = (this.tick * 60) % 360;
          color = `hsl(${hue}, 90%, 55%)`;
          break;
        }

        case 'wave':
        case 'flow':
        case 'neon': {
          const shift = this.direction === 1 ? -index : index;
          const hue = (shift * 14 + this.tick * 70) % 360;
          color = this.colorType === 'rainbow'
            ? `hsl(${hue}, 90%, 55%)`
            : this.primaryColor;
          if (this.colorType !== 'rainbow') {
            const waveA = (Math.sin(index * 0.5 + this.tick * 3) + 1) / 2;
            elOpacity = (waveA * opacity).toFixed(2);
          }
          break;
        }

        case 'ripple':
        case 'radiant':
        case 'loop': {
          const dist = Math.abs(index - totalKeys / 2);
          const ripplePhase = Math.sin(dist * 0.4 - this.tick * 4);
          if (this.colorType === 'rainbow') {
            const hue = (dist * 20 + this.tick * 50) % 360;
            color = `hsl(${hue}, 90%, 55%)`;
          } else {
            color = this.primaryColor;
            elOpacity = Math.max(0.15, ((ripplePhase + 1) / 2) * opacity);
          }
          break;
        }

        case 'stardots': {
          // Stardots: random sparkle flashes on dark background
          const starVal = Math.sin(index * 7 + this.tick * 3);
          if (starVal > 0.6) {
            color = this.colorType === 'rainbow' ? `hsl(${(index * 35) % 360}, 95%, 60%)` : '#ffffff';
            elOpacity = opacity;
          } else {
            color = this.primaryColor;
            elOpacity = opacity * 0.12;
          }
          break;
        }

        case 'silentsnow': {
          // Silent Snow: most keys dark, random ones gently glow then fade independently
          const snowOffset = index * 137.508; // golden angle for natural distribution
          const snowPhase = (this.tick * 0.6 + snowOffset) % (Math.PI * 2);
          const snowVal = Math.sin(snowPhase);
          const brightness2 = Math.max(0, (snowVal - 0.65) / 0.35);
          color = this.colorType === 'rainbow'
            ? `hsl(${(index * 29 + this.tick * 4) % 360}, 80%, 70%)`
            : '#e8f4fd';
          elOpacity = snowVal > 0.65 ? (brightness2 * opacity * 0.95 + 0.04) : (opacity * 0.03);
          break;
        }

        case 'snowfall': {
          // Snowfall: cascading columns top to bottom
          const col2 = index % 16;
          const row2 = Math.floor(index / 16);
          const fallPhase = (this.tick * 1.8 + col2 * 0.85 + row2 * 0.25) % (Math.PI * 2);
          const fallVal = (Math.sin(fallPhase) + 1) / 2;
          color = this.colorType === 'rainbow'
            ? `hsl(${(col2 * 22 + this.tick * 18) % 360}, 85%, 60%)`
            : '#c8e8ff';
          elOpacity = fallVal > 0.72 ? (opacity * fallVal) : (opacity * 0.04);
          break;
        }

        case 'meteor':
        case 'spring': {
          const meteorPos = (this.tick * 8) % totalKeys;
          const distM = Math.abs(index - meteorPos);
          if (distM < 4) {
            color = this.colorType === 'rainbow' ? '#ec4899' : '#06b6d4';
            elOpacity = opacity * (1 - distM / 4);
          } else {
            color = this.primaryColor;
            elOpacity = opacity * 0.25;
          }
          break;
        }

        case 'keyshadow':
        case 'layers':
        case 'sine':
        case 'colorgrid': {
          const gridVal = (Math.sin(index * 1.5 + this.tick * 3.5) + 1) / 2;
          const hue = (index * 25 + this.tick * 30) % 360;
          color = this.colorType === 'rainbow' ? `hsl(${hue}, 85%, 55%)` : this.primaryColor;
          elOpacity = (gridVal * opacity).toFixed(2);
          break;
        }

        case 'off':
          elOpacity = 0.05;
          color = '#222222';
          break;

        default:
          color = this.primaryColor;
          break;
      }

      el.style.opacity = elOpacity;
      el.style.setProperty('--key-rgb', color);
    });
  }


  // Flash a key on physical/virtual press
  triggerKeyRipple(code) {
    const el = this.keyElementsMap[code];
    if (!el) return;

    el.classList.add('active-pressed');
    setTimeout(() => el.classList.remove('active-pressed'), 120);

    if (this.currentEffect === 'reactive') {
      const flashColors = ['#ec4899', '#06b6d4', '#10b981', '#f59e0b', '#8b5cf6'];
      const randomColor = flashColors[Math.floor(Math.random() * flashColors.length)];
      el.setAttribute('data-reactive-color', randomColor);

      setTimeout(() => {
        el.removeAttribute('data-reactive-color');
      }, 600);
    }
  }
}


