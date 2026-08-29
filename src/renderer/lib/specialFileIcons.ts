import { Claude, Rust } from "@react-symbols/icons/files";

// FileIcon lowercases names before consulting caller-provided overrides.
// Shared by the workspace tree and the file-tab strip so both show the same glyphs.
export const SPECIAL_FILE_ICONS = {
  "claude.md": Claude,
  "cargo.toml": Rust
};
