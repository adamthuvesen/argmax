//! The bottom layer: errors, validated ids, enums, and the wire types that the
//! store and the app both name. It holds no SQL, no process, and no Tauri.

pub mod branch_names;
pub mod error;
pub mod goals;
pub mod messages;
pub mod routing;
pub mod sessions;
pub mod usage;
pub mod validation;
pub mod visualizations;
