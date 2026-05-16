import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type JSX
} from "react";
import type {
  ContestantConfig,
  CriterionScore,
  ProjectSummary,
  ScoringPolicy,
  Tournament,
  TournamentLeaderboard,
  TournamentLaunchInput
} from "../../shared/types.js";
import { PROVIDER_MODEL_DEFAULTS } from "../../shared/providerModels.js";

interface TournamentPanelProps {
  project: ProjectSummary;
  /** xterm-style sizing forwarded to provider PTYs. Match what the launcher uses. */
  cols?: number;
  rows?: number;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const POLL_INTERVAL_MS = 2000;

function defaultContestants(): ContestantConfig[] {
  // Two-row default: one Claude, one Codex. The user can add up to 8 contestants.
  const claudeDefault = PROVIDER_MODEL_DEFAULTS.claude;
  const codexDefault = PROVIDER_MODEL_DEFAULTS.codex;
  return [
    {
      provider: "claude",
      modelId: claudeDefault.modelId,
      modelLabel: claudeDefault.label
    },
    {
      provider: "codex",
      modelId: codexDefault.modelId,
      modelLabel: codexDefault.label,
      ...(codexDefault.reasoningEffort ? { reasoningEffort: codexDefault.reasoningEffort } : {})
    }
  ];
}

function statusLabel(state: Tournament["state"]): string {
  switch (state) {
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "judging":
      return "Judging";
    case "awaiting-decision":
      return "Awaiting decision";
    case "decided":
      return "Decided";
    case "cancelled":
      return "Cancelled";
    default:
      return state;
  }
}

function formatTotal(total: number | null): string {
  if (total === null) return "—";
  return total.toFixed(2);
}

function formatRaw(score: CriterionScore | undefined): string {
  if (!score || score.status === "inconclusive") return "—";
  if (score.status === "disqualified") return "DQ";
  if (score.rawValue === null) return "—";
  if (Number.isInteger(score.rawValue)) return String(score.rawValue);
  return score.rawValue.toFixed(2);
}

export function TournamentPanel({
  project,
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS
}: TournamentPanelProps): JSX.Element {
  const [policies, setPolicies] = useState<ScoringPolicy[]>([]);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [selectedTournamentId, setSelectedTournamentId] = useState<string | null>(null);
  const [leaderboard, setLeaderboard] = useState<TournamentLeaderboard | null>(null);
  const [taskLabel, setTaskLabel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [policyId, setPolicyId] = useState<string>("builtin:correctness-first");
  const [contestants, setContestants] = useState<ContestantConfig[]>(defaultContestants());
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [keeping, setKeeping] = useState(false);

  const refreshList = useCallback(async () => {
    const list = await window.argmax!.tournaments.list({ projectId: project.id });
    setTournaments(list);
  }, [project.id]);

  useEffect(() => {
    void window.argmax!.scoring.listPolicies().then(setPolicies);
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    if (!selectedTournamentId) {
      setLeaderboard(null);
      return;
    }
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const board = await window.argmax!.tournaments.get({ tournamentId: selectedTournamentId });
        if (!cancelled) setLeaderboard(board);
      } catch {
        // Silent — the tournament row may have been mid-write; the next tick
        // will retry. Surfacing every transient error would spam the panel.
      }
    };
    void tick();
    const interval = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [selectedTournamentId]);

  const onAddContestant = (): void => {
    if (contestants.length >= 8) return;
    const next = defaultContestants()[0];
    if (!next) return;
    setContestants((current) => [...current, next]);
  };
  const onRemoveContestant = (index: number): void => {
    setContestants((current) => current.filter((_, i) => i !== index));
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (launching) return;
    if (contestants.length < 2) {
      setLaunchError("Tournament needs at least two contestants.");
      return;
    }
    setLaunchError(null);
    setLaunching(true);
    try {
      const input: TournamentLaunchInput = {
        projectId: project.id,
        taskLabel: taskLabel.trim() || "Untitled tournament",
        prompt: prompt.trim(),
        policyId,
        contestants,
        cols,
        rows
      };
      const tournament = await window.argmax!.tournaments.launch(input);
      await refreshList();
      setSelectedTournamentId(tournament.id);
      setTaskLabel("");
      setPrompt("");
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : String(error));
    } finally {
      setLaunching(false);
    }
  };

  const onKeep = async (contestantIndex: number): Promise<void> => {
    if (!selectedTournamentId || keeping) return;
    setKeeping(true);
    try {
      const board = await window.argmax!.tournaments.keep({
        tournamentId: selectedTournamentId,
        contestantIndex
      });
      setLeaderboard(board);
      await refreshList();
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : String(error));
    } finally {
      setKeeping(false);
    }
  };

  const sortedRows = useMemo(() => {
    if (!leaderboard) return [];
    return [...leaderboard.rows].sort((a, b) => {
      const ra = a.rank ?? Number.POSITIVE_INFINITY;
      const rb = b.rank ?? Number.POSITIVE_INFINITY;
      return ra - rb;
    });
  }, [leaderboard]);

  const criterionIds = useMemo(
    () => leaderboard?.tournament.policySnapshot.criteria.map((c) => c.id) ?? [],
    [leaderboard]
  );

  return (
    <section className="tournament-panel" aria-labelledby="tournament-panel-h">
      <header>
        <h2 id="tournament-panel-h">Tournaments</h2>
        <p className="tournament-panel-subtitle">
          Run the same task across multiple agents in parallel worktrees, then
          let the judge rank them.
        </p>
      </header>

      <form className="tournament-launch" onSubmit={(event) => void onSubmit(event)}>
        <div className="tournament-field">
          <label htmlFor="tournament-task-label">Task label</label>
          <input
            id="tournament-task-label"
            type="text"
            value={taskLabel}
            onChange={(event) => setTaskLabel(event.target.value)}
            placeholder="Add hello() function"
            aria-label="Task label"
          />
        </div>

        <div className="tournament-field">
          <label htmlFor="tournament-prompt">Prompt</label>
          <textarea
            id="tournament-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Add a hello() function in src/lib that returns the string 'hello'. Add a passing test."
            rows={3}
            aria-label="Prompt"
          />
        </div>

        <div className="tournament-field">
          <label htmlFor="tournament-policy">Scoring policy</label>
          <select
            id="tournament-policy"
            value={policyId}
            onChange={(event) => setPolicyId(event.target.value)}
            aria-label="Scoring policy"
          >
            {policies.map((policy) => (
              <option key={policy.id} value={policy.id}>
                {policy.name}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="tournament-contestants">
          <legend>Contestants</legend>
          {contestants.map((contestant, index) => (
            <div key={index} className="tournament-contestant-row">
              <span>#{index + 1}</span>
              <select
                value={contestant.provider}
                onChange={(event) =>
                  setContestants((current) =>
                    current.map((c, i) => {
                      if (i !== index) return c;
                      const provider = event.target.value as ContestantConfig["provider"];
                      const def = PROVIDER_MODEL_DEFAULTS[provider];
                      return {
                        provider,
                        modelId: def.modelId,
                        modelLabel: def.label,
                        ...(def.reasoningEffort ? { reasoningEffort: def.reasoningEffort } : {})
                      };
                    })
                  )
                }
                aria-label={`Contestant ${index + 1} provider`}
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
                <option value="cursor">Cursor</option>
              </select>
              <span className="tournament-model-label">{contestant.modelLabel}</span>
              <button
                type="button"
                onClick={() => onRemoveContestant(index)}
                disabled={contestants.length <= 2}
                aria-label={`Remove contestant ${index + 1}`}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={onAddContestant}
            disabled={contestants.length >= 8}
            aria-label="Add contestant"
          >
            Add contestant
          </button>
        </fieldset>

        {launchError ? (
          <p className="tournament-error" role="alert">
            {launchError}
          </p>
        ) : null}

        <button type="submit" disabled={launching || prompt.trim().length === 0} aria-label="Launch tournament">
          {launching ? "Launching…" : "Launch tournament"}
        </button>
      </form>

      <div className="tournament-list" aria-label="Tournaments for this project">
        <h3>Recent tournaments</h3>
        {tournaments.length === 0 ? (
          <p>No tournaments yet.</p>
        ) : (
          <ul>
            {tournaments.map((tournament) => (
              <li key={tournament.id}>
                <button
                  type="button"
                  onClick={() => setSelectedTournamentId(tournament.id)}
                  aria-label={`Open tournament ${tournament.taskLabel}`}
                  aria-pressed={selectedTournamentId === tournament.id}
                >
                  <strong>{tournament.taskLabel}</strong>{" "}
                  <span className="tournament-state">{statusLabel(tournament.state)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {leaderboard ? (
        <div className="tournament-leaderboard" aria-label="Leaderboard">
          <h3>
            {leaderboard.tournament.taskLabel}{" "}
            <span className="tournament-state">{statusLabel(leaderboard.tournament.state)}</span>
          </h3>
          {leaderboard.tournament.state === "running" ? (
            <p>Waiting for all contestants to finish…</p>
          ) : null}
          <table>
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Contestant</th>
                <th scope="col">Provider · Model</th>
                {criterionIds.map((id) => (
                  <th scope="col" key={id}>
                    {id}
                  </th>
                ))}
                <th scope="col">Total</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => {
                const isWinner =
                  leaderboard.verdict?.winner === row.contestant.contestantIndex;
                const isDisqualified = leaderboard.verdict?.disqualified.includes(
                  row.contestant.contestantIndex
                );
                const canKeep =
                  leaderboard.tournament.state === "awaiting-decision" && !isDisqualified;
                return (
                  <tr
                    key={row.contestant.contestantIndex}
                    aria-label={`Contestant ${row.contestant.contestantIndex + 1}`}
                  >
                    <td>{row.rank ?? "—"}</td>
                    <td>#{row.contestant.contestantIndex + 1}</td>
                    <td>
                      {row.contestant.provider} · {row.contestant.modelLabel}
                    </td>
                    {criterionIds.map((id) => {
                      const score = row.scores.find((s) => s.criterionId === id);
                      return (
                        <td key={id} title={JSON.stringify(score?.evidence ?? {})}>
                          {formatRaw(score)}
                        </td>
                      );
                    })}
                    <td>
                      {formatTotal(row.total)}
                      {isWinner ? <span title="Winner"> ★</span> : null}
                    </td>
                    <td>
                      {canKeep ? (
                        <button
                          type="button"
                          onClick={() => void onKeep(row.contestant.contestantIndex)}
                          disabled={keeping}
                          aria-label={`Keep contestant ${row.contestant.contestantIndex + 1}`}
                        >
                          Keep
                        </button>
                      ) : null}
                      {leaderboard.tournament.state === "decided" &&
                      leaderboard.tournament.decision?.keptContestantIndex ===
                        row.contestant.contestantIndex ? (
                        <span aria-label="Kept">Kept</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
