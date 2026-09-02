//! Programmatic control of the in-app browser's child webviews.
//!
//! The panel's own toolbar drives its webviews through `ipc::browser`; this
//! module is the part agents need instead — capture what a tab looks like, run
//! a script in it and get the value back, and read and drive the page through
//! the two injected scripts. Capture and eval are callback-shaped on the macOS
//! side (a WebKit completion handler that runs on the main thread), so both
//! wrap that callback in a oneshot channel with a deadline: a page that never
//! answers must not park the caller forever.
//!
//! `registry` is the app's list of live tabs and who owns each one; the
//! renderer mirrors it rather than owning it.

pub mod automation;
pub mod eval;
pub mod registry;
pub mod snapshot_image;

/// Rect in the tab's own view coordinates (CSS pixels, origin top-left).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CaptureRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Standard base64, no line breaks. `attachments::store` hand-rolls the
/// decoder for the same reason this hand-rolls the encoder: one alphabet and
/// three lines of bit-shifting are not worth a dependency.
pub fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) as usize & 63] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[triple as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::encode_base64;

    #[test]
    fn encodes_with_padding_for_every_chunk_remainder() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"M"), "TQ==");
        assert_eq!(encode_base64(b"Ma"), "TWE=");
        assert_eq!(encode_base64(b"Man"), "TWFu");
        assert_eq!(encode_base64(b"Many"), "TWFueQ==");
    }

    #[test]
    fn encodes_the_png_magic_bytes() {
        assert_eq!(encode_base64(&[0x89, 0x50, 0x4e, 0x47]), "iVBORw==");
    }
}
