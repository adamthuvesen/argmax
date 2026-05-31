//! Shared streaming-reader primitive for the provider stdout/PTY reader and the
//! integrated-terminal PTY reader. Both read raw bytes from a child process and
//! forward decoded UTF-8 text to the renderer; doing the UTF-8 boundary handling
//! in one place keeps multi-byte codepoints (CJK, emoji, smart quotes) from
//! being mangled into U+FFFD when they straddle a read boundary.

use std::io::Read;

const READ_BUFFER_BYTES: usize = 8192;

/// Largest prefix of `bytes` that ends on a UTF-8 codepoint boundary. Scans at
/// most the last 3 bytes — UTF-8 codepoints are 1-4 bytes long, so an incomplete
/// trailing sequence is necessarily within the tail. Returns the byte length
/// safe to decode now; the remainder should be carried into the next read.
pub fn utf8_safe_split(bytes: &[u8]) -> usize {
    if bytes.is_empty() {
        return 0;
    }
    let len = bytes.len();
    let scan_from = len.saturating_sub(3);
    for i in (scan_from..len).rev() {
        let byte = bytes[i];
        // Continuation bytes are 10xxxxxx — keep walking left.
        if byte & 0b1100_0000 == 0b1000_0000 {
            continue;
        }
        let expected_len = if byte & 0b1000_0000 == 0 {
            1
        } else if byte & 0b1110_0000 == 0b1100_0000 {
            2
        } else if byte & 0b1111_0000 == 0b1110_0000 {
            3
        } else if byte & 0b1111_1000 == 0b1111_0000 {
            4
        } else {
            // Invalid leading byte — flush the whole buffer and let
            // from_utf8_lossy emit a single replacement char for it.
            return len;
        };
        if i + expected_len <= len {
            return len;
        }
        return i;
    }
    // Whole tail is continuation bytes — emit nothing this round.
    0
}

/// Reads `reader` in fixed-size chunks and forwards decoded UTF-8 text to
/// `on_chunk`, carrying a partial trailing codepoint across reads so it is never
/// split into U+FFFD.
///
/// `on_read` is called once per non-empty read, before decoding, with the byte
/// count just read; returning `false` stops the pump (used for the provider's
/// "disposed" check and the terminal's "still live" check, and as the hook the
/// provider uses to fire its one-shot stream-started beacon). On a read error,
/// `on_error` is called and the pump stops. At EOF, any complete trailing bytes
/// are flushed; an incomplete trailing codepoint is dropped rather than emitted
/// as a replacement character.
pub fn pump_utf8_stream<R, OnRead, OnChunk, OnError>(
    mut reader: R,
    mut on_read: OnRead,
    mut on_chunk: OnChunk,
    mut on_error: OnError,
) where
    R: Read,
    OnRead: FnMut(usize) -> bool,
    OnChunk: FnMut(String),
    OnError: FnMut(&std::io::Error),
{
    let mut buffer = [0u8; READ_BUFFER_BYTES];
    let mut pending: Vec<u8> = Vec::with_capacity(4);
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => {
                let split_at = utf8_safe_split(&pending);
                if split_at > 0 {
                    on_chunk(String::from_utf8_lossy(&pending[..split_at]).into_owned());
                }
                break;
            }
            Ok(n) => {
                if !on_read(n) {
                    break;
                }
                pending.extend_from_slice(&buffer[..n]);
                let split_at = utf8_safe_split(&pending);
                if split_at == 0 {
                    continue;
                }
                let chunk = String::from_utf8_lossy(&pending[..split_at]).into_owned();
                pending.drain(..split_at);
                on_chunk(chunk);
            }
            Err(error) => {
                on_error(&error);
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Read};

    #[test]
    fn split_keeps_complete_codepoints() {
        assert_eq!(utf8_safe_split(b""), 0);
        assert_eq!(utf8_safe_split(b"abc"), 3);
        // "é" is 0xC3 0xA9. A lone leading byte is incomplete.
        assert_eq!(utf8_safe_split(&[0xC3]), 0);
        assert_eq!(utf8_safe_split(&[b'a', 0xC3]), 1);
        assert_eq!(utf8_safe_split(&[0xC3, 0xA9]), 2);
        // 3 of the 4 bytes of an emoji are present → emit nothing yet.
        assert_eq!(utf8_safe_split(&[0xF0, 0x9F, 0x98]), 0);
    }

    /// Reader that hands out pre-baked chunks, then optionally one error.
    struct ChunkReader {
        chunks: Vec<Vec<u8>>,
        index: usize,
        error_at_end: bool,
    }

    impl Read for ChunkReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.index < self.chunks.len() {
                let chunk = &self.chunks[self.index];
                self.index += 1;
                buf[..chunk.len()].copy_from_slice(chunk);
                Ok(chunk.len())
            } else if self.error_at_end {
                self.error_at_end = false;
                Err(io::Error::other("boom"))
            } else {
                Ok(0)
            }
        }
    }

    #[test]
    fn carries_multibyte_codepoint_across_reads() {
        // "café☕": the ☕ (0xE2 0x98 0x95) straddles the read boundary.
        let reader = ChunkReader {
            chunks: vec![vec![b'c', b'a', b'f', 0xC3, 0xA9, 0xE2], vec![0x98, 0x95]],
            index: 0,
            error_at_end: false,
        };
        let mut out = String::new();
        pump_utf8_stream(reader, |_| true, |chunk| out.push_str(&chunk), |_| {});
        assert_eq!(out, "café☕");
        assert!(!out.contains('\u{FFFD}'));
    }

    #[test]
    fn drops_incomplete_trailing_codepoint_at_eof() {
        // ☕ is missing its final byte at EOF.
        let reader = ChunkReader {
            chunks: vec![vec![b'h', b'i', 0xE2, 0x98]],
            index: 0,
            error_at_end: false,
        };
        let mut out = String::new();
        pump_utf8_stream(reader, |_| true, |chunk| out.push_str(&chunk), |_| {});
        assert_eq!(out, "hi");
    }

    #[test]
    fn on_read_false_discards_that_read_and_stops() {
        let reader = ChunkReader {
            chunks: vec![vec![b'a'], vec![b'b']],
            index: 0,
            error_at_end: false,
        };
        let mut out = String::new();
        let mut reads = 0;
        pump_utf8_stream(
            reader,
            |_| {
                reads += 1;
                reads < 2
            },
            |chunk| out.push_str(&chunk),
            |_| {},
        );
        assert_eq!(out, "a");
    }

    #[test]
    fn reports_read_errors() {
        let reader = ChunkReader {
            chunks: vec![vec![b'x']],
            index: 0,
            error_at_end: true,
        };
        let mut errors = 0;
        let mut out = String::new();
        pump_utf8_stream(reader, |_| true, |chunk| out.push_str(&chunk), |_| errors += 1);
        assert_eq!(out, "x");
        assert_eq!(errors, 1);
    }
}
