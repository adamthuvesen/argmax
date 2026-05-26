use rusqlite::{Connection, Row};
use serde::{Deserialize, Serialize};

use super::prepared::prepared;
use super::time::now_iso;
use crate::error::{ArgmaxError, ArgmaxResult};

const VALID_CRITERION_IDS: &[&str] = &[
    "tests-pass",
    "lint-clean",
    "typecheck-clean",
    "diff-size-lines",
    "files-touched",
    "wall-clock-seconds",
    "cost-usd",
];

#[derive(Debug, Clone, PartialEq)]
pub struct SavePolicyInput {
    pub id: String,
    pub name: String,
    pub scope: String,
    pub project_id: Option<String>,
    pub criteria: Vec<PolicyCriterion>,
    pub auto_keep_rule: serde_json::Value,
    pub ties_threshold: f64,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyCriterion {
    pub id: String,
    pub weight: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoringPolicy {
    pub id: String,
    pub name: String,
    pub scope: String,
    pub project_id: Option<String>,
    pub is_built_in: bool,
    pub criteria: Vec<PolicyCriterion>,
    pub auto_keep_rule: serde_json::Value,
    pub ties_threshold: f64,
    pub created_at: String,
    pub updated_at: String,
}

pub fn find_scoring_policy_by_id(
    connection: &Connection,
    policy_id: &str,
) -> ArgmaxResult<ScoringPolicy> {
    let mut statement = prepared(connection, "SELECT * FROM scoring_policies WHERE id = ?")
        .map_err(sqlite_error)?;
    match statement.query_row([policy_id], row_to_policy) {
        Ok(policy) => Ok(policy),
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            Err(ArgmaxError::record_not_found("scoring_policy", policy_id))
        }
        Err(error) => Err(sqlite_error(error)),
    }
}

pub fn list_scoring_policies(
    connection: &Connection,
    project_id: Option<&str>,
) -> ArgmaxResult<Vec<ScoringPolicy>> {
    let rows = if let Some(project_id) = project_id {
        let mut statement = prepared(
            connection,
            r#"
            SELECT * FROM scoring_policies
            WHERE scope = 'user' OR (scope = 'project' AND project_id = ?)
            ORDER BY is_built_in DESC, name ASC
            "#,
        )
        .map_err(sqlite_error)?;
        let rows = statement
            .query_map([project_id], row_to_policy)
            .map_err(sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_error)?;
        rows
    } else {
        let mut statement = prepared(
            connection,
            "SELECT * FROM scoring_policies WHERE scope = 'user' ORDER BY is_built_in DESC, name ASC",
        )
        .map_err(sqlite_error)?;
        let rows = statement
            .query_map([], row_to_policy)
            .map_err(sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_error)?;
        rows
    };
    Ok(rows)
}

pub fn save_scoring_policy(
    connection: &Connection,
    input: &SavePolicyInput,
) -> ArgmaxResult<ScoringPolicy> {
    validate_policy(input)?;
    let existing = policy_is_built_in(connection, &input.id)?;
    if existing == Some(true) {
        return Err(built_in_error(&input.id));
    }

    let now = now_iso();
    let criteria_json = serde_json::to_string(&input.criteria).map_err(json_error)?;
    let auto_keep_json = serde_json::to_string(&input.auto_keep_rule).map_err(json_error)?;

    if existing.is_some() {
        let mut statement = prepared(
            connection,
            r#"
            UPDATE scoring_policies
            SET name = ?, scope = ?, project_id = ?, criteria_json = ?,
                auto_keep_rule_json = ?, ties_threshold = ?, updated_at = ?
            WHERE id = ?
            "#,
        )
        .map_err(sqlite_error)?;
        statement
            .execute((
                input.name.as_str(),
                input.scope.as_str(),
                input.project_id.as_deref(),
                criteria_json.as_str(),
                auto_keep_json.as_str(),
                input.ties_threshold,
                now.as_str(),
                input.id.as_str(),
            ))
            .map_err(sqlite_error)?;
    } else {
        let mut statement = prepared(
            connection,
            r#"
            INSERT INTO scoring_policies (
              id, name, scope, project_id, is_built_in,
              criteria_json, auto_keep_rule_json, ties_threshold,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
            "#,
        )
        .map_err(sqlite_error)?;
        statement
            .execute((
                input.id.as_str(),
                input.name.as_str(),
                input.scope.as_str(),
                input.project_id.as_deref(),
                criteria_json.as_str(),
                auto_keep_json.as_str(),
                input.ties_threshold,
                now.as_str(),
                now.as_str(),
            ))
            .map_err(sqlite_error)?;
    }

    find_scoring_policy_by_id(connection, &input.id)
}

pub fn delete_scoring_policy(connection: &Connection, policy_id: &str) -> ArgmaxResult<()> {
    match policy_is_built_in(connection, policy_id)? {
        Some(true) => Err(built_in_error(policy_id)),
        Some(false) => {
            let mut statement = prepared(connection, "DELETE FROM scoring_policies WHERE id = ?")
                .map_err(sqlite_error)?;
            statement.execute([policy_id]).map_err(sqlite_error)?;
            Ok(())
        }
        None => Err(ArgmaxError::record_not_found("scoring_policy", policy_id)),
    }
}

fn row_to_policy(row: &Row<'_>) -> rusqlite::Result<ScoringPolicy> {
    let criteria_json: String = row.get("criteria_json")?;
    let auto_keep_rule_json: String = row.get("auto_keep_rule_json")?;
    Ok(ScoringPolicy {
        id: row.get("id")?,
        name: row.get("name")?,
        scope: row.get("scope")?,
        project_id: row.get("project_id")?,
        is_built_in: row.get::<_, i64>("is_built_in")? == 1,
        criteria: serde_json::from_str(&criteria_json).unwrap_or_default(),
        auto_keep_rule: serde_json::from_str(&auto_keep_rule_json)
            .unwrap_or_else(|_| serde_json::json!({})),
        ties_threshold: row.get("ties_threshold")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn policy_is_built_in(connection: &Connection, policy_id: &str) -> ArgmaxResult<Option<bool>> {
    let mut statement = prepared(
        connection,
        "SELECT is_built_in FROM scoring_policies WHERE id = ?",
    )
    .map_err(sqlite_error)?;
    match statement.query_row([policy_id], |row| row.get::<_, i64>("is_built_in")) {
        Ok(value) => Ok(Some(value == 1)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(sqlite_error(error)),
    }
}

fn validate_policy(input: &SavePolicyInput) -> ArgmaxResult<()> {
    if input.criteria.is_empty() {
        return Err(invalid_policy("Policy must have at least one criterion"));
    }
    let mut weight_sum = 0.0;
    for criterion in &input.criteria {
        if !VALID_CRITERION_IDS.contains(&criterion.id.as_str()) {
            return Err(invalid_policy(format!(
                "Unknown criterion id: {}",
                criterion.id
            )));
        }
        if !criterion.weight.is_finite() || criterion.weight < 0.0 {
            return Err(invalid_policy(format!(
                "Criterion '{}' weight must be a non-negative finite number",
                criterion.id
            )));
        }
        weight_sum += criterion.weight;
    }
    if weight_sum <= 0.0 {
        return Err(invalid_policy("Sum of criterion weights must be positive"));
    }
    if input.scope == "project" && input.project_id.is_none() {
        return Err(invalid_policy("Project-scoped policy requires projectId"));
    }
    if input.scope == "user" && input.project_id.is_some() {
        return Err(invalid_policy(
            "User-scoped policy must not carry a projectId",
        ));
    }
    if !input.ties_threshold.is_finite() || !(0.0..=1.0).contains(&input.ties_threshold) {
        return Err(invalid_policy("tiesThreshold must be in [0, 1]"));
    }
    Ok(())
}

fn invalid_policy(message: impl Into<String>) -> ArgmaxError {
    ArgmaxError::service("INVALID_POLICY", message)
}

fn built_in_error(policy_id: &str) -> ArgmaxError {
    ArgmaxError::service(
        "BUILT_IN_POLICY_MUTATION",
        format!("Built-in scoring policy '{policy_id}' cannot be modified or deleted"),
    )
}

fn sqlite_error(error: rusqlite::Error) -> ArgmaxError {
    ArgmaxError::service("SQLITE", error.to_string())
}

fn json_error(error: serde_json::Error) -> ArgmaxError {
    ArgmaxError::service("JSON", error.to_string())
}
