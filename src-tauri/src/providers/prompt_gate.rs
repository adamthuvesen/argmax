//! The pre-turn checkpoint runs while the provider starts. A launch may spawn
//! its CLI and finish the handshake with the gate shut, but the user's prompt,
//! the first thing that lets the model act, waits for [`PromptGate::wait`].
//! The checkpoint therefore always describes the worktree before the agent
//! could change it. See docs/providers.md#the-pre-turn-checkpoint-gate.

use std::sync::{Arc, Mutex};

use argmax_contracts::error::{ArgmaxError, ArgmaxResult};
use tokio::sync::watch;

use super::runtime::{EventCallback, ProviderRuntimeEvent};
use super::turn_waterfall::{self, Stamp};

type GateState = Option<ArgmaxResult<()>>;

/// The launch side of the gate. Clones share one outcome, so the fresh retry
/// of a refused resume waits on the same capture.
#[derive(Clone)]
pub struct PromptGate {
    state: watch::Receiver<GateState>,
}

/// The capture side: resolved once, when the checkpoint has finished.
pub struct PromptGateOpener {
    shared: PromptGateStop,
}

/// Refuses a gate that has not resolved yet. A Stop holds one, so it can end
/// the launch without waiting for a capture that is blocked on the checkout
/// lock. The first outcome wins: a refusal after the gate opened is ignored.
#[derive(Clone)]
pub struct PromptGateStop {
    state: Arc<watch::Sender<GateState>>,
    held: Arc<HeldEvents>,
}

impl PromptGate {
    /// A gate that is already open, for a launch with nothing to wait on.
    pub fn open() -> Self {
        let (_, state) = watch::channel(Some(Ok(())));
        Self { state }
    }

    /// A shut gate. The returned callback holds every provider event until
    /// the gate resolves: an open gate replays them in order, and a refused
    /// gate drops them, so a launch the capture aborted shows nothing.
    pub fn shut(on_event: EventCallback) -> (PromptGateOpener, Self, EventCallback) {
        let (sender, state) = watch::channel(None);
        let held = Arc::new(HeldEvents {
            real: on_event,
            state: Mutex::new(HoldState::Holding(Vec::new())),
        });
        let emit = Arc::clone(&held);
        let on_event: EventCallback = Arc::new(move |event| emit.emit(event));
        (
            PromptGateOpener {
                shared: PromptGateStop {
                    state: Arc::new(sender),
                    held,
                },
            },
            Self { state },
            on_event,
        )
    }

    pub fn is_resolved(&self) -> bool {
        self.state.borrow().is_some()
    }

    /// Ok once the checkpoint is captured. An error means the turn must not
    /// run: the launch kills what it started and returns the error.
    pub async fn wait(&self) -> ArgmaxResult<()> {
        let mut state = self.state.clone();
        let outcome = state.wait_for(Option::is_some).await;
        match outcome {
            Ok(resolved) => resolved.clone().unwrap_or(Ok(())),
            Err(_) => Err(gate_dropped()),
        }
    }

    /// [`Self::wait`] for a launch that is about to send the prompt. Stamps
    /// `prompt_gate_waited` when the launch was blocked on the capture.
    pub async fn wait_before_prompt(&self, session_id: &str) -> ArgmaxResult<()> {
        if self.is_resolved() {
            return self.wait().await;
        }
        let outcome = self.wait().await;
        turn_waterfall::stamp(session_id, Stamp::PromptGateWaited);
        outcome
    }
}

impl PromptGateOpener {
    pub fn stopper(&self) -> PromptGateStop {
        self.shared.clone()
    }

    pub fn resolve(self, outcome: ArgmaxResult<()>) {
        self.shared.settle(outcome);
    }
}

impl Drop for PromptGateOpener {
    // A capture task that ends without a result (a panic) refuses the turn;
    // a Stop may still hold the channel open, so closing it is not enough.
    fn drop(&mut self) {
        self.shared.refuse(gate_dropped());
    }
}

fn gate_dropped() -> ArgmaxError {
    ArgmaxError::service(
        "CHECKPOINT_GATE_DROPPED",
        "The pre-turn checkpoint ended without a result.",
    )
}

impl PromptGateStop {
    pub fn refuse(&self, error: ArgmaxError) {
        self.settle(Err(error));
    }

    fn settle(&self, outcome: ArgmaxResult<()>) {
        // Settled under the watch's write lock, so a refusal and the capture's
        // own result cannot both reach the held events.
        self.state.send_if_modified(|state| {
            if state.is_some() {
                return false;
            }
            self.held.settle(outcome.is_ok());
            *state = Some(outcome);
            true
        });
    }
}

struct HeldEvents {
    real: EventCallback,
    state: Mutex<HoldState>,
}

enum HoldState {
    Holding(Vec<ProviderRuntimeEvent>),
    Open,
    Dropped,
}

impl HeldEvents {
    fn emit(&self, event: ProviderRuntimeEvent) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        match &mut *state {
            HoldState::Holding(held) => held.push(event),
            HoldState::Open => {
                drop(state);
                (self.real)(event);
            }
            HoldState::Dropped => {}
        }
    }

    /// Replays under the lock, so an event emitted during the replay cannot
    /// overtake one that was held.
    fn settle(&self, open: bool) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let next = if open {
            HoldState::Open
        } else {
            HoldState::Dropped
        };
        if let HoldState::Holding(held) = std::mem::replace(&mut *state, next) {
            if open {
                for event in held {
                    (self.real)(event);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::normalizer::ProviderOutputStream;
    use crate::providers::runtime::ProviderRuntimeEventType;

    fn event(message: &str) -> ProviderRuntimeEvent {
        ProviderRuntimeEvent {
            session_id: "session-1".to_string(),
            r#type: ProviderRuntimeEventType::Output,
            stream: ProviderOutputStream::Stderr,
            message: message.to_string(),
            exit_code: None,
            created_at: String::new(),
        }
    }

    fn recorder() -> (EventCallback, Arc<Mutex<Vec<String>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let callback: EventCallback =
            Arc::new(move |event| sink.lock().unwrap().push(event.message));
        (callback, seen)
    }

    #[tokio::test]
    async fn an_open_gate_replays_held_events_in_order_before_later_ones() {
        let (real, seen) = recorder();
        let (opener, gate, on_event) = PromptGate::shut(real);
        on_event(event("early"));
        assert!(seen.lock().unwrap().is_empty());
        let waiter = tokio::spawn({
            let gate = gate.clone();
            async move { gate.wait().await }
        });
        opener.resolve(Ok(()));
        waiter.await.unwrap().unwrap();
        on_event(event("late"));
        assert_eq!(*seen.lock().unwrap(), ["early", "late"]);
    }

    #[tokio::test]
    async fn a_refused_gate_drops_every_event_and_returns_the_capture_error() {
        let (real, seen) = recorder();
        let (opener, gate, on_event) = PromptGate::shut(real);
        on_event(event("before"));
        opener.resolve(Err(ArgmaxError::service("CAPTURE", "no database")));
        on_event(event("after"));
        let error = gate.wait().await.expect_err("refused");
        assert!(error.to_string().contains("no database"), "{error}");
        assert!(seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_first_outcome_wins_between_a_stop_and_the_capture() {
        let (real, seen) = recorder();
        let (opener, gate, on_event) = PromptGate::shut(real);
        let stop = opener.stopper();
        on_event(event("held"));
        stop.refuse(ArgmaxError::service("STOPPED", "stopped"));
        opener.resolve(Ok(()));
        on_event(event("after"));
        let error = gate.wait().await.expect_err("the stop came first");
        assert!(error.to_string().contains("stopped"), "{error}");
        assert!(seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_dropped_opener_refuses_the_turn_even_while_a_stop_is_held() {
        let (real, _) = recorder();
        let (opener, gate, _) = PromptGate::shut(real);
        let _stop = opener.stopper();
        drop(opener);
        assert!(gate.wait().await.is_err());
    }
}
