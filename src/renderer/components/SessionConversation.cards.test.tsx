import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionConversation } from "./SessionConversation.js";
import {
  baseSession,
  event,
  project,
  renderConversation,
  rerenderConversation,
  reviewStub,
  workspace
} from "../../test/sessionConversationTestHarness.js";
import { startedAgentName } from "../../test/agentRowName.js";

describe("SessionConversation — cards", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete (window as { argmax?: unknown }).argmax;
    cleanup();
  });
  it("takes the composer's place while the question is live, and gives it back when the question is closed", () => {
    render(
      <SessionConversation
        events={[
          event("u1", "user.message", "what should we do", "2026-05-12T15:00:00.000Z", {}),
          event("tu-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
            type: "tool_use",
            id: "tu_q_dock",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Pick a direction",
                  header: "Direction",
                  multiSelect: false,
                  options: [{ label: "Fix audit findings" }, { label: "General maintenance" }]
                }
              ]
            }
          })
        ]}
        isLogOpen={false}
        onSendSessionInput={vi.fn().mockResolvedValue(undefined)}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onClearSession={vi.fn().mockResolvedValue(undefined)}
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

    // There is nothing to type while the agent waits, so the panel owns the slot.
    expect(screen.getByLabelText("Question from agent")).toBeInTheDocument();
    expect(screen.queryByLabelText("Chat prompt")).not.toBeInTheDocument();

    // Closing is not declining: the composer returns so the reader can answer
    // in their own words, and the question goes with the panel rather than
    // landing in the scrollback as a second copy.
    fireEvent.click(screen.getByRole("button", { name: "Answer in your own words" }));
    expect(screen.getByLabelText("Chat prompt")).toBeInTheDocument();
    expect(screen.queryByLabelText("Question from agent")).not.toBeInTheDocument();
  });

  it("drops the question from the transcript once it is answered", () => {
    // The answer is the record. Leaving the card behind re-asked a question the
    // reader had already settled, complete with a live Send button.
    renderConversation(baseSession({ provider: "claude", state: "complete" }), [
      event("u1", "user.message", "what should we do", "2026-05-12T15:00:00.000Z", {}),
      event("tu-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
        type: "tool_use",
        id: "tu_q_answered",
        name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "Pick a direction",
              header: "Direction",
              multiSelect: false,
              options: [{ label: "Fix audit findings" }, { label: "General maintenance" }]
            }
          ]
        }
      }),
      event("u2", "user.message", "Direction: Fix audit findings", "2026-05-12T15:00:05.000Z", {})
    ]);

    expect(screen.queryByLabelText("Question from agent")).not.toBeInTheDocument();
    expect(screen.queryByText("Pick a direction")).not.toBeInTheDocument();
    // …and the composer is the reader's again.
    expect(screen.getByLabelText("Chat prompt")).toBeInTheDocument();
  });

  it("docks a question that arrives while the composer still holds focus from the last send, and stands down for a typed draft", () => {
    const questionEvents = [
      event("u1", "user.message", "what should we do", "2026-05-12T15:00:00.000Z", {}),
      event("tu-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
        type: "tool_use",
        id: "tu_q_focus",
        name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "Pick a direction",
              header: "Direction",
              multiSelect: false,
              options: [{ label: "Fix audit findings" }, { label: "General maintenance" }]
            }
          ]
        }
      })
    ];
    const session = baseSession({ provider: "claude", state: "running" });
    const { rerender } = renderConversation(session, [questionEvents[0]]);

    // Sending refocuses the input, so the composer holds focus for the whole
    // turn. That must not push the question into the scrollback.
    fireEvent.focus(screen.getByLabelText("Chat prompt"));
    rerenderConversation(rerender, session, questionEvents);
    expect(screen.getByLabelText("Question from agent")).toBeInTheDocument();
    expect(screen.queryByLabelText("Chat prompt")).not.toBeInTheDocument();

    cleanup();

    // A draft is the one thing the dock would cover, so the composer keeps
    // the slot and the question is not drawn anywhere else.
    const typed = renderConversation(session, [questionEvents[0]]);
    fireEvent.change(screen.getByLabelText("Chat prompt"), { target: { value: "half a thought" } });
    rerenderConversation(typed.rerender, session, questionEvents);
    expect(screen.queryByLabelText("Question from agent")).not.toBeInTheDocument();
    expect(screen.queryByText("Pick a direction")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Chat prompt")).toBeInTheDocument();
  });

  it("answers a blocking Codex question in the same turn and restores a saved draft", async () => {
    const resolveQuestion = vi.fn().mockResolvedValue({
      sessionId: "session-a",
      requestId: "request-1",
      status: "answered"
    });
    window.argmax = { questions: { resolve: resolveQuestion } } as unknown as NonNullable<typeof window.argmax>;
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onTerminate = vi.fn().mockResolvedValue(undefined);
    const session = baseSession({ provider: "codex", state: "waiting" });
    const questionEvents = [
      event("u1", "user.message", "ask me", "2026-05-12T15:00:00.000Z"),
      event("question-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
        id: "question-item-1",
        type: "AskUserQuestion",
        name: "AskUserQuestion",
        status: "running",
        input: {
          delivery: "blocking",
          requestId: "request-1",
          questions: [{
            id: "scope",
            question: "Which scope?",
            header: "Scope",
            options: [{ label: "Focused", description: "Only this flow" }],
            multiSelect: false,
            isOther: true,
            isSecret: false
          }]
        }
      })
    ];
    const rendered = renderConversation(session, [questionEvents[0]], {
      onSendSessionInput: onSend,
      onTerminateSession: onTerminate
    });
    fireEvent.change(screen.getByLabelText("Chat prompt"), { target: { value: "keep this draft" } });

    rerenderConversation(rendered.rerender, session, questionEvents, {
      onSendSessionInput: onSend,
      onTerminateSession: onTerminate
    });
    expect(screen.getByLabelText("Question from agent")).toBeInTheDocument();
    expect(screen.queryByLabelText("Chat prompt")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: /Focused/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));

    await waitFor(() => expect(resolveQuestion).toHaveBeenCalledTimes(1));
    expect(resolveQuestion).toHaveBeenCalledWith({
      sessionId: "session-a",
      requestId: "request-1",
      answers: { scope: ["Focused"] }
    });
    expect(onTerminate).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText("Chat prompt")).toHaveValue("keep this draft"));
  });

  it("masks a blocking Codex secret and returns it only in the native response", async () => {
    const resolveQuestion = vi.fn().mockResolvedValue({
      sessionId: "session-a",
      requestId: "request-secret",
      status: "answered"
    });
    window.argmax = { questions: { resolve: resolveQuestion } } as unknown as NonNullable<typeof window.argmax>;
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderConversation(
      baseSession({ provider: "codex", state: "running" }),
      [
        event("u1", "user.message", "connect", "2026-05-12T15:00:00.000Z"),
        event("question-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
          id: "question-secret",
          name: "AskUserQuestion",
          status: "running",
          input: {
            delivery: "blocking",
            requestId: "request-secret",
            questions: [{
              id: "token",
              question: "Paste the token",
              header: "Token",
              options: [],
              multiSelect: false,
              isOther: false,
              isSecret: true
            }]
          }
        })
      ],
      { onSendSessionInput: onSend }
    );

    fireEvent.click(screen.getByRole("option", { name: "Other" }));
    const secret = screen.getByLabelText("Your own answer");
    expect(secret).toHaveAttribute("type", "password");
    fireEvent.change(secret, { target: { value: "sk-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));

    await waitFor(() => expect(resolveQuestion).toHaveBeenCalledWith({
      sessionId: "session-a",
      requestId: "request-secret",
      answers: { token: ["user_note: sk-secret"] }
    }));
    expect(onSend).not.toHaveBeenCalled();
    const storedValues = Array.from({ length: window.localStorage.length }, (_, index) =>
      window.localStorage.getItem(window.localStorage.key(index) ?? "") ?? ""
    ).join("\n");
    expect(storedValues).not.toContain("sk-secret");
  });

  it("dismisses a blocking Codex question through its open request", async () => {
    const resolveQuestion = vi.fn().mockResolvedValue({
      sessionId: "session-a",
      requestId: "request-dismiss",
      status: "dismissed"
    });
    window.argmax = { questions: { resolve: resolveQuestion } } as unknown as NonNullable<typeof window.argmax>;
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onTerminate = vi.fn().mockResolvedValue(undefined);
    renderConversation(
      baseSession({ provider: "codex", state: "running" }),
      [
        event("u1", "user.message", "ask", "2026-05-12T15:00:00.000Z"),
        event("question-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
          id: "question-dismiss",
          name: "AskUserQuestion",
          status: "running",
          input: {
            delivery: "blocking",
            requestId: "request-dismiss",
            questions: [{
              id: "scope",
              question: "Which scope?",
              header: "Scope",
              options: [{ label: "Focused" }],
              multiSelect: false,
              isOther: false,
              isSecret: false
            }]
          }
        })
      ],
      {
        onSendSessionInput: onSend,
        onTerminateSession: onTerminate
      }
    );

    expect(screen.queryByRole("option", { name: "Other" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss question" }));

    await waitFor(() => expect(resolveQuestion).toHaveBeenCalledWith({
      sessionId: "session-a",
      requestId: "request-dismiss",
      answers: {},
      dismissed: true
    }));
    expect(onTerminate).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("takes an answer in the reader's own words through the Other row", () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionConversation
        events={[
          event("u1", "user.message", "what should we do", "2026-05-12T15:00:00.000Z", {}),
          event("tu-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
            type: "tool_use",
            id: "tu_q_other",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Pick a direction",
                  header: "Direction",
                  multiSelect: false,
                  options: [{ label: "Fix audit findings" }, { label: "General maintenance" }]
                },
                {
                  question: "Which files?",
                  header: "Files",
                  multiSelect: true,
                  options: [{ label: "Renderer" }, { label: "Rust" }]
                }
              ]
            }
          })
        ]}
        isLogOpen={false}
        onSendSessionInput={onSend}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onClearSession={vi.fn().mockResolvedValue(undefined)}
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

    // Every question ends in an Other row, numbered after the listed options.
    fireEvent.click(screen.getByRole("option", { name: "Other" }));
    // Picking it does not advance: the pick is a promise to type, and the
    // question is settled by the text, not the row.
    expect(screen.getByText("Pick a direction")).toBeInTheDocument();
    const line = screen.getByRole("textbox", { name: "Your own answer" });
    expect(line).toHaveFocus();
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeDisabled();

    // Enter on an empty line goes nowhere; with text it settles the question.
    fireEvent.keyDown(line, { key: "Enter" });
    expect(screen.getByText("Pick a direction")).toBeInTheDocument();
    fireEvent.change(line, { target: { value: "Ship the iOS review first" } });
    fireEvent.keyDown(line, { key: "Enter" });
    expect(screen.getByText("Which files?")).toBeInTheDocument();

    // On a multi-select the typed answer joins the listed picks.
    fireEvent.click(screen.getByRole("option", { name: /Renderer/ }));
    fireEvent.click(screen.getByRole("option", { name: "Other" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Your own answer" }), {
      target: { value: "the Swift bridge" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));

    const call = onSend.mock.calls[0] as [string, string, unknown, string] | undefined;
    expect(call?.[1]).toBe("Direction: Ship the iOS review first\nFiles: Renderer, the Swift bridge");
  });

  it("pages through several questions instead of stacking them, and sends every answer at once", () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionConversation
        events={[
          event("u1", "user.message", "what should we do", "2026-05-12T15:00:00.000Z", {}),
          event("tu-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
            type: "tool_use",
            id: "tu_q_pager",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Pick a direction",
                  header: "Direction",
                  multiSelect: false,
                  options: [{ label: "Fix audit findings" }, { label: "General maintenance" }]
                },
                {
                  question: "How deep should it go?",
                  header: "Depth",
                  multiSelect: false,
                  options: [{ label: "Just the blockers" }, { label: "Everything" }]
                }
              ]
            }
          })
        ]}
        isLogOpen={false}
        onSendSessionInput={onSend}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onClearSession={vi.fn().mockResolvedValue(undefined)}
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

    // One question on screen at a time, so the slot is the same height either way.
    expect(screen.getByText("Pick a direction")).toBeInTheDocument();
    expect(screen.queryByText("How deep should it go?")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeDisabled();

    // A single-select pick settles its question, so the panel moves on by itself.
    fireEvent.click(screen.getByRole("option", { name: /Fix audit findings/ }));
    expect(screen.getByText("How deep should it go?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: /Just the blockers/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));

    const call = onSend.mock.calls[0] as [string, string, unknown, string] | undefined;
    expect(call?.[1]).toBe("Direction: Fix audit findings\nDepth: Just the blockers");
  });

  it("renders a failed AskUserQuestion tool call in the question dock and submits the chosen answer", () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionConversation
        events={[
          event("u1", "user.message", "what should we do", "2026-05-12T15:00:00.000Z", {
            agentMode: "auto"
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
        onClearSession={vi.fn().mockResolvedValue(undefined)}
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
    expect(call?.[1]).toContain("Direction: Fix audit findings");
    expect(call?.[3]).toBe("auto");
  });

  it.each([
    {
      provider: "claude" as const,
      toolMessage: "AskUserQuestion",
      payload: {
        type: "tool_use",
        id: "tu_q_claude",
        name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "Which path should I take?",
              header: "Path",
              multiSelect: false,
              options: [{ label: "Fast fix" }, { label: "Deeper cleanup" }]
            }
          ]
        }
      }
    },
    {
      provider: "cursor" as const,
      toolMessage: "askQuestionToolCall",
      payload: {
        call_id: "call_q_cursor",
        name: "askQuestionToolCall",
        input: {
          questions: [
            {
              question: "Which path should I take?",
              header: "Path",
              multiSelect: false,
              options: [{ label: "Fast fix" }, { label: "Deeper cleanup" }]
            }
          ]
        }
      }
    },
    {
      provider: "codex" as const,
      toolMessage: "AskUserQuestion",
      payload: {
        type: "tool_call",
        id: "item_q_codex",
        name: "ask_user_question",
        arguments: JSON.stringify({
          questions: [
            {
              question: "Which path should I take?",
              header: "Path",
              multiSelect: false,
              options: [{ label: "Fast fix" }, { label: "Deeper cleanup" }]
            }
          ]
        })
      }
    }
  ])("renders AskUserQuestion in the question dock for $provider payloads", ({ provider, toolMessage, payload }) => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionConversation
        events={[
          event("u1", "user.message", "choose a path", "2026-05-12T15:00:00.000Z", {
            agentMode: "auto"
          }),
          event("tu-start", "command.started", toolMessage, "2026-05-12T15:00:01.000Z", payload)
        ]}
        isLogOpen={false}
        onSendSessionInput={onSend}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onClearSession={vi.fn().mockResolvedValue(undefined)}
        onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
        pendingMessages={[]}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={baseSession({ provider, state: "complete" })}
        workspace={workspace}
      />
    );

    expect(screen.getByLabelText("Question from agent")).toBeInTheDocument();
    expect(screen.getByText("Which path should I take?")).toBeInTheDocument();
    expect(screen.queryByText(toolMessage)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: /Fast fix/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));

    expect(onSend).toHaveBeenCalledTimes(1);
    const call = onSend.mock.calls[0] as [string, string, unknown, string] | undefined;
    expect(call?.[1]).toContain("Path: Fast fix");
    expect(call?.[3]).toBe("auto");
  });

  it("shows one completed async Codex question and submits its answer", () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const payload = {
      type: "AskUserQuestion",
      name: "AskUserQuestion",
      id: "ask-1",
      delivery: "async",
      phase: "final_answer",
      text: "Which surface?\n- iOS\n- Both",
      input: { delivery: "async", questions: [{
        question: "Which surface?",
        header: "",
        options: [{ label: "iOS" }, { label: "Both" }],
        multiSelect: false
      }] }
    };
    render(
      <SessionConversation
        events={[
          event("u1", "user.message", "pick a surface", "2026-05-12T15:00:00.000Z"),
          event("ask-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", payload),
          event("ask-end", "command.completed", "AskUserQuestion", "2026-05-12T15:00:02.000Z", payload),
          event("later", "message.completed", "I found the existing iPhone app.", "2026-05-12T15:00:03.000Z")
        ]}
        isLogOpen={false}
        onSendSessionInput={onSend}
        onTerminateSession={vi.fn().mockResolvedValue(undefined)}
        onClearSession={vi.fn().mockResolvedValue(undefined)}
        onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
        pendingMessages={[]}
        onToggleLog={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={baseSession({ provider: "codex", state: "complete" })}
        workspace={workspace}
      />
    );

    expect(screen.getAllByLabelText("Question from agent")).toHaveLength(1);
    expect(screen.getByText("I found the existing iPhone app.")).toBeInTheDocument();
    expect(screen.queryByText("AskUserQuestion")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /iOS/ }));
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[1]).toBe("Which surface?: iOS");
  });

  it("terminates the in-flight probe before sending the question dock answer (no queue wait)", async () => {
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
            agentMode: "auto"
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
        onClearSession={vi.fn().mockResolvedValue(undefined)}
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

    expect(onTerminate).toHaveBeenCalledWith("session-a", { restoreLauncherOnEarlyStop: false });
    // Send fires AFTER terminate resolves.
    // Testing Library's waitFor, not Vitest's: this one polls inside `act`,
    // so the terminate/send chain's state updates land during the test.
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const terminateOrder = onTerminate.mock.invocationCallOrder[0];
    const sendOrder = onSend.mock.invocationCallOrder[0];
    expect(terminateOrder).toBeLessThan(sendOrder);
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
            agentMode: "auto"
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
        onClearSession={vi.fn().mockResolvedValue(undefined)}
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
    // already conveys the ask, so post-tool prose is suppressed. Pre-tool
    // intro narration stays because it is useful context.
    renderConversation(
      baseSession({ provider: "claude", state: "complete" }),
      [
        event("u1", "user.message", "scan and ask", "2026-05-12T15:00:00.000Z", {
          agentMode: "auto"
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
            agentMode: "auto"
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
        onClearSession={vi.fn().mockResolvedValue(undefined)}
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

  it("hides the raw AskUserQuestion row when the only ask is invalid", () => {
    renderConversation(
      baseSession({ provider: "claude", state: "running" }),
      [
        event("u1", "user.message", "decide", "2026-05-12T15:00:00.000Z", {
          agentMode: "auto"
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
    expect(screen.queryByText("AskUserQuestion")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
  });

  it("renders a running AskUserQuestion card when it is mixed into an active tool group", () => {
    render(
      <SessionConversation
        events={[
          event("u1", "user.message", "scan and ask", "2026-05-12T15:00:00.000Z", {
            agentMode: "auto"
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
        onClearSession={vi.fn().mockResolvedValue(undefined)}
        onCancelQueuedMessage={vi.fn().mockResolvedValue(undefined)}
        pendingMessages={[]}
        onToggleLog={vi.fn()}
        onOpenAgent={vi.fn()}
        project={project}
        rawOutputs={[]}
        review={reviewStub()}
        session={baseSession({ provider: "claude", state: "running" })}
        workspace={workspace}
      />
    );

    expect(screen.getByLabelText("Question from agent")).toBeInTheDocument();
    expect(screen.getByText("What should we prioritize?")).toBeInTheDocument();

    const agentRow = screen.getByRole("button", { name: startedAgentName("Explore docs") });
    fireEvent.click(agentRow);
    expect(agentRow).toBeInTheDocument();
    expect(screen.getByText("echo ok")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ran echo ok" })).toBeNull();
    expect(screen.queryByText("AskUserQuestion")).not.toBeInTheDocument();
  });

  it("still docks the question when AskUserQuestion retries are adjacent", () => {
    render(
      <SessionConversation
        events={[
          event("u1", "user.message", "what should we do", "2026-05-12T15:00:00.000Z", {
            agentMode: "auto"
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
        onClearSession={vi.fn().mockResolvedValue(undefined)}
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
    // Both underlying tool rows are suppressed.
    expect(screen.queryByRole("button", { name: "Ran commands" })).not.toBeInTheDocument();
  });

  it("keeps Thinking visible while Codex works after an async question", () => {
    vi.useFakeTimers();
    renderConversation(
      baseSession({ provider: "codex", state: "running" }),
      [
        event("u1", "user.message", "ask me", "2026-05-12T15:00:00.000Z"),
        event("ask-start", "command.started", "AskUserQuestion", "2026-05-12T15:00:01.000Z", {
          id: "async-ask",
          name: "AskUserQuestion",
          delivery: "async",
          input: { delivery: "async", questions: [{
            question: "Which surface?", header: "", options: [{ label: "iOS" }]
          }] }
        })
      ]
    );
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByLabelText("Question from agent")).toBeInTheDocument();
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
  });

});
