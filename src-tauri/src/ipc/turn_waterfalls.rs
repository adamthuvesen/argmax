//! The turn waterfall's channels: the renderer's paint report, which closes a
//! turn, and the read of recent turns. See `providers::turn_waterfall`.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::ipc::system::SystemOk;
use crate::providers::turn_waterfall;
use crate::state::{live_database, read_off_main, AppState};
use argmax_contracts::error::ArgmaxResult;
use argmax_contracts::validation::{NonEmptyString, SessionId};
use argmax_store::turn_waterfalls::{recent_turn_waterfalls, TurnWaterfall};

const DEFAULT_TURN_WATERFALLS: u32 = 50;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionTurnPaintedInput {
    pub session_id: SessionId,
    /// The `user.message` event id of the turn whose answer was painted.
    pub turn_key: NonEmptyString,
    /// `Date.now()` epoch milliseconds when the first answer was painted.
    pub painted_at_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionTurnWaterfallsInput {
    /// Newest turns to return; 50 when omitted, at most 500.
    #[serde(default)]
    pub limit: Option<u32>,
}

#[tauri::command(rename = "session:turn-painted")]
#[specta::specta]
pub async fn session_turn_painted(
    state: State<'_, AppState>,
    input: SessionTurnPaintedInput,
) -> ArgmaxResult<SystemOk> {
    let database = live_database(&state)?;
    turn_waterfall::painted(
        &database,
        input.session_id.as_str(),
        input.turn_key.as_str(),
        input.painted_at_ms,
    );
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "session:turn-waterfalls")]
#[specta::specta]
pub async fn session_turn_waterfalls(
    state: State<'_, AppState>,
    input: SessionTurnWaterfallsInput,
) -> ArgmaxResult<Vec<TurnWaterfall>> {
    session_turn_waterfalls_impl(&state, input).await
}

pub(crate) async fn session_turn_waterfalls_impl(
    state: &AppState,
    input: SessionTurnWaterfallsInput,
) -> ArgmaxResult<Vec<TurnWaterfall>> {
    let database = live_database(state)?;
    let limit = input
        .limit
        .unwrap_or(DEFAULT_TURN_WATERFALLS)
        .min(argmax_store::turn_waterfalls::RETAINED_TURN_WATERFALLS as u32);
    read_off_main(move || recent_turn_waterfalls(&database.read_connection(), limit)).await
}
