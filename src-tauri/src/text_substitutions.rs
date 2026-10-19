//! Turns off macOS autocorrection in every Argmax webview.
//!
//! WebKit takes its text-checking switches from the host app's user defaults
//! (`TextCheckerMac.mm`), not from the page, and reads them once, when the
//! first webview starts. So they are written here, before any window exists,
//! and they cover every field: inputs, the CodeMirror composer, and pages in
//! the in-app browser. Spell-check underlines stay as each field asks; only
//! the edits macOS would make on its own are off. Writing them at every launch
//! also undoes a toggle from the Spelling and Grammar context menu.

#[cfg(target_os = "macos")]
const DISABLED_DEFAULTS: [&str; 4] = [
    // The correction bubble, including its capitalization fixes.
    "WebAutomaticSpellingCorrectionEnabled",
    // System text replacements such as "omw".
    "WebAutomaticTextReplacementEnabled",
    // Smart quotes and dashes would corrupt pasted commands and code.
    "WebAutomaticQuoteSubstitutionEnabled",
    "WebAutomaticDashSubstitutionEnabled",
];

#[cfg(target_os = "macos")]
pub fn disable() {
    use objc2_foundation::{NSString, NSUserDefaults};

    let defaults = NSUserDefaults::standardUserDefaults();
    for key in DISABLED_DEFAULTS {
        defaults.setBool_forKey(false, &NSString::from_str(key));
    }
}

#[cfg(not(target_os = "macos"))]
pub fn disable() {}
