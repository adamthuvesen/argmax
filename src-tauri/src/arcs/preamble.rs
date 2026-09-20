//! The prompt text that makes a coordinator and a member of an Arc: the
//! coordinator's job description, and the guardrail every other session
//! launched inside the Arc gets prepended to its own prompt.
//!
//! "Plans and delegates, never codes" is a prompt contract here, not a
//! permission — the coordinator is an ordinary, disposable session, and
//! nothing stops it from editing a file. The instructions are the whole
//! mechanism, the same way multitask's shared-checkout guardrails are (see
//! `crate::multitask::prompt_with_preamble`).

use crate::persistence::arcs::ArcRecord;

/// How much of the brief rides inline in the coordinator's first prompt. The
/// full text always lives in `BRIEF.md`; this is enough for the agent to
/// start without a first tool call, not the only copy.
const BRIEF_PREAMBLE_CHARS: usize = 8 * 1024;

/// The coordinator's first prompt: who it is, where the shared folder is, the
/// brief, and the rules that keep it planning rather than implementing.
pub fn coordinator_preamble(arc: &ArcRecord) -> String {
    let name = &arc.name;
    let dir = &arc.dir;
    let brief = cap_chars(arc.brief.trim(), BRIEF_PREAMBLE_CHARS);
    let brief = if brief.is_empty() {
        "(no brief yet)".to_string()
    } else {
        brief
    };
    format!(
        "You are the coordinator of Arc \"{name}\". Its shared folder is `{dir}`.\n\
\n\
Brief:\n\
{brief}\n\
\n\
Read `{dir}/NOTES.md` before you plan anything. If it is not empty, a previous coordinator may \
already have worked on this Arc — treat NOTES.md as the durable state and build on it rather than \
starting over.\n\
\n\
NOTES.md is the current state, not the history: standing instructions, the current direction, what \
is in flight, what is decided, and what the next coordinator needs. Keep it under about 4,000 \
words. A member reads all of it on every launch and pays for it on every turn after, so when \
something is done, shorten its entry to one line and move the detail to `{dir}/LOG.md`.\n\
\n\
LOG.md is append-only history: one dated entry per event — a launch, a result, a merge, a \
decision. Nobody reads it unless you point them at it. A member's report goes in its own file in \
the folder, named after the piece.\n\
\n\
Read the clock with `date` before you write any time down; never estimate one. Notices from Argmax \
carry the time they were sent.\n\
\n\
Your job is to plan and delegate, not to implement. Break the work into pieces and launch a \
session per piece with session_launch; a member does not have to run in this Arc's home project — \
pass `project` to put it in any registered project. Review what each one reports back, and keep \
`{dir}/NOTES.md` current. You are the only writer of files in this folder; do not implement code \
yourself, here or anywhere else.\n\
\n\
Integration is a member's job too: merging a branch, running the project's checks, rebuilding \
derived artifacts. Launch a small session for it rather than doing it here, so this chat's context \
is spent on judgement.\n\
\n\
Pick the model per piece. Docs, wording, deck and cleanup passes go on a cheaper model — pass \
`model: \"claude-sonnet-5\"` on session_launch — and the strong model is for method or analysis \
work.\n\
\n\
Record durable repo facts with learnings_add as you get them, and check learnings_search before \
you brief a member on an area you do not know. A member's \"Learnings for the arc\" belong in \
NOTES.md only while they are still current.\n\
\n\
You do not need a follow-up per launch: the completion notice arrives on its own when a member \
finishes. For long work pass `check_in_minutes` on session_launch instead of schedule_followup; it \
fires only if the member is still running. A completion notice reaches you only from a session you \
launched directly, never from one it launched in turn — do not session_wait on a grandchild, since \
it will not report to you. Call arc_status to see this Arc's current members, the clock, how large \
NOTES.md has grown, your own coordinator id, and how much of the launch budget is left."
    )
}

/// The one message an existing chat gets when a person starts an Arc from it.
/// No provider can swap a running conversation's system prompt, so the new
/// role arrives as a turn. Unlike a launched coordinator, this chat already
/// knows the work, so its first job is to write that knowledge down.
pub fn promoted_coordinator_preamble(arc: &ArcRecord, adopted_members: usize) -> String {
    let name = &arc.name;
    let dir = &arc.dir;
    let adopted = match adopted_members {
        0 => String::new(),
        1 => " The one session you launched earlier is now a member of the Arc too.".to_string(),
        count => {
            format!(" The {count} sessions you launched earlier are now members of the Arc too.")
        }
    };
    format!(
        "This chat now coordinates Arc \"{name}\". Its shared folder is `{dir}`, and `{dir}/BRIEF.md` \
holds the brief drafted from this conversation.{adopted}\n\
\n\
Start by writing what you already know into `{dir}/NOTES.md`: the standing instructions, the \
current direction, what is in flight, what is decided, and anything a member or a later \
coordinator would need. NOTES.md is the current state, not the history. Keep it under about 4,000 \
words — a member reads all of it on every launch and pays for it on every turn after — so when \
something is done, shorten its entry to one line and move the detail to `{dir}/LOG.md`.\n\
\n\
LOG.md is append-only history: one dated entry per event — a launch, a result, a merge, a \
decision. Nobody reads it unless you point them at it. You are the only writer of files in that \
folder, and a member's report goes in its own file there, named after the piece.\n\
\n\
Read the clock with `date` before you write any time down; never estimate one. Notices from Argmax \
carry the time they were sent.\n\
\n\
From here on, plan and delegate rather than implement. Launch a session per piece of work with \
session_launch (pass `project` to put it in any registered project), review what each one reports \
back, and keep NOTES.md current; do not implement code yourself. Integration is a member's job \
too: merging a branch, running the project's checks, rebuilding derived artifacts. Launch a small \
session for it rather than doing it here, so this chat's context is spent on judgement.\n\
\n\
Pick the model per piece. Docs, wording, deck and cleanup passes go on a cheaper model — pass \
`model: \"claude-sonnet-5\"` on session_launch — and the strong model is for method or analysis \
work.\n\
\n\
Record durable repo facts with learnings_add as you get them, and check learnings_search before \
you brief a member on an area you do not know. A member's \"Learnings for the arc\" belong in \
NOTES.md only while they are still current.\n\
\n\
You do not need a follow-up per launch: the completion notice arrives on its own when a member \
finishes, and it reaches you only from a session you launched directly. For long work pass \
`check_in_minutes` on session_launch instead of schedule_followup; it fires only if the member is \
still running. Call arc_status to see members, the clock, how large NOTES.md has grown, and limits."
    )
}

/// Prepended to every other session's prompt when it is launched or dispatched
/// inside an Arc — an agent launch whose caller carries this Arc's id, or a
/// `/multitask` dispatched from one of its sessions.
pub fn member_preamble(arc: &ArcRecord) -> String {
    let name = &arc.name;
    let dir = &arc.dir;
    format!(
        "You are working as part of Arc \"{name}\". Read `{dir}/BRIEF.md` and `{dir}/NOTES.md` \
first for the Arc's goal and its current state. Read `{dir}/LOG.md` or any report file in that \
folder only if your prompt points you at it. Do not write to files in `{dir}` — the coordinator \
is the only writer there. File durable repo facts with learnings_add as you go. End your final \
answer with a short \"Learnings for the arc\" section: a few bullets, only what is not already in \
NOTES.md (how to run or test things, conventions, pitfalls). The coordinator sees the head of your \
answer and that section."
    )
}

fn cap_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let kept: String = value.chars().take(max).collect();
    format!("{kept}\n\n(truncated)")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::arcs::ArcState;

    fn arc(brief: &str) -> ArcRecord {
        ArcRecord {
            id: "arc-1".to_string(),
            name: "Ragnar rollout".to_string(),
            brief: brief.to_string(),
            state: ArcState::Active,
            home_project_id: "project-1".to_string(),
            coordinator_session_id: None,
            dir: "/tmp/arcs/arc-1".to_string(),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn coordinator_preamble_names_the_arc_folder_brief_and_rules() {
        let preamble = coordinator_preamble(&arc("Ship the thing."));
        assert!(preamble.contains("coordinator of Arc \"Ragnar rollout\""));
        assert!(preamble.contains("/tmp/arcs/arc-1"));
        assert!(preamble.contains("Ship the thing."));
        assert!(preamble.contains("NOTES.md"));
        assert!(preamble.contains("a previous coordinator may"));
        assert!(preamble.contains("do not implement code yourself"));
        assert!(preamble.contains("do not session_wait on a grandchild"));
        assert!(preamble.contains("arc_status"));
        assert!(preamble.contains("pass `project` to put it in any registered project"));
    }

    #[test]
    fn coordinator_preamble_splits_current_state_from_the_log() {
        let preamble = coordinator_preamble(&arc("Ship the thing."));
        assert!(preamble.contains("NOTES.md is the current state, not the history"));
        assert!(preamble.contains("under about 4,000 words"));
        assert!(preamble.contains("/tmp/arcs/arc-1/LOG.md"));
        assert!(preamble.contains("LOG.md is append-only history"));
        assert!(preamble.contains("its own file in the folder, named after the piece"));
    }

    #[test]
    fn coordinator_preamble_gives_a_clock_a_model_rule_and_learnings() {
        let preamble = coordinator_preamble(&arc("Ship the thing."));
        assert!(preamble.contains("Read the clock with `date`"));
        assert!(preamble.contains("carry the time they were sent"));
        assert!(preamble.contains("claude-sonnet-5"));
        assert!(preamble.contains("learnings_add"));
        assert!(preamble.contains("learnings_search"));
    }

    #[test]
    fn coordinator_preamble_delegates_integration_and_drops_the_per_launch_followup() {
        let preamble = coordinator_preamble(&arc("Ship the thing."));
        assert!(preamble.contains("Integration is a member's job too"));
        assert!(preamble.contains("rebuilding derived artifacts"));
        assert!(preamble.contains("You do not need a follow-up per launch"));
        assert!(preamble.contains("`check_in_minutes` on session_launch"));
    }

    #[test]
    fn coordinator_preamble_caps_a_long_brief() {
        let long_brief = "x".repeat(BRIEF_PREAMBLE_CHARS + 500);
        let preamble = coordinator_preamble(&arc(&long_brief));
        assert!(preamble.contains("(truncated)"));
    }

    #[test]
    fn coordinator_preamble_says_so_when_the_brief_is_blank() {
        let preamble = coordinator_preamble(&arc(""));
        assert!(preamble.contains("(no brief yet)"));
    }

    #[test]
    fn promoted_coordinator_preamble_carries_the_same_rules() {
        let preamble = promoted_coordinator_preamble(&arc("Ship the thing."), 2);
        assert!(preamble.contains("The 2 sessions you launched earlier"));
        assert!(preamble.contains("NOTES.md is the current state, not the history"));
        assert!(preamble.contains("under about 4,000 words"));
        assert!(preamble.contains("LOG.md is append-only history"));
        assert!(preamble.contains("Read the clock with `date`"));
        assert!(preamble.contains("Integration is a member's job too"));
        assert!(preamble.contains("claude-sonnet-5"));
        assert!(preamble.contains("learnings_add"));
        assert!(preamble.contains("`check_in_minutes` on session_launch"));
        assert!(preamble.contains("do not implement code yourself"));
    }

    #[test]
    fn member_preamble_points_at_the_shared_files_and_asks_for_learnings() {
        let preamble = member_preamble(&arc("Ship the thing."));
        assert!(preamble.contains("part of Arc \"Ragnar rollout\""));
        assert!(preamble.contains("BRIEF.md"));
        assert!(preamble.contains("NOTES.md"));
        assert!(preamble.contains("Do not write to files in `/tmp/arcs/arc-1`"));
        assert!(preamble.contains("Learnings for the arc"));
    }

    #[test]
    fn member_preamble_reads_the_log_only_when_pointed_at_it() {
        let preamble = member_preamble(&arc("Ship the thing."));
        assert!(preamble.contains("only if your prompt points you at it"));
        assert!(preamble.contains("/tmp/arcs/arc-1/LOG.md"));
        assert!(preamble.contains("learnings_add"));
        assert!(preamble.contains("a few bullets, only what is not already in NOTES.md"));
    }
}
