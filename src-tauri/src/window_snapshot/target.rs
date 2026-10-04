//! Which window of the frontmost app a snapshot takes.

/// One on-screen window, as the window server lists it (front to back).
#[derive(Debug, Clone, PartialEq)]
pub struct WindowCandidate {
    pub id: u32,
    pub owner_pid: i32,
    pub title: Option<String>,
    /// 0 is a normal app window; menus, the Dock and overlays sit above it.
    pub layer: i32,
    pub alpha: f64,
    pub width: f64,
    pub height: f64,
}

/// Smaller than this is a toolbar, a palette or a tooltip, not the window the
/// user means.
const MIN_WIDTH: f64 = 100.0;
const MIN_HEIGHT: f64 = 60.0;

/// The frontmost normal window `pid` owns. `windows` is in the window server's
/// front-to-back order, so the first match is the one on top.
pub fn pick_window(windows: &[WindowCandidate], pid: i32) -> Option<&WindowCandidate> {
    windows.iter().find(|window| {
        window.owner_pid == pid
            && window.layer == 0
            && window.alpha > 0.0
            && window.width >= MIN_WIDTH
            && window.height >= MIN_HEIGHT
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(id: u32, pid: i32) -> WindowCandidate {
        WindowCandidate {
            id,
            owner_pid: pid,
            title: Some(format!("window {id}")),
            layer: 0,
            alpha: 1.0,
            width: 1200.0,
            height: 800.0,
        }
    }

    #[test]
    fn the_topmost_normal_window_of_the_app_wins() {
        let windows = [window(1, 20), window(2, 10), window(3, 10)];
        assert_eq!(pick_window(&windows, 10).map(|w| w.id), Some(2));
    }

    #[test]
    fn overlays_hidden_and_tiny_windows_are_skipped() {
        let mut menu = window(1, 10);
        menu.layer = 25;
        let mut hidden = window(2, 10);
        hidden.alpha = 0.0;
        let mut palette = window(3, 10);
        palette.height = 30.0;
        let real = window(4, 10);
        assert_eq!(
            pick_window(&[menu, hidden, palette, real], 10).map(|w| w.id),
            Some(4)
        );
    }

    #[test]
    fn an_app_with_no_window_yields_none() {
        assert_eq!(pick_window(&[window(1, 20)], 10), None);
        assert_eq!(pick_window(&[], 10), None);
    }
}
