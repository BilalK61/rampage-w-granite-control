// KeyboardEvent.code → USB HID usage code (keyboard page 0x07), plus short labels.
// Physical key codes, so the table is the same for every OS keyboard layout.

const TABLE = {};

'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((ch, i) => { TABLE['Key' + ch] = 0x04 + i; });
for (let i = 1; i <= 9; i++) TABLE['Digit' + i] = 0x1d + i;
TABLE.Digit0 = 0x27;
for (let i = 1; i <= 12; i++) TABLE['F' + i] = 0x39 + i;
for (let i = 1; i <= 9; i++) TABLE['Numpad' + i] = 0x58 + i;
TABLE.Numpad0 = 0x62;

Object.assign(TABLE, {
  Enter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c,
  Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31,
  Semicolon: 0x33, Quote: 0x34, Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38,
  CapsLock: 0x39,
  PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48, Insert: 0x49, Home: 0x4a, PageUp: 0x4b,
  Delete: 0x4c, End: 0x4d, PageDown: 0x4e,
  ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
  NumLock: 0x53, NumpadDivide: 0x54, NumpadMultiply: 0x55, NumpadSubtract: 0x56,
  NumpadAdd: 0x57, NumpadEnter: 0x58, NumpadDecimal: 0x63,
  IntlBackslash: 0x64, ContextMenu: 0x65,
  ControlLeft: 0xe0, ShiftLeft: 0xe1, AltLeft: 0xe2, MetaLeft: 0xe3,
  ControlRight: 0xe4, ShiftRight: 0xe5, AltRight: 0xe6, MetaRight: 0xe7
});

const HID_TO_CODE = {};
Object.entries(TABLE).forEach(([code, hid]) => { HID_TO_CODE[hid] = code; });

const LABELS = {
  Enter: 'Enter', Escape: 'Esc', Backspace: 'Backspace', Tab: 'Tab', Space: 'Boşluk',
  Minus: '*', Equal: '-', BracketLeft: 'Ğ', BracketRight: 'Ü', Backslash: ',',
  Semicolon: 'Ş', Quote: 'İ', Backquote: '"', Comma: 'Ö', Period: 'Ç', Slash: '.',
  CapsLock: 'Caps', IntlBackslash: '<>',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  PageUp: 'PgUp', PageDown: 'PgDn',
  ControlLeft: 'Ctrl', ControlRight: 'Sağ Ctrl', ShiftLeft: 'Shift', ShiftRight: 'Sağ Shift',
  AltLeft: 'Alt', AltRight: 'AltGr', MetaLeft: 'Win', MetaRight: 'Sağ Win'
};

export function codeToHid(code) {
  return TABLE[code];
}

export function hidToCode(hid) {
  return HID_TO_CODE[hid];
}

export function keyLabel(code) {
  if (LABELS[code]) return LABELS[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}
