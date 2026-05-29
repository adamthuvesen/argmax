use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

const APP_NAME: &str = "Argmax";
const MENU_COMMAND_EVENT: &str = "menu:command";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum MenuCommand {
    NewSession,
    OpenSettings,
    ToggleSidebar,
    ToggleDebugLog,
    OpenCommandPalette,
    OpenCheatSheet,
    CheckForUpdates,
}

impl MenuCommand {
    pub const ALL: [Self; 7] = [
        Self::NewSession,
        Self::OpenSettings,
        Self::ToggleSidebar,
        Self::ToggleDebugLog,
        Self::OpenCommandPalette,
        Self::OpenCheatSheet,
        Self::CheckForUpdates,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::NewSession => "new-session",
            Self::OpenSettings => "open-settings",
            Self::ToggleSidebar => "toggle-sidebar",
            Self::ToggleDebugLog => "toggle-debug-log",
            Self::OpenCommandPalette => "open-command-palette",
            Self::OpenCheatSheet => "open-cheat-sheet",
            Self::CheckForUpdates => "check-for-updates",
        }
    }

    fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|command| command.as_str() == id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuSpec {
    pub label: &'static str,
    pub items: Vec<MenuEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuEntry {
    Command(CommandItem),
    Native(NativeItem),
    Separator,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandItem {
    pub command: MenuCommand,
    pub label: &'static str,
    pub accelerator: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeItem {
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    CloseWindow,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    PasteAndMatchStyle,
    SelectAll,
    Minimize,
    Maximize,
    BringAllToFront,
    Fullscreen,
    DevReload,
    DevForceReload,
    DevToggleDevtools,
    ResetZoom,
    ZoomIn,
    ZoomOut,
    Delete,
}

pub fn app_menu_spec(is_dev: bool) -> Vec<MenuSpec> {
    let mut view_items = vec![
        command(
            MenuCommand::OpenCommandPalette,
            "Command Palette…",
            Some("CmdOrCtrl+K"),
        ),
        command(
            MenuCommand::ToggleSidebar,
            "Toggle Sidebar",
            Some("CmdOrCtrl+B"),
        ),
        command(
            MenuCommand::ToggleDebugLog,
            "Toggle Debug Log",
            Some("CmdOrCtrl+Shift+D"),
        ),
        MenuEntry::Separator,
    ];

    if is_dev {
        view_items.extend([
            native(NativeItem::DevReload),
            native(NativeItem::DevForceReload),
            native(NativeItem::DevToggleDevtools),
            MenuEntry::Separator,
        ]);
    }

    view_items.extend([
        native(NativeItem::ResetZoom),
        native(NativeItem::ZoomIn),
        native(NativeItem::ZoomOut),
        MenuEntry::Separator,
        native(NativeItem::Fullscreen),
    ]);

    vec![
        MenuSpec {
            label: APP_NAME,
            items: vec![
                native(NativeItem::About),
                MenuEntry::Separator,
                command(MenuCommand::OpenSettings, "Settings…", Some("CmdOrCtrl+,")),
                command(MenuCommand::CheckForUpdates, "Check for Updates…", None),
                MenuEntry::Separator,
                native(NativeItem::Services),
                MenuEntry::Separator,
                native(NativeItem::Hide),
                native(NativeItem::HideOthers),
                native(NativeItem::ShowAll),
                MenuEntry::Separator,
                native(NativeItem::Quit),
            ],
        },
        MenuSpec {
            label: "File",
            items: vec![
                command(MenuCommand::NewSession, "New Session", Some("CmdOrCtrl+N")),
                MenuEntry::Separator,
                native(NativeItem::CloseWindow),
            ],
        },
        MenuSpec {
            label: "Edit",
            items: vec![
                native(NativeItem::Undo),
                native(NativeItem::Redo),
                MenuEntry::Separator,
                native(NativeItem::Cut),
                native(NativeItem::Copy),
                native(NativeItem::Paste),
                native(NativeItem::PasteAndMatchStyle),
                native(NativeItem::SelectAll),
                MenuEntry::Separator,
                native(NativeItem::Delete),
            ],
        },
        MenuSpec {
            label: "View",
            items: view_items,
        },
        MenuSpec {
            label: "Window",
            items: vec![
                native(NativeItem::Minimize),
                native(NativeItem::Maximize),
                native(NativeItem::BringAllToFront),
            ],
        },
        MenuSpec {
            label: "Help",
            items: vec![command(
                MenuCommand::OpenCheatSheet,
                "Keyboard Shortcuts",
                Some("CmdOrCtrl+/"),
            )],
        },
    ]
}

pub fn install_app_menu<R: Runtime>(app: &AppHandle<R>, is_dev: bool) -> tauri::Result<()> {
    let submenus = app_menu_spec(is_dev)
        .iter()
        .map(|submenu_spec| build_submenu(app, submenu_spec))
        .collect::<tauri::Result<Vec<_>>>()?;
    let items = submenus
        .iter()
        .map(|submenu| submenu as &dyn IsMenuItem<R>)
        .collect::<Vec<_>>();
    let menu = Menu::with_items(app, &items)?;
    app.set_menu(menu)?;
    Ok(())
}

pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if id == MenuCommand::CheckForUpdates.as_str() {
        crate::updater::run_menu_update_check(app.clone());
        return;
    }

    if let Some(command) = MenuCommand::from_id(id) {
        if let Some(window) = app.get_webview_window("main") {
            if let Err(error) = window.emit(MENU_COMMAND_EVENT, command.as_str()) {
                tracing::warn!(
                    command = command.as_str(),
                    ?error,
                    "failed to emit menu command"
                );
            }
        }
        return;
    }

    match id {
        "argmax:dev-reload" | "argmax:dev-force-reload" => {
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window.reload() {
                    tracing::warn!(?error, "failed to reload webview from menu");
                }
            }
        }
        "argmax:dev-toggle-devtools" => {
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                if window.is_devtools_open() {
                    window.close_devtools();
                } else {
                    window.open_devtools();
                }
            }
        }
        "argmax:reset-zoom" => eval_main_window(app, "document.body.style.zoom = '1'"),
        "argmax:zoom-in" => eval_main_window(app, "document.body.style.zoom = String((Number.parseFloat(document.body.style.zoom || '1') || 1) + 0.1)"),
        "argmax:zoom-out" => eval_main_window(app, "document.body.style.zoom = String(Math.max(0.2, (Number.parseFloat(document.body.style.zoom || '1') || 1) - 0.1))"),
        _ => {}
    }
}

fn command(
    command: MenuCommand,
    label: &'static str,
    accelerator: Option<&'static str>,
) -> MenuEntry {
    MenuEntry::Command(CommandItem {
        command,
        label,
        accelerator,
    })
}

fn native(item: NativeItem) -> MenuEntry {
    MenuEntry::Native(item)
}

fn build_submenu<R: Runtime>(app: &AppHandle<R>, spec: &MenuSpec) -> tauri::Result<Submenu<R>> {
    let submenu = Submenu::new(app, spec.label, true)?;
    for item in &spec.items {
        append_item(app, &submenu, item)?;
    }
    Ok(submenu)
}

fn append_item<R: Runtime>(
    app: &AppHandle<R>,
    submenu: &Submenu<R>,
    item: &MenuEntry,
) -> tauri::Result<()> {
    match item {
        MenuEntry::Command(item) => {
            let menu_item = MenuItem::with_id(
                app,
                item.command.as_str(),
                item.label,
                true,
                item.accelerator,
            )?;
            submenu.append(&menu_item)?;
        }
        MenuEntry::Native(item) => match item {
            NativeItem::About => {
                let item = PredefinedMenuItem::about(app, Some("About Argmax"), None)?;
                submenu.append(&item)?;
            }
            NativeItem::Services => {
                let item = PredefinedMenuItem::services(app, None)?;
                submenu.append(&item)?;
            }
            NativeItem::Hide => {
                let item = PredefinedMenuItem::hide(app, Some("Hide Argmax"))?;
                submenu.append(&item)?;
            }
            NativeItem::HideOthers => {
                let item = PredefinedMenuItem::hide_others(app, None)?;
                submenu.append(&item)?;
            }
            NativeItem::ShowAll => {
                let item = PredefinedMenuItem::show_all(app, None)?;
                submenu.append(&item)?;
            }
            NativeItem::Quit => {
                let item = PredefinedMenuItem::quit(app, Some("Quit Argmax"))?;
                submenu.append(&item)?;
            }
            NativeItem::CloseWindow => {
                let item = PredefinedMenuItem::close_window(app, None)?;
                submenu.append(&item)?;
            }
            NativeItem::Undo => {
                let item = PredefinedMenuItem::undo(app, None)?;
                submenu.append(&item)?;
            }
            NativeItem::Redo => {
                let item = PredefinedMenuItem::redo(app, None)?;
                submenu.append(&item)?;
            }
            NativeItem::Cut => {
                let item = PredefinedMenuItem::cut(app, None)?;
                submenu.append(&item)?;
            }
            NativeItem::Copy => {
                let item = PredefinedMenuItem::copy(app, None)?;
                submenu.append(&item)?;
            }
            NativeItem::Paste => {
                let item = PredefinedMenuItem::paste(app, None)?;
                submenu.append(&item)?;
            }
            NativeItem::PasteAndMatchStyle => {
                let item = MenuItem::new(
                    app,
                    "Paste and Match Style",
                    true,
                    Some("CmdOrCtrl+Shift+V"),
                )?;
                submenu.append(&item)?;
            }
            NativeItem::SelectAll => {
                let item = PredefinedMenuItem::select_all(app, None)?;
                submenu.append(&item)?;
            }
            NativeItem::Minimize => {
                let item = PredefinedMenuItem::minimize(app, None)?;
                submenu.append(&item)?;
            }
            NativeItem::Maximize => {
                let item = PredefinedMenuItem::maximize(app, None)?;
                submenu.append(&item)?;
            }
            NativeItem::BringAllToFront => {
                let item = PredefinedMenuItem::bring_all_to_front(app, None)?;
                submenu.append(&item)?;
            }
            NativeItem::Fullscreen => {
                let item = PredefinedMenuItem::fullscreen(app, None)?;
                submenu.append(&item)?;
            }
            NativeItem::DevReload => {
                let item = MenuItem::with_id(
                    app,
                    "argmax:dev-reload",
                    "Reload",
                    true,
                    Some("CmdOrCtrl+R"),
                )?;
                submenu.append(&item)?;
            }
            NativeItem::DevForceReload => {
                let item = MenuItem::with_id(
                    app,
                    "argmax:dev-force-reload",
                    "Force Reload",
                    true,
                    Some("CmdOrCtrl+Shift+R"),
                )?;
                submenu.append(&item)?;
            }
            NativeItem::DevToggleDevtools => {
                let item = MenuItem::with_id(
                    app,
                    "argmax:dev-toggle-devtools",
                    "Toggle Developer Tools",
                    true,
                    Some("Alt+CmdOrCtrl+I"),
                )?;
                submenu.append(&item)?;
            }
            NativeItem::ResetZoom => {
                let item = MenuItem::with_id(
                    app,
                    "argmax:reset-zoom",
                    "Actual Size",
                    true,
                    Some("CmdOrCtrl+0"),
                )?;
                submenu.append(&item)?;
            }
            NativeItem::ZoomIn => {
                let item =
                    MenuItem::with_id(app, "argmax:zoom-in", "Zoom In", true, Some("CmdOrCtrl+="))?;
                submenu.append(&item)?;
            }
            NativeItem::ZoomOut => {
                let item = MenuItem::with_id(
                    app,
                    "argmax:zoom-out",
                    "Zoom Out",
                    true,
                    Some("CmdOrCtrl+-"),
                )?;
                submenu.append(&item)?;
            }
            NativeItem::Delete => {
                let item = MenuItem::new(app, "Delete", true, None::<&str>)?;
                submenu.append(&item)?;
            }
        },
        MenuEntry::Separator => {
            let item = PredefinedMenuItem::separator(app)?;
            submenu.append(&item)?;
        }
    }
    Ok(())
}

fn eval_main_window<R: Runtime>(app: &AppHandle<R>, js: &str) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.eval(js) {
            tracing::warn!(?error, "failed to evaluate menu action");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn menu_spec_matches_legacy_top_level_order() {
        let labels: Vec<_> = app_menu_spec(false)
            .into_iter()
            .map(|menu| menu.label)
            .collect();

        assert_eq!(labels, ["Argmax", "File", "Edit", "View", "Window", "Help"]);
    }

    #[test]
    fn command_items_match_legacy_labels_and_accelerators() {
        let commands = command_items(app_menu_spec(false));

        assert_eq!(
            commands,
            vec![
                (MenuCommand::OpenSettings, "Settings…", Some("CmdOrCtrl+,")),
                (MenuCommand::CheckForUpdates, "Check for Updates…", None),
                (MenuCommand::NewSession, "New Session", Some("CmdOrCtrl+N")),
                (
                    MenuCommand::OpenCommandPalette,
                    "Command Palette…",
                    Some("CmdOrCtrl+K"),
                ),
                (
                    MenuCommand::ToggleSidebar,
                    "Toggle Sidebar",
                    Some("CmdOrCtrl+B"),
                ),
                (
                    MenuCommand::ToggleDebugLog,
                    "Toggle Debug Log",
                    Some("CmdOrCtrl+Shift+D"),
                ),
                (
                    MenuCommand::OpenCheatSheet,
                    "Keyboard Shortcuts",
                    Some("CmdOrCtrl+/"),
                ),
            ]
        );
    }

    #[test]
    fn every_menu_command_is_reachable_from_the_spec() {
        let actual: BTreeSet<_> = command_items(app_menu_spec(false))
            .into_iter()
            .map(|(command, _, _)| command)
            .collect();
        let expected: BTreeSet<_> = MenuCommand::ALL.into_iter().collect();

        assert_eq!(actual, expected);
    }

    #[test]
    fn dev_only_items_are_only_in_dev_spec() {
        assert!(!native_items(app_menu_spec(false)).contains(&NativeItem::DevToggleDevtools));
        assert!(native_items(app_menu_spec(true)).contains(&NativeItem::DevToggleDevtools));
    }

    #[test]
    fn menu_command_ids_preserve_renderer_contract() {
        assert_eq!(MenuCommand::NewSession.as_str(), "new-session");
        assert_eq!(MenuCommand::OpenSettings.as_str(), "open-settings");
        assert_eq!(MenuCommand::ToggleSidebar.as_str(), "toggle-sidebar");
        assert_eq!(MenuCommand::ToggleDebugLog.as_str(), "toggle-debug-log");
        assert_eq!(
            MenuCommand::OpenCommandPalette.as_str(),
            "open-command-palette"
        );
        assert_eq!(MenuCommand::OpenCheatSheet.as_str(), "open-cheat-sheet");
        assert_eq!(MenuCommand::CheckForUpdates.as_str(), "check-for-updates");
    }

    fn command_items(
        spec: Vec<MenuSpec>,
    ) -> Vec<(MenuCommand, &'static str, Option<&'static str>)> {
        spec.into_iter()
            .flat_map(|menu| menu.items)
            .filter_map(|item| match item {
                MenuEntry::Command(item) => Some((item.command, item.label, item.accelerator)),
                _ => None,
            })
            .collect()
    }

    fn native_items(spec: Vec<MenuSpec>) -> Vec<NativeItem> {
        spec.into_iter()
            .flat_map(|menu| menu.items)
            .filter_map(|item| match item {
                MenuEntry::Native(item) => Some(item),
                _ => None,
            })
            .collect()
    }
}
