use std::collections::HashMap;

use rusqlite::{Connection, Row};
use serde::Serialize;

use super::prepared::prepared;
use super::scoring_policies::ScoringPolicy;
use super::time::now_iso;
use crate::error::{ArgmaxError, ArgmaxResult};

#[derive(Debug, Clone, PartialEq)]
pub struct CreateTournamentInput {
    pub id: String,
    pub project_id: String,
    pub task_label: String,
    pub prompt: String,
    pub quorum: i64,
    pub policy_snapshot: ScoringPolicy,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ContestantConfig {
    pub provider: String,
    pub model_id: String,
    pub model_label: String,
    pub reasoning_effort: Option<String>,
    pub config: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CreateContestantInput {
    pub tournament_id: String,
    pub contestant_index: i64,
    pub session_id: String,
    pub config: ContestantConfig,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PersistScoreInput {
    pub tournament_id: String,
    pub contestant_index: i64,
    pub criterion_id: String,
    pub status: String,
    pub raw_value: Option<f64>,
    pub normalized_value: Option<f64>,
    pub evidence: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ListTournamentsOptions {
    pub project_id: Option<String>,
    pub state: Option<String>,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tournament {
    pub id: String,
    pub project_id: String,
    pub task_label: String,
    pub prompt: String,
    pub state: String,
    pub quorum: i64,
    pub policy_id: Option<String>,
    pub policy_snapshot: serde_json::Value,
    pub verdict: Option<serde_json::Value>,
    pub decision: Option<serde_json::Value>,
    pub created_at: String,
    pub updated_at: String,
    pub decided_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TournamentContestant {
    pub tournament_id: String,
    pub contestant_index: i64,
    pub session_id: String,
    pub provider: String,
    pub model_id: String,
    pub model_label: String,
    pub reasoning_effort: Option<String>,
    pub config: serde_json::Value,
    pub outcome: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CriterionScore {
    pub tournament_id: String,
    pub contestant_index: i64,
    pub criterion_id: String,
    pub status: String,
    pub raw_value: Option<f64>,
    pub normalized_value: Option<f64>,
    pub evidence: serde_json::Value,
    pub scored_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TournamentLeaderboardRow {
    pub contestant: TournamentContestant,
    pub scores: Vec<CriterionScore>,
    pub total: Option<f64>,
    pub rank: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TournamentLeaderboard {
    pub tournament: Tournament,
    pub rows: Vec<TournamentLeaderboardRow>,
    pub verdict: Option<serde_json::Value>,
}

pub fn create_tournament(
    connection: &Connection,
    input: &CreateTournamentInput,
) -> ArgmaxResult<Tournament> {
    if input.quorum < 1 {
        return Err(ArgmaxError::service(
            "INVALID_TOURNAMENT",
            "Tournament quorum must be at least 1",
        ));
    }
    let now = now_iso();
    let snapshot_json = serde_json::to_string(&input.policy_snapshot).map_err(json_error)?;
    let mut statement = prepared(
        connection,
        r#"
        INSERT INTO tournaments (
          id, project_id, task_label, prompt, state, quorum,
          policy_id, policy_snapshot_json,
          verdict_json, decision_json,
          created_at, updated_at, decided_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, ?, ?, NULL)
        "#,
    )
    .map_err(sqlite_error)?;
    statement
        .execute((
            input.id.as_str(),
            input.project_id.as_str(),
            input.task_label.as_str(),
            input.prompt.as_str(),
            input.quorum,
            input.policy_snapshot.id.as_str(),
            snapshot_json.as_str(),
            now.as_str(),
            now.as_str(),
        ))
        .map_err(sqlite_error)?;
    find_tournament_by_id(connection, &input.id)
}

pub fn find_tournament_by_id(
    connection: &Connection,
    tournament_id: &str,
) -> ArgmaxResult<Tournament> {
    let mut statement =
        prepared(connection, "SELECT * FROM tournaments WHERE id = ?").map_err(sqlite_error)?;
    match statement.query_row([tournament_id], row_to_tournament) {
        Ok(tournament) => Ok(tournament),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(ArgmaxError::record_not_found("tournament", tournament_id))
        }
        Err(error) => Err(sqlite_error(error)),
    }
}

pub fn list_tournaments(
    connection: &Connection,
    options: &ListTournamentsOptions,
) -> ArgmaxResult<Vec<Tournament>> {
    let rows = match (&options.project_id, &options.state) {
        (Some(project_id), Some(state)) => {
            let mut statement = prepared(
                connection,
                "SELECT * FROM tournaments WHERE project_id = ? AND state = ? ORDER BY created_at DESC LIMIT ?",
            )
            .map_err(sqlite_error)?;
            let rows = statement
                .query_map(
                    (project_id.as_str(), state.as_str(), options.limit as i64),
                    row_to_tournament,
                )
                .map_err(sqlite_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_error)?;
            rows
        }
        (Some(project_id), None) => {
            let mut statement = prepared(
                connection,
                "SELECT * FROM tournaments WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
            )
            .map_err(sqlite_error)?;
            let rows = statement
                .query_map(
                    (project_id.as_str(), options.limit as i64),
                    row_to_tournament,
                )
                .map_err(sqlite_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_error)?;
            rows
        }
        (None, Some(state)) => {
            let mut statement = prepared(
                connection,
                "SELECT * FROM tournaments WHERE state = ? ORDER BY created_at DESC LIMIT ?",
            )
            .map_err(sqlite_error)?;
            let rows = statement
                .query_map((state.as_str(), options.limit as i64), row_to_tournament)
                .map_err(sqlite_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_error)?;
            rows
        }
        (None, None) => {
            let mut statement = prepared(
                connection,
                "SELECT * FROM tournaments ORDER BY created_at DESC LIMIT ?",
            )
            .map_err(sqlite_error)?;
            let rows = statement
                .query_map([options.limit as i64], row_to_tournament)
                .map_err(sqlite_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_error)?;
            rows
        }
    };
    Ok(rows)
}

pub fn update_tournament_state(
    connection: &Connection,
    tournament_id: &str,
    state: &str,
) -> ArgmaxResult<Tournament> {
    let mut statement = prepared(
        connection,
        "UPDATE tournaments SET state = ?, updated_at = ? WHERE id = ?",
    )
    .map_err(sqlite_error)?;
    let changes = statement
        .execute((state, now_iso(), tournament_id))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("tournament", tournament_id));
    }
    find_tournament_by_id(connection, tournament_id)
}

pub fn transition_tournament_state(
    connection: &Connection,
    tournament_id: &str,
    expected_from: &str,
    to: &str,
) -> ArgmaxResult<Option<Tournament>> {
    let mut statement = prepared(
        connection,
        "UPDATE tournaments SET state = ?, updated_at = ? WHERE id = ? AND state = ?",
    )
    .map_err(sqlite_error)?;
    let changes = statement
        .execute((to, now_iso(), tournament_id, expected_from))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Ok(None);
    }
    find_tournament_by_id(connection, tournament_id).map(Some)
}

pub fn set_tournament_verdict(
    connection: &Connection,
    tournament_id: &str,
    verdict: &serde_json::Value,
) -> ArgmaxResult<Tournament> {
    let verdict_json = serde_json::to_string(verdict).map_err(json_error)?;
    let mut statement = prepared(
        connection,
        "UPDATE tournaments SET verdict_json = ?, updated_at = ? WHERE id = ?",
    )
    .map_err(sqlite_error)?;
    let changes = statement
        .execute((verdict_json, now_iso(), tournament_id))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("tournament", tournament_id));
    }
    find_tournament_by_id(connection, tournament_id)
}

pub fn set_tournament_decision(
    connection: &Connection,
    tournament_id: &str,
    decision: &serde_json::Value,
) -> ArgmaxResult<Tournament> {
    let decision_json = serde_json::to_string(decision).map_err(json_error)?;
    let now = now_iso();
    let mut statement = prepared(
        connection,
        r#"
        UPDATE tournaments
        SET decision_json = ?, state = 'decided', decided_at = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .map_err(sqlite_error)?;
    let changes = statement
        .execute((decision_json, now.as_str(), now.as_str(), tournament_id))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found("tournament", tournament_id));
    }
    find_tournament_by_id(connection, tournament_id)
}

pub fn create_contestant(
    connection: &Connection,
    input: &CreateContestantInput,
) -> ArgmaxResult<TournamentContestant> {
    let now = now_iso();
    let config_json = serde_json::to_string(&input.config.config).map_err(json_error)?;
    let mut statement = prepared(
        connection,
        r#"
        INSERT INTO tournament_contestants (
          tournament_id, contestant_index, session_id,
          provider, model_id, model_label, reasoning_effort,
          config_json, outcome, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        "#,
    )
    .map_err(sqlite_error)?;
    statement
        .execute((
            input.tournament_id.as_str(),
            input.contestant_index,
            input.session_id.as_str(),
            input.config.provider.as_str(),
            input.config.model_id.as_str(),
            input.config.model_label.as_str(),
            input.config.reasoning_effort.as_deref(),
            config_json.as_str(),
            now.as_str(),
        ))
        .map_err(sqlite_error)?;
    let mut session_statement = prepared(
        connection,
        "UPDATE sessions SET tournament_id = ?, contestant_index = ? WHERE id = ?",
    )
    .map_err(sqlite_error)?;
    session_statement
        .execute((
            input.tournament_id.as_str(),
            input.contestant_index,
            input.session_id.as_str(),
        ))
        .map_err(sqlite_error)?;
    find_contestant_by_session(connection, &input.session_id)
}

pub fn find_contestant_by_session(
    connection: &Connection,
    session_id: &str,
) -> ArgmaxResult<TournamentContestant> {
    let mut statement = prepared(
        connection,
        "SELECT * FROM tournament_contestants WHERE session_id = ?",
    )
    .map_err(sqlite_error)?;
    match statement.query_row([session_id], row_to_contestant) {
        Ok(contestant) => Ok(contestant),
        Err(rusqlite::Error::QueryReturnedNoRows) => Err(ArgmaxError::record_not_found(
            "tournament_contestant",
            session_id,
        )),
        Err(error) => Err(sqlite_error(error)),
    }
}

pub fn list_contestants_by_tournament(
    connection: &Connection,
    tournament_id: &str,
) -> ArgmaxResult<Vec<TournamentContestant>> {
    let mut statement = prepared(
        connection,
        r#"
        SELECT * FROM tournament_contestants
        WHERE tournament_id = ?
        ORDER BY contestant_index ASC
        "#,
    )
    .map_err(sqlite_error)?;
    let rows = statement
        .query_map([tournament_id], row_to_contestant)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

pub fn update_contestant_outcome(
    connection: &Connection,
    tournament_id: &str,
    contestant_index: i64,
    outcome: &str,
) -> ArgmaxResult<()> {
    let mut statement = prepared(
        connection,
        r#"
        UPDATE tournament_contestants
        SET outcome = ?
        WHERE tournament_id = ? AND contestant_index = ?
        "#,
    )
    .map_err(sqlite_error)?;
    let changes = statement
        .execute((outcome, tournament_id, contestant_index))
        .map_err(sqlite_error)?;
    if changes == 0 {
        return Err(ArgmaxError::record_not_found(
            "tournament_contestant",
            format!("{tournament_id}#{contestant_index}"),
        ));
    }
    Ok(())
}

pub fn persist_criterion_score(
    connection: &Connection,
    input: &PersistScoreInput,
) -> ArgmaxResult<CriterionScore> {
    let scored_at = now_iso();
    let evidence_json = serde_json::to_string(&input.evidence).map_err(json_error)?;
    let mut statement = prepared(
        connection,
        r#"
        INSERT INTO tournament_scores (
          tournament_id, contestant_index, criterion_id,
          status, raw_value, normalized_value, evidence_json, scored_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tournament_id, contestant_index, criterion_id)
        DO UPDATE SET
          status = excluded.status,
          raw_value = excluded.raw_value,
          normalized_value = excluded.normalized_value,
          evidence_json = excluded.evidence_json,
          scored_at = excluded.scored_at
        "#,
    )
    .map_err(sqlite_error)?;
    statement
        .execute((
            input.tournament_id.as_str(),
            input.contestant_index,
            input.criterion_id.as_str(),
            input.status.as_str(),
            input.raw_value,
            input.normalized_value,
            evidence_json.as_str(),
            scored_at.as_str(),
        ))
        .map_err(sqlite_error)?;

    find_score(connection, input)
}

pub fn list_scores_by_tournament(
    connection: &Connection,
    tournament_id: &str,
) -> ArgmaxResult<Vec<CriterionScore>> {
    let mut statement = prepared(
        connection,
        "SELECT * FROM tournament_scores WHERE tournament_id = ?",
    )
    .map_err(sqlite_error)?;
    let rows = statement
        .query_map([tournament_id], row_to_score)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sqlite_error)?;
    Ok(rows)
}

pub fn read_tournament_leaderboard(
    connection: &Connection,
    tournament_id: &str,
) -> ArgmaxResult<TournamentLeaderboard> {
    let tournament = find_tournament_by_id(connection, tournament_id)?;
    let contestants = list_contestants_by_tournament(connection, tournament_id)?;
    let scores = list_scores_by_tournament(connection, tournament_id)?;

    let mut scores_by_contestant: HashMap<i64, Vec<CriterionScore>> = HashMap::new();
    for score in scores {
        scores_by_contestant
            .entry(score.contestant_index)
            .or_default()
            .push(score);
    }

    let totals = tournament
        .verdict
        .as_ref()
        .and_then(|verdict| verdict.get("totals"))
        .and_then(|totals| totals.as_array())
        .cloned()
        .unwrap_or_default();
    let mut totals_by_contestant = HashMap::new();
    let mut ordered_totals = Vec::new();
    for entry in totals {
        if let (Some(index), Some(total)) = (
            entry
                .get("contestantIndex")
                .and_then(|value| value.as_i64()),
            entry.get("total").and_then(|value| value.as_f64()),
        ) {
            totals_by_contestant.insert(index, total);
            ordered_totals.push((index, total));
        }
    }
    ordered_totals.sort_by(|left, right| right.1.total_cmp(&left.1));
    let rank_by_contestant: HashMap<i64, i64> = ordered_totals
        .into_iter()
        .enumerate()
        .map(|(index, (contestant_index, _))| (contestant_index, index as i64 + 1))
        .collect();

    let rows = contestants
        .into_iter()
        .map(|contestant| TournamentLeaderboardRow {
            total: totals_by_contestant
                .get(&contestant.contestant_index)
                .copied(),
            rank: rank_by_contestant
                .get(&contestant.contestant_index)
                .copied(),
            scores: scores_by_contestant
                .remove(&contestant.contestant_index)
                .unwrap_or_default(),
            contestant,
        })
        .collect();

    Ok(TournamentLeaderboard {
        verdict: tournament.verdict.clone(),
        tournament,
        rows,
    })
}

pub fn load_policy_snapshot(
    connection: &Connection,
    tournament_id: &str,
) -> ArgmaxResult<serde_json::Value> {
    find_tournament_by_id(connection, tournament_id).map(|tournament| tournament.policy_snapshot)
}

fn find_score(connection: &Connection, input: &PersistScoreInput) -> ArgmaxResult<CriterionScore> {
    let mut statement = prepared(
        connection,
        r#"
        SELECT * FROM tournament_scores
        WHERE tournament_id = ? AND contestant_index = ? AND criterion_id = ?
        "#,
    )
    .map_err(sqlite_error)?;
    statement
        .query_row(
            (
                input.tournament_id.as_str(),
                input.contestant_index,
                input.criterion_id.as_str(),
            ),
            row_to_score,
        )
        .map_err(sqlite_error)
}

fn row_to_tournament(row: &Row<'_>) -> rusqlite::Result<Tournament> {
    Ok(Tournament {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        task_label: row.get("task_label")?,
        prompt: row.get("prompt")?,
        state: row.get("state")?,
        quorum: row.get("quorum")?,
        policy_id: row.get("policy_id")?,
        policy_snapshot: parse_json(row.get("policy_snapshot_json")?),
        verdict: optional_json(row.get("verdict_json")?),
        decision: optional_json(row.get("decision_json")?),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        decided_at: row.get("decided_at")?,
    })
}

fn row_to_contestant(row: &Row<'_>) -> rusqlite::Result<TournamentContestant> {
    Ok(TournamentContestant {
        tournament_id: row.get("tournament_id")?,
        contestant_index: row.get("contestant_index")?,
        session_id: row.get("session_id")?,
        provider: row.get("provider")?,
        model_id: row.get("model_id")?,
        model_label: row.get("model_label")?,
        reasoning_effort: row.get("reasoning_effort")?,
        config: parse_json(row.get("config_json")?),
        outcome: row.get("outcome")?,
        created_at: row.get("created_at")?,
    })
}

fn row_to_score(row: &Row<'_>) -> rusqlite::Result<CriterionScore> {
    Ok(CriterionScore {
        tournament_id: row.get("tournament_id")?,
        contestant_index: row.get("contestant_index")?,
        criterion_id: row.get("criterion_id")?,
        status: row.get("status")?,
        raw_value: row.get("raw_value")?,
        normalized_value: row.get("normalized_value")?,
        evidence: parse_json(row.get("evidence_json")?),
        scored_at: row.get("scored_at")?,
    })
}

fn parse_json(value: String) -> serde_json::Value {
    serde_json::from_str(&value).unwrap_or_else(|_| serde_json::json!({}))
}

fn optional_json(value: Option<String>) -> Option<serde_json::Value> {
    value.map(parse_json)
}

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}

fn json_error(error: serde_json::Error) -> ArgmaxError {
    ArgmaxError::service("JSON", error.to_string())
}
