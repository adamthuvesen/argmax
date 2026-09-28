// TypeSafe Jev client. Jev answers typed questions about a piece of text
// (the "state") with calibrated probabilities instead of generated prose: a
// Choice for the task kind, a Score for difficulty, and optionally a Noul for
// "the user says the previous answer was wrong". Measured on 100 real opening
// prompts: 86% kind agreement at confidence >= 0.5 (96% on clear-cut prompts)
// after the 2026-09-27 description pass, p90 0.38 s warm.

use std::{collections::HashMap, time::Duration};

use reqwest::redirect::Policy;
use serde::Deserialize;
use serde_json::{json, Value};

use super::context::FollowUpContext;
use super::table::{Difficulty, TaskKind};
use crate::error::{ArgmaxError, ArgmaxResult};

const JEV_URL: &str = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL: &str = "jev-latest";
/// Routing must never hold up a launch for long; past this the caller falls back.
pub const JEV_TIMEOUT: Duration = Duration::from_millis(1500);
/// Jev reads the state whole; a pasted log or diff past this adds latency
/// without changing what kind of task it is.
const MAX_STATE_CHARS: usize = 8000;

const KIND_INSTRUCTIONS: &str =
    "Which kind of work does this request to a coding agent mainly ask for?";
const KIND_CRITERIA: [(&str, &str); 5] = [
    (
        "coding",
        "Build, change, or fix software: implement a feature, fix a bug or failing test, debug unexpected behavior, refactor, or design or restyle a UI. Needs judgment about behavior and results in code edits.",
    ),
    (
        "mechanical",
        "Routine operations that need little judgment: rename or move things, bulk find-and-replace, formatting, change a setting, theme, version or config value, add or remove a tool, dependency or integration, run a command or tool and report what it prints, small copy or text tweaks, commit, push, or other git housekeeping.",
    ),
    (
        "research",
        "Investigate or gather information rather than change code: search the web or docs, compare tools or options, benchmark, explore how a system or dataset works, query data, or write up findings in a report.",
    ),
    (
        "review",
        "Review or audit existing work: code review of a diff, branch, or pull request, look for bugs or risks, verify that a change is correct, or give feedback on a plan, proposal or draft the user shares (\"what do you think of this?\").",
    ),
    (
        "question",
        "Answer a direct question, give an opinion, or discuss an idea conversationally, without changing code and without a multi-step investigation.",
    ),
];
const DIFFICULTY_INSTRUCTIONS: &str =
    "How much effort and reasoning will this request take a strong coding agent?";
const DIFFICULTY_CRITERIA: [&str; 5] = [
    "Trivial: a one-line change, a single command, or a one-sentence answer.",
    "Easy: a small, well-specified change in one place, or a short answer that needs a quick look.",
    "Moderate: a few files or steps with some judgment; a typical task of under an hour.",
    "Hard: a cross-cutting change, an unclear root cause, or a design decision with real trade-offs.",
    "Very hard: a large multi-part project, a deep investigation, or new architecture spanning many subsystems.",
];
/// Worded so a preference, an idea or a new request stays low: measured on
/// 2026-09-27, failure reports, "let's redo this", "start over" and "this is
/// ugly" scored 0.90–0.97; preferences and new requests 0.16 or less.
const CORRECTION_INSTRUCTIONS: &str = "The user is unhappy with the agent's previous work: it is failing or wrong (the change broke something or does not work, tests or the bug still fail, the answer is incorrect, the agent keeps making the same mistake), the user dislikes the result (for example it looks ugly or bad), or the user wants it redone or thrown away and started over. Asking for an alternative, stating a preference, suggesting an idea, asking a follow-up question or requesting a new change does not count.";
const SCOPE_INSTRUCTIONS: &str = "How does the NEW USER REQUEST relate to earlier visible user tasks? Judge the whole upcoming workflow, including invoked skill instructions. A continuation such as 'continue' or 'implement that' inherits the relevant earlier task. Returning to an earlier hard task after a simple interlude is a continuation of that hard task.";
const SCOPE_CRITERIA: [(&str, &str); 3] = [
    ("continuation", "Continue or resume earlier substantive work, including a return to an earlier task after an interlude."),
    ("new_task", "A clearly independent new task with its own goal."),
    ("finishing_step", "A bounded final step of earlier work whose remaining scope is explicitly clear."),
];
const SIMPLER_INSTRUCTIONS: &str = "Is the ENTIRE upcoming task clearly simpler and safe for less model capability than the relevant earlier work? Include every step of invoked skills, external reviews, CI feedback, repairs, and repeated checks. Multi-step alone does not make a task hard, but unresolved difficult repairs do. Do not answer yes for ambiguous references, missing or truncated skill instructions, an uncertain continuation, or a return to an earlier hard task after a simple interlude. An independent, clearly easy task can answer yes even if earlier work was hard.";
/// Measured on 16 real prompts (2026-09-28): colour, contrast, spacing and
/// separator requests scored 0.89–0.98; git, docs, tests, questions and
/// renames 0.22 or less; a label-copy tweak 0.60, below the 0.7 cut.
const UI_INSTRUCTIONS: &str = "Is this request mainly about how software looks: visual UI or design work such as layout, styling, colors, contrast, spacing, typography, animation, icons, theming, or the look and feel of a screen or component? Backend logic, data, tooling, docs, git work and questions about behavior do not count.";
/// At or above this, the task is UI or design work.
const UI_THRESHOLD: f64 = 0.7;
const RESUME_INSTRUCTIONS: &str = "Only when the NEW USER REQUEST clearly continues or returns to the exact earlier user task attached to a labeled route, choose that R label. A similar kind of work is not enough. Prefer none when the link is unclear, the route's user task is unavailable, or the request is independent.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FollowUpScope {
    Continuation,
    NewTask,
    FinishingStep,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Classification {
    pub kind: TaskKind,
    pub kind_confidence: f64,
    /// Jev's probability for each kind, in `TASK_KINDS` order, when it sent them.
    pub kind_probabilities: Option<[f64; 5]>,
    /// Expected level on the 0 (trivial) – 4 (very hard) scale.
    pub difficulty_score: f64,
    pub difficulty_confidence: f64,
    /// Jev's probability for each level 0–4, when it sent them.
    pub level_probabilities: Option<[f64; 5]>,
    /// Probability the message reports a wrong previous answer; only asked
    /// for follow-ups.
    pub correction: Option<f64>,
    pub follow_up_scope: Option<FollowUpScope>,
    pub scope_confidence: Option<f64>,
    /// Jev's probability that the complete upcoming workflow clearly needs
    /// less capability than the relevant prior task.
    pub simpler_task: Option<f64>,
    pub resume_route: Option<String>,
    pub resume_confidence: Option<f64>,
    /// Probability the task is mainly visual UI or design work.
    pub ui: Option<f64>,
}

/// The order of `Classification::kind_probabilities`.
pub const TASK_KINDS: [TaskKind; 5] = [
    TaskKind::Coding,
    TaskKind::Mechanical,
    TaskKind::Research,
    TaskKind::Review,
    TaskKind::Question,
];

impl Classification {
    /// Trivial/easy → Light, moderate → Standard, hard/very hard → Heavy.
    pub fn difficulty(&self) -> Difficulty {
        match self.difficulty_score.round() as i64 {
            i64::MIN..=1 => Difficulty::Light,
            2 => Difficulty::Standard,
            _ => Difficulty::Heavy,
        }
    }

    /// How likely the task sits at `level` or harder on the 0–4 scale.
    pub fn probability_at_least(&self, level: usize) -> Option<f64> {
        self.level_probabilities
            .map(|probabilities| probabilities[level.min(4)..].iter().sum())
    }

    /// How likely the task needs at least `difficulty`: Jev's weight on that
    /// bucket's lowest level or harder. Jev's confidence in its exact 0–4
    /// score answers a narrower question and stands in only when it sent no
    /// level probabilities.
    pub fn probability_at_least_bucket(&self, difficulty: Difficulty) -> f64 {
        match difficulty {
            Difficulty::Light => return 1.0,
            Difficulty::Standard => self.probability_at_least(2),
            Difficulty::Heavy => self.probability_at_least(3),
        }
        .unwrap_or(self.difficulty_confidence)
    }

    /// How likely the task needs no more than `difficulty`.
    pub fn probability_at_most_bucket(&self, difficulty: Difficulty) -> f64 {
        match difficulty {
            Difficulty::Light => self.probability_at_least(2),
            Difficulty::Standard => self.probability_at_least(3),
            Difficulty::Heavy => return 1.0,
        }
        .map_or(self.difficulty_confidence, |harder| 1.0 - harder)
    }

    pub fn kind_probability(&self, kind: TaskKind) -> Option<f64> {
        let index = TASK_KINDS.iter().position(|candidate| *candidate == kind)?;
        self.kind_probabilities
            .map(|probabilities| probabilities[index])
    }

    pub fn is_ui(&self) -> bool {
        self.ui.is_some_and(|ui| ui >= UI_THRESHOLD)
    }

    /// Every signal Jev answered, stored on the route row so thresholds can
    /// be tuned from real decisions.
    pub fn signals_json(&self) -> String {
        json!({
            "kind": self.kind_probabilities.map(|probabilities| {
                TASK_KINDS.iter().zip(probabilities).map(|(kind, probability)| {
                    (super::kind_label(*kind).to_string(), Value::from(probability))
                }).collect::<serde_json::Map<String, Value>>()
            }),
            "kindConfidence": self.kind_confidence,
            "difficultyScore": self.difficulty_score,
            "difficultyConfidence": self.difficulty_confidence,
            "levels": self.level_probabilities,
            "correction": self.correction,
            "scope": self.follow_up_scope.map(|scope| match scope {
                FollowUpScope::Continuation => "continuation",
                FollowUpScope::NewTask => "new_task",
                FollowUpScope::FinishingStep => "finishing_step",
            }),
            "scopeConfidence": self.scope_confidence,
            "simpler": self.simpler_task,
            "resume": self.resume_route,
            "resumeConfidence": self.resume_confidence,
            "ui": self.ui,
        })
        .to_string()
    }
}

pub async fn classify(
    prompt: &str,
    api_key: &str,
    ask_correction: bool,
) -> ArgmaxResult<Classification> {
    parse_response(&post(&request_body(prompt, ask_correction), api_key, JEV_TIMEOUT).await?)
}

pub async fn classify_follow_up(
    context: &FollowUpContext,
    api_key: &str,
) -> ArgmaxResult<Classification> {
    parse_response(&post(&follow_up_request_body(context), api_key, JEV_TIMEOUT).await?)
}

/// One Choice question over caller-described options: Jev's probability for
/// each option key. Project check asks which project a prompt belongs to; its
/// options are long, so it brings its own timeout.
pub async fn classify_choice(
    text: &str,
    instructions: &str,
    criteria: &[(String, String)],
    api_key: &str,
    timeout: Duration,
) -> ArgmaxResult<HashMap<String, f64>> {
    let body = post(
        &choice_request_body(text, instructions, criteria),
        api_key,
        timeout,
    )
    .await?;
    parse_choice(&body)
}

async fn post(body: &Value, api_key: &str, timeout: Duration) -> ArgmaxResult<Value> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .connect_timeout(timeout)
        .timeout(timeout)
        .redirect(Policy::none())
        .retry(reqwest::retry::never())
        .user_agent("argmax")
        .build()
        .map_err(|error| jev_error(format!("could not configure the request: {error}")))?;
    let response = client
        .post(JEV_URL)
        .bearer_auth(api_key)
        .json(body)
        .send()
        .await
        .map_err(|error| jev_error(format!("request failed: {error}")))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(ArgmaxError::service(
            "ROUTING_KEY_INVALID",
            "Jev rejected the API key. Check it in Settings → Agents.",
        ));
    }
    if !status.is_success() {
        return Err(jev_error(format!("returned HTTP {status}")));
    }
    response
        .json()
        .await
        .map_err(|error| jev_error(format!("unreadable response: {error}")))
}

fn choice_request_body(text: &str, instructions: &str, criteria: &[(String, String)]) -> Value {
    let state: String = text.chars().take(MAX_STATE_CHARS).collect();
    let criteria: serde_json::Map<String, Value> = criteria
        .iter()
        .map(|(key, description)| (key.clone(), Value::from(description.as_str())))
        .collect();
    json!({
        "model": JEV_MODEL,
        "state": state,
        "questions": {
            "choice": { "type": "choice", "instructions": instructions, "criteria": criteria },
        },
    })
}

fn parse_choice(body: &Value) -> ArgmaxResult<HashMap<String, f64>> {
    let parsed: Answers = serde_json::from_value(body.clone())
        .map_err(|error| jev_error(format!("unexpected response shape: {error}")))?;
    parsed
        .answers
        .get("choice")
        .and_then(|answer| answer.probabilities.clone())
        .filter(|probabilities| !probabilities.is_empty())
        .ok_or_else(|| jev_error("choice answer has no probabilities"))
}

fn request_body(prompt: &str, ask_correction: bool) -> Value {
    let state: String = prompt.chars().take(MAX_STATE_CHARS).collect();
    let kinds: serde_json::Map<String, Value> = KIND_CRITERIA
        .iter()
        .map(|(key, text)| (key.to_string(), Value::from(*text)))
        .collect();
    let mut questions = json!({
        "kind": { "type": "choice", "instructions": KIND_INSTRUCTIONS, "criteria": kinds },
        "difficulty": { "type": "score", "instructions": DIFFICULTY_INSTRUCTIONS, "criteria": DIFFICULTY_CRITERIA },
        "ui": { "type": "noul", "instructions": UI_INSTRUCTIONS },
    });
    if ask_correction {
        questions["correction"] =
            json!({ "type": "noul", "instructions": CORRECTION_INSTRUCTIONS });
    }
    json!({ "model": JEV_MODEL, "state": state, "questions": questions })
}

fn follow_up_request_body(context: &FollowUpContext) -> Value {
    let mut body = request_body(&context.state, true);
    body["questions"]["correction"]["instructions"] = json!("Judge ONLY the NEW USER REQUEST: does it say the previous agent work is failing, wrong, disliked, or needs redoing? Old complaints quoted in visible history or skill instructions are context, not a new correction.");
    body["questions"]["kind"]["instructions"] = json!("Classify the entire next turn described by NEW USER REQUEST, including any invoked skill workflow and likely review, verification, and repair. A ship skill may involve more than a git command.");
    body["questions"]["difficulty"]["instructions"] = json!("How much effort and reasoning will the complete next turn need, including the invoked workflow and relevant unresolved prior work? Judge the new request first. A short finishing step need not inherit every token of a long debugging turn.");
    body["questions"]["ui"]["instructions"] = json!(format!(
        "Judge the complete next turn described by NEW USER REQUEST. {UI_INSTRUCTIONS}"
    ));
    body["questions"]["scope"] = json!({
        "type": "choice", "instructions": SCOPE_INSTRUCTIONS,
        "criteria": SCOPE_CRITERIA.iter().map(|(key, value)| ((*key).to_string(), Value::from(*value))).collect::<serde_json::Map<String, Value>>()
    });
    body["questions"]["simpler"] = json!({ "type": "noul", "instructions": SIMPLER_INSTRUCTIONS });
    if !context.routes.is_empty() {
        let mut criteria = serde_json::Map::new();
        criteria.insert(
            "none".to_string(),
            Value::from("No clear continuation of one labeled earlier user task."),
        );
        for route in &context.routes {
            if route.user_task.is_some() {
                criteria.insert(
                    route.id.clone(),
                    Value::from(format!(
                        "Continue the exact earlier user task marked {} in the state.",
                        route.id
                    )),
                );
            }
        }
        if criteria.len() > 1 {
            body["questions"]["resume"] = json!({
                "type": "choice", "instructions": RESUME_INSTRUCTIONS, "criteria": criteria
            });
        }
    }
    body
}

#[derive(Debug, Deserialize)]
struct Answers {
    answers: HashMap<String, Answer>,
}

#[derive(Debug, Deserialize)]
struct Answer {
    choice: Option<String>,
    score: Option<f64>,
    noul: Option<f64>,
    confidence: Option<f64>,
    probabilities: Option<HashMap<String, f64>>,
}

fn parse_response(body: &Value) -> ArgmaxResult<Classification> {
    let parsed: Answers = serde_json::from_value(body.clone())
        .map_err(|error| jev_error(format!("unexpected response shape: {error}")))?;
    let kind_answer = parsed
        .answers
        .get("kind")
        .ok_or_else(|| jev_error("response has no kind answer"))?;
    let kind = match kind_answer.choice.as_deref() {
        Some("coding") => TaskKind::Coding,
        Some("mechanical") => TaskKind::Mechanical,
        Some("research") => TaskKind::Research,
        Some("review") => TaskKind::Review,
        Some("question") => TaskKind::Question,
        other => return Err(jev_error(format!("unknown kind {other:?}"))),
    };
    let difficulty_answer = parsed
        .answers
        .get("difficulty")
        .ok_or_else(|| jev_error("response has no difficulty answer"))?;
    let difficulty_score = difficulty_answer
        .score
        .filter(|score| score.is_finite())
        .ok_or_else(|| jev_error("difficulty answer has no score"))?;
    Ok(Classification {
        kind,
        kind_confidence: kind_answer
            .confidence
            .and_then(valid_probability)
            .unwrap_or(0.0),
        kind_probabilities: kind_answer.probabilities.as_ref().map(|by_kind| {
            TASK_KINDS.map(|kind| {
                by_kind
                    .get(super::kind_label(kind))
                    .copied()
                    .and_then(valid_probability)
                    .unwrap_or(0.0)
            })
        }),
        difficulty_score,
        difficulty_confidence: difficulty_answer
            .confidence
            .and_then(valid_probability)
            .unwrap_or(0.0),
        level_probabilities: difficulty_answer.probabilities.as_ref().map(|by_level| {
            std::array::from_fn(|level| {
                by_level
                    .get(&level.to_string())
                    .copied()
                    .and_then(valid_probability)
                    .unwrap_or(0.0)
            })
        }),
        correction: parsed
            .answers
            .get("correction")
            .and_then(|answer| answer.noul.and_then(valid_probability)),
        follow_up_scope: parsed.answers.get("scope").and_then(|answer| {
            match answer.choice.as_deref() {
                Some("continuation") => Some(FollowUpScope::Continuation),
                Some("new_task") => Some(FollowUpScope::NewTask),
                Some("finishing_step") => Some(FollowUpScope::FinishingStep),
                _ => None,
            }
        }),
        scope_confidence: parsed
            .answers
            .get("scope")
            .and_then(|answer| answer.confidence.and_then(valid_probability)),
        simpler_task: parsed
            .answers
            .get("simpler")
            .and_then(|answer| answer.noul.and_then(valid_probability)),
        resume_route: parsed
            .answers
            .get("resume")
            .and_then(|answer| answer.choice.as_deref())
            .filter(|route| {
                route.starts_with('R')
                    && route.len() > 1
                    && route[1..].chars().all(|c| c.is_ascii_digit())
            })
            .map(str::to_string),
        resume_confidence: parsed
            .answers
            .get("resume")
            .and_then(|answer| answer.confidence.and_then(valid_probability)),
        ui: parsed
            .answers
            .get("ui")
            .and_then(|answer| answer.noul.and_then(valid_probability)),
    })
}

fn valid_probability(value: f64) -> Option<f64> {
    (value.is_finite() && (0.0..=1.0).contains(&value)).then_some(value)
}

fn jev_error(detail: impl std::fmt::Display) -> ArgmaxError {
    ArgmaxError::service("ROUTING_JEV_FAILED", format!("Jev {detail}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shape captured from a live jev-1.13.0 call on 2026-09-27.
    fn live_shaped_response(kind: &str, score: f64) -> Value {
        json!({
            "model": "jev-1.13.0",
            "answers": {
                "kind": { "type": "choice", "choice": kind, "confidence": 0.93,
                          "probabilities": { "coding": 0.96, "question": 0.04 } },
                "difficulty": { "type": "score", "score": score, "confidence": 0.64,
                                "legend": { "0": "trivial" }, "probabilities": { "0": 0.23 } },
                "correction": { "type": "noul", "noul": 0.81 },
                "ui": { "type": "noul", "noul": 0.93 }
            },
            "usage": { "input_tokens": 382, "output_tokens": 61 }
        })
    }

    #[test]
    fn parses_a_live_shaped_response() {
        let parsed = parse_response(&live_shaped_response("review", 2.4)).expect("parses");
        assert_eq!(parsed.kind, TaskKind::Review);
        assert_eq!(parsed.kind_confidence, 0.93);
        assert_eq!(parsed.difficulty(), Difficulty::Standard);
        assert_eq!(parsed.correction, Some(0.81));
        assert_eq!(parsed.probability_at_least(0), Some(0.23));
        assert_eq!(parsed.probability_at_least(1), Some(0.0));
        assert_eq!(parsed.kind_probability(TaskKind::Coding), Some(0.96));
        assert_eq!(parsed.kind_probability(TaskKind::Review), Some(0.0));
        assert!(parsed.is_ui());
    }

    #[test]
    fn buckets_read_the_level_weights_not_the_score_confidence() {
        let mut parsed = parse_response(&live_shaped_response("coding", 2.6)).expect("parses");
        parsed.difficulty_confidence = 0.45;
        parsed.level_probabilities = Some([0.0, 0.05, 0.3, 0.5, 0.15]);
        assert!((parsed.probability_at_least_bucket(Difficulty::Heavy) - 0.65).abs() < 1e-9);
        assert!((parsed.probability_at_least_bucket(Difficulty::Standard) - 0.95).abs() < 1e-9);
        assert!((parsed.probability_at_most_bucket(Difficulty::Standard) - 0.35).abs() < 1e-9);
        assert_eq!(parsed.probability_at_most_bucket(Difficulty::Heavy), 1.0);
        parsed.level_probabilities = None;
        assert_eq!(parsed.probability_at_least_bucket(Difficulty::Heavy), 0.45);
    }

    #[test]
    fn difficulty_score_folds_into_three_buckets() {
        for (score, expected) in [
            (0.0, Difficulty::Light),
            (1.49, Difficulty::Light),
            (1.5, Difficulty::Standard),
            (2.49, Difficulty::Standard),
            (2.5, Difficulty::Heavy),
            (4.0, Difficulty::Heavy),
        ] {
            let parsed = parse_response(&live_shaped_response("coding", score)).expect("parses");
            assert_eq!(parsed.difficulty(), expected, "score {score}");
        }
    }

    #[test]
    fn rejects_an_unknown_kind_loudly() {
        let error = parse_response(&live_shaped_response("poetry", 1.0)).expect_err("rejects");
        assert!(error.to_string().contains("unknown kind"), "{error}");
    }

    #[test]
    fn reads_choice_probabilities_by_option_key() {
        let body = json!({
            "answers": { "choice": { "type": "choice", "choice": "dbt-transform", "confidence": 1.0,
                                     "probabilities": { "dbt-transform": 0.97, "none": 0.02, "argmax": 0.01 } } }
        });
        let probabilities = parse_choice(&body).expect("parses");
        assert_eq!(probabilities.get("dbt-transform"), Some(&0.97));
        assert_eq!(probabilities.len(), 3);
        assert!(parse_choice(&json!({ "answers": { "choice": { "choice": "x" } } })).is_err());
    }

    #[test]
    fn asks_for_a_correction_only_when_requested() {
        assert!(request_body("fix it", false)["questions"]
            .get("correction")
            .is_none());
        assert_eq!(
            request_body("fix it", true)["questions"]["correction"]["type"],
            "noul"
        );
    }

    #[test]
    fn follow_up_asks_about_entire_scope_and_parses_reduction_evidence() {
        let context = FollowUpContext {
            state: "NEW USER REQUEST: ship this\nSkill ship: Review CI and repair failures"
                .to_string(),
            downgrade_safe: true,
            routes: vec![super::super::context::ContextRoute {
                id: "R0".to_string(),
                provider: crate::ipc::validation::ProviderId::Codex,
                model_id: "gpt-6-astra".to_string(),
                effort: Some(crate::ipc::validation::ReasoningEffort::Xhigh),
                user_task: Some("Investigate the hard bug".to_string()),
            }],
        };
        let body = follow_up_request_body(&context);
        assert_eq!(body["questions"]["scope"]["type"], "choice");
        assert_eq!(body["questions"]["simpler"]["type"], "noul");
        assert_eq!(
            body["questions"]["resume"]["criteria"]["R0"].as_str(),
            Some("Continue the exact earlier user task marked R0 in the state.")
        );
        assert!(body["state"].as_str().unwrap().contains("Review CI"));

        let mut response = live_shaped_response("coding", 3.0);
        response["answers"]["scope"] = json!({"choice": "continuation", "confidence": 0.91});
        response["answers"]["simpler"] = json!({"noul": 0.03});
        response["answers"]["resume"] = json!({"choice": "R0", "confidence": 0.96});
        let parsed = parse_response(&response).unwrap();
        assert_eq!(parsed.follow_up_scope, Some(FollowUpScope::Continuation));
        assert_eq!(parsed.scope_confidence, Some(0.91));
        assert_eq!(parsed.simpler_task, Some(0.03));
        assert_eq!(parsed.resume_route.as_deref(), Some("R0"));
        assert_eq!(parsed.resume_confidence, Some(0.96));
    }

    #[test]
    fn invalid_follow_up_probabilities_cannot_justify_a_switch() {
        let mut response = live_shaped_response("coding", 1.0);
        response["answers"]["scope"] = json!({"choice": "new_task", "confidence": 1.1});
        response["answers"]["simpler"] = json!({"noul": -0.1});
        response["answers"]["resume"] = json!({"choice": "R0", "confidence": 0.0});
        let parsed = parse_response(&response).unwrap();
        assert_eq!(parsed.scope_confidence, None);
        assert_eq!(parsed.simpler_task, None);
    }
}
