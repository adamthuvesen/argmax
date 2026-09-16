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
Your job is to plan and delegate, not to implement. Break the work into pieces and launch a \
session per piece with session_launch; a member does not have to run in this Arc's home project — \
pass `project` to put it in any registered project. Review what each one reports back, and keep \
`{dir}/NOTES.md` current with what is done, what is in flight, and anything the next coordinator or \
a member needs to know. You are the only writer of files in this folder; do not implement code \
yourself, here or anywhere else.\n\
\n\
A completion notice reaches you only from a session you launched directly, never from one it \
launched in turn — do not session_wait on a grandchild, since it will not report to you. Use \
schedule_followup to check back on longer-running work instead of blocking on it. Call arc_status \
to see this Arc's current members, your own coordinator id, and how much of the launch budget is \
left."
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
Start by writing what you already know into `{dir}/NOTES.md`: what is done, what is in flight, the \
decisions made so far, and anything a member or a later coordinator would need. You are the only \
writer of files in that folder.\n\
\n\
From here on, plan and delegate rather than implement. Launch a session per piece of work with \
session_launch (pass `project` to put it in any registered project), review what each one reports \
back, and keep NOTES.md current. A completion notice reaches you only from a session you launched \
directly. Use schedule_followup to check back on longer work, and arc_status to see members and \
limits."
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
first for the Arc's goal and its current state. Do not write to files in `{dir}` — the coordinator \
is the only writer there. End your final answer with any durable learnings (how to run or test \
things, conventions, pitfalls) under a \"Learnings for the arc\" heading, so the coordinator can \
record them in NOTES.md."
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
    fn member_preamble_points_at_the_shared_files_and_asks_for_learnings() {
        let preamble = member_preamble(&arc("Ship the thing."));
        assert!(preamble.contains("part of Arc \"Ragnar rollout\""));
        assert!(preamble.contains("BRIEF.md"));
        assert!(preamble.contains("NOTES.md"));
        assert!(preamble.contains("Do not write to files in `/tmp/arcs/arc-1`"));
        assert!(preamble.contains("Learnings for the arc"));
    }
}
