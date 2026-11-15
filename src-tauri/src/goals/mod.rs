//! A Goal is one free-text completion condition attached to a chat.
//!
//! After every turn a small, cheap model reads the transcript tail and returns
//! one of three verdicts: the condition holds, it does not hold yet, or it
//! cannot be met. "Not yet" feeds its reason back as guidance and the chat
//! takes another turn on its own. The evaluator runs without tools, so it
//! judges only what the agent actually surfaced in the conversation — it
//! cannot go looking for evidence the agent never showed.

pub mod service;

use serde::{Deserialize, Serialize};

/// Turn ceiling when the caller does not pick one. A goal that has not landed
/// in twenty turns is not one more turn away from landing.
pub const DEFAULT_MAX_TURNS: u32 = 20;

/// What the evaluator decided about one turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalVerdict {
    Met,
    NotYet,
    Impossible,
}
