#!/usr/bin/env node

import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export const VERIFICATION_PROVIDER = Object.freeze({
  provider: "claude",
  modelId: "claude-sonnet-5",
  modelLabel: "Sonnet 5",
  modeEnv: "ARGMAX_VERIFICATION",
  binaryEnv: "ARGMAX_VERIFICATION_CLAUDE_BINARY",
  homeEnv: "ARGMAX_VERIFICATION_HOME",
});

export const VERIFICATION_CODEX_PROVIDER = Object.freeze({
  provider: "codex",
  modelId: "gpt-5.6-luna",
  modelLabel: "GPT-5.6 Luna",
  modeEnv: "ARGMAX_VERIFICATION",
  binaryEnv: "ARGMAX_VERIFICATION_CODEX_BINARY",
  homeEnv: "ARGMAX_VERIFICATION_HOME",
});

export const VERIFICATION_OPENCODE_PROVIDER = Object.freeze({
  provider: "opencode",
  modelId: "opencode/big-pickle",
  modelLabel: "Big Pickle",
  modeEnv: "ARGMAX_VERIFICATION",
  binaryEnv: "ARGMAX_VERIFICATION_OPENCODE_BINARY",
  homeEnv: "ARGMAX_VERIFICATION_HOME",
});

export const VERIFICATION_CURSOR_PROVIDER = Object.freeze({
  provider: "cursor",
  modelId: "cursor-grok-4.6-medium",
  modelLabel: "Grok 4.6 (Cursor)",
  modeEnv: "ARGMAX_VERIFICATION",
  binaryEnv: "ARGMAX_VERIFICATION_CURSOR_BINARY",
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

export const VERIFICATION_CODEX_SUBAGENT = Object.freeze({
  id: "019f2214-c736-7f60-bb78-75b6ecff57a3",
  rootToolUseId: "verification-codex-spawn-agent",
  followUpToolUseId: "verification-codex-send-input",
  description: "Verification persistent Codex child",
});

export const VERIFICATION_OPENCODE_SUBAGENT = Object.freeze({
  id: "ses_argmax_verification_child",
  rootToolUseId: "call_argmax_task_first",
  followUpToolUseId: "call_argmax_task_follow_up",
  description: "Verification persistent OpenCode child",
});

export const VERIFICATION_CURSOR_SUBAGENT = Object.freeze({
  id: "077b8dfb-bb6b-4603-b718-b0ffa9808ef2",
  initialAgentId: "f29e3566-30af-4903-b054-b382fa3754e4",
  rootToolUseId: "tool_cursor_task_first",
  followUpToolUseId: "tool_cursor_task_follow_up",
  description: "Verification persistent Cursor child",
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
  persistentCodexSubagentFirst: {
    prompt: "[argmax-verification:persistent-codex-subagent:first]",
    visibleText: "Verification persistent Codex child first response.",
  },
  persistentCodexSubagentSecond: {
    prompt: "[argmax-verification:persistent-codex-subagent:second]",
    visibleText: "Verification persistent Codex child follow-up response.",
    resumeConversationId: VERIFICATION_CONVERSATION_ID,
  },
  persistentOpencodeSubagentFirst: {
    prompt: "[argmax-verification:persistent-opencode-subagent:first]",
    visibleText: "Verification persistent OpenCode child first response.",
  },
  persistentOpencodeSubagentSecond: {
    prompt: "[argmax-verification:persistent-opencode-subagent:second]",
    visibleText: "Verification persistent OpenCode child follow-up response.",
    resumeConversationId: VERIFICATION_CONVERSATION_ID,
  },
  persistentCursorSubagentFirst: {
    prompt: "[argmax-verification:persistent-cursor-subagent:first]",
    visibleText: "Verification persistent Cursor child first response.",
  },
  persistentCursorSubagentSecond: {
    prompt: "[argmax-verification:persistent-cursor-subagent:second]",
    visibleText: "Verification persistent Cursor child follow-up response.",
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
    `${JSON.stringify({ args, cwd: process.cwd(), home: process.env.HOME, backgroundWaitCeiling: process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS })}\n`,
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

async function promptFrom(args) {
  const separator = args.lastIndexOf("--");
  if (separator >= 0) return args[separator + 1] ?? "";
  if (optionValue(args, "--input-format") === "stream-json") {
    const lines = createInterface({ input: process.stdin });
    try {
      for await (const line of lines) {
        const message = JSON.parse(line);
        if (message.type === "control_request" && message.request?.subtype === "initialize") {
          await emit({
            type: "control_response",
            response: { subtype: "success", request_id: message.request_id, response: {} },
          });
        } else if (message.type === "user" && typeof message.message?.content === "string") {
          return message.message.content;
        } else {
          throw new Error("verification fixture received an unsupported control input");
        }
      }
      throw new Error("verification fixture input ended before the user prompt");
    } finally {
      lines.close();
      process.stdin.pause();
    }
  }
  if (args.at(-1) !== "-") return "";
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  return prompt;
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

function opencodeTaskPart({ callId, childId, prompt, visibleText, continuation = false }) {
  return {
    id: `${callId}-part`,
    type: "tool",
    sessionID: VERIFICATION_CONVERSATION_ID,
    messageID: `${callId}-message`,
    callID: callId,
    tool: "task",
    state: {
      status: "completed",
      metadata: {
        parentSessionId: VERIFICATION_CONVERSATION_ID,
        sessionId: childId,
      },
      input: {
        description: VERIFICATION_OPENCODE_SUBAGENT.description,
        prompt,
        subagent_type: "general",
        ...(continuation ? { task_id: childId } : {}),
      },
      output: `<task id="${childId}" state="completed">\n<task_result>\n${visibleText}\n</task_result>\n</task>`,
    },
  };
}

function writeJsonRpc(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function codexNotification(method, params) {
  writeJsonRpc({ jsonrpc: "2.0", method, params });
}

function codexCollabItem({ id, tool, prompt = null, childStatus, message = null }) {
  return {
    id,
    type: "collabAgentToolCall",
    tool,
    status: "completed",
    senderThreadId: VERIFICATION_CONVERSATION_ID,
    receiverThreadIds: [VERIFICATION_CODEX_SUBAGENT.id],
    prompt,
    agentsStates: {
      [VERIFICATION_CODEX_SUBAGENT.id]: { status: childStatus, message },
    },
  };
}

function emitCodexItem(turnId, item) {
  codexNotification("item/started", {
    threadId: VERIFICATION_CONVERSATION_ID,
    turnId,
    item: { ...item, status: "inProgress", agentsStates: {} },
  });
  codexNotification("item/completed", {
    threadId: VERIFICATION_CONVERSATION_ID,
    turnId,
    item,
  });
}

function emitCodexTurn(prompt, turnId, resumed) {
  const child = VERIFICATION_CODEX_SUBAGENT;
  const first = prompt.includes(VERIFICATION_SCENARIOS.persistentCodexSubagentFirst.prompt);
  const second = prompt.includes(VERIFICATION_SCENARIOS.persistentCodexSubagentSecond.prompt);
  if (!first && !second) {
    throw new Error("Codex app-server fixture received an unknown verification prompt");
  }
  if (first === resumed) {
    throw new Error(first
      ? "fresh Codex scenario unexpectedly resumed a thread"
      : "follow-up Codex scenario did not resume its thread");
  }
  const visibleText = first
    ? VERIFICATION_SCENARIOS.persistentCodexSubagentFirst.visibleText
    : VERIFICATION_SCENARIOS.persistentCodexSubagentSecond.visibleText;

  codexNotification("turn/started", {
    threadId: VERIFICATION_CONVERSATION_ID,
    turn: { id: turnId, status: "inProgress", items: [] },
  });
  if (first) {
    emitCodexItem(turnId, codexCollabItem({
      id: child.rootToolUseId,
      tool: "spawnAgent",
      prompt: "Reply with the first persistent Codex verification response.",
      childStatus: "pendingInit",
    }));
  } else {
    emitCodexItem(turnId, codexCollabItem({
      id: "verification-codex-resume-agent",
      tool: "resumeAgent",
      childStatus: "pendingInit",
    }));
    emitCodexItem(turnId, codexCollabItem({
      id: child.followUpToolUseId,
      tool: "sendInput",
      prompt: "Reply with the follow-up persistent Codex verification response.",
      childStatus: "pendingInit",
    }));
  }
  emitCodexItem(turnId, codexCollabItem({
    id: first ? "verification-codex-wait-pending-first" : "verification-codex-wait-pending-follow-up",
    tool: "wait",
    childStatus: "pendingInit",
  }));
  emitCodexItem(turnId, codexCollabItem({
    id: first ? "verification-codex-wait-first" : "verification-codex-wait-follow-up",
    tool: "wait",
    childStatus: "completed",
    message: visibleText,
  }));
  codexNotification("item/completed", {
    threadId: VERIFICATION_CONVERSATION_ID,
    turnId,
    item: {
      id: first ? "verification-codex-parent-first" : "verification-codex-parent-follow-up",
      type: "agentMessage",
      text: first
        ? "Verification Codex parent first turn complete."
        : "Verification Codex parent follow-up complete.",
    },
  });
  codexNotification("thread/tokenUsage/updated", {
    threadId: VERIFICATION_CONVERSATION_ID,
    turnId,
    tokenUsage: { total: { inputTokens: 24, cachedInputTokens: 8, outputTokens: 12 } },
  });
  codexNotification("turn/completed", {
    threadId: VERIFICATION_CONVERSATION_ID,
    turn: { id: turnId, status: "completed", items: [] },
  });
}

async function runCodexAppServer(args) {
  if (args.join(" ") !== "app-server --stdio") {
    throw new Error(`unsupported Codex app-server arguments: ${args.join(" ")}`);
  }
  const lines = createInterface({ input: process.stdin });
  let resumed = false;
  for await (const line of lines) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      throw new Error("Codex app-server fixture received malformed JSON-RPC");
    }
    const { id, method, params = {} } = request;
    if (method === "initialized" && id === undefined) continue;
    if (id === undefined) {
      throw new Error(`Codex app-server fixture received unsupported notification ${method ?? "<missing>"}`);
    }
    if (method === "initialize") {
      writeJsonRpc({ jsonrpc: "2.0", id, result: { userAgent: "argmax-verification" } });
    } else if (method === "thread/start") {
      resumed = false;
      writeJsonRpc({ jsonrpc: "2.0", id, result: { thread: { id: VERIFICATION_CONVERSATION_ID } } });
    } else if (method === "thread/resume" || method === "thread/fork") {
      if (params.threadId !== VERIFICATION_CONVERSATION_ID) {
        writeJsonRpc({ jsonrpc: "2.0", id, error: { code: -32602, message: "unexpected threadId" } });
        continue;
      }
      resumed = true;
      writeJsonRpc({ jsonrpc: "2.0", id, result: { thread: { id: VERIFICATION_CONVERSATION_ID } } });
    } else if (method === "turn/start") {
      if (params.threadId !== VERIFICATION_CONVERSATION_ID) {
        writeJsonRpc({ jsonrpc: "2.0", id, error: { code: -32602, message: "unexpected threadId" } });
        continue;
      }
      const prompt = Array.isArray(params.input)
        ? params.input.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n")
        : "";
      const turnId = `argmax-verification-turn-${resumed ? "follow-up" : "first"}`;
      const first = prompt.includes(VERIFICATION_SCENARIOS.persistentCodexSubagentFirst.prompt);
      const second = prompt.includes(VERIFICATION_SCENARIOS.persistentCodexSubagentSecond.prompt);
      if ((!first && !second) || first === resumed) {
        writeJsonRpc({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Codex fixture received an unexpected scenario or thread mode" },
        });
        continue;
      }
      writeJsonRpc({ jsonrpc: "2.0", id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      emitCodexTurn(prompt, turnId, resumed);
    } else {
      writeJsonRpc({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported method ${method}` } });
    }
  }
}

function opencodeScenarioParts(prompt) {
  const first = prompt.includes(VERIFICATION_SCENARIOS.persistentOpencodeSubagentFirst.prompt);
  const second = prompt.includes(VERIFICATION_SCENARIOS.persistentOpencodeSubagentSecond.prompt);
  if (!first && !second) throw new Error("OpenCode fixture received an unknown verification prompt");
  const definition = first
    ? VERIFICATION_SCENARIOS.persistentOpencodeSubagentFirst
    : VERIFICATION_SCENARIOS.persistentOpencodeSubagentSecond;
  const callId = first
    ? VERIFICATION_OPENCODE_SUBAGENT.rootToolUseId
    : VERIFICATION_OPENCODE_SUBAGENT.followUpToolUseId;
  return [
    { id: `${callId}-start`, type: "step-start", sessionID: VERIFICATION_CONVERSATION_ID, messageID: `${callId}-message` },
    opencodeTaskPart({
      callId,
      childId: VERIFICATION_OPENCODE_SUBAGENT.id,
      prompt: first
        ? "Reply with the first persistent OpenCode verification response."
        : "Reply with the follow-up persistent OpenCode verification response.",
      visibleText: definition.visibleText,
      continuation: second,
    }),
    {
      id: `${callId}-text`,
      type: "text",
      sessionID: VERIFICATION_CONVERSATION_ID,
      messageID: `${callId}-message`,
      text: first
        ? "Verification OpenCode parent first turn complete."
        : "Verification OpenCode parent follow-up complete.",
      time: { start: 1_788_675_207_600, end: 1_788_675_207_640 },
    },
    {
      id: `${callId}-finish`,
      type: "step-finish",
      sessionID: VERIFICATION_CONVERSATION_ID,
      messageID: `${callId}-message`,
      reason: "stop",
      tokens: { input: 24, output: 12, reasoning: 0, cache: { read: 8, write: 0 } },
      cost: 0,
    },
  ];
}

async function readRequestJson(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

async function runOpencodeServer(args) {
  if (args[0] !== "serve") throw new Error(`unsupported OpenCode arguments: ${args.join(" ")}`);
  const hostname = optionValue(args, "--hostname");
  const port = Number(optionValue(args, "--port"));
  if (hostname !== "127.0.0.1" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("OpenCode fixture requires a valid 127.0.0.1 serve port");
  }
  const username = process.env.OPENCODE_SERVER_USERNAME;
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!username || !password) throw new Error("OpenCode fixture requires server credentials");
  const expectedAuthorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const streams = new Set();
  const broadcast = (event) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const stream of streams) stream.write(line);
  };

  const server = createServer(async (request, response) => {
    const fail = (status, message) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: message }));
    };
    try {
      if (request.headers.authorization !== expectedAuthorization) {
        fail(401, "invalid verification fixture authorization");
        return;
      }
      const url = new URL(request.url ?? "/", `http://${hostname}:${port}`);
      if (request.method === "GET" && url.pathname === "/global/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ healthy: true }));
      } else if (request.method === "GET" && url.pathname === "/event") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        streams.add(response);
        response.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
        request.on("close", () => streams.delete(response));
      } else if (request.method === "POST" && url.pathname === "/session") {
        await readRequestJson(request);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ id: VERIFICATION_CONVERSATION_ID }));
      } else if (request.method === "POST" && /^\/session\/[^/]+\/prompt_async$/.test(url.pathname)) {
        const sessionId = url.pathname.split("/")[2];
        if (sessionId !== VERIFICATION_CONVERSATION_ID) {
          fail(422, "unexpected OpenCode session id");
          return;
        }
        const body = await readRequestJson(request);
        const prompt = Array.isArray(body.parts)
          ? body.parts.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n")
          : "";
        const parts = opencodeScenarioParts(prompt);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("true");
        setTimeout(() => {
          for (const part of parts) {
            broadcast({ type: "message.part.updated", properties: { part } });
          }
          broadcast({
            type: "session.status",
            properties: { sessionID: VERIFICATION_CONVERSATION_ID, status: { type: "idle" } },
          });
        }, 10);
      } else {
        fail(404, `unsupported OpenCode fixture route ${request.method} ${url.pathname}`);
      }
    } catch (error) {
      fail(400, error.message);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, resolve);
  });
  await new Promise(() => {});
}

async function emitCursorEvent(value) {
  await emit({ ...value, session_id: VERIFICATION_CONVERSATION_ID });
}

function cursorTaskData({ callId, visibleText, continuation = false }) {
  const child = VERIFICATION_CURSOR_SUBAGENT;
  const args = {
    description: child.description,
    prompt: continuation
      ? "Reply with the follow-up persistent Cursor verification response."
      : "Reply with the first persistent Cursor verification response.",
    subagentType: { unspecified: {} },
    model: VERIFICATION_CURSOR_PROVIDER.modelId,
    ...(continuation
      ? { resume: child.id, agentId: child.id }
      : { agentId: child.initialAgentId }),
    attachments: [],
    mode: "TASK_MODE_UNSPECIFIED",
    respondingToMessageIds: [],
    environment: "SUBAGENT_EXECUTION_ENVIRONMENT_UNSPECIFIED",
    machine: { sameMachine: {} },
  };
  const success = {
    conversationSteps: [{ assistantMessage: { text: visibleText } }],
    agentId: child.id,
    isBackground: false,
    durationMs: "2164",
    backgroundReason: "SUBAGENT_BACKGROUND_REASON_UNSPECIFIED",
  };
  return { args, success };
}

async function emitCursorTask({ callId, visibleText, continuation = false }) {
  const { args, success } = cursorTaskData({ callId, visibleText, continuation });
  const wrapper = {
    taskToolCall: {
      args,
      hookAdditionalContexts: [],
      toolCallId: callId,
      startedAtMs: "1788681638528",
      ...(continuation ? {} : {}),
    },
  };
  await emitCursorEvent({
    type: "tool_call",
    subtype: "started",
    call_id: callId,
    tool_call: wrapper,
  });
  await emitCursorEvent({
    type: "tool_call",
    subtype: "completed",
    call_id: callId,
    tool_call: {
      ...wrapper,
      taskToolCall: {
        ...wrapper.taskToolCall,
        result: { success },
        completedAtMs: "1788681641752",
      },
    },
  });
}

async function runPersistentCursorSubagentFirst(args) {
  if (args.includes("--resume")) throw new Error("fresh persistent-cursor-subagent fixture unexpectedly received --resume");
  const definition = VERIFICATION_SCENARIOS.persistentCursorSubagentFirst;
  await emitCursorEvent({ type: "system", subtype: "init", model: VERIFICATION_CURSOR_PROVIDER.modelId });
  await emitCursorTask({ callId: VERIFICATION_CURSOR_SUBAGENT.rootToolUseId, visibleText: definition.visibleText });
  await emitCursorEvent({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Verification Cursor parent first turn complete." }] } });
  await emitCursorEvent({ type: "result", subtype: "success", is_error: false, result: "Verification Cursor parent first turn complete." });
}

async function runPersistentCursorSubagentSecond(args) {
  if (!args.includes("--resume")) throw new Error("persistent-cursor-subagent fixture expected cursor --resume");
  const definition = VERIFICATION_SCENARIOS.persistentCursorSubagentSecond;
  await emitCursorEvent({ type: "system", subtype: "init", model: VERIFICATION_CURSOR_PROVIDER.modelId });
  await emitCursorTask({ callId: VERIFICATION_CURSOR_SUBAGENT.followUpToolUseId, visibleText: definition.visibleText, continuation: true });
  await emitCursorEvent({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Verification Cursor parent follow-up complete." }] } });
  await emitCursorEvent({ type: "result", subtype: "success", is_error: false, result: "Verification Cursor parent follow-up complete." });
}

function cursorAcpUpdate(update) {
  writeJsonRpc({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: VERIFICATION_CONVERSATION_ID, update },
  });
}

function emitCursorAcpTurn(prompt) {
  const first = prompt.includes(VERIFICATION_SCENARIOS.persistentCursorSubagentFirst.prompt);
  const second = prompt.includes(VERIFICATION_SCENARIOS.persistentCursorSubagentSecond.prompt);
  if (!first && !second) throw new Error("Cursor ACP fixture received an unknown verification prompt");
  const definition = first
    ? VERIFICATION_SCENARIOS.persistentCursorSubagentFirst
    : VERIFICATION_SCENARIOS.persistentCursorSubagentSecond;
  const callId = first
    ? VERIFICATION_CURSOR_SUBAGENT.rootToolUseId
    : VERIFICATION_CURSOR_SUBAGENT.followUpToolUseId;
  const { args, success } = cursorTaskData({
    callId,
    visibleText: definition.visibleText,
    continuation: second,
  });
  cursorAcpUpdate({
    sessionUpdate: "tool_call",
    toolCallId: callId,
    title: "task",
    kind: "other",
    status: "pending",
    rawInput: { _toolName: "task", ...args },
  });
  cursorAcpUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: callId,
    title: "task",
    kind: "other",
    status: "completed",
    rawOutput: { success },
  });
  cursorAcpUpdate({
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: first
        ? "Verification Cursor parent first turn complete."
        : "Verification Cursor parent follow-up complete.",
    },
  });
}

async function runCursorAcp(args) {
  if (args.at(-1) !== "acp") throw new Error(`unsupported Cursor ACP arguments: ${args.join(" ")}`);
  const models = { availableModels: [{ modelId: "grok-4.6[effort=medium]" }] };
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      throw new Error("Cursor ACP fixture received malformed JSON-RPC");
    }
    const { id, method, params = {} } = request;
    if (id === undefined) throw new Error(`Cursor ACP fixture received unsupported notification ${method ?? "<missing>"}`);
    const result = (value) => writeJsonRpc({ jsonrpc: "2.0", id, result: value });
    const invalid = (message) => writeJsonRpc({ jsonrpc: "2.0", id, error: { code: -32602, message } });
    if (method === "initialize") {
      result({ protocolVersion: 1 });
    } else if (method === "session/new") {
      result({ sessionId: VERIFICATION_CONVERSATION_ID, models });
    } else if (method === "session/load") {
      if (params.sessionId !== VERIFICATION_CONVERSATION_ID) invalid("unexpected sessionId");
      else result({ sessionId: VERIFICATION_CONVERSATION_ID, models });
    } else if (method === "session/set_model") {
      if (params.sessionId !== VERIFICATION_CONVERSATION_ID || !String(params.modelId).startsWith("grok-4.6")) {
        invalid("unexpected Cursor model selection");
      } else result({});
    } else if (method === "session/set_mode") {
      if (params.sessionId !== VERIFICATION_CONVERSATION_ID || params.modeId !== "agent") {
        invalid("unexpected Cursor mode selection");
      } else result({});
    } else if (method === "session/prompt") {
      if (params.sessionId !== VERIFICATION_CONVERSATION_ID) {
        invalid("unexpected sessionId");
        continue;
      }
      const prompt = Array.isArray(params.prompt)
        ? params.prompt.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("\n")
        : "";
      try {
        emitCursorAcpTurn(prompt);
        result({ stopReason: "end_turn" });
      } catch (error) {
        invalid(error.message);
      }
    } else {
      writeJsonRpc({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported method ${method}` } });
    }
  }
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
    process.stdout.write("Provider verification fixture 1.0.0\n");
    return;
  }
  if (args[0] === "auth" && args[1] === "status") {
    process.stdout.write('{"authenticated":true,"fixture":true}\n');
    return;
  }
  if (args[0] === "login" && args[1] === "status") {
    process.stdout.write('{"logged_in":true,"fixture":true}\n');
    return;
  }
  if (args[0] === "app-server") {
    await runCodexAppServer(args);
    return;
  }
  if (args[0] === "serve") {
    await runOpencodeServer(args);
    return;
  }
  if (args.at(-1) === "acp") {
    await runCursorAcp(args);
    return;
  }

  const prompt = await promptFrom(args);
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
  if (prompt.includes(VERIFICATION_SCENARIOS.persistentCursorSubagentFirst.prompt)) {
    await runPersistentCursorSubagentFirst(args);
    return;
  }
  if (prompt.includes(VERIFICATION_SCENARIOS.persistentCursorSubagentSecond.prompt)) {
    await runPersistentCursorSubagentSecond(args);
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
