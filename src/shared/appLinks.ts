// Outbound links the app offers the user. The native menu (src-tauri/src/menu.rs)
// repeats these as Rust literals because it is built before the renderer loads;
// a change here needs the same change there.
export const REPO_URL = "https://github.com/adamthuvesen/argmax";
export const DOCS_URL = `${REPO_URL}/blob/main/README.md`;
export const ISSUES_URL = `${REPO_URL}/issues`;
export const RELEASES_URL = `${REPO_URL}/releases`;
