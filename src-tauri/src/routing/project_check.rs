// Project check: before a launch, ask Jev which of the user's projects the
// prompt belongs to, and suggest (or, on overwhelming evidence, make) the
// switch when it is not the one the launcher is aimed at. See
// docs/routing.md#project-check for the thresholds and where they came from.
//
// Everything Jev reads about a project is derived from that user's own
// checkouts and history, so it works for anyone's repositories. Every failure
// here is "no opinion": a check never blocks or fails a launch.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque},
    path::Path,
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant, SystemTime},
};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use uuid::Uuid;

use super::jev;
use crate::{
    error::{ArgmaxError, ArgmaxResult},
    persistence::{
        app_settings::{project_check_mode, ProjectCheckMode},
        project_checks::{
            checkout_paths, launches_since, prompts_not_history, recent_opening_prompts,
            record_project_check, ProjectCheckRecord,
        },
        projects::{list_projects, ProjectSummary},
        time::{hours_ago, now_iso},
        Database,
    },
    util::sync::LockOrRecover,
    workspaces::SCRATCH_PROJECT_ID,
};

// Tuned to ask freely and move carefully (2026-09-27 held-out eval, numbers in
// docs/routing.md#project-check): a wrong question costs one keypress, a
// wrong silent move costs an Undo.
const SUGGEST_MIN: f64 = 0.50;
const SUGGEST_CURRENT_MAX: f64 = 0.10;
// Jev alone was never safe enough to act without asking: an automatic switch
// also needs the prompt to name the project or cite a file only it has.
const SWITCH_MIN: f64 = 0.90;
const SWITCH_CURRENT_MAX: f64 = 0.05;
/// A prompt that names another project (or one of its apps) is asked about
/// at a lower bar: "Is alfred in a good shape?" typed in argmax scored the
/// Alfred monorepo 0.66, with the rest on `none`.
const NAMED_SUGGEST_MIN: f64 = 0.35;
const NAMED_CURRENT_MAX: f64 = 0.10;
/// A second project worth listing in the dialog.
const RUNNER_UP_MIN: f64 = 0.10;
/// The current project plus the ones the user works in most.
const MAX_CANDIDATES: usize = 10;
/// Projects the prompt names that usage left out.
const MAX_NAMED_EXTRA: usize = 2;
/// "Most used" counts the chats started in this many past hours.
const USAGE_WINDOW_HOURS: i64 = 30 * 24;
/// "Is this in the wrong project?" has no answer for "ok" or "go on".
const MIN_PROMPT_CHARS: usize = 12;
/// The options are long; the launcher starts the check while the user types.
const JEV_CHECK_TIMEOUT: Duration = Duration::from_secs(3);
const PROFILE_TTL: Duration = Duration::from_secs(10 * 60);
const GIT_TIMEOUT: Duration = Duration::from_secs(3);
/// Opening prompts kept per project, and how many of them Jev reads.
const HISTORY_LIMIT: usize = 200;
const PROFILE_EXAMPLES: usize = 16;
const EXAMPLE_CHARS: usize = 140;
/// Claude Code transcripts read per project, newest first.
const TRANSCRIPT_LIMIT: usize = 80;
const TOPIC_WORDS: usize = 20;
const DESCRIPTION_CHARS: usize = 420;
/// Folders whose children are the apps and services of a monorepo.
const COMPONENT_ROOTS: [&str; 4] = ["applications", "apps", "services", "packages"];
/// Of those, the ones whose names identify a project when a prompt says them.
/// A package called `tools` or `checks` names nothing.
const NAMING_ROOTS: [&str; 3] = ["applications", "apps", "services"];
/// A checkout this small whose name is another project's app is a pointer to
/// that app, not a home for work.
const STUB_MAX_FILES: usize = 20;
/// Checks waiting for the user's answer; a speculative check may never get one.
const PENDING_CAPACITY: usize = 32;

const INSTRUCTIONS: &str = "A user typed this request to a coding agent. Which of the user's repositories is the request about, i.e. which codebase should the agent work in?";
const NONE_KEY: &str = "none";
/// Narrow on purpose: a personal-ops repository (notes, a work tracker) is
/// where "prep my week" belongs, and a broad "not about a codebase" option
/// outbid it in the eval.
const NONE_TEXT: &str = "None of these repositories: general knowledge or trivia, creative writing, or a question about the coding agent itself that no repository here is about.";

/// Prompts that open a chat but were not typed as a request: Argmax's own
/// handoffs and continuations, provider notes, slash commands.
const NOT_TYPED_PREFIXES: [&str; 10] = [
    "/",
    "<",
    "[",
    "session ",
    "You are ",
    "Argmax ",
    "Project handoff",
    "The user is continuing",
    "Proceed:",
    "Caveat",
];
const ARC_HEADER: &str = "You are working as part of Arc ";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ProjectCheckDecision {
    None,
    Suggest,
    Switch,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCheck {
    pub decision: ProjectCheckDecision,
    /// Names this check when its outcome is reported; null for `none`.
    pub check_id: Option<String>,
    pub suggested_project_id: Option<String>,
    /// A second project Jev gave real weight to, offered in the dialog.
    pub runner_up_project_id: Option<String>,
    pub suggested_probability: f64,
    pub current_probability: f64,
    /// Why, in the words the dialog shows: "Mentions argmax", "Jev 96%".
    pub reasons: Vec<String>,
}

impl ProjectCheck {
    fn none() -> Self {
        ProjectCheck {
            decision: ProjectCheckDecision::None,
            check_id: None,
            suggested_project_id: None,
            runner_up_project_id: None,
            suggested_probability: 0.0,
            current_probability: 0.0,
            reasons: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ProjectCheckOutcome {
    /// Started in the suggested project, by the user or by the switch.
    Accepted,
    /// Started where the launcher was aimed after all.
    Stayed,
    /// Undid an automatic switch.
    Undone,
    /// Went back to the composer without launching.
    Cancelled,
}

impl ProjectCheckOutcome {
    fn as_str(self) -> &'static str {
        match self {
            ProjectCheckOutcome::Accepted => "accepted",
            ProjectCheckOutcome::Stayed => "stayed",
            ProjectCheckOutcome::Undone => "undone",
            ProjectCheckOutcome::Cancelled => "cancelled",
        }
    }
}

/// What is known about one project, cached. The text Jev reads is assembled
/// per check, because two parts of it depend on the other candidates: the
/// topic words that set this project apart, and the examples that name none
/// of the others.
struct Profile {
    built_at: Instant,
    description: String,
    languages: Vec<&'static str>,
    folders: Vec<String>,
    /// `applications` → `alfred`, `backoffice`, …
    components: BTreeMap<String, Vec<String>>,
    files: HashSet<String>,
    basenames: HashSet<String>,
    /// The user's opening prompts here, newest first, cleaned and deduplicated.
    history: Vec<String>,
    /// How many prompts in `history` use each topic word.
    word_counts: HashMap<String, usize>,
}

impl Profile {
    /// App and service names that identify this project when a prompt says them.
    fn naming_components(&self) -> impl Iterator<Item = &str> {
        NAMING_ROOTS
            .iter()
            .filter_map(|root| self.components.get(*root))
            .flatten()
            .map(String::as_str)
            .filter(|name| name.len() >= 4 && !STOP_WORDS.contains(name))
    }
}

static PROFILES: LazyLock<Mutex<HashMap<String, Arc<Profile>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static PENDING: LazyLock<Mutex<VecDeque<ProjectCheckRecord>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));

/// What the prompt itself says about one candidate.
#[derive(Debug, Default, Clone, PartialEq)]
struct Evidence {
    /// The project's name, or one of its apps' names, as a whole word.
    named: Option<String>,
    /// Paths in the prompt that only this candidate has.
    cited: Vec<String>,
}

impl Evidence {
    fn any(&self) -> bool {
        self.named.is_some() || !self.cited.is_empty()
    }
}

struct Candidate {
    project: ProjectSummary,
    /// The option's name in the Jev question; unique within one check.
    key: String,
    profile: Arc<Profile>,
}

/// Runs the check. `data_dir` is Argmax's own data directory, whose attachment
/// paths are stripped: a pasted screenshot says nothing about the project.
pub async fn check_prompt(
    database: Arc<Database>,
    data_dir: Option<std::path::PathBuf>,
    project_id: String,
    prompt: String,
    picked_by_hand: bool,
) -> ArgmaxResult<ProjectCheck> {
    let Some((prepared, probabilities)) =
        classify_prompt(database, data_dir, project_id, prompt).await?
    else {
        return Ok(ProjectCheck::none());
    };
    Ok(decide(&prepared, &probabilities, picked_by_hand, true).check)
}

/// The same question as [`check_prompt`], for a launch no one is watching.
/// A switch is not queued for the launcher dialog: the caller records it once
/// the session exists. A suggestion is only reported. Any failure, including
/// no key and a short prompt, is "no opinion" and never an error.
pub async fn check_agent_launch(
    database: Arc<Database>,
    data_dir: Option<std::path::PathBuf>,
    project_id: String,
    prompt: String,
) -> AgentLaunchCheck {
    let classified = match classify_prompt(database, data_dir, project_id, prompt).await {
        Ok(classified) => classified,
        Err(error) => {
            tracing::warn!(target: "argmax::routing", "project check failed: {error}");
            return AgentLaunchCheck::none();
        }
    };
    let Some((prepared, probabilities)) = classified else {
        return AgentLaunchCheck::none();
    };
    AgentLaunchCheck::from_finished(decide(&prepared, &probabilities, false, false))
}

/// What an agent launch should do with the check. `record` is set only for a
/// switch, and only so the caller can store it against the session it created.
#[derive(Debug, Clone)]
pub struct AgentLaunchCheck {
    pub decision: ProjectCheckDecision,
    pub suggested_project_id: Option<String>,
    pub suggested_project_name: Option<String>,
    pub suggested_repo_path: Option<String>,
    pub reasons: Vec<String>,
    pub record: Option<ProjectCheckRecord>,
}

impl AgentLaunchCheck {
    pub(crate) fn none() -> Self {
        AgentLaunchCheck {
            decision: ProjectCheckDecision::None,
            suggested_project_id: None,
            suggested_project_name: None,
            suggested_repo_path: None,
            reasons: Vec::new(),
            record: None,
        }
    }

    fn from_finished(finished: FinishedCheck) -> Self {
        AgentLaunchCheck {
            decision: finished.check.decision,
            suggested_project_id: finished.check.suggested_project_id,
            suggested_project_name: finished.suggested_project_name,
            suggested_repo_path: finished.suggested_repo_path,
            reasons: finished.check.reasons,
            record: finished.record,
        }
    }
}

async fn classify_prompt(
    database: Arc<Database>,
    data_dir: Option<std::path::PathBuf>,
    project_id: String,
    prompt: String,
) -> ArgmaxResult<Option<(Prepared, HashMap<String, f64>)>> {
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        prepare(&database, data_dir.as_deref(), &project_id, &prompt)
    })
    .await
    .map_err(|error| ArgmaxError::service("PROJECT_CHECK_JOIN", error.to_string()))??;
    let Some(prepared) = prepared else {
        return Ok(None);
    };
    match jev::classify_choice(
        &prepared.text,
        INSTRUCTIONS,
        &prepared.criteria,
        &prepared.api_key,
        JEV_CHECK_TIMEOUT,
    )
    .await
    {
        Ok(probabilities) => Ok(Some((prepared, probabilities))),
        Err(error) => {
            tracing::warn!(target: "argmax::routing", "project check failed: {error}");
            Ok(None)
        }
    }
}

/// Stores the user's answer to a check this process handed out.
pub fn resolve_check(
    database: &Database,
    check_id: &str,
    outcome: ProjectCheckOutcome,
    session_id: Option<&str>,
) -> ArgmaxResult<()> {
    let record = PENDING
        .lock_or_recover("project check pending")
        .iter()
        .find(|record| record.id == check_id)
        .cloned()
        .ok_or_else(|| {
            ArgmaxError::service(
                "PROJECT_CHECK_UNKNOWN",
                "That project check is no longer pending.",
            )
        })?;
    record_project_check(
        &database.connection(),
        &record,
        outcome.as_str(),
        session_id,
    )
}

struct Prepared {
    api_key: String,
    text: String,
    current_id: String,
    mode: ProjectCheckMode,
    candidates: Vec<Candidate>,
    criteria: Vec<(String, String)>,
    evidence: HashMap<String, Evidence>,
}

fn prepare(
    database: &Database,
    data_dir: Option<&Path>,
    project_id: &str,
    prompt: &str,
) -> ArgmaxResult<Option<Prepared>> {
    let connection = database.read_connection();
    let mode = project_check_mode(&connection);
    if mode == ProjectCheckMode::Off {
        return Ok(None);
    }
    let Some(api_key) = super::api_key::stored_key() else {
        return Ok(None);
    };
    let text = match data_dir {
        Some(data_dir) => strip_paths_under(prompt, data_dir),
        None => prompt.to_string(),
    };
    if text.trim().chars().count() < MIN_PROMPT_CHARS {
        return Ok(None);
    }
    let projects: Vec<ProjectSummary> = list_projects(&connection)?
        .into_iter()
        .filter(|project| {
            project.id != SCRATCH_PROJECT_ID && Path::new(&project.repo_path).is_dir()
        })
        .collect();
    let Some(current) = projects.iter().find(|project| project.id == project_id) else {
        return Ok(None);
    };
    if projects.len() < 2 {
        return Ok(None);
    }
    let usage = launches_since(&connection, &hours_ago(USAGE_WINDOW_HOURS)).unwrap_or_default();
    let lowered = text.to_lowercase();
    let chosen = choose_candidates(current, &projects, &usage, &lowered);
    let mut candidates: Vec<Candidate> = chosen
        .into_iter()
        .map(|project| Candidate {
            project: project.clone(),
            key: String::new(),
            profile: profile_for(&connection, project, data_dir),
        })
        .collect();
    drop_stubs(&mut candidates, &current.id);
    let mut used_keys = HashSet::new();
    for candidate in &mut candidates {
        candidate.key = unique_key(&candidate.project.name, &mut used_keys);
    }
    let criteria = candidates
        .iter()
        .map(|candidate| {
            (
                candidate.key.clone(),
                criterion_text(candidate, &candidates),
            )
        })
        .chain(std::iter::once((
            NONE_KEY.to_string(),
            NONE_TEXT.to_string(),
        )))
        .collect();
    let evidence = gather_evidence(&text, &lowered, &candidates);
    Ok(Some(Prepared {
        api_key,
        text,
        current_id: current.id.clone(),
        mode,
        candidates,
        criteria,
        evidence,
    }))
}

/// The current project first, then the ones the user started the most chats
/// in lately (recency, `list_projects`' order, breaks ties), then projects
/// the prompt names outright.
fn choose_candidates<'a>(
    current: &'a ProjectSummary,
    projects: &'a [ProjectSummary],
    usage: &HashMap<String, i64>,
    lowered_prompt: &str,
) -> Vec<&'a ProjectSummary> {
    let mut by_usage: Vec<(usize, &ProjectSummary)> = projects
        .iter()
        .enumerate()
        .filter(|(_, project)| project.id != current.id)
        .collect();
    by_usage.sort_by_key(|(recency, project)| {
        (
            std::cmp::Reverse(usage.get(&project.id).copied().unwrap_or(0)),
            *recency,
        )
    });
    let mut chosen = vec![current];
    chosen.extend(
        by_usage
            .into_iter()
            .take(MAX_CANDIDATES - 1)
            .map(|(_, project)| project),
    );
    let named: Vec<&ProjectSummary> = projects
        .iter()
        .filter(|project| {
            !chosen.iter().any(|picked| picked.id == project.id)
                && (mentions_word(lowered_prompt, &project.name.to_lowercase())
                    || lowered_prompt.contains(&format!("{}/", project.repo_path.to_lowercase())))
        })
        .take(MAX_NAMED_EXTRA)
        .collect();
    chosen.extend(named);
    chosen
}

/// A tiny checkout named after another candidate's app is a pointer into that
/// monorepo ("maintained in revops-backoffice → applications/alfred"). As an
/// option it splits the app's weight with its real home, so it goes; the
/// app's name still counts as naming the owner. The current project stays.
fn drop_stubs(candidates: &mut Vec<Candidate>, current_id: &str) {
    let app_names: HashSet<String> = candidates
        .iter()
        .flat_map(|candidate| {
            candidate
                .profile
                .naming_components()
                .map(str::to_lowercase)
                .collect::<Vec<_>>()
        })
        .collect();
    candidates.retain(|candidate| {
        candidate.project.id == current_id
            || candidate.profile.files.len() > STUB_MAX_FILES
            || !app_names.contains(&candidate.project.name.to_lowercase())
    });
}

struct FinishedCheck {
    check: ProjectCheck,
    /// Present for a switch that nobody will answer in the dialog, so the
    /// caller can store it once the session exists. A suggestion the launcher
    /// is holding lives in the pending queue instead.
    record: Option<ProjectCheckRecord>,
    suggested_project_name: Option<String>,
    suggested_repo_path: Option<String>,
}

impl FinishedCheck {
    fn none() -> Self {
        FinishedCheck {
            check: ProjectCheck::none(),
            record: None,
            suggested_project_name: None,
            suggested_repo_path: None,
        }
    }
}

fn decide(
    prepared: &Prepared,
    probabilities: &HashMap<String, f64>,
    picked_by_hand: bool,
    hold_for_dialog: bool,
) -> FinishedCheck {
    let probability =
        |candidate: &Candidate| probabilities.get(&candidate.key).copied().unwrap_or(0.0);
    let Some(current) = prepared
        .candidates
        .iter()
        .find(|candidate| candidate.project.id == prepared.current_id)
    else {
        return FinishedCheck::none();
    };
    let current_probability = probability(current);
    let mut others: Vec<(&Candidate, f64)> = prepared
        .candidates
        .iter()
        .filter(|candidate| candidate.project.id != prepared.current_id)
        .map(|candidate| (candidate, probability(candidate)))
        .collect();
    others.sort_by(|left, right| right.1.total_cmp(&left.1));
    let Some(&(best, best_probability)) = others.first() else {
        return FinishedCheck::none();
    };
    let evidence = prepared
        .evidence
        .get(&best.project.id)
        .cloned()
        .unwrap_or_default();
    let switch = match verdict(
        best_probability,
        current_probability,
        evidence.any(),
        prepared.mode == ProjectCheckMode::Switch && !picked_by_hand,
    ) {
        ProjectCheckDecision::None => return FinishedCheck::none(),
        ProjectCheckDecision::Suggest => false,
        ProjectCheckDecision::Switch => true,
    };
    let mut reasons = Vec::new();
    if let Some(name) = &evidence.named {
        reasons.push(format!("Mentions {name}"));
    }
    for path in evidence.cited.iter().take(2) {
        reasons.push(format!("Cites {path}"));
    }
    reasons.push(format!("Jev {:.0}% sure", best_probability * 100.0));
    let runner_up = others
        .get(1)
        .filter(|(_, probability)| *probability >= RUNNER_UP_MIN)
        .map(|(candidate, _)| candidate.project.id.clone());
    let record = ProjectCheckRecord {
        id: Uuid::new_v4().to_string(),
        created_at: now_iso(),
        prompt_hash: Sha256::digest(prepared.text.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        current_project_id: prepared.current_id.clone(),
        suggested_project_id: best.project.id.clone(),
        current_probability,
        suggested_probability: best_probability,
        reasons: reasons.clone(),
        decision: if switch { "switched" } else { "suggested" },
    };
    // The launcher holds the row until the person answers. An agent launch has
    // no dialog: a suggestion is reported and dropped, and a switch is handed
    // back so the caller can store it against the session it actually created.
    // Leaving it pending would sit in the queue until a launch that never comes.
    let (check_id, returned_record) = if hold_for_dialog {
        let check_id = record.id.clone();
        let mut pending = PENDING.lock_or_recover("project check pending");
        if pending.len() >= PENDING_CAPACITY {
            pending.pop_front();
        }
        pending.push_back(record);
        (Some(check_id), None)
    } else if switch {
        (None, Some(record))
    } else {
        (None, None)
    };
    FinishedCheck {
        check: ProjectCheck {
            decision: if switch {
                ProjectCheckDecision::Switch
            } else {
                ProjectCheckDecision::Suggest
            },
            check_id,
            suggested_project_id: Some(best.project.id.clone()),
            runner_up_project_id: runner_up,
            suggested_probability: best_probability,
            current_probability,
            reasons,
        },
        record: returned_record,
        suggested_project_name: Some(best.project.name.clone()),
        suggested_repo_path: Some(best.project.repo_path.clone()),
    }
}

/// The thresholds, on their own. `may_switch` is the mode allowing it and the
/// user not having picked the project by hand.
fn verdict(
    best_probability: f64,
    current_probability: f64,
    has_evidence: bool,
    may_switch: bool,
) -> ProjectCheckDecision {
    let sure = best_probability >= SUGGEST_MIN && current_probability <= SUGGEST_CURRENT_MAX;
    let named = has_evidence
        && best_probability >= NAMED_SUGGEST_MIN
        && current_probability <= NAMED_CURRENT_MAX;
    if !sure && !named {
        ProjectCheckDecision::None
    } else if may_switch
        && has_evidence
        && best_probability >= SWITCH_MIN
        && current_probability <= SWITCH_CURRENT_MAX
    {
        ProjectCheckDecision::Switch
    } else {
        ProjectCheckDecision::Suggest
    }
}

fn unique_key(name: &str, used: &mut HashSet<String>) -> String {
    let base = if name.trim().is_empty() || name == NONE_KEY {
        format!("{name} project")
    } else {
        name.to_string()
    };
    let mut key = base.clone();
    let mut suffix = 2;
    while !used.insert(key.clone()) {
        key = format!("{base} ({suffix})");
        suffix += 1;
    }
    key
}

/// The prompt names the project or one of its apps, or points into its
/// checkout by path.
fn gather_evidence(
    text: &str,
    lowered: &str,
    candidates: &[Candidate],
) -> HashMap<String, Evidence> {
    let mut evidence: HashMap<String, Evidence> = HashMap::new();
    let mut app_owners: HashMap<String, Vec<&Candidate>> = HashMap::new();
    for candidate in candidates {
        for app in candidate.profile.naming_components() {
            app_owners
                .entry(app.to_lowercase())
                .or_default()
                .push(candidate);
        }
    }
    for candidate in candidates {
        if mentions_word(lowered, &candidate.project.name.to_lowercase()) {
            evidence
                .entry(candidate.project.id.clone())
                .or_default()
                .named = Some(candidate.project.name.clone());
        }
    }
    for (app, owners) in &app_owners {
        if let [owner] = owners.as_slice() {
            if mentions_word(lowered, app) {
                evidence
                    .entry(owner.project.id.clone())
                    .or_default()
                    .named
                    .get_or_insert_with(|| app.clone());
            }
        }
    }
    for token in path_tokens(text) {
        let owners: Vec<&Candidate> = candidates
            .iter()
            .filter(|candidate| cites(candidate, &token))
            .collect();
        if let [owner] = owners.as_slice() {
            evidence
                .entry(owner.project.id.clone())
                .or_default()
                .cited
                .push(token);
        }
    }
    evidence
}

fn cites(candidate: &Candidate, token: &str) -> bool {
    let repo = candidate.project.repo_path.trim_end_matches('/');
    if token.starts_with('/') {
        return token.starts_with(&format!("{repo}/"));
    }
    if token.contains('/') {
        let relative = token.trim_start_matches("./");
        let suffix = format!("/{relative}");
        return candidate.profile.files.contains(relative)
            || candidate
                .profile
                .files
                .iter()
                .any(|file| file.ends_with(&suffix));
    }
    candidate.profile.basenames.contains(token)
}

/// Words in the prompt that look like a file path or a file name.
fn path_tokens(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    for raw in text.split_whitespace() {
        let token = raw
            .trim_start_matches('@')
            .trim_matches(|character: char| {
                matches!(
                    character,
                    '`' | '"' | '\'' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' | ',' | ';'
                ) || (character == '.' || character == ':' || character == '?' || character == '!')
            })
            .to_string();
        if token.len() < 4 || token.contains("://") {
            continue;
        }
        let looks_like_file = token.rsplit_once('.').is_some_and(|(stem, extension)| {
            !stem.is_empty()
                && (1..=6).contains(&extension.len())
                && extension
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
                && extension
                    .chars()
                    .any(|character| character.is_ascii_alphabetic())
        });
        if (token.contains('/') || looks_like_file) && !tokens.contains(&token) {
            tokens.push(token);
        }
    }
    tokens
}

/// `needle` appears as a whole word: not inside a longer name like
/// `argmax-dev` or `hqx`.
fn mentions_word(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let is_word =
        |character: char| character.is_alphanumeric() || character == '_' || character == '-';
    haystack.match_indices(needle).any(|(start, _)| {
        let before = haystack[..start].chars().next_back();
        let after = haystack[start + needle.len()..].chars().next();
        !before.is_some_and(is_word) && !after.is_some_and(is_word)
    })
}

/// Removes every path under `root` from the prompt, attachment references
/// included. The root may contain spaces ("Application Support"), so a path
/// runs from the root to the next whitespace after it.
fn strip_paths_under(prompt: &str, root: &Path) -> String {
    let root = root.to_string_lossy();
    let root = root.trim_end_matches('/');
    if root.is_empty() {
        return prompt.to_string();
    }
    let mut remaining = prompt;
    let mut stripped = String::with_capacity(prompt.len());
    while let Some(start) = remaining.find(root) {
        let before = &remaining[..start];
        stripped.push_str(before.strip_suffix('@').unwrap_or(before));
        let after_root = &remaining[start + root.len()..];
        let end = after_root
            .find(char::is_whitespace)
            .unwrap_or(after_root.len());
        remaining = &after_root[end..];
    }
    stripped.push_str(remaining);
    stripped
}

fn profile_for(
    connection: &Connection,
    project: &ProjectSummary,
    data_dir: Option<&Path>,
) -> Arc<Profile> {
    let cache_key = format!("{}\u{0}{}", project.id, project.repo_path);
    if let Some(profile) = PROFILES
        .lock_or_recover("project check profiles")
        .get(&cache_key)
    {
        if profile.built_at.elapsed() < PROFILE_TTL {
            return profile.clone();
        }
    }
    let profile = Arc::new(build_profile(connection, project, data_dir));
    PROFILES
        .lock_or_recover("project check profiles")
        .insert(cache_key, profile.clone());
    profile
}

fn build_profile(
    connection: &Connection,
    project: &ProjectSummary,
    data_dir: Option<&Path>,
) -> Profile {
    let repo = Path::new(&project.repo_path);
    let files: Vec<String> =
        crate::git::exec::run_git_text_blocking(repo, ["ls-files"], GIT_TIMEOUT)
            .map(|stdout| stdout.lines().map(str::to_string).collect())
            .unwrap_or_default();
    let history = project_history(connection, project, data_dir);
    let mut word_counts: HashMap<String, usize> = HashMap::new();
    for prompt in &history {
        for word in topic_words(prompt).into_iter().collect::<HashSet<_>>() {
            *word_counts.entry(word).or_default() += 1;
        }
    }
    let mut folders: Vec<String> = files
        .iter()
        .filter_map(|file| file.split_once('/').map(|(folder, _)| folder))
        .filter(|folder| !folder.starts_with('.'))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(str::to_string)
        .collect();
    folders.truncate(12);
    let mut components: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for file in &files {
        let mut parts = file.split('/');
        if let (Some(root), Some(child), Some(_)) = (parts.next(), parts.next(), parts.next()) {
            if COMPONENT_ROOTS.contains(&root) {
                let names = components.entry(root.to_string()).or_default();
                if !names.iter().any(|name| name == child) {
                    names.push(child.to_string());
                }
            }
        }
    }
    for names in components.values_mut() {
        names.sort();
        names.truncate(15);
    }
    Profile {
        built_at: Instant::now(),
        description: describe(repo),
        languages: top_languages(&files),
        folders,
        components,
        basenames: files
            .iter()
            .filter_map(|file| file.rsplit('/').next())
            .map(str::to_string)
            .collect(),
        files: files.into_iter().collect(),
        history,
        word_counts,
    }
}

/// The user's opening prompts in the project, newest first: Argmax's own
/// chats, plus Claude Code's transcripts for the project's checkouts, which
/// reach back before Argmax and cover work started in a terminal.
fn project_history(
    connection: &Connection,
    project: &ProjectSummary,
    data_dir: Option<&Path>,
) -> Vec<String> {
    let mut dated: Vec<(String, String)> =
        recent_opening_prompts(connection, &project.id, HISTORY_LIMIT as u32).unwrap_or_default();
    let not_history: HashSet<String> = prompts_not_history(connection, &project.id)
        .unwrap_or_default()
        .iter()
        .filter_map(|prompt| clean_opening_prompt(prompt, data_dir))
        .collect();
    let mut checkouts = checkout_paths(connection, &project.id).unwrap_or_default();
    checkouts.push(project.repo_path.clone());
    let home = crate::sync::home_dir();
    let mut transcripts: Vec<(SystemTime, std::path::PathBuf)> = checkouts
        .iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter_map(|checkout| {
            std::fs::read_dir(crate::sync::claude::transcript_dir(&home, checkout)).ok()
        })
        .flat_map(|entries| entries.flatten())
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "jsonl"))
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .collect();
    transcripts.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    for (modified, path) in transcripts.into_iter().take(TRANSCRIPT_LIMIT) {
        if let Some(prompt) = crate::sync::claude::opening_prompt(&path) {
            let started = chrono::DateTime::<chrono::Utc>::from(modified)
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            dated.push((started, prompt));
        }
    }
    dated.sort_by(|left, right| right.0.cmp(&left.0));
    let mut history: Vec<String> = Vec::new();
    for (_, prompt) in dated {
        let Some(cleaned) = clean_opening_prompt(&prompt, data_dir) else {
            continue;
        };
        if not_history.contains(&cleaned) || history.contains(&cleaned) {
            continue;
        }
        history.push(cleaned);
        if history.len() >= HISTORY_LIMIT {
            break;
        }
    }
    history
}

/// The request a person made, or None for text that only opens a chat. An
/// Arc member's prompt is its task after the fixed header paragraph.
fn clean_opening_prompt(raw: &str, data_dir: Option<&Path>) -> Option<String> {
    let mut text = crate::providers::mcp_injection::strip_instruction(raw.trim()).trim();
    if text.starts_with(ARC_HEADER) {
        text = text.split_once("\n\n").map(|(_, task)| task.trim())?;
    }
    let text = match data_dir {
        Some(data_dir) => strip_paths_under(text, data_dir),
        None => text.to_string(),
    };
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let typed = collapsed.chars().count() > 15
        && !NOT_TYPED_PREFIXES
            .iter()
            .any(|prefix| collapsed.starts_with(prefix));
    typed.then_some(collapsed)
}

/// Jev's option for one candidate. `others` are this check's other options:
/// examples that name one of them say nothing about this project, and topic
/// words are the ones this project's history uses more than theirs.
fn criterion_text(candidate: &Candidate, others: &[Candidate]) -> String {
    let profile = &candidate.profile;
    let other_names: Vec<String> = others
        .iter()
        .filter(|other| other.project.id != candidate.project.id)
        .flat_map(|other| {
            std::iter::once(other.project.name.to_lowercase())
                .chain(other.profile.naming_components().map(str::to_lowercase))
                .collect::<Vec<_>>()
        })
        .collect();
    let own: Vec<&String> = profile
        .history
        .iter()
        .filter(|prompt| {
            let lowered = prompt.to_lowercase();
            !other_names.iter().any(|name| mentions_word(&lowered, name))
        })
        .collect();
    let mut examples: Vec<String> = Vec::new();
    for prompt in &own {
        let example = truncate_chars(prompt, EXAMPLE_CHARS);
        if !examples.contains(&example) {
            examples.push(example);
        }
        if examples.len() >= PROFILE_EXAMPLES {
            break;
        }
    }
    let others_profiles: Vec<&Profile> = others
        .iter()
        .filter(|other| other.project.id != candidate.project.id)
        .map(|other| other.profile.as_ref())
        .collect();
    let topics = distinctive_words(&own, &others_profiles);
    let components: Vec<String> = profile
        .components
        .iter()
        .map(|(root, names)| format!("{root}: {}", names.join(", ")))
        .collect();
    profile_text(
        &candidate.project.name,
        &profile.description,
        &profile.languages,
        &profile.folders,
        &components,
        &topics,
        &examples,
    )
}

fn profile_text(
    name: &str,
    description: &str,
    languages: &[&str],
    folders: &[String],
    components: &[String],
    topics: &[String],
    examples: &[String],
) -> String {
    let mut parts = vec![format!("The {name} repository.")];
    if !description.is_empty() {
        parts.push(description.to_string());
    }
    if !languages.is_empty() {
        parts.push(format!("Written in {}.", languages.join(", ")));
    }
    if !folders.is_empty() {
        parts.push(format!("Top-level folders: {}.", folders.join(", ")));
    }
    if !components.is_empty() {
        parts.push(format!("Contains {}.", components.join("; ")));
    }
    if !topics.is_empty() {
        parts.push(format!(
            "Topics the user often raises here: {}.",
            topics.join(", ")
        ));
    }
    if !examples.is_empty() {
        parts.push(format!(
            "Requests the user typically makes here: {}",
            examples.join(" | ")
        ));
    }
    parts.join(" ")
}

/// Words `own` (this option's prompts) uses markedly more than the other
/// options' histories: a tf-idf style score over the share of prompts using
/// each word.
fn distinctive_words(own: &[&String], others: &[&Profile]) -> Vec<String> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for prompt in own {
        for word in topic_words(prompt).into_iter().collect::<HashSet<_>>() {
            *counts.entry(word).or_default() += 1;
        }
    }
    let here_total = own.len().max(1) as f64;
    let elsewhere_total = others
        .iter()
        .map(|other| other.history.len())
        .sum::<usize>()
        .max(1) as f64;
    let mut scored: Vec<(f64, String)> = counts
        .into_iter()
        .filter(|(_, count)| *count >= 2 || own.len() <= 5)
        .map(|(word, count)| {
            let here = count as f64 / here_total;
            let elsewhere = others
                .iter()
                .map(|other| other.word_counts.get(&word).copied().unwrap_or(0))
                .sum::<usize>() as f64
                / elsewhere_total;
            (here * ((here + 0.01) / (elsewhere + 0.01)).ln(), word)
        })
        .filter(|(score, _)| *score > 0.0)
        .collect();
    scored.sort_by(|left, right| right.0.total_cmp(&left.0).then(left.1.cmp(&right.1)));
    scored
        .into_iter()
        .take(TOPIC_WORDS)
        .map(|(_, word)| word)
        .collect()
}

/// Lowercase words worth counting: no links, paths, ids or numbers, and none
/// of the words every request uses.
fn topic_words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .filter(|token| !token.contains("://") && !token.contains('/'))
        .flat_map(|token| {
            token.split(|character: char| {
                !(character.is_alphanumeric() || character == '-' || character == '_')
            })
        })
        .map(|word| word.trim_matches(|character| character == '-' || character == '_'))
        .map(str::to_lowercase)
        .filter(|word| {
            word.chars().count() >= 3
                && !word.chars().any(|character| character.is_ascii_digit())
                && !STOP_WORDS.contains(&word.as_str())
        })
        .collect()
}

static STOP_WORDS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    "about above after again all also and any are because been before being below between both but
     can could did does doing down during each few for from further had has have having her here
     hers him his how into its itself just let lets more most not now off once only other our out
     over own same she should some such than that the their them then there these they this those
     through too under until very was were what when where which while who whom why will with would
     you your yours make sure check need want like get see use using new one two way thing things
     look please thanks think good better work working done still really right well give take know
     etc can't don't it's i'm we're that's there's what's add fix update run show tell help try yes
     okay let's also maybe currently seems something anything everything should'nt isn't wasn't
     doesn't didn't"
        .split_whitespace()
        .collect()
});

fn top_languages(files: &[String]) -> Vec<&'static str> {
    let mut counts: HashMap<&'static str, usize> = HashMap::new();
    for file in files {
        let Some((_, extension)) = file.rsplit_once('.') else {
            continue;
        };
        let language = match extension.to_ascii_lowercase().as_str() {
            "rs" => "Rust",
            "ts" | "tsx" => "TypeScript",
            "js" | "mjs" | "cjs" | "jsx" => "JavaScript",
            "py" => "Python",
            "ipynb" => "Jupyter",
            "sql" => "SQL",
            "swift" => "Swift",
            "go" => "Go",
            "sh" | "zsh" | "bash" => "Shell",
            "lua" => "Lua",
            "rb" => "Ruby",
            "java" => "Java",
            "kt" => "Kotlin",
            "css" | "scss" => "CSS",
            "html" => "HTML",
            _ => continue,
        };
        *counts.entry(language).or_default() += 1;
    }
    let mut ranked: Vec<(&'static str, usize)> = counts.into_iter().collect();
    ranked.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.cmp(right.0)));
    ranked
        .into_iter()
        .take(4)
        .map(|(language, _)| language)
        .collect()
}

/// What the repository is, in its own words: the opening prose of the README
/// and of the agent instructions, when they say something different. For a
/// project with no history yet, this is most of what Jev has to go on.
fn describe(repo: &Path) -> String {
    let mut picked: Vec<String> = Vec::new();
    for name in ["README.md", "readme.md", "AGENTS.md", "CLAUDE.md"] {
        let Ok(content) = std::fs::read_to_string(repo.join(name)) else {
            continue;
        };
        let head: String = content.chars().take(8000).collect();
        if let Some(paragraph) = prose_paragraphs(&head).into_iter().next() {
            let opening: String = paragraph.chars().take(50).collect();
            let repeated = picked.iter().any(|other| {
                other.contains(&opening)
                    || paragraph.contains(&other.chars().take(50).collect::<String>())
            });
            if !repeated {
                picked.push(paragraph);
            }
        }
    }
    truncate_chars(&picked.join(" "), DESCRIPTION_CHARS)
}

/// Prose paragraphs outside setup sections: what the project is, not how to
/// install it. Headings, badges, lists, tables and code are skipped.
fn prose_paragraphs(markdown: &str) -> Vec<String> {
    static LINK: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"\[([^\]]*)\]\([^)]*\)").expect("link pattern"));
    static SETUP_HEADING: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)setup|install|contribut|getting started|usage|develop|licen|running|quick ?start|requirements",
        )
        .expect("heading pattern")
    });
    let mut paragraphs = Vec::new();
    let mut heading = "";
    let mut in_code = false;
    for block in markdown.split("\n\n") {
        let block = block.trim();
        let fences = block.matches("```").count();
        if in_code {
            in_code = fences % 2 == 0;
            continue;
        }
        if block.starts_with("```") {
            in_code = fences % 2 == 1;
            continue;
        }
        let mut body = block;
        if block.starts_with('#') {
            let (first, rest) = block.split_once('\n').unwrap_or((block, ""));
            heading = first;
            body = rest.trim();
        }
        if body.is_empty()
            || SETUP_HEADING.is_match(heading)
            || ["<", "!", "[", "|", "---", ">", "@", "- ", "* ", "1."]
                .iter()
                .any(|prefix| body.starts_with(prefix))
        {
            continue;
        }
        let unlinked = LINK.replace_all(body, "$1");
        let text = unlinked
            .chars()
            .filter(|character| !matches!(character, '*' | '_' | '`'))
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if text.chars().count() >= 60 && !text.ends_with(':') {
            paragraphs.push(text);
        }
    }
    paragraphs
}

fn truncate_chars(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(history: &[&str], components: &[(&str, &[&str])], files: usize) -> Profile {
        let history: Vec<String> = history.iter().map(|prompt| prompt.to_string()).collect();
        let mut word_counts = HashMap::new();
        for prompt in &history {
            for word in topic_words(prompt).into_iter().collect::<HashSet<_>>() {
                *word_counts.entry(word).or_default() += 1;
            }
        }
        Profile {
            built_at: Instant::now(),
            description: String::new(),
            languages: Vec::new(),
            folders: Vec::new(),
            components: components
                .iter()
                .map(|(root, names)| {
                    (
                        root.to_string(),
                        names.iter().map(|name| name.to_string()).collect(),
                    )
                })
                .collect(),
            files: (0..files)
                .map(|index| format!("file-{index}.txt"))
                .collect(),
            basenames: HashSet::new(),
            history,
            word_counts,
        }
    }

    fn candidate(id: &str, profile: Profile) -> Candidate {
        Candidate {
            project: ProjectSummary {
                id: id.to_string(),
                name: id.to_string(),
                repo_path: format!("/repos/{id}"),
                current_branch: "main".to_string(),
                default_branch: None,
                settings: crate::persistence::projects::ProjectSettings {
                    worktree_location: String::new(),
                    setup_command: String::new(),
                    check_commands: Vec::new(),
                    archive_on_merge: false,
                },
                branch_template: None,
                counts: crate::persistence::projects::ProjectCounts {
                    active: 0,
                    blocked: 0,
                    failed: 0,
                    review_ready: 0,
                },
                latest_activity_at: None,
            },
            key: id.to_string(),
            profile: Arc::new(profile),
        }
    }

    #[test]
    fn asks_freely_and_switches_only_on_a_sure_answer_backed_by_the_prompt() {
        use ProjectCheckDecision::{None, Suggest, Switch};
        // Too unsure, or the current project still holds real weight.
        assert_eq!(verdict(0.49, 0.0, false, true), None);
        assert_eq!(verdict(0.99, 0.11, true, true), None);
        // Sure enough to ask.
        assert_eq!(verdict(0.50, 0.10, false, true), Suggest);
        // Naming the project lowers the bar to ask, never the bar to switch.
        assert_eq!(verdict(0.35, 0.10, true, true), Suggest);
        assert_eq!(verdict(0.34, 0.0, true, true), None);
        // Sure enough to switch, but the prompt neither names the project nor
        // cites its files: Jev alone never moves a chat.
        assert_eq!(verdict(0.99, 0.0, false, true), Suggest);
        assert_eq!(verdict(0.90, 0.05, true, true), Switch);
        assert_eq!(verdict(0.89, 0.0, true, true), Suggest);
        assert_eq!(verdict(0.95, 0.06, true, true), Suggest);
        // The mode is Suggest, or the user picked the project by hand.
        assert_eq!(verdict(0.99, 0.0, true, false), Suggest);
    }

    fn prepared(
        mode: ProjectCheckMode,
        current: &str,
        other: &str,
        named: bool,
    ) -> (Prepared, HashMap<String, f64>) {
        let mut evidence = HashMap::new();
        if named {
            evidence.insert(
                other.to_string(),
                Evidence {
                    named: Some(other.to_string()),
                    cited: Vec::new(),
                },
            );
        }
        let prepared = Prepared {
            api_key: "test".into(),
            text: format!("work on {other}"),
            current_id: current.into(),
            mode,
            candidates: vec![
                candidate(current, profile(&[], &[], 30)),
                candidate(other, profile(&[], &[], 30)),
            ],
            criteria: Vec::new(),
            evidence,
        };
        let probabilities = HashMap::from([(current.to_string(), 0.02), (other.to_string(), 0.96)]);
        (prepared, probabilities)
    }

    #[test]
    fn an_agent_launch_switches_without_waiting_on_the_dialog() {
        PENDING.lock_or_recover("project check pending").clear();
        let (sure, probabilities) = prepared(ProjectCheckMode::Switch, "argmax", "alfred", true);
        let switched = decide(&sure, &probabilities, false, false);
        assert_eq!(switched.check.decision, ProjectCheckDecision::Switch);
        assert!(switched.check.check_id.is_none());
        assert_eq!(
            switched.record.as_ref().map(|record| record.decision),
            Some("switched")
        );
        assert_eq!(switched.suggested_project_name.as_deref(), Some("alfred"));
        assert!(PENDING.lock_or_recover("project check pending").is_empty());

        let (ask, probabilities) = prepared(ProjectCheckMode::Switch, "argmax", "alfred", false);
        let suggested = decide(&ask, &probabilities, false, false);
        assert_eq!(suggested.check.decision, ProjectCheckDecision::Suggest);
        assert!(suggested.record.is_none());
        assert!(PENDING.lock_or_recover("project check pending").is_empty());

        let held = decide(&sure, &probabilities, false, true);
        assert!(held.check.check_id.is_some());
        assert!(held.record.is_none());
        assert_eq!(PENDING.lock_or_recover("project check pending").len(), 1);
        PENDING.lock_or_recover("project check pending").clear();
    }

    #[test]
    fn strips_argmax_attachment_paths_even_with_spaces_in_the_root() {
        let root = Path::new("/Users/me/Library/Application Support/com.argmax.rs");
        let prompt = "Fix this @/Users/me/Library/Application Support/com.argmax.rs/local-state/attachments/a.png please";
        assert_eq!(strip_paths_under(prompt, root), "Fix this  please");
        assert_eq!(strip_paths_under("no paths here", root), "no paths here");
    }

    #[test]
    fn a_project_name_counts_only_as_a_whole_word() {
        assert!(mentions_word(
            "why is cmd+§ not working in argmax?",
            "argmax"
        ));
        assert!(mentions_word(
            "see mentimeter/dbt-transform/pull/1",
            "dbt-transform"
        ));
        assert!(!mentions_word("the argmax-dev profile", "argmax"));
        assert!(!mentions_word("a hqx build", "hq"));
    }

    #[test]
    fn picks_out_paths_and_file_names_but_not_urls_or_sentences() {
        let tokens = path_tokens(
            "Look at `src/renderer/App.tsx` and LaunchSurface.tsx, not https://example.com/a.md. Done.",
        );
        assert_eq!(tokens, vec!["src/renderer/App.tsx", "LaunchSurface.tsx"]);
        assert!(path_tokens("version 1.2 is out").is_empty());
    }

    #[test]
    fn a_description_is_what_the_project_is_not_how_to_install_it() {
        let readme = "# prefect-dataflows\n\n![badge](x.svg)\n\n## Initial local setup\n\nInstall uv and Docker, then clone the repository and copy the sample env file over.\n\n## About\n\nThe [orchestration](https://x) monorepo for *every* scheduled data flow the team runs.";
        assert_eq!(
            prose_paragraphs(readme),
            vec!["The orchestration monorepo for every scheduled data flow the team runs."]
        );
    }

    #[test]
    fn an_opening_prompt_is_the_request_not_what_argmax_wrapped_around_it() {
        let preamble = crate::providers::mcp_injection::ARGMAX_ROUTING_INSTRUCTION;
        assert_eq!(
            clean_opening_prompt(&format!("{preamble}\n\nIs alfred in a good shape?"), None)
                .as_deref(),
            Some("Is alfred in a good shape?")
        );
        assert_eq!(
            clean_opening_prompt(
                "You are working as part of Arc \"Forecast\". Read BRIEF.md first.\n\ntealeaves: a read-only check of September",
                None
            )
            .as_deref(),
            Some("tealeaves: a read-only check of September")
        );
        for not_typed in [
            "The user is continuing this Argmax chat session. Use the transcript",
            "Project handoff: this chat moved to another checkout",
            "/review this branch please now",
            "short",
        ] {
            assert_eq!(clean_opening_prompt(not_typed, None), None, "{not_typed}");
        }
    }

    #[test]
    fn topic_words_skip_links_paths_ids_and_filler() {
        assert_eq!(
            topic_words("Can you check alfred https://x.com/a in src/app v2 and the rollout-plan?"),
            vec!["alfred", "rollout-plan"]
        );
    }

    #[test]
    fn topics_are_what_sets_a_project_apart_from_the_other_options() {
        let revops = [
            "Review alfred in slack",
            "Is alfred broken in slack?",
            "Fix the experiment loop",
        ]
        .map(String::from);
        let own: Vec<&String> = revops.iter().collect();
        // Every argmax prompt mentions slack too, so slack sets nothing apart.
        let argmax = profile(
            &["Fix the sidebar in slack", "The sidebar in slack flickers"],
            &[],
            100,
        );
        let topics = distinctive_words(&own, &[&argmax]);
        assert_eq!(topics.first().map(String::as_str), Some("alfred"));
        assert!(!topics.iter().any(|word| word == "slack"), "{topics:?}");
    }

    #[test]
    fn an_app_name_counts_as_naming_the_monorepo_that_holds_it() {
        let candidates = [
            candidate("argmax", profile(&[], &[], 100)),
            candidate(
                "revops-backoffice",
                profile(
                    &[],
                    &[
                        ("applications", &["alfred", "backoffice"]),
                        ("packages", &["tools"]),
                    ],
                    100,
                ),
            ),
        ];
        let text = "Is alfred in a good shape? Check the tools.";
        let evidence = gather_evidence(text, &text.to_lowercase(), &candidates);
        assert_eq!(
            evidence["revops-backoffice"].named.as_deref(),
            Some("alfred")
        );
        assert!(!evidence.contains_key("argmax"));
    }

    #[test]
    fn a_stub_named_after_another_projects_app_is_not_an_option() {
        let mut candidates = vec![
            candidate("argmax", profile(&[], &[], 100)),
            candidate(
                "revops-backoffice",
                profile(&[], &[("applications", &["alfred"])], 900),
            ),
            candidate("alfred", profile(&[], &[], 3)),
        ];
        drop_stubs(&mut candidates, "argmax");
        let ids: Vec<&str> = candidates.iter().map(|c| c.project.id.as_str()).collect();
        assert_eq!(ids, ["argmax", "revops-backoffice"]);

        // The current project always stays, stub or not.
        let mut from_the_stub = vec![
            candidate("alfred", profile(&[], &[], 3)),
            candidate(
                "revops-backoffice",
                profile(&[], &[("applications", &["alfred"])], 900),
            ),
        ];
        drop_stubs(&mut from_the_stub, "alfred");
        assert_eq!(from_the_stub.len(), 2);
    }

    #[test]
    fn an_option_leaves_out_examples_that_name_another_option() {
        let argmax = candidate(
            "argmax",
            profile(
                &["Is alfred in a good shape?", "Fix the composer focus"],
                &[],
                100,
            ),
        );
        let revops = candidate(
            "revops-backoffice",
            profile(&[], &[("applications", &["alfred"])], 100),
        );
        let text = criterion_text(&argmax, &[argmax_clone(&argmax), revops]);
        assert!(text.contains("Fix the composer focus"), "{text}");
        // Neither as an example nor as a topic word.
        assert!(!text.contains("alfred"), "{text}");
        assert!(!text.contains("shape"), "{text}");
    }

    fn argmax_clone(candidate: &Candidate) -> Candidate {
        Candidate {
            project: candidate.project.clone(),
            key: candidate.key.clone(),
            profile: candidate.profile.clone(),
        }
    }

    #[test]
    fn candidates_are_the_most_used_projects_after_the_current_one() {
        let make = |id: &str| candidate(id, profile(&[], &[], 10)).project;
        let projects = [make("current"), make("recent"), make("busy"), make("idle")];
        let usage = HashMap::from([("busy".to_string(), 40), ("recent".to_string(), 2)]);
        let chosen = choose_candidates(&projects[0], &projects, &usage, "a prompt");
        let ids: Vec<&str> = chosen.iter().map(|project| project.id.as_str()).collect();
        assert_eq!(ids, ["current", "busy", "recent", "idle"]);
    }

    #[test]
    fn duplicate_or_reserved_names_get_distinct_keys() {
        let mut used = HashSet::new();
        assert_eq!(unique_key("brain", &mut used), "brain");
        assert_eq!(unique_key("brain", &mut used), "brain (2)");
        assert_eq!(unique_key("none", &mut used), "none project");
    }
}
