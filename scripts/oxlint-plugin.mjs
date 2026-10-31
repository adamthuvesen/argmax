// Project lint rules that oxlint has no built-in for. Loaded by .oxlintrc.json
// as the `argmax` plugin; scripts/lint.mjs ratchets their existing violations.

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
                "Route timeline semantics through decodeTimelineEvent(). Keep raw payload access for lossless debug bodies and large tool input or output only.",
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
    "no-container": {
      create(context) {
        return {
          MemberExpression(node) {
            if (node.object.type !== "Identifier" || node.object.name !== "container") return;
            context.report({
              node,
              message:
                "Query by role, label, or title through screen instead of the render container.",
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
                "Query by role, label, or title through screen instead of walking DOM nodes.",
            });
          },
        };
      },
    },
  },
};
