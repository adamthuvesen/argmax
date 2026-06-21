import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionConversation } from "./SessionConversation.js";
import {
  baseSession,
  event,
  project,
  renderConversation,
  reviewStub,
  workspace
} from "../../test/sessionConversationTestHarness.js";

describe("SessionConversation — cards", () => {
  afterEach(() => {
    cleanup();
  });
  it("hides assistant text emitted AFTER an ExitPlanMode card so the plan isn't duplicated as a chat bubble", () => {
    // When Argmax denies ExitPlanMode in structured-json mode, the model
    // often retries by writing the plan as a text fallback. The card has
    // already rendered, so showing the fallback text below it duplicates
    // the entire plan in the chat. Pre-tool narration stays visible
    // because it's useful intro context.
    renderConversation(
      baseSession({ provider: "claude", state: "complete" }),
      [
        event("u1", "user.message", "make a plan", "2026-05-12T15:00:00.000Z", {
          agentMode: "plan"
        }),
        event("m1", "message.completed", "Let me draft a plan.", "2026-05-12T15:00:01.000Z"),
        event("tu-start", "command.started", "ExitPlanMode", "2026-05-12T15:00:02.000Z", {
          type: "tool_use",
          id: "tu_plan_dup",
          name: "ExitPlanMode",
          input: { plan: "## Plan\n\n**Step:** Do the thing\n\nApprove?" }
        }),
        event("tu-end", "command.completed", "tool_result", "2026-05-12T15:00:03.000Z", {
          tool_use_id: "tu_plan_dup",
          content: "Exit plan mode?",
          is_error: true
        }),
        event("m2", "message.completed", "Plan written. Ready for your approval.", "2026-05-12T15:00:04.000Z")
      ]
    );

    expect(screen.getByLabelText(/Plan: /)).toBeInTheDocument();
    // Pre-tool intro narration is kept.
    expect(screen.getByText("Let me draft a plan.")).toBeInTheDocument();
    // Post-tool fallback text is suppressed (the card already conveys it).
    expect(screen.queryByText("Plan written. Ready for your approval.")).not.toBeInTheDocument();
  });

  it("renders a PlanCard from ExitPlanMode even when the tool ended in error (denied in structured-json mode)", () => {
    // In structured-json mode Argmax denies ExitPlanMode with a tool_result
    // {is_error: true, content: "Exit plan mode?"}. The plan markdown is
    // still in inputFull.plan, so the card MUST still render — otherwise the
    // user just sees a "Plan written" text bubble with no card.
    const planMarkdown =
      "## Refactor docs\n\n**Files to change:** README.md, docs/\n\nApprove?";
    renderConversation(
      baseSession({ provider: "claude", state: "complete" }),
      [
        event("u1", "user.message", "make a plan", "2026-05-12T15:00:00.000Z", {
          agentMode: "plan"
        }),
        event("tu-start", "command.started", "ExitPlanMode", "2026-05-12T15:00:01.000Z", {
          type: "tool_use",
          id: "tu_plan_err",
          name: "ExitPlanMode",
          input: { plan: planMarkdown }
        }),
        event("tu-end", "command.completed", "tool_result", "2026-05-12T15:00:02.000Z", {
          tool_use_id: "tu_plan_err",
          content: "Exit plan mode?",
          is_error: true
        })
      ]
    );

    expect(screen.getByLabelText(/Plan: /)).toBeInTheDocument();
    expect(screen.getByText("Refactor docs")).toBeInTheDocument();
    expect(screen.queryByText("ExitPlanMode")).not.toBeInTheDocument();
  });

  it("renders an ExitPlanMode tool call as a PlanCard, hiding the raw tool row", () => {
    const planMarkdown =
      "## Refactor auth module\n\n" +
      "**Files to change:** auth.ts, login.tsx\n\n" +
      "Approve this plan?";
    renderConversation(
      baseSession({ provider: "claude", state: "complete" }),
      [
        event("u1", "user.message", "refactor auth", "2026-05-12T15:00:00.000Z", {
          agentMode: "plan"
        }),
        event(
          "m1",
          "message.completed",
          "Let me lay out a plan.",
          "2026-05-12T15:00:01.000Z"
        ),
        event("tu-start", "command.started", "ExitPlanMode", "2026-05-12T15:00:02.000Z", {
          type: "tool_use",
          id: "tu_plan_1",
          name: "ExitPlanMode",
          input: { plan: planMarkdown }
        }),
        event("tu-end", "command.completed", "tool_result", "2026-05-12T15:00:03.000Z", {
          tool_use_id: "tu_plan_1",
          content: "ok"
        })
      ]
    );

    expect(screen.getByLabelText(/Plan: /)).toBeInTheDocument();
    expect(screen.getByText("Refactor auth module")).toBeInTheDocument();
    expect(screen.getByText("Let me lay out a plan.")).toBeInTheDocument();
    // The raw ExitPlanMode tool row should not appear once the card has the plan.
    expect(screen.queryByText("ExitPlanMode")).not.toBeInTheDocument();
  });

  it("suppresses a premature plan card when an unanswered question precedes it in the same turn", () => {
    // Plan-mode flow: the model asks a clarifying question (AskUserQuestion), but
    // because Argmax denies that tool the model falls back to ExitPlanMode in the
    // SAME turn — writing a plan before the user has answered. Show only the
    // question; the premature plan card must NOT render (the agent re-plans with
    // the answer in the next turn).
    renderConversation(
      baseSession({ provider: "claude", state: "complete" }),
      [
        event("u1", "user.message", "make a plan", "2026-05-12T15:00:00.000Z", {
          agentMode: "plan"
        }),
        event("tu-q", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
          type: "tool_use",
          id: "tu_q",
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "What's the scope?",
                header: "Scope",
                multiSelect: false,
                options: [
                  { label: "Consolidate & clean", description: "Merge overlaps" },
                  { label: "Fill gaps", description: "Add missing concepts" }
                ]
              }
            ]
          }
        }),
        event("tu-q-end", "command.completed", "tool_result", "2026-05-12T15:00:02.000Z", {
          tool_use_id: "tu_q",
          content: "Answer questions?",
          is_error: true
        }),
        event("tu-plan", "command.started", "ExitPlanMode", "2026-05-12T15:00:03.000Z", {
          type: "tool_use",
          id: "tu_plan",
          name: "ExitPlanMode",
          input: { plan: "## Premature plan\n\n**Step:** Do it anyway\n\nApprove?" }
        }),
        event("tu-plan-end", "command.completed", "tool_result", "2026-05-12T15:00:04.000Z", {
          tool_use_id: "tu_plan",
          content: "Exit plan mode?",
          is_error: true
        })
      ]
    );

    // The question is the authoritative ask…
    expect(screen.getByLabelText("Question from agent")).toBeInTheDocument();
    expect(screen.getByText("What's the scope?")).toBeInTheDocument();
    // …and the premature plan card is suppressed until it's answered.
    expect(screen.queryByLabelText(/Plan: /)).not.toBeInTheDocument();
    expect(screen.queryByText("Premature plan")).not.toBeInTheDocument();
  });

  it("renders a failed AskUserQuestion tool call as a QuestionCard and submits the chosen answer", () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionConversation
        events={[
          event("u1", "user.message", "what should we do", "2026-05-12T15:00:00.000Z", {
            agentMode: "plan"
          }),
          event("tu-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
            type: "tool_use",
            id: "tu_q_1",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Pick a direction",
                  header: "Direction",
                  multiSelect: false,
                  options: [
                    { label: "Fix audit findings", description: "Address 4 high-severity bugs" },
                    { label: "General maintenance", description: "Clean up timestamps" }
                  ]
                }
              ]
            }
          }),
          event("tu-end", "command.completed", "tool_result", "2026-05-12T15:00:02.000Z", {
            tool_use_id: "tu_q_1",
            content: "Answer questions?",
            is_error: true
          })
        ]}
        isLogOpen={false}
        onSendSessionInput={onSend}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onCreateCheckpoint={vi.fn().mockResolvedValue(undefined)}
        onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
        pendingMessages={[]}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={baseSession({ provider: "claude", state: "complete" })}
        workspace={workspace}
      />
    );

    expect(screen.getByLabelText("Question from agent")).toBeInTheDocument();
    expect(screen.getByText("Pick a direction")).toBeInTheDocument();
    // Tool row is hidden once the card renders.
    expect(screen.queryByText("AskUserQuestion")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: /Fix audit findings/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));

    expect(onSend).toHaveBeenCalledTimes(1);
    const call = onSend.mock.calls[0] as [string, string, unknown, string] | undefined;
    expect(call?.[1]).toContain("**Direction**: Fix audit findings");
    expect(call?.[3]).toBe("plan");
  });

  it("terminates the in-flight probe before sending the QuestionCard answer (no queue wait)", async () => {
    // While Haiku is still emitting fallback narration after a denied
    // AskUserQuestion, session.state === "running". A naive send would queue
    // the answer behind that narration. Instead we terminate first, then
    // send — main's sendInput relaunches the agent on the next message.
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onTerminate = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionConversation
        events={[
          event("u1", "user.message", "ask me", "2026-05-12T15:00:00.000Z", {
            agentMode: "plan"
          }),
          event("tu-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
            type: "tool_use",
            id: "tu_q_running",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Pick",
                  header: "Pick",
                  multiSelect: false,
                  options: [{ label: "A" }, { label: "B" }]
                }
              ]
            }
          }),
          event("tu-end", "command.completed", "tool_result", "2026-05-12T15:00:02.000Z", {
            tool_use_id: "tu_q_running",
            content: "Answer questions?",
            is_error: true
          })
        ]}
        isLogOpen={false}
        onSendSessionInput={onSend}
        onTerminateSession={onTerminate}
        onCreateCheckpoint={vi.fn().mockResolvedValue(undefined)}
        onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
        pendingMessages={[]}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={baseSession({ provider: "claude", state: "running" })}
        workspace={workspace}
      />
    );

    fireEvent.click(screen.getByRole("option", { name: /A/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));

    expect(onTerminate).toHaveBeenCalledWith("session-a");
    // Send fires AFTER terminate resolves.
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const terminateOrder = onTerminate.mock.invocationCallOrder[0];
    const sendOrder = onSend.mock.invocationCallOrder[0];
    expect(terminateOrder).toBeLessThan(sendOrder);
  });

  it("hides the Thinking indicator once a completed assistant answer is visible", () => {
    // Provider answer events and runtime completion state arrive in separate
    // dashboard deltas. If the answer has landed but the session row still
    // says running, the answer should win; otherwise the appended Thinking
    // bubble pins the scroll and makes the reply look missing until Stop.
    renderConversation(
      baseSession({ provider: "claude", state: "running" }),
      [
        event("m1", "message.completed", "Done.", "2026-05-12T15:00:01.000Z"),
        event("u1", "user.message", "do a thing", "2026-05-12T15:00:00.000Z")
      ]
    );

    expect(screen.getByText("Done.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
  });

  it("suppresses the Thinking indicator while AskUserQuestion is outstanding (the card is the ask)", () => {
    // When AskUserQuestion has fired and no user.message has landed since,
    // the agent is waiting on the user — even though the probe may still
    // technically be running while it emits fallback text. The Thinking
    // bubble would mislead the user into thinking the agent is still
    // working. The card itself conveys "waiting for you".
    renderConversation(
      baseSession({ provider: "claude", state: "running" }),
      [
        event("u1", "user.message", "ask me", "2026-05-12T15:00:00.000Z", {
          agentMode: "plan"
        }),
        event("tu-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
          type: "tool_use",
          id: "tu_q_running",
          name: "AskUserQuestion",
          input: { questions: [{ question: "?", header: "?", multiSelect: false, options: [{ label: "A" }] }] }
        })
        // No command.completed yet — tool still running.
      ]
    );

    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
  });

  it("restores Thinking once the user submits and a new user.message arrives", () => {
    // After the user submits the card, a new user.message lands.
    // `lastUserMessageTime` now advances past the AskUserQuestion's
    // createdAt, so the outstanding-ask gate releases and Thinking is
    // free to indicate that the next turn is being processed.
    renderConversation(
      baseSession({ provider: "claude", state: "running" }),
      [
        event("u1", "user.message", "ask me", "2026-05-12T15:00:00.000Z", {
          agentMode: "plan"
        }),
        event("tu-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
          type: "tool_use",
          id: "tu_q_done",
          name: "AskUserQuestion",
          input: { questions: [{ question: "?", header: "?", multiSelect: false, options: [{ label: "A" }] }] }
        }),
        event("tu-end", "command.completed", "tool_result", "2026-05-12T15:00:02.000Z", {
          tool_use_id: "tu_q_done",
          content: "Answer questions?",
          is_error: true
        }),
        event("u2", "user.message", "**Question**: A", "2026-05-12T15:00:03.000Z")
      ]
    );

    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
  });

  it("hides the Thinking indicator while a regular tool is actually running on screen", () => {
    // For a visible tool, the row's own spinner is the progress indicator —
    // no need to double up with Thinking.
    renderConversation(
      baseSession({ provider: "claude", state: "running" }),
      [
        event("u1", "user.message", "run it", "2026-05-12T15:00:00.000Z"),
        event("tu-start", "command.started", "Bash", "2026-05-12T15:00:01.000Z", {
          type: "tool_use",
          id: "tu_bash_running",
          name: "Bash",
          input: { command: "ls" }
        })
      ]
    );

    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
  });

  it("renders an AskUserQuestion card immediately from command.started and hides the raw row", () => {
    // In parallel-tool turns, Claude can start AskUserQuestion and keep the
    // provider process busy with a sub-agent for many seconds before the
    // tool_result/error arrives. The card can render from the complete
    // command.started input; waiting for completion hides the actual ask.
    render(
      <SessionConversation
        events={[
          event("u1", "user.message", "decide", "2026-05-12T15:00:00.000Z", {
            agentMode: "plan"
          }),
          event("tu-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
            type: "tool_use",
            id: "tu_q_running",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Pick",
                  header: "Pick",
                  multiSelect: false,
                  options: [{ label: "A" }, { label: "B" }]
                }
              ]
            }
          })
          // No `command.completed` event yet — the tool is still running.
        ]}
        isLogOpen={false}
        onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onCreateCheckpoint={vi.fn().mockResolvedValue(undefined)}
        onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
        pendingMessages={[]}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={baseSession({ provider: "claude", state: "running" })}
        workspace={workspace}
      />
    );

    // Tool row hidden from the moment it fires.
    expect(screen.queryByText("AskUserQuestion")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Question from agent")).toBeInTheDocument();
    expect(screen.getByText("Pick")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Working/ })).not.toBeInTheDocument();
  });

  it("hides hallucinated assistant prose emitted AFTER an AskUserQuestion card", () => {
    // When AskUserQuestion errors out in structured-json mode, the model
    // sometimes confabulates a "Thanks based on your input" message with
    // fabricated answers BEFORE the user has touched the card. The card
    // already conveys the ask, so post-tool prose is suppressed — same rule
    // as PlanCard. Pre-tool intro narration stays (it's useful context).
    renderConversation(
      baseSession({ provider: "claude", state: "complete" }),
      [
        event("u1", "user.message", "scan and ask", "2026-05-12T15:00:00.000Z", {
          agentMode: "plan"
        }),
        event("m0", "message.completed", "Scanning the repo now.", "2026-05-12T15:00:00.500Z"),
        event("tu-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
          type: "tool_use",
          id: "tu_q_fallback",
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "What should we prioritize?",
                header: "Priority",
                multiSelect: false,
                options: [{ label: "Runbooks" }, { label: "Examples" }]
              }
            ]
          }
        }),
        event("tu-end", "command.completed", "tool_result", "2026-05-12T15:00:02.000Z", {
          tool_use_id: "tu_q_fallback",
          content: "Answer questions?",
          is_error: true
        }),
        event(
          "m1",
          "message.completed",
          "Thanks! Based on your input: Priority: Runbooks.",
          "2026-05-12T15:00:08.000Z"
        )
      ]
    );

    expect(screen.getByLabelText("Question from agent")).toBeInTheDocument();
    expect(screen.getByText("Scanning the repo now.")).toBeInTheDocument();
    expect(
      screen.queryByText("Thanks! Based on your input: Priority: Runbooks.")
    ).not.toBeInTheDocument();
  });

  it("hides invalid running AskUserQuestion attempts and renders the first valid retry", () => {
    render(
      <SessionConversation
        events={[
          event("u1", "user.message", "decide", "2026-05-12T15:00:00.000Z", {
            agentMode: "plan"
          }),
          event("bad-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
            type: "tool_use",
            id: "tu_q_bad",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Too many options",
                  header: "Bad",
                  multiSelect: false,
                  options: [
                    { label: "A" },
                    { label: "B" },
                    { label: "C" },
                    { label: "D" },
                    { label: "E" }
                  ]
                }
              ]
            }
          }),
          event("good-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:02.000Z", {
            type: "tool_use",
            id: "tu_q_good",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Valid retry",
                  header: "Good",
                  multiSelect: false,
                  options: [{ label: "A" }, { label: "B" }]
                }
              ]
            }
          })
        ]}
        isLogOpen={false}
        onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onCreateCheckpoint={vi.fn().mockResolvedValue(undefined)}
        onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
        pendingMessages={[]}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={baseSession({ provider: "claude", state: "running" })}
        workspace={workspace}
      />
    );

    expect(screen.getByLabelText("Question from agent")).toBeInTheDocument();
    expect(screen.getByText("Valid retry")).toBeInTheDocument();
    expect(screen.queryByText("Too many options")).not.toBeInTheDocument();
    expect(screen.queryByText("AskUserQuestion")).not.toBeInTheDocument();
  });

  it("shows the raw AskUserQuestion row when the only ask is invalid", () => {
    renderConversation(
      baseSession({ provider: "claude", state: "running" }),
      [
        event("u1", "user.message", "decide", "2026-05-12T15:00:00.000Z", {
          agentMode: "plan"
        }),
        event("bad-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
          type: "tool_use",
          id: "tu_q_bad_only",
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "Too many options",
                header: "Bad",
                multiSelect: false,
                options: [
                  { label: "A" },
                  { label: "B" },
                  { label: "C" },
                  { label: "D" },
                  { label: "E" }
                ]
              }
            ]
          }
        })
      ]
    );

    expect(screen.queryByLabelText("Question from agent")).not.toBeInTheDocument();
    expect(screen.getByText("AskUserQuestion")).toBeInTheDocument();
    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
  });

  it("renders a running AskUserQuestion card when it is mixed into an active tool group", () => {
    render(
      <SessionConversation
        events={[
          event("u1", "user.message", "scan and ask", "2026-05-12T15:00:00.000Z", {
            agentMode: "plan"
          }),
          event("agent-start", "command.started", "Agent", "2026-05-12T15:00:01.000Z", {
            type: "tool_use",
            id: "tu_agent",
            name: "Agent",
            input: {
              description: "Explore docs",
              subagent_type: "Explore",
              prompt: "Map docs"
            }
          }),
          event("ask-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.020Z", {
            type: "tool_use",
            id: "tu_q_parallel",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "What should we prioritize?",
                  header: "Priority",
                  multiSelect: false,
                  options: [{ label: "Runbooks" }, { label: "Examples" }]
                }
              ]
            }
          }),
          event("bash-start", "command.started", "Bash", "2026-05-12T15:00:01.040Z", {
            type: "tool_use",
            id: "tu_bash",
            name: "Bash",
            input: { command: "echo ok" }
          })
        ]}
        isLogOpen={false}
        onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onCreateCheckpoint={vi.fn().mockResolvedValue(undefined)}
        onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
        pendingMessages={[]}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={baseSession({ provider: "claude", state: "running" })}
        workspace={workspace}
      />
    );

    expect(screen.getByLabelText("Question from agent")).toBeInTheDocument();
    expect(screen.getByText("What should we prioritize?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Started an agent/ }));
    expect(screen.getByRole("button", { name: "Agent Explore docs" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ran echo ok" })).toBeInTheDocument();
    expect(screen.queryByText("AskUserQuestion")).not.toBeInTheDocument();
  });

  it("hides the ExitPlanMode tool row immediately, even while still running (no flicker)", () => {
    render(
      <SessionConversation
        events={[
          event("u1", "user.message", "plan it", "2026-05-12T15:00:00.000Z", {
            agentMode: "plan"
          }),
          event("tu-start", "command.started", "ExitPlanMode", "2026-05-12T15:00:01.000Z", {
            type: "tool_use",
            id: "tu_plan_running",
            name: "ExitPlanMode",
            input: { plan: "## Title\n\n**Section:** body\n\nApprove?" }
          })
        ]}
        isLogOpen={false}
        onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onCreateCheckpoint={vi.fn().mockResolvedValue(undefined)}
        onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
        pendingMessages={[]}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={baseSession({ provider: "claude", state: "running" })}
        workspace={workspace}
      />
    );

    expect(screen.queryByText("ExitPlanMode")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Plan: /)).not.toBeInTheDocument();
  });

  it("renders an ExitPlanMode card when the tool is folded into a mixed tool group", () => {
    render(
      <SessionConversation
        defaultToolCallsExpanded={true}
        events={[
          event("u1", "user.message", "plan and check", "2026-05-12T15:00:00.000Z", {
            agentMode: "plan"
          }),
          event("plan-start", "command.started", "ExitPlanMode", "2026-05-12T15:00:01.000Z", {
            type: "tool_use",
            id: "tu_plan_grouped",
            name: "ExitPlanMode",
            input: { plan: "## Grouped plan\n\n**Step:** Keep the bash row visible\n\nApprove?" }
          }),
          event("bash-start", "command.started", "Bash", "2026-05-12T15:00:01.020Z", {
            type: "tool_use",
            id: "tu_bash_grouped",
            name: "Bash",
            input: { command: "echo ok" }
          }),
          event("plan-end", "command.completed", "tool_result", "2026-05-12T15:00:01.040Z", {
            tool_use_id: "tu_plan_grouped",
            content: "ok"
          }),
          event("bash-end", "command.completed", "tool_result", "2026-05-12T15:00:01.060Z", {
            tool_use_id: "tu_bash_grouped",
            content: "ok"
          })
        ]}
        isLogOpen={false}
        onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onCreateCheckpoint={vi.fn().mockResolvedValue(undefined)}
        onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
        pendingMessages={[]}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={baseSession({ provider: "claude", state: "complete" })}
        workspace={workspace}
      />
    );

    expect(screen.getByLabelText(/Plan: /)).toBeInTheDocument();
    expect(screen.getByText("Grouped plan")).toBeInTheDocument();
    expect(screen.queryByText("ExitPlanMode")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ran echo ok" })).toBeInTheDocument();
  });

  it("still renders the QuestionCard when AskUserQuestion retries fold into a tool-group", () => {
    // Two AskUserQuestion calls within the 75ms parallel-window fold into
    // a `tool-group`. Detection that only checks `t.kind === "tool"` would
    // silently miss this case and the card would vanish after a brief flash.
    render(
      <SessionConversation
        events={[
          event("u1", "user.message", "what should we do", "2026-05-12T15:00:00.000Z", {
            agentMode: "plan"
          }),
          event("tu1-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
            type: "tool_use",
            id: "tu_q_a",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "First attempt",
                  header: "First",
                  multiSelect: false,
                  options: [{ label: "Option A" }, { label: "Option B" }]
                }
              ]
            }
          }),
          event("tu1-end", "command.completed", "tool_result", "2026-05-12T15:00:01.020Z", {
            tool_use_id: "tu_q_a",
            content: "Answer questions?",
            is_error: true
          }),
          event("tu2-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.040Z", {
            type: "tool_use",
            id: "tu_q_b",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Refined ask — what's the priority?",
                  header: "Priority",
                  multiSelect: false,
                  options: [{ label: "Fix bugs" }, { label: "Add features" }]
                }
              ]
            }
          }),
          event("tu2-end", "command.completed", "tool_result", "2026-05-12T15:00:01.060Z", {
            tool_use_id: "tu_q_b",
            content: "Answer questions?",
            is_error: true
          })
        ]}
        isLogOpen={false}
        onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onCreateCheckpoint={vi.fn().mockResolvedValue(undefined)}
        onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
        pendingMessages={[]}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={baseSession({ provider: "claude", state: "complete" })}
        workspace={workspace}
      />
    );

    expect(screen.getByLabelText("Question from agent")).toBeInTheDocument();
    // First valid attempt wins and stays put — swapping to the retry would
    // remount the card and wipe in-progress selections.
    expect(screen.getByText("First attempt")).toBeInTheDocument();
    expect(screen.queryByText(/Refined ask/)).not.toBeInTheDocument();
    // The fold-induced tool-group row is suppressed.
    expect(screen.queryByRole("button", { name: /Ran 2 commands/ })).not.toBeInTheDocument();
  });


});
