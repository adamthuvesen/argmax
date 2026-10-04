//! The chord: saved settings, registration with the OS, and what runs when it
//! fires.
//!
//! Registration goes through [`ChordRegistrar`] so an error from the OS call can
//! be tested without the OS. An error is never silent: it is kept in
//! [`Registration`], returned by `window-snapshot:configure`, and shown in
//! Settings next to the chord, and the previous chord stays registered.
//!
//! macOS registers these chords non-exclusively (`RegisterEventHotKey` with no
//! exclusive option), so it does not refuse a chord another app already holds:
//! both apps may fire. Only an OS-level error reaches the user. The maintained
//! plugin exposes no exclusive option, so Argmax does not try to detect it.

use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use super::{SnapshotError, WindowSnapshotAttach, ATTACH_EVENT, FAILED_EVENT};
use crate::error::{ArgmaxError, ArgmaxResult, InvalidInputIssue};
use crate::persistence::{sqlite_error, time::now_iso};
use crate::util::sync::LockOrRecover;

/// ⌘⌥⇧S on macOS. Three modifiers keep it clear of the system's ⌘⇧3/4/5 and of
/// most apps' own bindings.
pub const DEFAULT_CHORD: &str = "CommandOrControl+Alt+Shift+S";
const ENABLED_KEY: &str = "window_snapshot.enabled";
const CHORD_KEY: &str = "window_snapshot.chord";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    /// Off until the user turns it on: a system-wide shortcut is theirs to opt into.
    pub enabled: bool,
    pub chord: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            chord: DEFAULT_CHORD.to_owned(),
        }
    }
}

fn read_value<T: serde::de::DeserializeOwned>(connection: &Connection, key: &str) -> Option<T> {
    connection
        .prepare_cached("SELECT value_json FROM ui_state WHERE key = ?")
        .and_then(|mut statement| {
            statement
                .query_row(params![key], |row| row.get::<_, String>(0))
                .optional()
        })
        .unwrap_or(None)
        .and_then(|value| serde_json::from_str(&value).ok())
}

fn write_value<T: Serialize>(connection: &Connection, key: &str, value: &T) -> ArgmaxResult<()> {
    let value = serde_json::to_string(value).map_err(crate::persistence::json_error)?;
    connection
        .prepare_cached(
            "INSERT INTO ui_state (key, value_json, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        )
        .map_err(sqlite_error)?
        .execute(params![key, value, now_iso()])
        .map_err(sqlite_error)?;
    Ok(())
}

/// A stored chord that no longer parses reads as the default, not as a
/// shortcut that silently never fires.
pub fn load_settings(connection: &Connection) -> Settings {
    let defaults = Settings::default();
    let chord = read_value::<String>(connection, CHORD_KEY)
        .filter(|chord| validate_chord(chord).is_ok())
        .unwrap_or(defaults.chord);
    Settings {
        enabled: read_value(connection, ENABLED_KEY).unwrap_or(defaults.enabled),
        chord,
    }
}

/// Both rows or neither: a failure on the second must not leave the first
/// written, or the saved flag and chord would disagree.
pub fn save_settings(connection: &Connection, settings: &Settings) -> ArgmaxResult<()> {
    let transaction = connection.unchecked_transaction().map_err(sqlite_error)?;
    write_value(&transaction, ENABLED_KEY, &settings.enabled)?;
    write_value(&transaction, CHORD_KEY, &settings.chord)?;
    transaction.commit().map_err(sqlite_error)
}

fn chord_issue(message: impl Into<String>) -> ArgmaxError {
    ArgmaxError::invalid(InvalidInputIssue::at(
        vec!["chord".to_owned()],
        "WINDOW_SNAPSHOT_CHORD_INVALID",
        message,
    ))
}

/// A chord a person can press and the OS can register: one key plus at least
/// one of ⌘, ⌃ or ⌥. Shift alone is a capital letter, and a bare key would
/// swallow typing in every app.
pub fn validate_chord(chord: &str) -> ArgmaxResult<Shortcut> {
    let shortcut = Shortcut::from_str(chord.trim())
        .map_err(|error| chord_issue(format!("{chord:?} is not a valid shortcut: {error}")))?;
    let anchoring = Modifiers::SUPER | Modifiers::CONTROL | Modifiers::ALT;
    if !shortcut.mods.intersects(anchoring) {
        return Err(chord_issue(
            "A shortcut needs Command, Control or Option as well as a key.",
        ));
    }
    Ok(shortcut)
}

/// The OS side of registration.
pub trait ChordRegistrar {
    fn register(&self, chord: &Shortcut) -> Result<(), String>;
    fn unregister(&self, chord: &Shortcut) -> Result<(), String>;
}

struct TauriRegistrar<'a, R: Runtime>(&'a AppHandle<R>);

impl<R: Runtime> ChordRegistrar for TauriRegistrar<'_, R> {
    fn register(&self, chord: &Shortcut) -> Result<(), String> {
        self.0
            .global_shortcut()
            .on_shortcut(*chord, |app, _chord, event| {
                // The press, not the release: a held chord must not fire twice.
                if event.state() == ShortcutState::Pressed {
                    on_chord_pressed(app);
                }
            })
            .map_err(|error| error.to_string())
    }

    fn unregister(&self, chord: &Shortcut) -> Result<(), String> {
        self.0
            .global_shortcut()
            .unregister(*chord)
            .map_err(|error| error.to_string())
    }
}

/// What registration achieved, for Settings.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Registration {
    /// The chord the OS holds for us right now, in the form it was saved.
    pub registered: Option<String>,
    pub error: Option<String>,
}

/// Managed app state: what is registered, and whether a capture is under way.
#[derive(Default)]
pub struct WindowSnapshotState {
    registration: Mutex<Registration>,
    capturing: AtomicBool,
}

impl WindowSnapshotState {
    pub fn registration(&self) -> Registration {
        self.registration
            .lock_or_recover("window snapshot registration")
            .clone()
    }
}

/// Make the OS registration match `settings`. A chord the OS refuses leaves
/// nothing registered and the reason in the returned [`Registration`].
pub fn apply(
    registrar: &dyn ChordRegistrar,
    state: &WindowSnapshotState,
    settings: &Settings,
) -> Registration {
    let mut registration = state
        .registration
        .lock_or_recover("window snapshot registration");
    if let Some(previous) = registration.registered.take() {
        if let Ok(previous) = Shortcut::from_str(&previous) {
            if let Err(error) = registrar.unregister(&previous) {
                tracing::warn!(%error, "could not release the previous window snapshot chord");
            }
        }
    }
    registration.error = None;
    if settings.enabled {
        let outcome = if !super::is_supported() {
            Err(SnapshotError::Unsupported.to_string())
        } else {
            validate_chord(&settings.chord)
                .map_err(|error| error.to_string())
                .and_then(|chord| registrar.register(&chord))
        };
        match outcome {
            Ok(()) => registration.registered = Some(settings.chord.clone()),
            Err(error) => {
                tracing::warn!(chord = %settings.chord, %error, "window snapshot chord was not registered");
                registration.error = Some(error);
            }
        }
    }
    registration.clone()
}

/// Register the saved chord at startup. A failure is recorded, not fatal.
pub fn install<R: Runtime>(app: &AppHandle<R>, connection: &Connection) {
    let state = app.state::<WindowSnapshotState>();
    apply(&TauriRegistrar(app), &state, &load_settings(connection));
}

/// Apply new settings; on a registration error or a failed save put the
/// previous registration back and fail, so the OS and the saved settings agree
/// and a rejected chord never leaves the user with no shortcut at all.
pub fn configure<R: Runtime>(
    app: &AppHandle<R>,
    connection: &Connection,
    next: Settings,
) -> ArgmaxResult<Registration> {
    configure_with(
        &TauriRegistrar(app),
        &app.state::<WindowSnapshotState>(),
        connection,
        next,
    )
}

fn configure_with(
    registrar: &dyn ChordRegistrar,
    state: &WindowSnapshotState,
    connection: &Connection,
    next: Settings,
) -> ArgmaxResult<Registration> {
    if next.enabled {
        validate_chord(&next.chord)?;
    }
    let previous = load_settings(connection);
    let result = apply(registrar, state, &next);
    if let Some(error) = result.error {
        apply(registrar, state, &previous);
        return Err(ArgmaxError::service(
            "WINDOW_SNAPSHOT_REGISTRATION_FAILED",
            error,
        ));
    }
    if let Err(error) = save_settings(connection, &next) {
        // The OS holds the new chord but the settings still name the old one;
        // put the registration back so the two agree.
        apply(registrar, state, &previous);
        return Err(error);
    }
    Ok(result)
}

/// Where a finished capture goes.
pub trait SnapshotSink {
    /// Raise the Argmax window that last had focus and name it.
    fn raise_window(&self) -> String;
    fn attach(&self, window: &str, snapshot: &WindowSnapshotAttach);
    fn failed(&self, window: &str, error: &SnapshotError);
}

/// Hand the result to exactly one window: raised first so the user sees where
/// it landed, then addressed by label rather than broadcast.
pub fn deliver(sink: &dyn SnapshotSink, result: Result<WindowSnapshotAttach, SnapshotError>) {
    let window = sink.raise_window();
    match result {
        Ok(snapshot) => sink.attach(&window, &snapshot),
        Err(error) => sink.failed(&window, &error),
    }
}

struct TauriSink<'a, R: Runtime>(&'a AppHandle<R>);

impl<R: Runtime> SnapshotSink for TauriSink<'_, R> {
    fn raise_window(&self) -> String {
        crate::windows::focus_session_window(self.0, None);
        crate::windows::focused_window_label()
    }

    fn attach(&self, window: &str, snapshot: &WindowSnapshotAttach) {
        if let Err(error) = self.0.emit_to(window, ATTACH_EVENT, snapshot) {
            tracing::warn!(%error, "could not hand the window snapshot to the composer");
        }
    }

    fn failed(&self, window: &str, error: &SnapshotError) {
        tracing::info!(code = error.code(), "window snapshot failed");
        if let Err(emit_error) = self.0.emit_to(window, FAILED_EVENT, error.payload()) {
            tracing::warn!(%emit_error, "could not report the window snapshot failure");
        }
    }
}

fn on_chord_pressed<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<WindowSnapshotState>();
    // A second press while the first is still capturing would photograph
    // whatever the first press just raised.
    if state.capturing.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let result = match app.state::<crate::state::AppState>().attachments.get() {
            Some(store) => super::capture_frontmost_window(store, std::process::id() as i32),
            None => Err(SnapshotError::StoreFailed(
                "attachment storage is not ready".to_owned(),
            )),
        };
        deliver(&TauriSink(&app), result);
        app.state::<WindowSnapshotState>()
            .capturing
            .store(false, Ordering::SeqCst);
    });
}

/// What Settings shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowSnapshotStatus {
    pub supported: bool,
    /// `granted`, `denied` or `unsupported`.
    pub permission: String,
    pub enabled: bool,
    pub chord: String,
    pub default_chord: String,
    pub registered: bool,
    pub registration_error: Option<String>,
}

pub fn status(connection: &Connection, registration: &Registration) -> WindowSnapshotStatus {
    let settings = load_settings(connection);
    WindowSnapshotStatus {
        supported: super::is_supported(),
        permission: super::permission_label().to_owned(),
        enabled: settings.enabled,
        chord: settings.chord,
        default_chord: DEFAULT_CHORD.to_owned(),
        registered: registration.registered.is_some(),
        registration_error: registration.error.clone(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowSnapshotConfigureInput {
    pub enabled: bool,
    pub chord: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::Database;
    use crate::window_snapshot::{SnapshotAttachment, SnapshotSource};
    use std::cell::RefCell;

    /// Holds registered chords, and fails for any chord listed in
    /// `fails_to_register`, as the OS call does when it returns an error.
    #[derive(Default)]
    struct FakeOs {
        held: RefCell<Vec<String>>,
        fails_to_register: Vec<String>,
    }

    fn key(chord: &Shortcut) -> String {
        chord.into_string()
    }

    impl ChordRegistrar for FakeOs {
        fn register(&self, chord: &Shortcut) -> Result<(), String> {
            let name = key(chord);
            if self.fails_to_register.contains(&name) {
                return Err(format!(
                    "Unable to register hotkey: {name} was rejected by the OS"
                ));
            }
            self.held.borrow_mut().push(name);
            Ok(())
        }
        fn unregister(&self, chord: &Shortcut) -> Result<(), String> {
            self.held.borrow_mut().retain(|held| *held != key(chord));
            Ok(())
        }
    }

    fn on(chord: &str) -> Settings {
        Settings {
            enabled: true,
            chord: chord.to_owned(),
        }
    }

    #[test]
    fn a_chord_needs_a_key_and_an_anchoring_modifier() {
        assert!(validate_chord("CommandOrControl+Alt+Shift+S").is_ok());
        assert!(validate_chord("Control+Alt+K").is_ok());
        for bad in ["S", "Shift+S", "", "Alt+", "Banana+S", "Command+Shift"] {
            assert!(validate_chord(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    /// `recordChord` in the renderer sends the browser's physical key names
    /// (`KeyboardEvent.code`); the host has to parse every one it can produce.
    #[test]
    fn every_key_name_the_settings_recorder_can_send_parses() {
        for key in [
            "F5",
            "4",
            "Space",
            "Enter",
            "Tab",
            "Backquote",
            "Comma",
            "Period",
            "Slash",
            "Minus",
            "Equal",
            "BracketLeft",
            "Semicolon",
            "Quote",
            "Backslash",
            "ArrowUp",
            "ArrowLeft",
            "Home",
            "PageDown",
            "Delete",
            "Backspace",
            "Escape",
        ] {
            let chord = format!("Command+{key}");
            assert!(validate_chord(&chord).is_ok(), "{chord} should parse");
        }
        assert!(validate_chord("Command+Alt+Shift+S").is_ok());
        assert!(validate_chord("Control+Command+S").is_ok());
    }

    #[test]
    fn settings_default_to_off_and_survive_a_restart_and_a_corrupt_chord() {
        let database = Database::open_in_memory().unwrap();
        let connection = database.connection();
        assert_eq!(load_settings(&connection), Settings::default());
        assert!(!Settings::default().enabled);

        save_settings(&connection, &on("Control+Alt+K")).unwrap();
        assert_eq!(load_settings(&connection), on("Control+Alt+K"));

        write_value(&connection, CHORD_KEY, &"not a chord").unwrap();
        assert_eq!(load_settings(&connection).chord, DEFAULT_CHORD);
    }

    #[test]
    fn enabling_registers_and_remapping_moves_the_registration() {
        let os = FakeOs::default();
        let state = WindowSnapshotState::default();

        let first = apply(&os, &state, &on("Control+Alt+K"));
        assert_eq!(first.registered.as_deref(), Some("Control+Alt+K"));
        assert_eq!(os.held.borrow().len(), 1);

        let moved = apply(&os, &state, &on("Control+Alt+J"));
        assert_eq!(moved.registered.as_deref(), Some("Control+Alt+J"));
        assert_eq!(os.held.borrow().len(), 1, "the old chord was released");

        let off = apply(
            &os,
            &state,
            &Settings {
                enabled: false,
                chord: "Control+Alt+J".to_owned(),
            },
        );
        assert_eq!(off, Registration::default());
        assert!(os.held.borrow().is_empty());
    }

    #[test]
    fn a_registration_error_is_reported_and_the_old_chord_is_restored() {
        let database = Database::open_in_memory().unwrap();
        let connection = database.connection();
        let mut os = FakeOs::default();
        os.fails_to_register
            .push(key(&validate_chord("Control+Alt+J").unwrap()));
        let state = WindowSnapshotState::default();

        configure_with(&os, &state, &connection, on("Control+Alt+K")).unwrap();
        let refused = configure_with(&os, &state, &connection, on("Control+Alt+J")).unwrap_err();

        assert!(
            matches!(&refused, ArgmaxError::ServiceError { sub_code, message }
            if sub_code == "WINDOW_SNAPSHOT_REGISTRATION_FAILED" && message.contains("rejected by the OS"))
        );
        assert_eq!(
            state.registration().registered.as_deref(),
            Some("Control+Alt+K")
        );
        assert_eq!(
            load_settings(&connection),
            on("Control+Alt+K"),
            "the refused chord was not saved"
        );
    }

    /// The save is two rows. A failure on the second must leave neither
    /// written, and the OS must hold the chord the saved settings name.
    #[test]
    fn a_failed_save_rolls_back_both_rows_and_restores_the_old_registration() {
        let database = Database::open_in_memory().unwrap();
        let connection = database.connection();
        let os = FakeOs::default();
        let state = WindowSnapshotState::default();
        configure_with(&os, &state, &connection, on("Control+Alt+K")).unwrap();

        // The enabled row is written first and succeeds; the chord row aborts.
        connection
            .execute_batch(
                "CREATE TRIGGER inject_chord_write_failure BEFORE UPDATE ON ui_state
                 WHEN NEW.key = 'window_snapshot.chord'
                 BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;",
            )
            .unwrap();
        let off_and_moved = Settings {
            enabled: false,
            chord: "Control+Alt+J".to_owned(),
        };
        let error = configure_with(&os, &state, &connection, off_and_moved).unwrap_err();

        assert!(
            error.to_string().contains("injected write failure"),
            "the save error is reported: {error}"
        );
        assert_eq!(
            load_settings(&connection),
            on("Control+Alt+K"),
            "neither row changed: the enabled flag was rolled back too"
        );
        assert_eq!(
            state.registration().registered.as_deref(),
            Some("Control+Alt+K"),
            "the previous chord is registered again"
        );
        assert_eq!(
            *os.held.borrow(),
            vec![key(&validate_chord("Control+Alt+K").unwrap())]
        );
    }

    #[test]
    fn a_saved_chord_that_fails_at_startup_is_recorded_not_fatal() {
        let mut os = FakeOs::default();
        os.fails_to_register
            .push(key(&validate_chord("Control+Alt+K").unwrap()));
        let state = WindowSnapshotState::default();

        let result = apply(&os, &state, &on("Control+Alt+K"));

        assert_eq!(result.registered, None);
        assert!(result.error.unwrap().contains("rejected by the OS"));
    }

    #[test]
    fn an_invalid_chord_is_rejected_before_anything_is_touched() {
        let database = Database::open_in_memory().unwrap();
        let connection = database.connection();
        let os = FakeOs::default();
        let state = WindowSnapshotState::default();

        let error = configure_with(&os, &state, &connection, on("Shift+S")).unwrap_err();

        assert!(matches!(error, ArgmaxError::InvalidInput { .. }));
        assert!(os.held.borrow().is_empty());
        assert_eq!(load_settings(&connection), Settings::default());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn where_capture_is_unsupported_enabling_reports_it_instead_of_registering() {
        let os = FakeOs::default();
        let state = WindowSnapshotState::default();
        let result = apply(&os, &state, &on("Control+Alt+K"));
        assert_eq!(result.registered, None);
        assert!(result.error.unwrap().contains("macOS"));
        assert!(os.held.borrow().is_empty());
    }

    #[derive(Default)]
    struct RecordingSink {
        calls: RefCell<Vec<String>>,
    }

    impl SnapshotSink for RecordingSink {
        fn raise_window(&self) -> String {
            self.calls.borrow_mut().push("raise".to_owned());
            "chat-2".to_owned()
        }
        fn attach(&self, window: &str, snapshot: &WindowSnapshotAttach) {
            self.calls
                .borrow_mut()
                .push(format!("attach {window} {}", snapshot.source.app_name));
        }
        fn failed(&self, window: &str, error: &SnapshotError) {
            self.calls
                .borrow_mut()
                .push(format!("failed {window} {}", error.code()));
        }
    }

    fn snapshot() -> WindowSnapshotAttach {
        WindowSnapshotAttach {
            attachment: SnapshotAttachment {
                file_path: "/tmp/x.png".to_owned(),
                mime_type: "image/png".to_owned(),
                size_bytes: 3,
            },
            source: SnapshotSource {
                app_name: "Safari".to_owned(),
                bundle_id: None,
                window_title: None,
                captured_at: "2026-10-04T00:00:00.000Z".to_owned(),
            },
        }
    }

    #[test]
    fn a_capture_raises_one_window_then_addresses_only_that_window() {
        let sink = RecordingSink::default();
        deliver(&sink, Ok(snapshot()));
        assert_eq!(*sink.calls.borrow(), vec!["raise", "attach chat-2 Safari"]);
    }

    #[test]
    fn a_failure_raises_the_window_and_reports_to_it_instead_of_attaching() {
        let sink = RecordingSink::default();
        deliver(&sink, Err(SnapshotError::PermissionDenied));
        assert_eq!(
            *sink.calls.borrow(),
            vec!["raise", "failed chat-2 screen-recording-denied"]
        );
    }
}
