/// ─────────────────────────────────────────────────────────────────────────────
/// ROYUAN / Yichip USB HID Protocol — Packet Builders & Checksum
///
/// Hardware: Rampage W-Granite (75% Turkish Q)
///   VID: 0x3151  PID: 0x4015 / 0x4011
///   Interface 2, UsagePage 0xFFFF, Usage 2
///
/// Packet layout (65 bytes, Report ID in byte 0):
///
/// SET_LEDPARAM (opcode 0x07):
///   [0]  = 0x00  Report ID
///   [1]  = 0x07  Opcode
///   [2]  = mode  (1..19, 0 = off)
///   [3]  = speed wire value (1..5; 5=slowest, 1=fastest)
///   [4]  = brightness wire value (0..4)
///   [5]  = (direction & 0x0F) << 4 | (flags & 0x0F)
///   [6]  = R
///   [7]  = G
///   [8]  = B
///   [9]  = checksum = (0xFF - sum(bytes[1..=8])) & 0xFF
///   [10..64] = 0x00
///
/// SET_SLEDPARAM (opcode 0x08) — Edge / Side Light:
///   [0]  = 0x00
///   [1]  = 0x08
///   [2]  = side_mode (0=off, 1=static, 2=breathing, 3=spectrum, 4=wave, 5=snake)
///   [3]  = speed (1..5)
///   [4]  = brightness (0..4)
///   [5]  = flags (0x07 = fixed color, 0x08 = rainbow)
///   [6]  = R
///   [7]  = G
///   [8]  = B
///   [9]  = checksum = (0xFF - sum(bytes[1..=8])) & 0xFF
///
/// GET_LEDPARAM (opcode 0x87): send a 65-byte packet with byte[1]=0x87, read back
///   the reply in the same layout as SET_LEDPARAM.
/// ─────────────────────────────────────────────────────────────────────────────

/// All 19 official hardware lighting modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LightingMode {
    Off       = 0,
    Static    = 1,
    Breathing = 2,
    Spectrum  = 3,
    Wave      = 4,
    Ripple    = 5,
    Stardots  = 6,
    Flow      = 7,
    Keyshadow = 8,
    Layers    = 9,
    Sine      = 10,
    Spring    = 11,
    Neon      = 12,
    // Mode 13 = Userpic/per-key (not exposed via normal SET_LEDPARAM on this FW)
    Radiant   = 14,
    Loop      = 15,
    Colorgrid = 16,
    Snowfall  = 17,
    Meteor    = 18,
    Silentsnow = 19,
}

impl LightingMode {
    /// Parse from a string name (matches JS modeMap keys).
    pub fn from_name(s: &str) -> Option<Self> {
        match s {
            "off"        => Some(Self::Off),
            "static"     => Some(Self::Static),
            "breathing"  => Some(Self::Breathing),
            "spectrum"   => Some(Self::Spectrum),
            "wave"       => Some(Self::Wave),
            "ripple"     => Some(Self::Ripple),
            "stardots"   => Some(Self::Stardots),
            "flow"       => Some(Self::Flow),
            "keyshadow"  => Some(Self::Keyshadow),
            "layers"     => Some(Self::Layers),
            "sine"       => Some(Self::Sine),
            "spring"     => Some(Self::Spring),
            "neon"       => Some(Self::Neon),
            "radiant"    => Some(Self::Radiant),
            "loop"       => Some(Self::Loop),
            "colorgrid"  => Some(Self::Colorgrid),
            "snowfall"   => Some(Self::Snowfall),
            "meteor"     => Some(Self::Meteor),
            "silentsnow" => Some(Self::Silentsnow),
            _            => None,
        }
    }

    pub fn from_wire(byte: u8) -> Option<Self> {
        match byte {
            0  => Some(Self::Off),
            1  => Some(Self::Static),
            2  => Some(Self::Breathing),
            3  => Some(Self::Spectrum),
            4  => Some(Self::Wave),
            5  => Some(Self::Ripple),
            6  => Some(Self::Stardots),
            7  => Some(Self::Flow),
            8  => Some(Self::Keyshadow),
            9  => Some(Self::Layers),
            10 => Some(Self::Sine),
            11 => Some(Self::Spring),
            12 => Some(Self::Neon),
            14 => Some(Self::Radiant),
            15 => Some(Self::Loop),
            16 => Some(Self::Colorgrid),
            17 => Some(Self::Snowfall),
            18 => Some(Self::Meteor),
            19 => Some(Self::Silentsnow),
            _  => None,
        }
    }

    pub fn wire_byte(self) -> u8 {
        self as u8
    }
}

/// Colour mode flag sent in byte[5] low nibble.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ColorType {
    Custom,
    Rainbow,
}

impl ColorType {
    pub fn flag(self) -> u8 {
        match self {
            Self::Custom  => 0x07,
            Self::Rainbow => 0x08,
        }
    }

    pub fn from_flag(flag: u8) -> Self {
        if flag == 0x08 { Self::Rainbow } else { Self::Custom }
    }

    /// Determine the color type flag for a given mode if not explicitly set.
    /// Rainbow modes: Spectrum(3), Wave(4), Flow(7), Neon(12).
    pub fn default_for_mode(mode: LightingMode) -> Self {
        match mode {
            LightingMode::Spectrum | LightingMode::Wave
            | LightingMode::Flow   | LightingMode::Neon => Self::Rainbow,
            _ => Self::Custom,
        }
    }
}

/// ─── Conversion helpers ──────────────────────────────────────────────────────

/// Speed: UI percentage (25 / 50 / 75 / 100) → wire byte (4 / 3 / 2 / 1).
///
/// The firmware has 4 speed levels. UI step = 25 pp each.
/// Wire encoding is inverted: level 1 (25%) → wire 4 (slowest), level 4 (100%) → wire 1 (fastest).
///
/// JS original:
///   const speedLevel = Math.max(1, Math.min(4, Math.round(speedPct / 25)));
///   const speedWire  = 5 - speedLevel;
pub fn speed_pct_to_wire(speed_pct: u8) -> u8 {
    let clamped = speed_pct.clamp(25, 100);
    // Round to nearest 25-step level (1..=4)
    let level = ((clamped as f64 / 25.0).round() as u8).clamp(1, 4);
    5 - level // invert: 1→4, 2→3, 3→2, 4→1
}

/// Speed wire byte → UI percentage (inverse of above).
pub fn speed_wire_to_pct(wire: u8) -> u8 {
    let clamped = wire.clamp(1, 4);
    let level = 5 - clamped; // 4→1, 3→2, 2→3, 1→4
    level * 25
}

/// Brightness: UI percentage (0..=100) → wire value (0..=4).
///
/// JS: Math.round((brightPct / 100) * 4)
pub fn brightness_pct_to_wire(brightness_pct: u8) -> u8 {
    let clamped = brightness_pct.clamp(0, 100);
    ((clamped as f64 / 100.0) * 4.0).round() as u8
}

/// Brightness wire value → UI percentage.
pub fn brightness_wire_to_pct(wire: u8) -> u8 {
    let clamped = wire.clamp(0, 4);
    ((clamped as f64 / 4.0) * 100.0).round() as u8
}

/// ─── Packet size ─────────────────────────────────────────────────────────────

pub const PACKET_LEN: usize = 65;

pub type Packet = [u8; PACKET_LEN];

/// Checksum over bytes[1..=8] (inclusive): (0xFF - sum) & 0xFF.
///
/// JS original: `(0xFF - payloadBytes.reduce((a,b)=>a+b,0) & 0xFF) & 0xFF`
pub fn calc_checksum(bytes_1_to_8: &[u8]) -> u8 {
    let sum: u8 = bytes_1_to_8.iter().fold(0u8, |acc, &b| acc.wrapping_add(b));
    0xFFu8.wrapping_sub(sum)
}

/// ─── SET_LEDPARAM packet (opcode 0x07) ───────────────────────────────────────

#[derive(Debug, Clone)]
pub struct RgbParams {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub mode: LightingMode,
    /// Wire speed value (1..=5); use `speed_pct_to_wire` to convert from UI %.
    pub speed_wire: u8,
    /// Wire brightness value (0..=4); use `brightness_pct_to_wire` to convert.
    pub brightness_wire: u8,
    pub color_type: ColorType,
    /// Direction nibble (0=left, 1=right, 2=up, 3=down). Stored in high nibble of byte[5].
    pub direction: u8,
}

pub fn build_rgb_packet(p: &RgbParams) -> Packet {
    let mut buf = [0u8; PACKET_LEN];
    buf[0] = 0x00; // Report ID
    buf[1] = 0x07; // SET_LEDPARAM opcode
    buf[2] = p.mode.wire_byte();
    buf[3] = p.speed_wire.clamp(1, 5);
    buf[4] = p.brightness_wire.clamp(0, 4);
    buf[5] = ((p.direction & 0x0F) << 4) | (p.color_type.flag() & 0x0F);

    // Protocol note: pure white #FFFFFF → use #FAFAFA instead (firmware recommendation).
    let (r, g, b) = if p.r == 255 && p.g == 255 && p.b == 255 {
        (0xFA, 0xFA, 0xFA)
    } else {
        (p.r, p.g, p.b)
    };
    buf[6] = r;
    buf[7] = g;
    buf[8] = b;
    buf[9] = calc_checksum(&buf[1..=8]);
    // bytes [10..64] remain 0x00
    buf
}

/// ─── SET_SLEDPARAM packet (opcode 0x08) — Edge / Side Light ─────────────────

#[derive(Debug, Clone)]
pub struct SideRgbParams {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    /// Side light mode: 0=off, 1=static, 2=breathing, 3=spectrum, 4=wave, 5=snake.
    pub side_mode: u8,
    pub speed_wire: u8,
    pub brightness_wire: u8,
    pub color_type: ColorType,
}

pub fn build_side_rgb_packet(p: &SideRgbParams) -> Packet {
    let mut buf = [0u8; PACKET_LEN];
    buf[0] = 0x00;
    buf[1] = 0x08; // SET_SLEDPARAM opcode
    buf[2] = p.side_mode.clamp(0, 5);
    buf[3] = p.speed_wire.clamp(1, 5);
    buf[4] = p.brightness_wire.clamp(0, 4);
    buf[5] = p.color_type.flag();
    buf[6] = p.r;
    buf[7] = p.g;
    buf[8] = p.b;
    buf[9] = calc_checksum(&buf[1..=8]);
    buf
}

/// ─── GET_LEDPARAM query packet (opcode 0x87) ─────────────────────────────────

pub fn build_get_ledparam_packet() -> Packet {
    let mut buf = [0u8; PACKET_LEN];
    buf[0] = 0x00;
    buf[1] = 0x87; // GET_LEDPARAM opcode
    // Checksum over bytes[1..=8] — only byte[1] is non-zero here.
    buf[8] = calc_checksum(&buf[1..=8]);
    buf
}

/// Parsed reply from GET_LEDPARAM (opcode 0x87).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareRgbState {
    pub mode: u8,
    /// Speed expressed as UI percentage (25 / 50 / 75 / 100).
    pub speed_pct: u8,
    /// Brightness expressed as UI percentage (0..=100).
    pub brightness_pct: u8,
    pub color_type: String,    // "custom" | "rainbow"
    pub direction: u8,
    pub primary_color: String, // "#rrggbb"
}

/// Parse a 65-byte GET_LEDPARAM reply buffer into `HardwareRgbState`.
///
/// Returns `None` if the buffer is too short or the opcode doesn't match.
pub fn parse_get_ledparam_reply(rep: &[u8]) -> Option<HardwareRgbState> {
    if rep.len() < 9 || rep[1] != 0x87 {
        return None;
    }

    let mode          = rep[2];
    let wire_speed    = rep[3]; // 1..5 (5=slowest, 1=fastest)
    let brightness_w  = rep[4]; // 0..4
    let flags_byte    = rep[5];
    let direction     = (flags_byte >> 4) & 0x0F;
    let flags         = flags_byte & 0x0F;
    let r             = rep[6];
    let g             = rep[7];
    let b             = rep[8];

    let speed_pct      = speed_wire_to_pct(wire_speed);
    let brightness_pct = brightness_wire_to_pct(brightness_w);

    let color_type = if flags == 0x08 { "rainbow" } else { "custom" };
    let primary_color = format!("#{:02x}{:02x}{:02x}", r, g, b);

    Some(HardwareRgbState {
        mode,
        speed_pct,
        brightness_pct,
        color_type: color_type.to_string(),
        direction,
        primary_color,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Checksum ──────────────────────────────────────────────────────────────

    /// Verify the checksum formula: (0xFF - sum) & 0xFF wrapping arithmetic.
    #[test]
    fn checksum_all_zeros() {
        // bytes[1..=8] all zero → sum = 0 → checksum = 0xFF
        let bytes = [0u8; 8];
        assert_eq!(calc_checksum(&bytes), 0xFF);
    }

    #[test]
    fn checksum_all_ones() {
        // sum = 8, checksum = 0xFF - 8 = 0xF7
        let bytes = [1u8; 8];
        assert_eq!(calc_checksum(&bytes), 0xF7);
    }

    #[test]
    fn checksum_wraps_correctly() {
        // sum = 0xFF * 8 = 0x7F8; low byte = 0xF8; checksum = 0xFF - 0xF8 = 0x07
        let bytes = [0xFFu8; 8];
        assert_eq!(calc_checksum(&bytes), 0x07);
    }

    // ── build_rgb_packet ──────────────────────────────────────────────────────

    fn static_purple_params() -> RgbParams {
        RgbParams {
            r: 139, g: 92, b: 246,
            mode: LightingMode::Static,
            speed_wire: 2,
            brightness_wire: 4,
            color_type: ColorType::Custom,
            direction: 0,
        }
    }

    #[test]
    fn packet_opcode_and_report_id() {
        let pkt = build_rgb_packet(&static_purple_params());
        assert_eq!(pkt[0], 0x00, "Report ID must be 0x00");
        assert_eq!(pkt[1], 0x07, "SET_LEDPARAM opcode must be 0x07");
    }

    #[test]
    fn packet_mode_byte() {
        let pkt = build_rgb_packet(&static_purple_params());
        assert_eq!(pkt[2], 1, "Static mode wire byte = 1");
    }

    #[test]
    fn packet_speed_and_brightness() {
        let pkt = build_rgb_packet(&static_purple_params());
        assert_eq!(pkt[3], 2, "speed_wire");
        assert_eq!(pkt[4], 4, "brightness_wire");
    }

    #[test]
    fn packet_flags_byte_custom_no_direction() {
        let pkt = build_rgb_packet(&static_purple_params());
        // direction=0, flags=0x07 → byte[5] = (0 << 4) | 0x07 = 0x07
        assert_eq!(pkt[5], 0x07);
    }

    #[test]
    fn packet_flags_byte_rainbow_with_direction() {
        let mut p = static_purple_params();
        p.color_type = ColorType::Rainbow;
        p.direction = 2; // Up
        let pkt = build_rgb_packet(&p);
        // (2 << 4) | 0x08 = 0x28
        assert_eq!(pkt[5], 0x28);
    }

    #[test]
    fn packet_color_bytes() {
        let pkt = build_rgb_packet(&static_purple_params());
        assert_eq!(pkt[6], 139, "R");
        assert_eq!(pkt[7], 92,  "G");
        assert_eq!(pkt[8], 246, "B");
    }

    #[test]
    fn packet_pure_white_remapped() {
        let p = RgbParams {
            r: 255, g: 255, b: 255,
            mode: LightingMode::Static,
            speed_wire: 2,
            brightness_wire: 4,
            color_type: ColorType::Custom,
            direction: 0,
        };
        let pkt = build_rgb_packet(&p);
        // Protocol: pure #FFFFFF → #FAFAFA on wire
        assert_eq!(pkt[6], 0xFA);
        assert_eq!(pkt[7], 0xFA);
        assert_eq!(pkt[8], 0xFA);
    }

    #[test]
    fn packet_checksum_is_valid() {
        let pkt = build_rgb_packet(&static_purple_params());
        let expected = calc_checksum(&pkt[1..=8]);
        assert_eq!(pkt[9], expected, "checksum must equal calc_checksum(pkt[1..=8])");
    }

    #[test]
    fn packet_tail_is_zero() {
        let pkt = build_rgb_packet(&static_purple_params());
        assert!(pkt[10..].iter().all(|&b| b == 0), "bytes 10..64 must be zero");
    }

    #[test]
    fn packet_total_length() {
        let pkt = build_rgb_packet(&static_purple_params());
        assert_eq!(pkt.len(), 65);
    }

    // ── build_side_rgb_packet ─────────────────────────────────────────────────

    #[test]
    fn side_packet_opcode() {
        let p = SideRgbParams {
            r: 255, g: 0, b: 0,
            side_mode: 1,
            speed_wire: 3,
            brightness_wire: 4,
            color_type: ColorType::Custom,
        };
        let pkt = build_side_rgb_packet(&p);
        assert_eq!(pkt[0], 0x00);
        assert_eq!(pkt[1], 0x08, "SET_SLEDPARAM opcode must be 0x08");
    }

    #[test]
    fn side_packet_checksum_valid() {
        let p = SideRgbParams {
            r: 100, g: 150, b: 200,
            side_mode: 2,
            speed_wire: 3,
            brightness_wire: 2,
            color_type: ColorType::Rainbow,
        };
        let pkt = build_side_rgb_packet(&p);
        assert_eq!(pkt[9], calc_checksum(&pkt[1..=8]));
    }

    // ── Speed conversion ──────────────────────────────────────────────────────

    #[test]
    fn speed_pct_25_to_wire_4() {
        assert_eq!(speed_pct_to_wire(25), 4); // slowest
    }

    #[test]
    fn speed_pct_50_to_wire_3() {
        assert_eq!(speed_pct_to_wire(50), 3);
    }

    #[test]
    fn speed_pct_75_to_wire_2() {
        assert_eq!(speed_pct_to_wire(75), 2);
    }

    #[test]
    fn speed_pct_100_to_wire_1() {
        assert_eq!(speed_pct_to_wire(100), 1); // fastest
    }

    #[test]
    fn speed_wire_roundtrip() {
        for pct in [25u8, 50, 75, 100] {
            let wire = speed_pct_to_wire(pct);
            let back = speed_wire_to_pct(wire);
            assert_eq!(back, pct, "roundtrip failed for pct={pct}");
        }
    }

    // ── Brightness conversion ─────────────────────────────────────────────────

    #[test]
    fn brightness_pct_0_to_wire_0() {
        assert_eq!(brightness_pct_to_wire(0), 0);
    }

    #[test]
    fn brightness_pct_25_to_wire_1() {
        assert_eq!(brightness_pct_to_wire(25), 1);
    }

    #[test]
    fn brightness_pct_50_to_wire_2() {
        assert_eq!(brightness_pct_to_wire(50), 2);
    }

    #[test]
    fn brightness_pct_75_to_wire_3() {
        assert_eq!(brightness_pct_to_wire(75), 3);
    }

    #[test]
    fn brightness_pct_100_to_wire_4() {
        assert_eq!(brightness_pct_to_wire(100), 4);
    }

    #[test]
    fn brightness_wire_roundtrip() {
        for pct in [0u8, 25, 50, 75, 100] {
            let wire = brightness_pct_to_wire(pct);
            let back = brightness_wire_to_pct(wire);
            assert_eq!(back, pct, "roundtrip failed for pct={pct}");
        }
    }

    // ── LightingMode ──────────────────────────────────────────────────────────

    #[test]
    fn mode_from_name_known() {
        assert_eq!(LightingMode::from_name("static"),     Some(LightingMode::Static));
        assert_eq!(LightingMode::from_name("breathing"),  Some(LightingMode::Breathing));
        assert_eq!(LightingMode::from_name("spectrum"),   Some(LightingMode::Spectrum));
        assert_eq!(LightingMode::from_name("off"),        Some(LightingMode::Off));
        assert_eq!(LightingMode::from_name("silentsnow"), Some(LightingMode::Silentsnow));
    }

    #[test]
    fn mode_from_name_unknown() {
        assert_eq!(LightingMode::from_name("custom_per_key"), None);
        assert_eq!(LightingMode::from_name(""), None);
    }

    #[test]
    fn mode_wire_roundtrip() {
        let modes = [
            LightingMode::Off, LightingMode::Static, LightingMode::Breathing,
            LightingMode::Spectrum, LightingMode::Wave, LightingMode::Ripple,
            LightingMode::Stardots, LightingMode::Flow, LightingMode::Keyshadow,
            LightingMode::Layers, LightingMode::Sine, LightingMode::Spring,
            LightingMode::Neon, LightingMode::Radiant, LightingMode::Loop,
            LightingMode::Colorgrid, LightingMode::Snowfall, LightingMode::Meteor,
            LightingMode::Silentsnow,
        ];
        for m in modes {
            let wire = m.wire_byte();
            let back = LightingMode::from_wire(wire).expect("from_wire failed");
            assert_eq!(back, m, "roundtrip failed for {m:?}");
        }
    }

    // ── GET_LEDPARAM reply parser ─────────────────────────────────────────────

    #[test]
    fn parse_get_ledparam_valid_static_purple() {
        // Simulate what the keyboard would return for Static purple, speed=75%, brightness=100%, dir=0
        let mut rep = [0u8; 65];
        rep[1] = 0x87; // correct opcode echo
        rep[2] = 1;    // Static mode
        rep[3] = 2;    // speed wire (75% → 2)
        rep[4] = 4;    // brightness wire (100% → 4)
        rep[5] = 0x07; // direction=0, flags=0x07 (custom)
        rep[6] = 139;  // R
        rep[7] = 92;   // G
        rep[8] = 246;  // B

        let state = parse_get_ledparam_reply(&rep).expect("parse must succeed");
        assert_eq!(state.mode, 1);
        assert_eq!(state.speed_pct, 75);
        assert_eq!(state.brightness_pct, 100);
        assert_eq!(state.color_type, "custom");
        assert_eq!(state.direction, 0);
        assert_eq!(state.primary_color, "#8b5cf6");
    }

    #[test]
    fn parse_get_ledparam_rainbow_flag() {
        let mut rep = [0u8; 65];
        rep[1] = 0x87;
        rep[2] = 3;    // Spectrum
        rep[5] = 0x08; // rainbow flag
        let state = parse_get_ledparam_reply(&rep).expect("parse must succeed");
        assert_eq!(state.color_type, "rainbow");
    }

    #[test]
    fn parse_get_ledparam_wrong_opcode_returns_none() {
        let mut rep = [0u8; 65];
        rep[1] = 0x07; // wrong — not an echo of 0x87
        assert!(parse_get_ledparam_reply(&rep).is_none());
    }

    #[test]
    fn parse_get_ledparam_too_short_returns_none() {
        let rep = [0u8; 8]; // needs at least 9
        assert!(parse_get_ledparam_reply(&rep).is_none());
    }

    // ── GET_LEDPARAM query packet ─────────────────────────────────────────────

    #[test]
    fn get_ledparam_packet_structure() {
        let pkt = build_get_ledparam_packet();
        assert_eq!(pkt[0], 0x00);
        assert_eq!(pkt[1], 0x87);
        // Only byte[1] is non-zero in payload bytes[1..8], so sum = 0x87 = 135.
        // checksum = 0xFF - 135 = 120 = 0x78
        assert_eq!(pkt[8], 0x78, "checksum for GET_LEDPARAM query");
    }

    // ── ColorType helpers ─────────────────────────────────────────────────────

    #[test]
    fn color_type_flags() {
        assert_eq!(ColorType::Custom.flag(),  0x07);
        assert_eq!(ColorType::Rainbow.flag(), 0x08);
    }

    #[test]
    fn color_type_default_for_mode() {
        assert_eq!(ColorType::default_for_mode(LightingMode::Spectrum), ColorType::Rainbow);
        assert_eq!(ColorType::default_for_mode(LightingMode::Wave),     ColorType::Rainbow);
        assert_eq!(ColorType::default_for_mode(LightingMode::Neon),     ColorType::Rainbow);
        assert_eq!(ColorType::default_for_mode(LightingMode::Static),   ColorType::Custom);
        assert_eq!(ColorType::default_for_mode(LightingMode::Breathing),ColorType::Custom);
    }
}
