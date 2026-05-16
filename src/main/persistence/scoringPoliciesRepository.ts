import type Database from "better-sqlite3";
import { RecordNotFoundError } from "./errors.js";
import { safeJsonParse } from "../../shared/safeJson.js";
import type {
  AutoKeepRule,
  CriterionId,
  PolicyCriterion,
  ScoringPolicy
} from "../../shared/types.js";

interface ScoringPolicyRow {
  id: string;
  name: string;
  scope: "user" | "project";
  project_id: string | null;
  is_built_in: 0 | 1;
  criteria_json: string;
  auto_keep_rule_json: string;
  ties_threshold: number;
  created_at: string;
  updated_at: string;
}

export interface SavePolicyInput {
  id: string;
  name: string;
  scope: "user" | "project";
  projectId: string | null;
  criteria: PolicyCriterion[];
  autoKeepRule: AutoKeepRule;
  tiesThreshold: number;
}

const VALID_CRITERION_IDS: ReadonlySet<CriterionId> = new Set<CriterionId>([
  "tests-pass",
  "lint-clean",
  "typecheck-clean",
  "diff-size-lines",
  "files-touched",
  "wall-clock-seconds",
  "cost-usd"
]);

export class BuiltInPolicyMutationError extends Error {
  constructor(policyId: string) {
    super(`Built-in scoring policy '${policyId}' cannot be modified or deleted`);
    this.name = "BuiltInPolicyMutationError";
  }
}

export class InvalidPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPolicyError";
  }
}

function rowToPolicy(row: ScoringPolicyRow): ScoringPolicy {
  const criteriaParsed = safeJsonParse(row.criteria_json, "scoring_policies.criteria_json");
  const criteria = Array.isArray(criteriaParsed)
    ? criteriaParsed.filter(
        (c): c is PolicyCriterion =>
          typeof c === "object" &&
          c !== null &&
          typeof (c as { id?: unknown }).id === "string" &&
          typeof (c as { weight?: unknown }).weight === "number"
      )
    : [];
  const autoKeepParsed = safeJsonParse(row.auto_keep_rule_json, "scoring_policies.auto_keep_rule_json");
  const autoKeepRule: AutoKeepRule =
    autoKeepParsed && typeof autoKeepParsed === "object" ? autoKeepParsed : {};

  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    projectId: row.project_id,
    isBuiltIn: row.is_built_in === 1,
    criteria,
    autoKeepRule,
    tiesThreshold: row.ties_threshold,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function validatePolicy(input: SavePolicyInput): void {
  if (input.criteria.length === 0) {
    throw new InvalidPolicyError("Policy must have at least one criterion");
  }
  let weightSum = 0;
  for (const criterion of input.criteria) {
    if (!VALID_CRITERION_IDS.has(criterion.id)) {
      throw new InvalidPolicyError(`Unknown criterion id: ${criterion.id}`);
    }
    if (!Number.isFinite(criterion.weight) || criterion.weight < 0) {
      throw new InvalidPolicyError(`Criterion '${criterion.id}' weight must be a non-negative finite number`);
    }
    weightSum += criterion.weight;
  }
  if (weightSum <= 0) {
    throw new InvalidPolicyError("Sum of criterion weights must be positive");
  }
  if (input.scope === "project" && !input.projectId) {
    throw new InvalidPolicyError("Project-scoped policy requires projectId");
  }
  if (input.scope === "user" && input.projectId) {
    throw new InvalidPolicyError("User-scoped policy must not carry a projectId");
  }
  if (!Number.isFinite(input.tiesThreshold) || input.tiesThreshold < 0 || input.tiesThreshold > 1) {
    throw new InvalidPolicyError("tiesThreshold must be in [0, 1]");
  }
}

export function findScoringPolicyById(
  connection: Database.Database,
  policyId: string
): ScoringPolicy {
  const row = connection
    .prepare("SELECT * FROM scoring_policies WHERE id = ?")
    .get(policyId) as ScoringPolicyRow | undefined;
  if (!row) {
    throw new RecordNotFoundError("scoring_policy", policyId);
  }
  return rowToPolicy(row);
}

export function listScoringPolicies(
  connection: Database.Database,
  options?: { projectId?: string }
): ScoringPolicy[] {
  // Surfaces user-scope + (optional) the project-scope policies for a project.
  // Project-scope shadowing-by-name is handled by the orchestrator at launch
  // time; this read returns both so the editor UI can show them as a flat list.
  const rows = options?.projectId
    ? (connection
        .prepare(
          `SELECT * FROM scoring_policies
           WHERE scope = 'user' OR (scope = 'project' AND project_id = ?)
           ORDER BY is_built_in DESC, name ASC`
        )
        .all(options.projectId) as ScoringPolicyRow[])
    : (connection
        .prepare(
          `SELECT * FROM scoring_policies WHERE scope = 'user'
           ORDER BY is_built_in DESC, name ASC`
        )
        .all() as ScoringPolicyRow[]);
  return rows.map(rowToPolicy);
}

export function saveScoringPolicy(
  connection: Database.Database,
  input: SavePolicyInput
): ScoringPolicy {
  validatePolicy(input);

  const existing = connection
    .prepare("SELECT is_built_in FROM scoring_policies WHERE id = ?")
    .get(input.id) as { is_built_in: 0 | 1 } | undefined;
  if (existing && existing.is_built_in === 1) {
    throw new BuiltInPolicyMutationError(input.id);
  }

  const now = new Date().toISOString();
  const criteriaJson = JSON.stringify(input.criteria);
  const autoKeepJson = JSON.stringify(input.autoKeepRule ?? {});

  if (existing) {
    connection
      .prepare(
        `UPDATE scoring_policies
         SET name = @name,
             scope = @scope,
             project_id = @projectId,
             criteria_json = @criteriaJson,
             auto_keep_rule_json = @autoKeepJson,
             ties_threshold = @tiesThreshold,
             updated_at = @now
         WHERE id = @id`
      )
      .run({
        id: input.id,
        name: input.name,
        scope: input.scope,
        projectId: input.projectId,
        criteriaJson,
        autoKeepJson,
        tiesThreshold: input.tiesThreshold,
        now
      });
  } else {
    connection
      .prepare(
        `INSERT INTO scoring_policies (
           id, name, scope, project_id, is_built_in,
           criteria_json, auto_keep_rule_json, ties_threshold,
           created_at, updated_at
         ) VALUES (
           @id, @name, @scope, @projectId, 0,
           @criteriaJson, @autoKeepJson, @tiesThreshold,
           @now, @now
         )`
      )
      .run({
        id: input.id,
        name: input.name,
        scope: input.scope,
        projectId: input.projectId,
        criteriaJson,
        autoKeepJson,
        tiesThreshold: input.tiesThreshold,
        now
      });
  }

  return findScoringPolicyById(connection, input.id);
}

export function deleteScoringPolicy(connection: Database.Database, policyId: string): void {
  const existing = connection
    .prepare("SELECT is_built_in FROM scoring_policies WHERE id = ?")
    .get(policyId) as { is_built_in: 0 | 1 } | undefined;
  if (!existing) {
    throw new RecordNotFoundError("scoring_policy", policyId);
  }
  if (existing.is_built_in === 1) {
    throw new BuiltInPolicyMutationError(policyId);
  }
  connection.prepare("DELETE FROM scoring_policies WHERE id = ?").run(policyId);
}
