// Outbound links the app offers the user. The native menu (src-tauri/src/menu.rs)
// repeats the issues link as a Rust literal because it is built before the
// renderer loads; a change here needs the same change there.
export const REPO_URL = "https://github.com/adamthuvesen/argmax";
export const ISSUES_URL = `${REPO_URL}/issues`;
