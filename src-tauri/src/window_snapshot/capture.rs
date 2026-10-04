//! Taking the picture: the system `screencapture` tool, then proof that what
//! it wrote is a real image.
//!
//! `screencapture -l<window id>` captures one window by id and works on every
//! macOS Argmax supports, where ScreenCaptureKit's screenshot API needs 14 and
//! `CGWindowListCreateImage` is gone from current SDKs. The tool is run with an
//! argument vector, never through a shell. Permission is checked before it
//! runs, because a process without Screen Recording access can still get a
//! picture back that shows the desktop and none of the window.

use std::path::Path;
use std::process::Command;

use super::SnapshotError;

pub const SCREENCAPTURE: &str = "/usr/sbin/screencapture";
pub const SIPS: &str = "/usr/bin/sips";

/// Long edge of a pasted image (`MAX_ATTACHMENT_DIMENSION_PX` in
/// `composerAttachments.ts`). A full Retina window is several megabytes of PNG
/// and its base64 has to fit the provider's 4 MiB single-line stream, so a
/// snapshot is held to the same edge before it is stored.
pub const MAX_EDGE_PX: u32 = 1920;

/// No window is wider than this. It bounds the decode buffer for a corrupt file.
const MAX_DIMENSION: u32 = 16_384;

/// Write window `window_id` to `output` as a PNG with `program`.
/// `-x` silences the shutter sound, `-o` leaves out the window's drop shadow.
pub fn run_screencapture(
    program: &Path,
    window_id: u32,
    output: &Path,
) -> Result<(), SnapshotError> {
    let result = Command::new(program)
        .args(["-x", "-o", "-t", "png"])
        .arg(format!("-l{window_id}"))
        .arg(output)
        .output()
        .map_err(|error| {
            SnapshotError::CaptureFailed(format!("could not run screencapture: {error}"))
        })?;
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        let detail = stderr.trim();
        return Err(SnapshotError::CaptureFailed(if detail.is_empty() {
            format!("screencapture exited with {}", result.status)
        } else {
            detail.to_owned()
        }));
    }
    Ok(())
}

/// Shrink `input` so its long edge is [`MAX_EDGE_PX`], writing `output`.
/// `sips -Z` enlarges a smaller image too, so callers only run it on an image
/// that is over the edge.
pub fn downscale_png(program: &Path, input: &Path, output: &Path) -> Result<(), SnapshotError> {
    let result = Command::new(program)
        .arg("-Z")
        .arg(MAX_EDGE_PX.to_string())
        .arg(input)
        .arg("--out")
        .arg(output)
        .output()
        .map_err(|error| SnapshotError::CaptureFailed(format!("could not run sips: {error}")))?;
    if !result.status.success() {
        return Err(SnapshotError::CaptureFailed(format!(
            "could not shrink the snapshot: {}",
            String::from_utf8_lossy(&result.stderr).trim()
        )));
    }
    Ok(())
}

/// The PNG to store: `bytes` as captured when its long edge is within
/// [`MAX_EDGE_PX`], else the shrunk copy, and in both cases a verified image.
/// `scratch` is a directory the caller removes.
pub fn prepare_png(bytes: Vec<u8>, scratch: &Path, sips: &Path) -> Result<Vec<u8>, SnapshotError> {
    let (width, height) = verify_png(&bytes)?;
    if width.max(height) <= MAX_EDGE_PX {
        return Ok(bytes);
    }
    let input = scratch.join("full.png");
    let output = scratch.join("scaled.png");
    std::fs::write(&input, &bytes)
        .map_err(|error| SnapshotError::CaptureFailed(format!("no scratch file: {error}")))?;
    downscale_png(sips, &input, &output)?;
    let scaled = std::fs::read(&output).map_err(|error| {
        SnapshotError::CaptureFailed(format!("the shrink wrote no file: {error}"))
    })?;
    let (scaled_width, scaled_height) = verify_png(&scaled)?;
    if scaled_width.max(scaled_height) > MAX_EDGE_PX {
        return Err(SnapshotError::CaptureFailed(
            "the snapshot was not shrunk".to_owned(),
        ));
    }
    Ok(scaled)
}

/// Reads `bytes` as a PNG and refuses an empty file, a file that is not a
/// PNG, a zero-sized image, and an image with no visible pixel at all.
pub fn verify_png(bytes: &[u8]) -> Result<(u32, u32), SnapshotError> {
    if bytes.is_empty() {
        return Err(SnapshotError::BlankCapture);
    }
    let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
        .read_info()
        .map_err(|error| SnapshotError::CaptureFailed(format!("not a readable PNG: {error}")))?;
    let (width, height) = {
        let info = reader.info();
        (info.width, info.height)
    };
    if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err(SnapshotError::CaptureFailed(format!(
            "unusable image size {width}x{height}"
        )));
    }
    let mut pixels = vec![0u8; reader.output_buffer_size()];
    let frame = reader
        .next_frame(&mut pixels)
        .map_err(|error| SnapshotError::CaptureFailed(format!("not a readable PNG: {error}")))?;
    let has_alpha = matches!(
        frame.color_type,
        png::ColorType::Rgba | png::ColorType::GrayscaleAlpha
    );
    if has_alpha {
        let stride = if frame.color_type == png::ColorType::Rgba {
            4
        } else {
            2
        };
        let bytes_per_sample = if frame.bit_depth == png::BitDepth::Sixteen {
            2
        } else {
            1
        };
        let pixel = stride * bytes_per_sample;
        let alpha_offset = pixel - bytes_per_sample;
        let visible = pixels[..frame.buffer_size()]
            .chunks_exact(pixel)
            .any(|chunk| chunk[alpha_offset..pixel].iter().any(|byte| *byte != 0));
        if !visible {
            return Err(SnapshotError::BlankCapture);
        }
    }
    Ok((width, height))
}

#[cfg(test)]
pub(super) mod fixtures {
    /// An encoded PNG of `width`x`height` RGBA pixels, each `pixel`.
    pub fn rgba_png(width: u32, height: u32, pixel: [u8; 4]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("header");
        let data: Vec<u8> = (0..width * height).flat_map(|_| pixel).collect();
        writer.write_image_data(&data).expect("pixels");
        writer.finish().expect("finish");
        out
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::rgba_png;
    use super::*;

    #[test]
    fn a_real_window_picture_passes() {
        assert_eq!(
            verify_png(&rgba_png(40, 30, [200, 10, 10, 255])),
            Ok((40, 30))
        );
    }

    #[test]
    fn a_fully_transparent_picture_is_a_blank_capture_not_a_success() {
        assert_eq!(
            verify_png(&rgba_png(40, 30, [0, 0, 0, 0])),
            Err(SnapshotError::BlankCapture)
        );
    }

    #[test]
    fn an_empty_or_garbage_file_is_refused() {
        assert_eq!(verify_png(&[]), Err(SnapshotError::BlankCapture));
        assert!(matches!(
            verify_png(b"not a png"),
            Err(SnapshotError::CaptureFailed(_))
        ));
    }

    #[test]
    fn an_image_within_the_edge_is_stored_as_captured() {
        let png = rgba_png(1920, 600, [1, 2, 3, 255]);
        let dir = tempfile::tempdir().unwrap();
        // The tool path does not exist: it must not even be tried.
        let kept = prepare_png(png.clone(), dir.path(), Path::new("/nonexistent/sips")).unwrap();
        assert_eq!(kept, png);
    }

    /// The real `sips`, on a Retina-sized window: long edge to 1920, aspect and
    /// opacity kept.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_retina_window_is_shrunk_to_the_paste_edge_by_the_system_tool() {
        let dir = tempfile::tempdir().unwrap();
        let big = rgba_png(5120, 2880, [200, 10, 10, 255]);
        let scaled = prepare_png(big.clone(), dir.path(), Path::new(SIPS)).unwrap();
        assert_eq!(verify_png(&scaled), Ok((1920, 1080)));
        assert!(scaled.len() < big.len());
    }

    #[cfg(unix)]
    mod with_a_stand_in_tool {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        /// A script that behaves like `screencapture`: it gets the argument
        /// vector the real tool would and writes `body` to the last argument.
        fn stand_in(dir: &Path, script: &str) -> std::path::PathBuf {
            let path = dir.join("screencapture");
            std::fs::write(&path, script).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        #[test]
        fn the_tool_gets_the_window_id_and_a_png_destination_as_separate_arguments() {
            let dir = tempfile::tempdir().unwrap();
            let log = dir.path().join("args.log");
            let fixture = dir.path().join("fixture.png");
            std::fs::write(&fixture, rgba_png(8, 8, [1, 2, 3, 255])).unwrap();
            let tool = stand_in(
                dir.path(),
                &format!(
                    "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >> '{log}'; done\nfor last; do :; done\ncp '{fixture}' \"$last\"\n",
                    log = log.display(),
                    fixture = fixture.display()
                ),
            );
            let out = dir.path().join("out dir with spaces.png");

            run_screencapture(&tool, 4242, &out).unwrap();

            let args = std::fs::read_to_string(&log).unwrap();
            assert_eq!(
                args.lines().collect::<Vec<_>>(),
                vec!["-x", "-o", "-t", "png", "-l4242", out.to_str().unwrap()]
            );
            assert_eq!(verify_png(&std::fs::read(&out).unwrap()), Ok((8, 8)));
        }

        #[test]
        fn a_failing_shrink_is_an_error_not_the_full_size_image() {
            let dir = tempfile::tempdir().unwrap();
            let tool = stand_in(dir.path(), "#!/bin/sh\necho 'no good' >&2\nexit 1\n");
            let error =
                prepare_png(rgba_png(2400, 100, [1, 2, 3, 255]), dir.path(), &tool).unwrap_err();
            assert!(
                matches!(error, SnapshotError::CaptureFailed(message) if message.contains("no good"))
            );
        }

        #[test]
        fn a_shrink_that_leaves_the_image_too_large_is_refused() {
            let dir = tempfile::tempdir().unwrap();
            // Copies its input to --out unchanged.
            let tool = stand_in(dir.path(), "#!/bin/sh\ncp \"$3\" \"$5\"\n");
            let error =
                prepare_png(rgba_png(2400, 100, [1, 2, 3, 255]), dir.path(), &tool).unwrap_err();
            assert!(matches!(error, SnapshotError::CaptureFailed(_)));
        }

        #[test]
        fn a_failing_tool_reports_its_own_message() {
            let dir = tempfile::tempdir().unwrap();
            let tool = stand_in(
                dir.path(),
                "#!/bin/sh\necho 'could not create image from window' >&2\nexit 1\n",
            );
            let error = run_screencapture(&tool, 1, &dir.path().join("x.png")).unwrap_err();
            assert_eq!(
                error,
                SnapshotError::CaptureFailed("could not create image from window".to_owned())
            );
        }

        #[test]
        fn a_missing_tool_is_a_capture_failure() {
            let error = run_screencapture(
                Path::new("/nonexistent/screencapture"),
                1,
                Path::new("/tmp/x.png"),
            )
            .unwrap_err();
            assert!(matches!(error, SnapshotError::CaptureFailed(_)));
        }
    }
}
