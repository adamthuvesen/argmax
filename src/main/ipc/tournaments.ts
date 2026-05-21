import {
  tournamentGetInputSchema,
  tournamentKeepInputSchema,
  tournamentLaunchInputSchema,
  tournamentListInputSchema,
  type IpcChannel
} from "../../shared/ipcSchemas.js";
import type { TournamentService } from "../tournaments/tournamentService.js";
import { withValidation } from "../ipc.js";
import { createIpcRegistrar } from "./registry.js";
import { z } from "zod";

const scoringListInputSchema = z.void();

/** Tournament-mode IPC handlers (idea #1: parallel agents + auto-judge). */
export function registerTournamentHandlers(
  tournaments: TournamentService
): readonly IpcChannel[] {
  const { register, channels: registered } = createIpcRegistrar();

  register(
    "tournament:launch",
    withValidation(tournamentLaunchInputSchema, (input) => tournaments.launchTournament(input))
  );
  register(
    "tournament:list",
    withValidation(tournamentListInputSchema, (input) =>
      tournaments.listTournamentsForProject(input.projectId)
    )
  );
  register(
    "tournament:get",
    withValidation(tournamentGetInputSchema, (input) =>
      tournaments.refreshAndJudgeIfReady(input.tournamentId)
    )
  );
  register(
    "tournament:keep",
    withValidation(tournamentKeepInputSchema, (input) => tournaments.keepWinner(input))
  );
  register(
    "scoring:list-policies",
    withValidation(scoringListInputSchema, () => tournaments.listPolicies())
  );

  return registered;
}
