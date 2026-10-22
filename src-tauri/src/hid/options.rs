/// Device option commands (same 65-byte, Bit7-checksum framing as `keymap`).
///
/// SET_DEBOUNCE (0x11): `[0x11, 0, level]`, level 1..=10 (vendor driver range).
/// GET_DEBOUNCE (0x91): reply `[0x91, _, level]`.
/// GET_REV      (0x80): reply `[0x80, minor, major]`.
///
/// Sleep time, report rate and side-light settings are not supported by this
/// firmware family (the vendor driver stubs them out), so there is no command.

use super::keymap::header;
use super::protocol::{Packet, PACKET_LEN};

pub const OP_SET_DEBOUNCE: u8 = 0x11;
pub const OP_GET_DEBOUNCE: u8 = 0x91;
pub const OP_GET_REV: u8 = 0x80;

pub const DEBOUNCE_MIN: u8 = 1;
pub const DEBOUNCE_MAX: u8 = 10;

pub fn build_set_debounce_packet(level: u8) -> Packet {
    header(OP_SET_DEBOUNCE, 0, level, 0, 0)
}

pub fn build_get_debounce_packet() -> Packet {
    header(OP_GET_DEBOUNCE, 0, 0, 0, 0)
}

pub fn build_get_rev_packet() -> Packet {
    header(OP_GET_REV, 0, 0, 0, 0)
}

/// `reply` has the Report ID at [0] and the command echo at [1].
pub fn parse_debounce_reply(reply: &[u8; PACKET_LEN]) -> Option<u8> {
    (reply[1] == OP_GET_DEBOUNCE && (DEBOUNCE_MIN..=DEBOUNCE_MAX).contains(&reply[3])).then(|| reply[3])
}

pub fn parse_firmware_reply(reply: &[u8; PACKET_LEN]) -> Option<String> {
    (reply[1] == OP_GET_REV && (reply[2] != 0 || reply[3] != 0)).then(|| format!("{}.{}", reply[3], reply[2]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hid::protocol::calc_checksum;

    fn reply(bytes: &[u8]) -> [u8; PACKET_LEN] {
        let mut r = [0u8; PACKET_LEN];
        r[1..1 + bytes.len()].copy_from_slice(bytes);
        r
    }

    #[test]
    fn set_debounce_layout() {
        let p = build_set_debounce_packet(7);
        assert_eq!(&p[..5], &[0, 0x11, 0, 7, 0]);
        assert_eq!(p[8], calc_checksum(&p[1..=7]));
    }

    #[test]
    fn debounce_reply_from_real_keyboard() {
        // Captured: 91 00 01 00 00 00 00 6e
        assert_eq!(parse_debounce_reply(&reply(&[0x91, 0, 1, 0, 0, 0, 0, 0x6e])), Some(1));
        assert_eq!(parse_debounce_reply(&reply(&[0x91, 0, 0])), None);
        assert_eq!(parse_debounce_reply(&reply(&[0x87, 0, 3])), None);
    }

    #[test]
    fn firmware_reply_from_real_keyboard() {
        // Captured: 80 01 01 00 00 00 00 7f
        assert_eq!(parse_firmware_reply(&reply(&[0x80, 1, 1])), Some("1.1".to_string()));
        assert_eq!(parse_firmware_reply(&reply(&[0x80, 0, 0])), None);
    }
}
