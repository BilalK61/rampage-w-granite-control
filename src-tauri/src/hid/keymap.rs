/// ─────────────────────────────────────────────────────────────────────────────
/// Key matrix + on-board macro protocol (ROYUAN / Yichip, same family as SET_USERPIC)
///
/// Reverse-engineered from the vendor web driver; every packet is 65 bytes
/// (Report ID at [0]) with a Bit7 checksum: `buf[8] = 0xFF - sum(buf[1..=7])`.
///
/// SET_KEYMATRIX (0x09) — 9 pages of 56 bytes = 504 bytes = 126 slots × 4:
///   [1]=0x09 [2]=profile [3]=0xF8 [4]=0x01 [5]=page(0..8) [8]=checksum [9..]=data
/// GET_KEYMATRIX (0x89) — 8 pages, reply = 64 data bytes (16 slots), no echo:
///   [1]=0x89 [2]=profile [3]=page(0..7)
/// SET_MACRO (0x0B) — 5 pages of 56 bytes (first 256 bytes used):
///   [1]=0x0B [2]=macro index [3]=0x00 [4]=0x01 [5]=page(0..4) [8]=checksum [9..]=data
/// GET_MACRO (0x8B) — 4 pages, reply = 64 data bytes:
///   [1]=0x8B [2]=macro index [3]=page(0..3)
///
/// Slot entries (4 bytes) in the matrix:
///   normal key   [0x00, modifiers, key, key2]   (default: [0, 0, hid, 0])
///   macro        [0x09, mode, macro index, 0]   (mode 0=repeat N, 1=toggle, 2=hold)
///
/// Macro data (256 bytes): `[repeat lo, repeat hi]` then one record per key event:
///   delay ≤ 127 ms → `[hid, delay | (down ? 0x80 : 0)]`
///   delay  > 127 ms → `[hid, down ? 0x80 : 0, delay lo, delay hi]`
/// The list ends at the first zero key code.
/// ─────────────────────────────────────────────────────────────────────────────

use super::protocol::{calc_checksum, Packet, PACKET_LEN};

pub const OP_SET_KEYMATRIX: u8 = 0x09;
pub const OP_SET_MACRO: u8 = 0x0B;
pub const OP_GET_PROFILE: u8 = 0x85;
pub const OP_GET_KEYMATRIX: u8 = 0x89;
pub const OP_GET_MACRO: u8 = 0x8B;

/// Slots returned by GET_KEYMATRIX (8 pages × 16).
pub const KEYMAP_SLOTS: usize = 128;
pub const KEYMAP_READ_PAGES: usize = 8;
pub const KEYMAP_WRITE_PAGES: usize = 9;
pub const KEYMAP_BYTES: usize = KEYMAP_SLOTS * 4;
/// Bytes the keyboard accepts on write (126 slots).
pub const KEYMAP_WRITE_BYTES: usize = 504;
/// Slots 0..92 hold a key on the 75% layout; used to reject stale/zeroed reads.
pub const KEYMAP_FILLED_SLOTS: usize = 92;

pub const MACRO_SLOTS: u8 = 50;
pub const MACRO_BYTES: usize = 256;
pub const MACRO_WRITE_PAGES: usize = 5;
pub const MACRO_READ_PAGES: usize = 4;
const PAGE_BYTES: usize = 56;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacroMode {
    /// Play `repeat` times per press.
    Repeat = 0,
    /// Press once to start looping, press again to stop.
    Toggle = 1,
    /// Loop while the key is held.
    Hold = 2,
}

impl MacroMode {
    pub fn from_name(s: &str) -> Option<Self> {
        match s {
            "repeat" => Some(Self::Repeat),
            "toggle" => Some(Self::Toggle),
            "hold"   => Some(Self::Hold),
            _        => None,
        }
    }

    pub fn from_wire(b: u8) -> Self {
        match b {
            1 => Self::Toggle,
            2 => Self::Hold,
            _ => Self::Repeat,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Repeat => "repeat",
            Self::Toggle => "toggle",
            Self::Hold   => "hold",
        }
    }
}

/// One key transition followed by a wait, in USB HID usage codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MacroEvent {
    pub hid: u8,
    pub down: bool,
    pub delay_ms: u16,
}

/// Matrix entry that runs macro `index`.
pub fn macro_entry(mode: MacroMode, index: u8) -> [u8; 4] {
    [0x09, mode as u8, index, 0]
}

/// `Some((mode, index))` when the entry runs a macro.
pub fn parse_macro_entry(entry: &[u8]) -> Option<(MacroMode, u8)> {
    (entry.len() >= 3 && entry[0] == 0x09).then(|| (MacroMode::from_wire(entry[1]), entry[2]))
}

/// Entry of a key with no remap: `[0, 0, hid, 0]`.
pub fn plain_entry(hid: u8) -> [u8; 4] {
    [0, 0, hid, 0]
}

/// Entry that presses up to three keys together (`[0, k1, k2, k3]`).
/// One key uses the same `[0, 0, key, 0]` form as the stock layout.
pub fn key_entry(keys: &[u8]) -> Result<[u8; 4], String> {
    if keys.is_empty() || keys.len() > 3 {
        return Err("Bir atamada 1 ile 3 tuş olabilir.".into());
    }
    if keys.iter().any(|k| !(4..=231).contains(k)) {
        return Err("Atamada geçersiz tuş kodu var.".into());
    }
    if (1..keys.len()).any(|i| keys[..i].contains(&keys[i])) {
        return Err("Aynı tuş atamada iki kez kullanılamaz.".into());
    }
    Ok(match keys {
        [k] => plain_entry(*k),
        [a, b] => [0, *a, *b, 0],
        _ => [0, keys[0], keys[1], keys[2]],
    })
}

/// True for entries that just press keys (stock key or a remap).
pub fn is_key_entry(entry: &[u8]) -> bool {
    entry.len() >= 4 && entry[0] == 0 && entry[1..4].iter().any(|&b| b != 0)
}

/// Keys pressed by a key entry, in order.
pub fn parse_key_entry(entry: &[u8]) -> Option<Vec<u8>> {
    is_key_entry(entry).then(|| entry[1..4].iter().copied().filter(|&b| b != 0).collect())
}

/// Encode a macro into the 256-byte on-board format.
pub fn encode_macro(events: &[MacroEvent], repeat: u16) -> Result<[u8; MACRO_BYTES], String> {
    if events.is_empty() {
        return Err("Makroda hiç olay yok.".into());
    }
    let mut out = [0u8; MACRO_BYTES];
    out[0] = (repeat & 0xFF) as u8;
    out[1] = (repeat >> 8) as u8;
    let mut pos = 2;

    for ev in events {
        if ev.hid == 0 {
            return Err("Geçersiz tuş kodu (0).".into());
        }
        // 0 would be read back as the long form, so the shortest delay is 1 ms.
        let delay = ev.delay_ms.max(1);
        let record: ([u8; 4], usize) = if delay <= 127 {
            ([ev.hid, delay as u8 | if ev.down { 0x80 } else { 0 }, 0, 0], 2)
        } else {
            ([ev.hid, if ev.down { 0x80 } else { 0 }, (delay & 0xFF) as u8, (delay >> 8) as u8], 4)
        };
        // Keep at least one zero byte after the last record as the terminator.
        if pos + record.1 >= MACRO_BYTES {
            return Err(format!("Makro çok uzun (en fazla {} bayt).", MACRO_BYTES - 3));
        }
        out[pos..pos + record.1].copy_from_slice(&record.0[..record.1]);
        pos += record.1;
    }
    Ok(out)
}

/// Inverse of `encode_macro` (used for read-back verification).
pub fn decode_macro(data: &[u8]) -> Option<(u16, Vec<MacroEvent>)> {
    if data.len() < 3 {
        return None;
    }
    let repeat = u16::from_le_bytes([data[0], data[1]]);
    let mut events = Vec::new();
    let mut i = 2;
    while i + 1 < data.len() && data[i] != 0 {
        let hid = data[i];
        let flags = data[i + 1];
        let down = flags & 0x80 != 0;
        let short = (flags & 0x7F) as u16;
        if short != 0 {
            events.push(MacroEvent { hid, down, delay_ms: short });
            i += 2;
        } else {
            if i + 3 >= data.len() {
                return None;
            }
            events.push(MacroEvent { hid, down, delay_ms: u16::from_le_bytes([data[i + 2], data[i + 3]]) });
            i += 4;
        }
    }
    Some((repeat, events))
}

pub(crate) fn header(op: u8, b2: u8, b3: u8, b4: u8, b5: u8) -> Packet {
    let mut buf = [0u8; PACKET_LEN];
    buf[1] = op;
    buf[2] = b2;
    buf[3] = b3;
    buf[4] = b4;
    buf[5] = b5;
    buf[8] = calc_checksum(&buf[1..=7]);
    buf
}

fn with_payload(mut buf: Packet, payload: &[u8]) -> Packet {
    buf[9..9 + payload.len()].copy_from_slice(payload);
    buf
}

/// One page (0..5) of SET_MACRO for macro `index`.
pub fn build_macro_page(index: u8, page: usize, data: &[u8; MACRO_BYTES]) -> Packet {
    let start = page * PAGE_BYTES;
    let end = (start + PAGE_BYTES).min(MACRO_BYTES);
    let payload = if start < MACRO_BYTES { &data[start..end] } else { &[][..] };
    with_payload(header(OP_SET_MACRO, index, 0x00, 0x01, page as u8), payload)
}

/// One page (0..9) of SET_KEYMATRIX; `matrix` is the full 512-byte read buffer.
pub fn build_keymap_page(profile: u8, page: usize, matrix: &[u8; KEYMAP_BYTES]) -> Packet {
    let start = page * PAGE_BYTES;
    let end = (start + PAGE_BYTES).min(KEYMAP_WRITE_BYTES);
    with_payload(header(OP_SET_KEYMATRIX, profile, 0xF8, 0x01, page as u8), &matrix[start..end])
}

pub fn build_get_keymap_page(profile: u8, page: usize) -> Packet {
    let mut buf = header(OP_GET_KEYMATRIX, profile, page as u8, 0, 0);
    buf[8] = calc_checksum(&buf[1..=7]);
    buf
}

pub fn build_get_macro_page(index: u8, page: usize) -> Packet {
    header(OP_GET_MACRO, index, page as u8, 0, 0)
}

pub fn build_get_profile_packet() -> Packet {
    header(OP_GET_PROFILE, 0, 0, 0, 0)
}

/// Check that a matrix read looks complete (every key slot of the layout is
/// populated). Stale or zeroed pages fail this, so they never get written back.
pub fn matrix_looks_complete(matrix: &[u8; KEYMAP_BYTES]) -> bool {
    (0..KEYMAP_FILLED_SLOTS).all(|slot| matrix[slot * 4..slot * 4 + 4].iter().any(|&b| b != 0))
}

pub fn slot_entry(matrix: &[u8; KEYMAP_BYTES], slot: usize) -> [u8; 4] {
    let o = slot * 4;
    [matrix[o], matrix[o + 1], matrix[o + 2], matrix[o + 3]]
}

pub fn set_slot_entry(matrix: &mut [u8; KEYMAP_BYTES], slot: usize, entry: [u8; 4]) {
    matrix[slot * 4..slot * 4 + 4].copy_from_slice(&entry);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(hid: u8, down: bool, delay_ms: u16) -> MacroEvent {
        MacroEvent { hid, down, delay_ms }
    }

    #[test]
    fn short_delay_packs_into_two_bytes() {
        let d = encode_macro(&[ev(0x0A, true, 20), ev(0x0A, false, 100)], 1).unwrap();
        assert_eq!(&d[..8], &[1, 0, 0x0A, 0x80 | 20, 0x0A, 100, 0, 0]);
    }

    #[test]
    fn long_delay_packs_into_four_bytes() {
        let d = encode_macro(&[ev(0x04, true, 500)], 3).unwrap();
        assert_eq!(&d[..6], &[3, 0, 0x04, 0x80, 0xF4, 0x01]);
    }

    #[test]
    fn zero_delay_is_raised_to_one() {
        let d = encode_macro(&[ev(0x04, false, 0)], 1).unwrap();
        assert_eq!(&d[2..4], &[0x04, 1]);
    }

    #[test]
    fn encode_decode_roundtrip() {
        let events = vec![ev(0xE0, true, 10), ev(0x06, true, 300), ev(0x06, false, 1), ev(0xE0, false, 127)];
        let d = encode_macro(&events, 7).unwrap();
        let (repeat, back) = decode_macro(&d).unwrap();
        assert_eq!(repeat, 7);
        assert_eq!(back, events);
    }

    #[test]
    fn empty_macro_is_rejected() {
        assert!(encode_macro(&[], 1).is_err());
    }

    #[test]
    fn oversized_macro_is_rejected() {
        let events: Vec<_> = (0..130).map(|_| ev(0x04, true, 10)).collect();
        assert!(encode_macro(&events, 1).is_err());
        let ok: Vec<_> = (0..126).map(|_| ev(0x04, true, 10)).collect();
        assert!(encode_macro(&ok, 1).is_ok());
    }

    #[test]
    fn macro_entry_roundtrip() {
        let e = macro_entry(MacroMode::Hold, 7);
        assert_eq!(e, [9, 2, 7, 0]);
        assert_eq!(parse_macro_entry(&e), Some((MacroMode::Hold, 7)));
        assert_eq!(parse_macro_entry(&plain_entry(0x0A)), None);
    }

    #[test]
    fn key_entry_forms() {
        assert_eq!(key_entry(&[0x05]).unwrap(), [0, 0, 0x05, 0]);
        assert_eq!(key_entry(&[0xE0, 0x06]).unwrap(), [0, 0xE0, 0x06, 0]);
        assert_eq!(key_entry(&[0xE0, 0xE1, 0x29]).unwrap(), [0, 0xE0, 0xE1, 0x29]);
    }

    #[test]
    fn key_entry_validation() {
        assert!(key_entry(&[]).is_err());
        assert!(key_entry(&[4, 5, 6, 7]).is_err());
        assert!(key_entry(&[0]).is_err());
        assert!(key_entry(&[232]).is_err());
        assert!(key_entry(&[4, 4]).is_err());
    }

    #[test]
    fn key_entry_parsing() {
        assert_eq!(parse_key_entry(&[0, 0, 0x2B, 0]), Some(vec![0x2B]));
        assert_eq!(parse_key_entry(&[0, 0xE0, 0x06, 0]), Some(vec![0xE0, 0x06]));
        assert_eq!(parse_key_entry(&macro_entry(MacroMode::Repeat, 1)), None);
        assert_eq!(parse_key_entry(&[0, 0, 0, 0]), None);
        // Function/consumer entries seen on the real board (Win, volume) are not plain keys.
        assert!(!is_key_entry(&[0x0A, 0x01, 0, 0]));
        assert!(!is_key_entry(&[0x03, 0x00, 0xE9, 0x00]));
    }

    #[test]
    fn macro_page_header_and_checksum() {
        let mut data = [0u8; MACRO_BYTES];
        data[0] = 1;
        data[2] = 0x0A;
        let p = build_macro_page(5, 0, &data);
        assert_eq!(&p[..9], &[0, 0x0B, 5, 0, 1, 0, 0, 0, 0xFF - (0x0B + 5 + 1)]);
        assert_eq!(&p[9..13], &[1, 0, 0x0A, 0]);
        // Page 4 only carries the last 32 bytes; the rest stays zero.
        let last = build_macro_page(5, 4, &data);
        assert_eq!(last[5], 4);
        assert!(last[9 + 32..].iter().all(|&b| b == 0));
    }

    #[test]
    fn keymap_page_header() {
        let mut m = [0u8; KEYMAP_BYTES];
        m[56 * 8] = 0xAB; // first byte of the last write page
        let p = build_keymap_page(0, 8, &m);
        assert_eq!(&p[1..6], &[0x09, 0, 0xF8, 1, 8]);
        assert_eq!(p[9], 0xAB);
        assert_eq!(p[8], calc_checksum(&p[1..=7]));
    }

    #[test]
    fn get_packets() {
        let p = build_get_keymap_page(0, 3);
        assert_eq!(&p[1..4], &[0x89, 0, 3]);
        assert_eq!(p[8], calc_checksum(&p[1..=7]));
        let p = build_get_macro_page(4, 2);
        assert_eq!(&p[1..4], &[0x8B, 4, 2]);
    }

    #[test]
    fn completeness_check_rejects_zero_pages() {
        let mut m = [0u8; KEYMAP_BYTES];
        for slot in 0..KEYMAP_FILLED_SLOTS {
            set_slot_entry(&mut m, slot, plain_entry(4));
        }
        assert!(matrix_looks_complete(&m));
        set_slot_entry(&mut m, 40, [0, 0, 0, 0]);
        assert!(!matrix_looks_complete(&m));
        assert!(!matrix_looks_complete(&[0u8; KEYMAP_BYTES]));
    }
}
