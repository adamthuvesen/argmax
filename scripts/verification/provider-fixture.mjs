#!/usr/bin/env node

import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const VERIFICATION_PROVIDER = Object.freeze({
  provider: "claude",
  modelId: "claude-sonnet-5",
  modelLabel: "Sonnet 5",
  modeEnv: "ARGMAX_VERIFICATION",
  binaryEnv: "ARGMAX_VERIFICATION_CLAUDE_BINARY",
  homeEnv: "ARGMAX_VERIFICATION_HOME",
});

export const VERIFICATION_CONVERSATION_ID =
  "argmax-verification-conversation";

export const VERIFICATION_SUBAGENT = Object.freeze({
  id: "verification-persistent-agent",
  rootToolUseId: "verification-task-launch",
  followUpToolUseId: "verification-send-message",
  description: "Verification persistent child",
  subagentType: "general-purpose",
});

export const VERIFICATION_BARRIERS = Object.freeze({
  chatResumeStream: "chat-resume-stream",
  chatResumeTool: "chat-resume-tool",
});

export const VERIFICATION_SCENARIOS = Object.freeze({
  chatResumeFirst: {
    prompt: "[argmax-verification:chat-resume:first]",
    visibleText: "Verification first turn complete.",
    toolName: "Read",
  },
  chatResumeSecond: {
    prompt: "[argmax-verification:chat-resume:second]",
    visibleText: "Verification resumed turn complete.",
    resumeConversationId: VERIFICATION_CONVERSATION_ID,
  },
  persistentSubagentFirst: {
    prompt: "[argmax-verification:persistent-subagent:first]",
    visibleText: "Verification persistent child first response.",
  },
  persistentSubagentSecond: {
    prompt: "[argmax-verification:persistent-subagent:second]",
    visibleText: "Verification persistent child follow-up response.",
    resumeConversationId: VERIFICATION_CONVERSATION_ID,
  },
  cancellation: {
    prompt: "[argmax-verification:cancellation]",
    visibleText: "Verification cancellation stream started.",
  },
  providerError: {
    prompt: "[argmax-verification:provider-error]",
    diagnostic: "Verification provider failed as requested.",
    exitCode: 42,
  },
});

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitAtBarrier(name) {
  const controlDirectory = process.env.ARGMAX_VERIFICATION_CONTROL_DIR;
  if (!controlDirectory) return;
  await mkdir(controlDirectory, { recursive: true });
  await writeFile(join(controlDirectory, `${name}.ready`), "ready\n", "utf8");
  const releasePath = join(controlDirectory, `${name}.continue`);
  while (true) {
    try {
      await access(releasePath);
      return;
    } catch {
      await delay(10);
    }
  }
}

async function recordInvocation(args) {
  const path = process.env.ARGMAX_VERIFICATION_LOG;
  if (!path) return;
  await appendFile(
    path,
    `${JSON.stringify({ args, cwd: process.cwd(), home: process.env.HOME })}\n`,
    "utf8",
  );
}

async function emit(value, milliseconds = 20) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  await delay(milliseconds);
}

function optionValue(args, option) {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

function promptFrom(args) {
  const separator = args.lastIndexOf("--");
  return separator >= 0 ? args[separator + 1] ?? "" : "";
}

async function emitInit() {
  await emit({
    type: "system",
    subtype: "init",
    session_id: VERIFICATION_CONVERSATION_ID,
    model: VERIFICATION_PROVIDER.modelId,
  });
}

async function emitTextDelta(text) {
  await emit({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    session_id: VERIFICATION_CONVERSATION_ID,
  });
}

async function emitAssistant(content, id) {
  await emit({
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: VERIFICATION_PROVIDER.modelId,
      content,
      usage: {
        input_tokens: 12,
        output_tokens: 8,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    session_id: VERIFICATION_CONVERSATION_ID,
  });
}

async function emitSuccess(result) {
  await emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    session_id: VERIFICATION_CONVERSATION_ID,
  });
}

async function emitChildAssistant(text) {
  await emit({
    type: "assistant",
    message: {
      id: `verification-child-${text.includes("follow-up") ? "follow-up" : "first"}`,
      type: "message",
      role: "assistant",
      model: VERIFICATION_PROVIDER.modelId,
      content: [{ type: "text", text }],
      usage: {
        input_tokens: 4,
        output_tokens: 8,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    parent_tool_use_id: VERIFICATION_SUBAGENT.rootToolUseId,
    session_id: VERIFICATION_CONVERSATION_ID,
    subagent_type: VERIFICATION_SUBAGENT.subagentType,
    task_description: VERIFICATION_SUBAGENT.description,
  });
}

async function emitTaskStarted({ toolUseId, prompt, isBackgrounded }) {
  await emit({
    type: "system",
    subtype: "task_started",
    task_id: VERIFICATION_SUBAGENT.id,
    tool_use_id: toolUseId,
    description: VERIFICATION_SUBAGENT.description,
    subagent_type: VERIFICATION_SUBAGENT.subagentType,
    is_backgrounded: isBackgrounded,
    spawn_depth: 1,
    task_type: "local_agent",
    prompt,
    session_id: VERIFICATION_CONVERSATION_ID,
  });
}

async function emitTaskCompleted({ toolUseId, summary }) {
  await emit({
    type: "system",
    subtype: "task_updated",
    task_id: VERIFICATION_SUBAGENT.id,
    patch: { status: "completed", end_time: 1_788_675_207_644 },
    session_id: VERIFICATION_CONVERSATION_ID,
  });
  await emit({
    type: "system",
    subtype: "task_notification",
    task_id: VERIFICATION_SUBAGENT.id,
    tool_use_id: toolUseId,
    status: "completed",
    output_file: "/tmp/argmax-verification-child.output",
    summary,
    usage: { total_tokens: 12, tool_uses: 0, duration_ms: 20 },
    session_id: VERIFICATION_CONVERSATION_ID,
  });
}

async function runPersistentSubagentFirst(args) {
  if (args.includes("--resume")) {
    throw new Error("fresh persistent-subagent fixture unexpectedly received --resume");
  }
  await emitInit();
  await emitAssistant(
    [{
      type: "tool_use",
      id: VERIFICATION_SUBAGENT.rootToolUseId,
      name: "Agent",
      input: {
        description: VERIFICATION_SUBAGENT.description,
        prompt: "Reply with the first verification response.",
        subagent_type: VERIFICATION_SUBAGENT.subagentType,
        run_in_background: false,
      },
    }],
    "verification-persistent-parent-task",
  );
  await emitTaskStarted({
    toolUseId: VERIFICATION_SUBAGENT.rootToolUseId,
    prompt: "Reply with the first verification response.",
    isBackgrounded: false,
  });
  await emitChildAssistant(VERIFICATION_SCENARIOS.persistentSubagentFirst.visibleText);
  await emitTaskCompleted({
    toolUseId: VERIFICATION_SUBAGENT.rootToolUseId,
    summary: VERIFICATION_SCENARIOS.persistentSubagentFirst.visibleText,
  });
  await emit({
    type: "user",
    message: {
      role: "user",
      content: [{
        tool_use_id: VERIFICATION_SUBAGENT.rootToolUseId,
        type: "tool_result",
        content: [{ type: "text", text: VERIFICATION_SCENARIOS.persistentSubagentFirst.visibleText }],
      }],
    },
    session_id: VERIFICATION_CONVERSATION_ID,
    tool_use_result: {
      status: "completed",
      agentId: VERIFICATION_SUBAGENT.id,
      agentType: VERIFICATION_SUBAGENT.subagentType,
    },
  });
  await emitAssistant(
    [{ type: "text", text: "Verification parent first turn complete." }],
    "verification-persistent-parent-first",
  );
  await emitSuccess("Verification parent first turn complete.");
}

async function runPersistentSubagentSecond(args) {
  const resumeId = optionValue(args, "--resume");
  if (resumeId !== VERIFICATION_CONVERSATION_ID) {
    throw new Error(`persistent-subagent expected --resume ${VERIFICATION_CONVERSATION_ID}, received ${resumeId ?? "nothing"}`);
  }
  await emitInit();
  await emitAssistant(
    [{
      type: "tool_use",
      id: VERIFICATION_SUBAGENT.followUpToolUseId,
      name: "SendMessage",
      input: {
        to: VERIFICATION_SUBAGENT.id,
        message: "Reply with the follow-up verification response.",
        summary: "persistent verification follow-up",
      },
    }],
    "verification-persistent-parent-follow-up",
  );
  await emitTaskStarted({
    toolUseId: VERIFICATION_SUBAGENT.followUpToolUseId,
    prompt: "Reply with the follow-up verification response.",
    isBackgrounded: true,
  });
  await emit({
    type: "user",
    message: {
      role: "user",
      content: [{
        tool_use_id: VERIFICATION_SUBAGENT.followUpToolUseId,
        type: "tool_result",
        content: [{ type: "text", text: "Resuming verification persistent agent" }],
      }],
    },
    session_id: VERIFICATION_CONVERSATION_ID,
    tool_use_result: {
      success: true,
      resumedAgentId: VERIFICATION_SUBAGENT.id,
      pin: { id: VERIFICATION_SUBAGENT.id, name: VERIFICATION_SUBAGENT.id, ref: "fixture" },
    },
  });
  await emitChildAssistant(VERIFICATION_SCENARIOS.persistentSubagentSecond.visibleText);
  await emitTaskCompleted({
    toolUseId: VERIFICATION_SUBAGENT.followUpToolUseId,
    summary: VERIFICATION_SCENARIOS.persistentSubagentSecond.visibleText,
  });
  await emitAssistant(
    [{ type: "text", text: "Verification parent follow-up complete." }],
    "verification-persistent-parent-complete",
  );
  await emitSuccess("Verification parent follow-up complete.");
}

async function runFirstTurn(args) {
  if (args.includes("--resume")) {
    throw new Error("fresh chat-resume fixture unexpectedly received --resume");
  }
  await emitInit();
  await emitTextDelta("Verification first ");
  await emitTextDelta("turn complete.");
  await waitAtBarrier(VERIFICATION_BARRIERS.chatResumeStream);
  await emitAssistant(
    [
      {
        type: "tool_use",
        id: "verification-tool-read",
        name: "Read",
        input: { file_path: "README.md" },
      },
    ],
    "verification-message-tool",
  );
  await waitAtBarrier(VERIFICATION_BARRIERS.chatResumeTool);
  await emit({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "verification-tool-read",
          content: "Argmax verification fixture",
        },
      ],
    },
    session_id: VERIFICATION_CONVERSATION_ID,
  });
  await emitAssistant(
    [{ type: "text", text: VERIFICATION_SCENARIOS.chatResumeFirst.visibleText }],
    "verification-message-first",
  );
  await emitSuccess(VERIFICATION_SCENARIOS.chatResumeFirst.visibleText);
}

async function runSecondTurn(args) {
  const resumeId = optionValue(args, "--resume");
  if (resumeId !== VERIFICATION_CONVERSATION_ID) {
    throw new Error(
      `resume fixture expected --resume ${VERIFICATION_CONVERSATION_ID}, received ${resumeId ?? "nothing"}`,
    );
  }
  await emitInit();
  await emitTextDelta("Verification resumed ");
  await emitTextDelta("turn complete.");
  await emitAssistant(
    [{ type: "text", text: VERIFICATION_SCENARIOS.chatResumeSecond.visibleText }],
    "verification-message-second",
  );
  await emitSuccess(VERIFICATION_SCENARIOS.chatResumeSecond.visibleText);
}

async function runCancellation() {
  await emitInit();
  await emitTextDelta(VERIFICATION_SCENARIOS.cancellation.visibleText);
  await new Promise((resolve) => {
    const keepAlive = setInterval(() => {}, 60_000);
    process.once("SIGINT", () => {
      clearInterval(keepAlive);
      resolve();
    });
  });
}

async function runProviderError() {
  await emitInit();
  process.stderr.write(`${VERIFICATION_SCENARIOS.providerError.diagnostic}\n`);
  await delay(20);
  process.exitCode = VERIFICATION_SCENARIOS.providerError.exitCode;
}

export async function runProviderFixture(args = process.argv.slice(2)) {
  await recordInvocation(args);
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write("Claude Code verification fixture 1.0.0\n");
    return;
  }
  if (args[0] === "auth" && args[1] === "status") {
    process.stdout.write('{"authenticated":true,"fixture":true}\n');
    return;
  }

  const prompt = promptFrom(args);
  if (args.includes("text") && !prompt.includes("[argmax-verification:")) {
    process.stdout.write("Argmax Verification Chat\n");
    return;
  }
  if (prompt.includes(VERIFICATION_SCENARIOS.chatResumeFirst.prompt)) {
    await runFirstTurn(args);
    return;
  }
  if (prompt.includes(VERIFICATION_SCENARIOS.chatResumeSecond.prompt)) {
    await runSecondTurn(args);
    return;
  }
  if (prompt.includes(VERIFICATION_SCENARIOS.persistentSubagentFirst.prompt)) {
    await runPersistentSubagentFirst(args);
    return;
  }
  if (prompt.includes(VERIFICATION_SCENARIOS.persistentSubagentSecond.prompt)) {
    await runPersistentSubagentSecond(args);
    return;
  }
  if (prompt.includes(VERIFICATION_SCENARIOS.cancellation.prompt)) {
    await runCancellation();
    return;
  }
  if (prompt.includes(VERIFICATION_SCENARIOS.providerError.prompt)) {
    await runProviderError();
    return;
  }
  throw new Error(
    "verification fixture refused an unknown invocation; no real provider fallback is available",
  );
}

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  runProviderFixture().catch((error) => {
    process.stderr.write(`Argmax verification fixture: ${error.message}\n`);
    process.exitCode = 64;
  });
}
