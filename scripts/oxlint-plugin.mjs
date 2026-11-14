// Project lint rules that oxlint has no built-in for. Loaded by .oxlintrc.json
// as the `argmax` plugin; every hit fails `npm run lint`.
//
// no-timeline-payload-access is off in src/renderer/lib/toolCalls.ts (see
// .oxlintrc.json): its extract* functions are the accessors that read provider
// payload fields, so they cannot go through decodeTimelineEvent().

const TIMELINE_PAYLOAD_FIELDS = new Set([
  "thinking",
  "traceImported",
  "traceSyntheticSuperseded",
  "item_type",
  "item",
  "thread_id",
  "sender_thread_id",
  "parent_tool_use_id",
  "preTokens",
  "postTokens",
  "from",
  "provider",
  "modelLabel",
  "checkoutMode",
  "sourceProjectName",
  "destinationProjectName",
  "sourceArchiveState",
  "direction",
  "sourceSessionId",
  "destinationSessionId",
  "destinationWorkspaceId",
  "childSessionId",
  "taskLabel",
  "prompt",
  "worktree",
  "state",
  "answer",
  "id",
  "call_id",
  "tool_use_id",
  "providerInvocationId",
  "name",
  "status",
  "raw",
  "traceSyntheticLaunch",
]);
const SESSION_LIKE = new Set([
  "session",
  "routine",
  "previousSession",
  "openSession",
  "parentSession",
  "sourceSession",
]);
const MODEL_RESOLVERS = new Set(["resolveModelId", "modelLabelFor", "contextWindowForModel"]);
const GLOBAL_OBJECTS = new Set(["window", "globalThis", "global", "self", "view"]);
const DOM_TRAVERSAL = new Set([
  "activeElement",
  "children",
  "childElementCount",
  "firstChild",
  "firstElementChild",
  "fullscreenElement",
  "lastChild",
  "lastElementChild",
  "nextElementSibling",
  "nextSibling",
  "parentElement",
  "parentNode",
  "pointerLockElement",
  "previousElementSibling",
  "previousSibling",
  "rootNode",
  "scripts",
  "closest",
  "getElementById",
  "getElementsByClassName",
  "getElementsByName",
  "getElementsByTagName",
  "getElementsByTagNameNS",
  "querySelector",
  "querySelectorAll",
]);

function propertyName(member) {
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  if (member.computed && member.property.type === "Literal") return String(member.property.value);
  return undefined;
}

function isPayloadObject(object) {
  if (object.type === "Identifier") return object.name === "payload";
  return (
    object.type === "MemberExpression" && !object.computed && object.property.name === "payload"
  );
}

function isResolverArgument(member) {
  let node = member;
  if (node.parent?.type === "ChainExpression") node = node.parent;
  const call = node.parent;
  return (
    call?.type === "CallExpression" &&
    call.callee.type === "Identifier" &&
    MODEL_RESOLVERS.has(call.callee.name)
  );
}

export default {
  meta: { name: "argmax" },
  rules: {
    "no-timeline-payload-access": {
      create(context) {
        return {
          MemberExpression(node) {
            if (!isPayloadObject(node.object) || !TIMELINE_PAYLOAD_FIELDS.has(propertyName(node)))
              return;
            context.report({
              node,
              message:
                "Read timeline fields through decodeTimelineEvent() from src/renderer/lib/canonicalTimeline.ts. Raw payload access is only for lossless debug bodies and large tool input or output.",
            });
          },
        };
      },
    },
    "no-raw-model-id": {
      create(context) {
        return {
          MemberExpression(node) {
            if (propertyName(node) !== "modelId" || node.object.type !== "Identifier") return;
            if (!SESSION_LIKE.has(node.object.name) || isResolverArgument(node)) return;
            context.report({
              node,
              message:
                "A stored model id can be retired. Read it through resolveModelId(provider, id) from src/shared/providerModels.ts.",
            });
          },
        };
      },
    },
    "no-real-time": {
      create(context) {
        const CLOCK_FIX =
          "Use vi.useFakeTimers() with vi.setSystemTime(FIXED) or a literal date; a real clock read makes tests nondeterministic.";
        const TIMER_FIX =
          "Use vi.useFakeTimers() and vi.advanceTimersByTimeAsync; real timers make tests slow and flaky.";
        return {
          MemberExpression(node) {
            const name = propertyName(node);
            if (node.object.type !== "Identifier") return;
            const object = node.object.name;
            if (object === "Date" && name === "now") {
              context.report({ node, message: `Date.now() reads the real clock. ${CLOCK_FIX}` });
            } else if (object === "performance" && name === "now") {
              context.report({
                node,
                message: `performance.now() reads the real clock. Assert behavior or counts, not elapsed time; or ${CLOCK_FIX}`,
              });
            } else if (
              (name === "setTimeout" || name === "setInterval") &&
              GLOBAL_OBJECTS.has(object)
            ) {
              context.report({
                node,
                message: `${object}.${name} waits on a real timer. ${TIMER_FIX}`,
              });
            }
          },
          NewExpression(node) {
            if (node.callee.type !== "Identifier" || node.callee.name !== "Date") return;
            if (node.arguments.length > 0) return;
            context.report({ node, message: `new Date() reads the real clock. ${CLOCK_FIX}` });
          },
        };
      },
    },
    "no-container": {
      create(context) {
        return {
          MemberExpression(node) {
            if (node.object.type !== "Identifier" || node.object.name !== "container") return;
            context.report({
              node,
              message:
                "Tests do not read the render container. Query by role, label, or title with screen from @testing-library/react.",
            });
          },
        };
      },
    },
    "no-node-access": {
      create(context) {
        return {
          MemberExpression(node) {
            if (!DOM_TRAVERSAL.has(propertyName(node))) return;
            context.report({
              node,
              message:
                "Tests do not walk DOM nodes. Query by role, label, or title with screen from @testing-library/react.",
            });
          },
        };
      },
    },
  },
};
