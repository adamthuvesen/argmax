//! How Argmax prepares a child process. The store and the app both run git
//! through [`git_exec`], so it sits below them.

pub mod environment;
pub mod git_exec;
pub mod login_shell;
