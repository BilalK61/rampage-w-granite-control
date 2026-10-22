// Keyboard Layout Definitions: Turkish Q 75% (84-Key Compact Layout matching user's keyboard)
// Total units per row = exactly 16.0 units (Row 1: 16x 1.0u keys)
export const KEYBOARD_LAYOUTS = {
  compact75: [
    // Row 1: 16 Keys x 1.0u = 16.0u
    [
      { code: 'Escape', label: 'Esc', icon: 'sun' },
      { code: 'F1', label: 'F1', sub: 'BT1' },
      { code: 'F2', label: 'F2', sub: 'BT2' },
      { code: 'F3', label: 'F3', sub: 'BT3' },
      { code: 'F4', label: 'F4', sub: '2.4G' },
      { code: 'F5', label: 'F5', icon: 'volume-x' },
      { code: 'F6', label: 'F6', icon: 'volume-1' },
      { code: 'F7', label: 'F7', icon: 'volume-2' },
      { code: 'F8', label: 'F8', icon: 'play-pause' },
      { code: 'F9', label: 'F9', icon: 'monitor' },
      { code: 'F10', label: 'F10', icon: 'tv' },
      { code: 'F11', label: 'F11', icon: 'smartphone' },
      { code: 'F12', label: 'F12', icon: 'app-window' },
      { code: 'Search', icon: 'search' },
      { code: 'Lock', icon: 'lock' },
      { code: 'Delete', label: 'Del', icon: 'rotate-ccw', isSpecial: true }
    ],
    // Row 2: 13x 1.0u + Backspace (2.0u) + Home (1.0u) = 16.0u
    [
      { code: 'Backquote', label: '"', sub: 'é' },
      { code: 'Digit1', label: '1', sub: '!' },
      { code: 'Digit2', label: '2', sub: "'" },
      { code: 'Digit3', label: '3', sub: '^ #' },
      { code: 'Digit4', label: '4', sub: '+ $' },
      { code: 'Digit5', label: '5', sub: '%' },
      { code: 'Digit6', label: '6', sub: '&' },
      { code: 'Digit7', label: '7', sub: '/ {' },
      { code: 'Digit8', label: '8', sub: '( [' },
      { code: 'Digit9', label: '9', sub: ') ]' },
      { code: 'Digit0', label: '0', sub: '= }' },
      { code: 'Minus', label: '*', sub: '?' },
      { code: 'Equal', label: '-', sub: '_' },
      { code: 'Backspace', label: 'Back', icon: 'delete', width: 'u-2-0' },
      { code: 'Home', label: 'Home', sub: 'Ins', isSpecial: true }
    ],
    // Row 3: Tab (1.5u) + 11x 1.0u + ISO Enter (1.5u) + End (1.0u) = 15.0u (+ ISO Enter overlaps Row 4) = 16.0u
    [
      { code: 'Tab', label: 'Tab', width: 'u-1-5' },
      { code: 'KeyQ', label: 'Q', sub: '@' },
      { code: 'KeyW', label: 'W' },
      { code: 'KeyE', label: 'E', sub: '€' },
      { code: 'KeyR', label: 'R' },
      { code: 'KeyT', label: 'T', sub: '₺' },
      { code: 'KeyY', label: 'Y' },
      { code: 'KeyU', label: 'U' },
      { code: 'KeyI', label: 'I' },
      { code: 'KeyO', label: 'O' },
      { code: 'KeyP', label: 'P' },
      { code: 'BracketLeft', label: 'Ğ' },
      { code: 'BracketRight', label: 'Ü', sub: '~' },
      { code: 'Enter', label: 'Enter', icon: 'corner-down-left', isIsoEnter: true, width: 'u-iso-top' },
      { code: 'End', label: 'End', sub: 'PS', isSpecial: true }
    ],
    // Row 4: Caps (1.75u) + 11x 1.0u + (ISO lower placeholder 1.25u) + PgUp (1.0u) = 15.0u (+ lower enter) = 16.0u
    [
      { code: 'CapsLock', label: 'Caps', width: 'u-1-75' },
      { code: 'KeyA', label: 'A' },
      { code: 'KeyS', label: 'S' },
      { code: 'KeyD', label: 'D' },
      { code: 'KeyF', label: 'F' },
      { code: 'KeyG', label: 'G' },
      { code: 'KeyH', label: 'H' },
      { code: 'KeyJ', label: 'J' },
      { code: 'KeyK', label: 'K' },
      { code: 'KeyL', label: 'L' },
      { code: 'Semicolon', label: 'Ş' },
      { code: 'Quote', label: 'İ' },
      { code: 'Backslash', label: ',', sub: ';' },
      { code: 'EnterLower', isIsoPlaceholder: true, width: 'u-iso-bot' },
      { code: 'PageUp', label: 'PgUp', sub: 'SL', isSpecial: true }
    ],
    // Row 5: ShiftLeft (1.25u) + 11x 1.0u + ShiftRight (1.75u) + ArrowUp (1.0u) + PgDn (1.0u) = 16.0u
    [
      { code: 'ShiftLeft', label: 'Shift', icon: 'sun', width: 'u-1-25' },
      { code: 'IntlBackslash', label: '< >', sub: '|' },
      { code: 'KeyZ', label: 'Z' },
      { code: 'KeyX', label: 'X' },
      { code: 'KeyC', label: 'C' },
      { code: 'KeyV', label: 'V' },
      { code: 'KeyB', label: 'B' },
      { code: 'KeyN', label: 'N' },
      { code: 'KeyM', label: 'M' },
      { code: 'Comma', label: 'Ö' },
      { code: 'Period', label: 'Ç' },
      { code: 'Slash', label: '.', sub: ':' },
      { code: 'ShiftRight', label: 'Shift', icon: 'target', width: 'u-1-75' },
      { code: 'ArrowUp', icon: 'arrow-up', sub: '☼+' },
      { code: 'PageDown', label: 'PgDn', sub: 'PB', isSpecial: true }
    ],
    // Row 6: Ctrl (1.25u) + Fn (1.0u) + Win (1.25u) + Alt (1.25u) + Space (6.25u) + Alt (1.0u) + Win (1.0u) + Left (1.0u) + Down (1.0u) + Right (1.0u) = 16.0u
    [
      { code: 'ControlLeft', label: 'Ctrl', width: 'u-1-25' },
      { code: 'Fn', label: 'Fn' },
      { code: 'MetaLeft', label: 'Win', sub: 'Option', width: 'u-1-25' },
      { code: 'AltLeft', label: 'Alt', sub: 'Cmd', width: 'u-1-25' },
      { code: 'Space', label: '—', width: 'u-6-25' },
      { code: 'AltRight', label: 'Alt', sub: 'Cmd' },
      { code: 'MetaRight', label: 'Win', sub: 'Option' },
      { code: 'ArrowLeft', icon: 'arrow-left', sub: '🏃-' },
      { code: 'ArrowDown', icon: 'arrow-down', sub: '☼-' },
      { code: 'ArrowRight', icon: 'arrow-right', sub: '🏃+' }
    ]
  ]
};





export const DEFAULT_PRESET_COLORS = [
  '#e50914', // Rampage Crimson Red
  '#00e5ff', // Cyber Cyan
  '#ff9100', // Amber Orange
  '#00e676', // Acid Green
  '#d500f9', // Neon Purple
  '#2979ff', // Cobalt Blue
  '#ffd600', // Electric Yellow
  '#ffffff'  // Crystal White
];
