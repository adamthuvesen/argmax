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

#[derive(Debug, Clone, PartialEq)]
pub struct Classification {
    pub kind: TaskKind,
    pub kind_confidence: f64,
    /// Expected level on the 0 (trivial) – 4 (very hard) scale.
    pub difficulty_score: f64,
    pub difficulty_confidence: f64,
    /// Jev's probability for each level 0–4, when it sent them.
    pub level_probabilities: Option<[f64; 5]>,
    /// Probability the message reports a wrong previous answer; only asked
    /// for follow-ups.
    pub correction: Option<f64>,
}

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
}

pub async fn classify(
    prompt: &str,
    api_key: &str,
    ask_correction: bool,
) -> ArgmaxResult<Classification> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .connect_timeout(JEV_TIMEOUT)
        .timeout(JEV_TIMEOUT)
        .redirect(Policy::none())
        .retry(reqwest::retry::never())
        .user_agent("argmax")
        .build()
        .map_err(|error| jev_error(format!("could not configure the request: {error}")))?;
    let response = client
        .post(JEV_URL)
        .bearer_auth(api_key)
        .json(&request_body(prompt, ask_correction))
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
    let body: Value = response
        .json()
        .await
        .map_err(|error| jev_error(format!("unreadable response: {error}")))?;
    parse_response(&body)
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
    });
    if ask_correction {
        questions["correction"] =
            json!({ "type": "noul", "instructions": CORRECTION_INSTRUCTIONS });
    }
    json!({ "model": JEV_MODEL, "state": state, "questions": questions })
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
        kind_confidence: kind_answer.confidence.unwrap_or(0.0),
        difficulty_score,
        difficulty_confidence: difficulty_answer.confidence.unwrap_or(0.0),
        level_probabilities: difficulty_answer.probabilities.as_ref().map(|by_level| {
            std::array::from_fn(|level| by_level.get(&level.to_string()).copied().unwrap_or(0.0))
        }),
        correction: parsed
            .answers
            .get("correction")
            .and_then(|answer| answer.noul),
    })
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
                "correction": { "type": "noul", "noul": 0.81 }
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
    fn asks_for_a_correction_only_when_requested() {
        assert!(request_body("fix it", false)["questions"]
            .get("correction")
            .is_none());
        assert_eq!(
            request_body("fix it", true)["questions"]["correction"]["type"],
            "noul"
        );
    }
}
