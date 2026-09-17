import { ChevronRight } from "lucide-react";
import { useRef, useState, type JSX } from "react";
import { codenameForTool, fallbackCodename } from "../lib/agentNames.js";
import { emblemForCodename, type Emblem } from "../lib/agentEmblems.js";
import {
  agentLaunchAriaLabel,
  agentLaunchLabel,
  agentStatusLabel
} from "../lib/agentLaunch.js";
import { useSettleHold } from "../hooks/useSettleHold.js";
import { usePacedHeadline } from "../lib/pacedHeadline.js";
import { useReadingWave } from "../lib/readingWave.js";
import type { ToolCall } from "../lib/toolCalls.js";
import { AgentEmblem } from "./AgentEmblem.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import { ToolCallDetail } from "./ToolCallDetail.js";
import { toolCallHasExpandableDetail } from "./toolCallDetailLogic.js";
import { WORKING_NEST_SETTLE_MS, WorkingNest } from "./WorkingNest.js";

/** Joins the row's parts into the one string `usePacedHeadline` paces, and
 *  splits them back out. Not `headlineClauses`' comma: a task description is
 *  free text, and "Fix the parser, again" would come back as two parts. */
const PART = "\u0000";

/**
 * The agent's emblem, whatever the row is doing — the same mark its dock tab
 * and pane masthead carry. A row the reader is waiting on says so on its own
 * words now (the reading wave, the way a running tool row is marked), so a
 * nest beside them would say "running" a second time. The finished state is
 * carried by the word "Completed" on the row's status line, so a check glyph
 * would say *that* twice.
 *
 * A backgrounded launch is the one row that keeps the nest. No completion for
 * one ever arrives, so the row is marked running by inference rather than by
 * evidence (docs/chat-cards.md), and a band reading its words for the rest of
 * the session would claim progress nobody can watch. A status mark is the
 * honest reading there: alive, somewhere else.
 *
 * That nest still hands over only after its landing (useSettleHold): the
 * mark's four dots gather, pulse once and open back out, and only then does
 * the emblem take over. An agent that *errored* skips it — a landing is the
 * app saying the work arrived, and it must never say that about work that
 * didn't.
 */
function AgentLaunchMark({
  status,
  emblem,
  phaseKey,
  nest
}: {
  status: ToolCall["status"];
  emblem: Emblem;
  phaseKey: string;
  /** Carry liveness on the mark rather than on the row's words. */
  nest: boolean;
}): JSX.Element {
  const phase = useSettleHold(nest && status === "running", WORKING_NEST_SETTLE_MS);
  // Same element in the same slot across the flip, so React keeps the instance
  // and the nest can see `active` go true → false. Returning a different node
  // for the finished state would unmount it mid-landing.
  if (status !== "error" && phase !== "done") {
    return (
      <WorkingNest
        active={phase === "running"}
        className="agent-launch-mark"
        size={14}
        phaseKey={phaseKey}
      />
    );
  }
  return (
    <span
      className="agent-launch-mark agent-launch-emblem"
      aria-hidden="true"
      data-launch-mark={status}
    >
      <AgentEmblem
        shape={emblem.shape}
        hue={emblem.hue}
        size={14}
        status={status === "error" ? "error" : "done"}
      />
    </span>
  );
}

type UserToggle = {
  value: boolean;
  defaultExpanded?: boolean;
};

function AgentLaunchRow({
  tool,
  agentCodename,
  defaultExpanded,
  workspaceCwd,
  onOpenFile,
  onOpenAgent
}: {
  tool: ToolCall;
  agentCodename?: string;
  defaultExpanded?: boolean;
  workspaceCwd?: string | null;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
  onOpenAgent?: (tool: ToolCall) => void;
}): JSX.Element {
  const [userToggle, setUserToggle] = useState<UserToggle | null>(null);
  const localExpanded =
    userToggle && userToggle.defaultExpanded === defaultExpanded ? userToggle.value : null;
  const hasDetail = toolCallHasExpandableDetail(tool);
  const expanded =
    hasDetail && (localExpanded ?? (tool.status === "error" || (defaultExpanded ?? false)));
  const { title, identity } = agentLaunchLabel(tool, agentCodename);
  const action = agentLaunchAriaLabel(tool, agentCodename);
  const emblem = emblemForCodename(agentCodename ?? fallbackCodename(tool.toolUseId));
  // A launch the turn is blocked on is work the reader is waiting for, and it
  // already owns the transcript's beat — it is what keeps the Thinking cue
  // down. A backgrounded one does not vote for the beat, so it does not take
  // the band either.
  const liveWork = tool.status === "running" && tool.backgroundLaunch !== true;
  // One wording for the whole row, so a codename that resolves a moment after
  // the launch row appeared and a status that flips in the same beat land as a
  // single change rather than two. `kindKey` is the wording itself: unlike a
  // tool group's headline there is no count in here to hold back, every change
  // is a real one.
  const wording = [title, identity ?? "", agentStatusLabel(tool.status)].join(PART);
  const paced = usePacedHeadline(wording, wording, tool.status === "running");
  const [shownTitle, shownIdentity, shownStatus] = paced.shown.split(PART);
  const previousParts = paced.previous.split(PART);
  // Only the part that changed moves; a first render has nothing to arrive.
  const arriving = (index: number, part: string): "true" | undefined =>
    previousParts[index] !== part ? "true" : undefined;
  const headlineRef = useRef<HTMLSpanElement | null>(null);
  useReadingWave(headlineRef, liveWork, `${shownTitle}${PART}${shownIdentity}`);
  const toggleExpanded = (): void => {
    if (!hasDetail) return;
    setUserToggle({ value: !expanded, defaultExpanded });
  };
  // The row's click opens the run in the pane's Agents view. A surface with no
  // dock to host that view — the phone — keeps the row as a record of the
  // delegated work: same mark, name and status, nothing to press.
  const opensAgentPane = onOpenAgent !== undefined;
  const headline = (
    <>
      {/* The band reads the task and the codename as one line, the way it
          reads a tool row's verb and target; the status word below sits on a
          line of its own and holds still. Keyed on their own text so a
          re-worded part remounts and its fade actually plays. */}
      <span
        className="agent-launch-headline"
        ref={headlineRef}
        data-reading-wave={liveWork ? "true" : undefined}
      >
        <span
          key={shownTitle}
          className="agent-launch-title reading-wave-text"
          data-arriving={arriving(0, shownTitle)}
        >
          {shownTitle}
        </span>
        {shownIdentity ? (
          <span
            key={shownIdentity}
            className="agent-launch-identity reading-wave-text"
            data-arriving={arriving(1, shownIdentity)}
          >
            {shownIdentity}
          </span>
        ) : null}
      </span>
      <span
        key={shownStatus}
        className="agent-launch-status"
        data-arriving={arriving(2, shownStatus)}
      >
        {shownStatus}
      </span>
    </>
  );

  return (
    // The hue rides the row so a backgrounded launch's nest sits in this
    // agent's colour, the one its emblem takes when the run lands.
    <div
      className="agent-launch-row agent-emblem-tint"
      data-status={tool.status}
      data-hue={emblem.hue}
    >
      <div className="agent-launch-row-main">
        <AgentLaunchMark
          status={tool.status}
          emblem={emblem}
          phaseKey={tool.toolUseId}
          nest={tool.backgroundLaunch === true}
        />
        {opensAgentPane ? (
          <button
            type="button"
            className="agent-launch-row-button"
            aria-label={action}
            onClick={() => onOpenAgent(tool)}
          >
            {headline}
          </button>
        ) : (
          <div className="agent-launch-row-button">{headline}</div>
        )}
        {opensAgentPane && hasDetail ? (
          <button
            className="tool-call-row-disclosure"
            type="button"
            aria-expanded={expanded}
            aria-label={`Toggle details for ${action}`}
            title="Toggle details"
            onClick={toggleExpanded}
          >
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {expanded ? (
        <ToolCallDetail
          tool={tool}
          workspaceCwd={workspaceCwd ?? null}
          onOpenFile={onOpenFile}
        />
      ) : null}
    </div>
  );
}

export function AgentLaunchList({
  tools,
  defaultExpanded,
  workspaceCwd,
  agentCodenames,
  onOpenFile,
  onOpenAgent
}: {
  tools: ToolCall[];
  defaultExpanded?: boolean;
  workspaceCwd?: string | null;
  agentCodenames?: Map<string, string>;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
  onOpenAgent?: (tool: ToolCall) => void;
}): JSX.Element {
  return (
    <div className="agent-launch-list">
      {tools.map((tool) => (
        <AgentLaunchRow
          key={tool.id}
          tool={tool}
          agentCodename={codenameForTool(tool, agentCodenames)}
          defaultExpanded={defaultExpanded}
          workspaceCwd={workspaceCwd}
          onOpenFile={onOpenFile}
          onOpenAgent={onOpenAgent}
        />
      ))}
    </div>
  );
}
