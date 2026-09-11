//! The Goal driver: one background task per active goal.
//!
//! The loop is deliberately small. Wait for the chat's turn to settle, hand
//! the tail of the conversation plus the condition to a fresh evaluator, and
//! act on its one-word verdict: met and the goal is achieved, impossible and
//! it stops, not yet and its reason becomes the next turn's guidance. The
//! ceiling on turns is the only other way out, and it is enforced here rather
//! than trusted to the model.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::{sync::broadcast, task::JoinHandle};
use uuid::Uuid;

use crate::{
    error::{ArgmaxError, ArgmaxResult},
    ipc::{
        inputs::ProvidersSendInput,
        validation::{Prompt, SessionId},
    },
    persistence::{
        database::Database,
        events::goal_transcript_tail,
        goals::{
            find_active_goal_for_session, find_goal, insert_goal, list_goals, settle_goal,
            stop_orphaned_goals, update_goal_progress,
        },
        sessions::find_session_by_id,
        time::now_iso,
        workspaces::find_workspace_by_id,
    },
    providers::{
        one_shot,
        runtime::parse_provider,
        session_service::{self, GoalTurnIdentity, ProviderSessionService, SessionStateChange},
        AgentMode,
    },
    sessions::state::SessionState,
    util::sync::LockOrRecover,
};

use super::{Goal, GoalState, GoalVerdict, DEFAULT_MAX_TURNS};

const MAX_CONDITION_BYTES: usize = 8 * 1024;
/// Hard ceiling on the caller's ceiling. Twenty is the default; a hundred turns
/// of an agent talking to an evaluator is already past any useful goal.
const MAX_TURNS_CEILING: u32 = 100;
/// How much conversation the evaluator reads. Enough to cover a long turn's
/// tool work and its answer, small enough to stay a cheap call.
const TRANSCRIPT_TAIL_CHARS: usize = 12_000;
/// Settled turns with no tool call at all before the goal hands back. An agent
/// that answers three times running without touching anything has stopped
/// working, and more turns will not change that.
const MAX_IDLE_TURNS: u32 = 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalSetInput {
    pub workspace_id: String,
    pub session_id: String,
    pub condition: String,
    pub max_turns: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalSessionInput {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalListInput {
    pub workspace_id: Option<String>,
}

pub struct GoalService {
    database: Arc<Database>,
    providers: Arc<ProviderSessionService>,
    tasks: Mutex<HashMap<String, GoalDriverTask>>,
}

pub(crate) struct GoalConfig {
    condition: String,
    max_turns: u32,
}

struct GoalDriverTask {
    generation: Uuid,
    handle: JoinHandle<()>,
}

/// Only the driver that still owns the slot may clear it. A goal cleared and
/// set again in the same breath leaves the old task racing the new one, and
/// without the generation the loser would evict the winner.
fn remove_current_driver(
    tasks: &mut HashMap<String, GoalDriverTask>,
    goal_id: &str,
    generation: Uuid,
) -> bool {
    let is_current = tasks
        .get(goal_id)
        .is_some_and(|task| task.generation == generation);
    if is_current {
        tasks.remove(goal_id);
    }
    is_current
}

impl GoalService {
    pub fn new(
        database: Arc<Database>,
        providers: Arc<ProviderSessionService>,
    ) -> ArgmaxResult<Arc<Self>> {
        stop_orphaned_goals(&database.connection())?;
        let service = Arc::new(Self {
            database,
            providers: Arc::clone(&providers),
            tasks: Mutex::new(HashMap::new()),
        });
        providers.set_goal_service(Arc::downgrade(&service));
        Ok(service)
    }

    pub(crate) fn validate_config(
        condition: &str,
        max_turns: Option<u32>,
    ) -> ArgmaxResult<GoalConfig> {
        let condition = condition.trim().to_string();
        if condition.is_empty() || condition.len() > MAX_CONDITION_BYTES {
            return Err(ArgmaxError::service(
                "GOAL_INVALID_CONDITION",
                "A goal needs a completion condition of at most 8 KiB.",
            ));
        }
        let max_turns = max_turns.unwrap_or(DEFAULT_MAX_TURNS);
        if max_turns == 0 || max_turns > MAX_TURNS_CEILING {
            return Err(ArgmaxError::service(
                "GOAL_INVALID_MAX_TURNS",
                format!("maxTurns must be between 1 and {MAX_TURNS_CEILING}."),
            ));
        }
        Ok(GoalConfig {
            condition,
            max_turns,
        })
    }

    pub(crate) fn insert_initial_goal(
        &self,
        connection: &rusqlite::Connection,
        workspace_id: &str,
        session_id: &str,
        config: &GoalConfig,
    ) -> ArgmaxResult<Goal> {
        let timestamp = now_iso();
        insert_goal(
            connection,
            &Goal {
                id: Uuid::new_v4().to_string(),
                workspace_id: workspace_id.to_string(),
                session_id: session_id.to_string(),
                condition: config.condition.clone(),
                state: GoalState::Active,
                turns: 0,
                max_turns: config.max_turns,
                last_reason: None,
                created_at: timestamp.clone(),
                updated_at: timestamp,
            },
        )
    }

    pub(crate) fn start_initial_goal(self: &Arc<Self>, goal: &Goal) {
        self.providers.publish_goal_changed(&goal.id);
        self.spawn_driver(goal.id.clone());
    }

    /// Attaches a condition to a chat and starts working toward it right away.
    /// Any goal already on that chat is stopped first — a chat pursues one
    /// condition at a time, which the partial unique index also enforces.
    pub async fn set(self: &Arc<Self>, input: GoalSetInput) -> ArgmaxResult<Goal> {
        let config = Self::validate_config(&input.condition, input.max_turns)?;
        let session = {
            let connection = self.database.read_connection();
            find_workspace_by_id(&connection, &input.workspace_id)?;
            find_session_by_id(&connection, &input.session_id)?
        };
        if session.workspace_id != input.workspace_id {
            return Err(ArgmaxError::service(
                "GOAL_SESSION_WORKSPACE_MISMATCH",
                "The goal's chat does not belong to the selected workspace.",
            ));
        }
        self.clear(&session.id).await?;

        let timestamp = now_iso();
        let goal = insert_goal(
            &self.database.connection(),
            &Goal {
                id: Uuid::new_v4().to_string(),
                workspace_id: session.workspace_id.clone(),
                session_id: session.id.clone(),
                condition: config.condition,
                state: GoalState::Active,
                turns: 0,
                max_turns: config.max_turns,
                last_reason: None,
                created_at: timestamp.clone(),
                updated_at: timestamp,
            },
        )?;
        self.providers.publish_goal_changed(&goal.id);

        // A goal set from inside a running turn — the agent calling `goal_set`
        // on itself — gets no opening prompt. The turn in flight is already the
        // goal's first turn, and the prompt would only queue behind it as a
        // follow-up telling the agent to start work it is doing. The driver
        // picks that turn up when it settles, the same way `providers:launch`
        // attaches a goal to its own opening prompt.
        let turn_in_flight = !find_session_by_id(&self.database.read_connection(), &session.id)?
            .state
            .is_settled();
        if !turn_in_flight {
            // Started before the driver so a provider that refuses the turn
            // fails the caller's `set`, rather than leaving a goal that looks
            // active and never moves.
            if let Err(error) = self.send_turn(&goal, opening_prompt(&goal.condition)).await {
                self.settle(&goal.id, GoalState::Stopped, Some(&error.to_string()))?;
                return Err(error);
            }
        }
        self.spawn_driver(goal.id.clone());
        Ok(goal)
    }

    pub fn get_for_session(&self, session_id: &str) -> ArgmaxResult<Option<Goal>> {
        find_active_goal_for_session(&self.database.read_connection(), session_id)
    }

    pub fn list(&self, workspace_id: Option<&str>) -> ArgmaxResult<Vec<Goal>> {
        list_goals(&self.database.read_connection(), workspace_id)
    }

    /// Stops the chat's goal and returns it, or `None` when it had none. The
    /// turn in flight is left alone: the user asked to stop chasing the
    /// condition, not to interrupt the work already underway.
    pub async fn clear(&self, session_id: &str) -> ArgmaxResult<Option<Goal>> {
        let Some(goal) = self.get_for_session(session_id)? else {
            return Ok(None);
        };
        let settled = self.settle(&goal.id, GoalState::Stopped, Some("Goal cleared."))?;
        if let Some(task) = self.tasks.lock_or_recover("goal tasks").remove(&goal.id) {
            task.handle.abort();
        }
        Ok(settled)
    }

    fn settle(
        &self,
        goal_id: &str,
        state: GoalState,
        reason: Option<&str>,
    ) -> ArgmaxResult<Option<Goal>> {
        let settled = settle_goal(&self.database.connection(), goal_id, state, reason)?;
        if settled.is_some() {
            self.providers.publish_goal_changed(goal_id);
        }
        Ok(settled)
    }

    fn active_goal(&self, goal_id: &str) -> ArgmaxResult<Option<Goal>> {
        let goal = find_goal(&self.database.read_connection(), goal_id)?;
        Ok((goal.state == GoalState::Active).then_some(goal))
    }

    fn spawn_driver(self: &Arc<Self>, goal_id: String) {
        let mut tasks = self.tasks.lock_or_recover("goal tasks");
        if tasks.contains_key(&goal_id) {
            return;
        }
        let service = Arc::clone(self);
        let task_goal_id = goal_id.clone();
        let generation = Uuid::new_v4();
        let task = tokio::spawn(async move {
            let result = service.run_driver(&task_goal_id).await;
            let owns_current_task = {
                let mut tasks = service.tasks.lock_or_recover("goal tasks");
                remove_current_driver(&mut tasks, &task_goal_id, generation)
            };
            if owns_current_task {
                if let Err(error) = result {
                    tracing::warn!(?error, goal_id = %task_goal_id, "goal driver stopped");
                    let _ =
                        service.settle(&task_goal_id, GoalState::Stopped, Some(&error.to_string()));
                }
            }
        });
        tasks.insert(
            goal_id,
            GoalDriverTask {
                generation,
                handle: task,
            },
        );
    }

    async fn run_driver(self: &Arc<Self>, goal_id: &str) -> ArgmaxResult<()> {
        let mut states = self.providers.subscribe_session_states();
        let mut idle_turns = 0u32;
        loop {
            let Some(goal) = self.active_goal(goal_id)? else {
                return Ok(());
            };
            self.wait_for_session(&goal.session_id, &mut states).await?;
            // Re-read: the user may have cleared the goal while the turn ran.
            let Some(goal) = self.active_goal(goal_id)? else {
                return Ok(());
            };

            let (tail, tool_calls) = {
                let connection = self.database.read_connection();
                let tail =
                    goal_transcript_tail(&connection, &goal.session_id, TRANSCRIPT_TAIL_CHARS)?;
                (tail.text, tail.tool_calls_in_last_turn)
            };
            let judgement = self.judge(&goal, &tail).await;
            // A failed call is reported as "not yet" so the goal survives it,
            // but it says nothing about whether the agent is still working, so
            // it must not push the no-progress counter either way.
            let evaluator_answered = judgement.is_some();
            let (verdict, reason) = match judgement {
                Some((verdict, reason)) => (verdict, (!reason.is_empty()).then_some(reason)),
                // A CLI hiccup is not a verdict. Keep going, and do not let it
                // count against the no-progress ceiling either.
                None => (GoalVerdict::NotYet, None),
            };

            let turns = goal.turns + 1;
            let updated = update_goal_progress(
                &self.database.connection(),
                &goal.id,
                turns,
                reason.as_deref(),
            )?;
            if updated.is_none() {
                return Ok(());
            }
            self.providers.publish_goal_changed(&goal.id);

            match verdict {
                GoalVerdict::Met => {
                    self.settle(&goal.id, GoalState::Achieved, reason.as_deref())?;
                    return Ok(());
                }
                GoalVerdict::Impossible => {
                    self.settle(&goal.id, GoalState::Impossible, reason.as_deref())?;
                    return Ok(());
                }
                GoalVerdict::NotYet => {}
            }

            if evaluator_answered {
                idle_turns = if tool_calls == 0 { idle_turns + 1 } else { 0 };
            }
            if idle_turns >= MAX_IDLE_TURNS {
                self.settle(
                    &goal.id,
                    GoalState::Stopped,
                    Some("Stopped: the agent went several turns without doing any work."),
                )?;
                return Ok(());
            }
            if turns >= goal.max_turns {
                self.settle(
                    &goal.id,
                    GoalState::Stopped,
                    Some(&format!(
                        "Stopped after {turns} turns without meeting the goal."
                    )),
                )?;
                return Ok(());
            }
            // A turn can start between the settle we judged and this send: the
            // user types, or a queued follow-up drains. The send is refused
            // rather than queued, and the right answer is to judge that turn
            // too when it settles — queueing would leave the goal's guidance in
            // the composer looking hand-typed, with another copy behind it
            // every time round.
            match self
                .send_turn(&goal, follow_up_prompt(&goal.condition, reason.as_deref()))
                .await
            {
                Ok(()) => {}
                Err(ArgmaxError::ServiceError { ref sub_code, .. })
                    if sub_code == session_service::TURN_IN_FLIGHT => {}
                Err(error) => return Err(error),
            }
        }
    }

    async fn judge(&self, goal: &Goal, transcript_tail: &str) -> Option<(GoalVerdict, String)> {
        let session =
            find_session_by_id(&self.database.read_connection(), &goal.session_id).ok()?;
        let provider = parse_provider(&session.provider).ok()?;
        one_shot::evaluate_goal(
            provider,
            one_shot::helper_model(provider),
            &goal.condition,
            transcript_tail,
        )
        .await
    }

    /// Sends the chat its next goal turn. `send_goal_input` carries the goal's
    /// identity so the send is refused if the goal settled in the meantime.
    async fn send_turn(&self, goal: &Goal, prompt: String) -> ArgmaxResult<()> {
        self.providers
            .send_goal_input(
                ProvidersSendInput {
                    session_id: SessionId::try_from(goal.session_id.clone())
                        .map_err(ArgmaxError::invalid)?,
                    input: Prompt::try_from(prompt).map_err(ArgmaxError::invalid)?,
                    provider: None,
                    model_label: None,
                    model_id: None,
                    reasoning_effort: None,
                    fast_mode: false,
                    agent_mode: Some(AgentMode::Auto),
                    attachments: None,
                    agent_references: None,
                },
                GoalTurnIdentity {
                    goal_id: goal.id.clone(),
                },
            )
            .await?;
        Ok(())
    }

    /// Blocks until the chat's turn settles. There is no timeout: a goal's
    /// ceiling is counted in turns, and cutting a long-running turn short
    /// would judge work that had not finished.
    async fn wait_for_session(
        &self,
        session_id: &str,
        states: &mut broadcast::Receiver<SessionStateChange>,
    ) -> ArgmaxResult<SessionState> {
        loop {
            let state = find_session_by_id(&self.database.read_connection(), session_id)?.state;
            if state.is_settled() {
                return Ok(state);
            }
            match states.recv().await {
                Ok(change) if change.session_id == session_id && change.state.is_settled() => {
                    return Ok(change.state)
                }
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => {
                    return Err(ArgmaxError::service(
                        "GOAL_SESSION_EVENTS_CLOSED",
                        "Session state updates stopped while the goal was running.",
                    ))
                }
            }
        }
    }
}

fn opening_prompt(condition: &str) -> String {
    format!(
        "Work toward this goal, and keep working until it holds:\n\n{condition}\n\nRun whatever \
         checks prove it. When you believe it holds, state that and show the evidence."
    )
}

fn follow_up_prompt(condition: &str, reason: Option<&str>) -> String {
    let reason = reason.unwrap_or("the evidence so far does not show it holds");
    format!("The goal is not met yet: {reason}\n\nKeep working toward it:\n\n{condition}")
}
