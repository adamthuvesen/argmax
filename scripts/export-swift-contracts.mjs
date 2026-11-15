import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
// TypeScript 7 ships no synchronous compiler API; this script reads the AST through the 5.x package (`typescript-5`).
import ts from "typescript-5";

const root = resolve(import.meta.dirname, "..");
const sourcePath = resolve(root, "src/shared/bindings.d.ts");
const outputPath = resolve(root, "ios/Argmax/Sources/Bridge/GeneratedWireContracts.swift");
const semanticOutputPath = resolve(
  root,
  "ios/Argmax/Sources/Transcript/GeneratedTimelineSemantics.swift",
);
const responseOutputPath = resolve(root, "ios/Argmax/Sources/Bridge/GeneratedWireResponses.swift");
const source = ts.createSourceFile(
  sourcePath,
  readFileSync(sourcePath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const aliases = new Map(
  source.statements
    .filter(ts.isTypeAliasDeclaration)
    .map((declaration) => [declaration.name.text, declaration]),
);

// The phone's request contracts. Responses are declared below; every other
// model the phone keeps is its own presentation.
const requests = [
  "AgentReference",
  "ProjectsListBranchesInput",
  "ProvidersDiscoverInput",
  "WorkspacesCreateIsolatedInput",
  "WorkspacesCreateCurrentInput",
  "WorkspacesCreateScratchInput",
  "ProvidersLaunchInput",
  "WorkspacesAutotitleInput",
  "ComposerAttachmentInput",
  "AttachmentsSaveImageInput",
  "ProvidersSendInput",
  "QuestionsResolveInput",
  "ProvidersTerminateInput",
  "ProvidersCancelQueuedMessageInput",
  "ProvidersSendQueuedMessageNowInput",
  "SessionMultitaskInput",
  "WorkspacesSetPinnedInput",
  "WorkspacesSetLabelInput",
  "WorkspacesArchiveInput",
  "SessionForkInput",
  "RemoteRegisterPushDeviceInput",
  "RemoteUnregisterPushDeviceInput",
];
const enums = new Set();
const objects = new Set(requests);

function alias(name) {
  const declaration = aliases.get(name);
  if (!declaration) throw new Error(`Missing Rust binding: ${name}`);
  return declaration.type;
}

function literalValues(node) {
  const members = ts.isUnionTypeNode(node) ? node.types : [node];
  if (
    members.every((member) => ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal))
  ) {
    return members.map((member) => member.literal.text);
  }
  return null;
}

function removeNull(node) {
  if (!ts.isUnionTypeNode(node)) return { type: node, nullable: false };
  const members = node.types.filter(
    (member) =>
      member.kind !== ts.SyntaxKind.NullKeyword &&
      !(ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword),
  );
  if (members.length === node.types.length) return { type: node, nullable: false };
  if (members.length !== 1) throw new Error(`Unsupported nullable union: ${node.getText(source)}`);
  return { type: members[0], nullable: true };
}

function swiftType(node) {
  if (node.kind === ts.SyntaxKind.StringKeyword) return "String";
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return "Bool";
  if (node.kind === ts.SyntaxKind.NumberKeyword) return "Int";
  if (ts.isArrayTypeNode(node)) return `[${swiftType(node.elementType)}]`;
  if (ts.isParenthesizedTypeNode(node)) return swiftType(node.type);
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText(source);
    if (name === "Partial" && node.typeArguments?.length === 1)
      return swiftType(node.typeArguments[0]);
    if (objects.has(name)) return `Wire${name}`;
    const target = alias(name);
    if (literalValues(target)) {
      enums.add(name);
      return `Wire${name}`;
    }
    return swiftType(target);
  }
  if (
    ts.isTypeLiteralNode(node) &&
    node.members.length === 1 &&
    ts.isIndexSignatureDeclaration(node.members[0])
  ) {
    const signature = node.members[0];
    return `[String: ${swiftType(signature.type)}]`;
  }
  if (ts.isMappedTypeNode(node) && node.type) return `[String: ${swiftType(node.type)}]`;
  throw new Error(`Unsupported Swift wire type: ${node.getText(source)}`);
}

function fields(name) {
  const node = alias(name);
  if (!ts.isTypeLiteralNode(node)) throw new Error(`${name} is not a Rust object binding`);
  return node.members.map((member) => {
    if (
      !ts.isPropertySignature(member) ||
      !member.type ||
      !member.name ||
      !ts.isIdentifier(member.name)
    ) {
      throw new Error(`Unsupported field in ${name}: ${member.getText(source)}`);
    }
    const { type, nullable } = removeNull(member.type);
    return {
      name: member.name.text,
      type: swiftType(type),
      presence: Boolean(member.questionToken) || nullable,
    };
  });
}

function enumCase(value) {
  const words = value.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const name = words
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : word[0].toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join("");
  return /^[0-9]/.test(name) ? `value${name}` : name;
}

const requestFields = new Map(requests.map((name) => [name, fields(name)]));
const lines = [
  "// Generated from src/shared/bindings.d.ts by scripts/export-swift-contracts.mjs.",
  "// Change the Rust contract and run `npm run generate:contracts`.",
  "import Foundation",
  "",
  "enum WireField<Value: Encodable & Sendable>: Sendable {",
  "    case absent",
  "    case null",
  "    case value(Value)",
  "",
  "    func encode<Key: CodingKey>(into container: inout KeyedEncodingContainer<Key>, forKey key: Key) throws {",
  "        switch self {",
  "        case .absent: break",
  "        case .null: try container.encodeNil(forKey: key)",
  "        case .value(let value): try container.encode(value, forKey: key)",
  "        }",
  "    }",
  "}",
  "",
  "func wireEnum<Value: RawRepresentable>(_ raw: String, as type: Value.Type) throws -> Value",
  "where Value.RawValue == String {",
  "    guard let value = Value(rawValue: raw) else {",
  '        throw EncodingError.invalidValue(raw, .init(codingPath: [], debugDescription: "Unsupported wire enum value: \\(raw)"))',
  "    }",
  "    return value",
  "}",
  "",
];

for (const name of [...enums].sort()) {
  const values = literalValues(alias(name));
  lines.push(`enum Wire${name}: String, Codable, Sendable {`);
  for (const value of values) lines.push(`    case ${enumCase(value)} = ${JSON.stringify(value)}`);
  lines.push("}", "");
}

for (const [name, properties] of requestFields) {
  lines.push(`struct Wire${name}: Encodable, Sendable {`);
  for (const property of properties) {
    const type = property.presence ? `WireField<${property.type}>` : property.type;
    lines.push(`    var ${property.name}: ${type}${property.presence ? " = .absent" : ""}`);
  }
  lines.push("", "    enum CodingKeys: String, CodingKey {");
  for (const property of properties) lines.push(`        case ${property.name}`);
  lines.push(
    "    }",
    "",
    "    func encode(to encoder: Encoder) throws {",
    "        var container = encoder.container(keyedBy: CodingKeys.self)",
  );
  for (const property of properties) {
    lines.push(
      property.presence
        ? `        try ${property.name}.encode(into: &container, forKey: .${property.name})`
        : `        try container.encode(${property.name}, forKey: .${property.name})`,
    );
  }
  lines.push("    }", "}", "");
}

const output = `${lines.join("\n").trimEnd()}\n`;

// The chat list's and the transcript's response types. Each entry names only
// the fields the phone reads, in the order its memberwise initializer takes
// them: an unlisted key on the wire is ignored, which is what lets a host grow
// a column without breaking an older phone. A listed field that the host
// renames, removes, or retypes fails this script, and so `check:static`.
//
// A field spec is its name, or an object:
//   as:     the Swift type to read it as, when the wire type is wider
//   older:  optional here although the binding requires it, because an older
//           host or a saved transcript does not send it
//   note:   what the phone uses it for
const swiftNameForBinding = new Map([
  ["SessionState", "SessionState"],
  ["AttentionState", "AttentionState"],
  ["TimelineSemantics", "TimelineSemantics"],
  ["JsonValue", "TranscriptJSONValue"],
]);
// A Swift type standing in for a wider wire type, and the binding it reads.
const swiftReadsWire = new Map([
  ["Int64", ts.SyntaxKind.NumberKeyword],
  ["WorkspaceState", ts.SyntaxKind.StringKeyword],
  ["WorkspaceKind", ts.SyntaxKind.StringKeyword],
]);
const identifiable = "Codable, Hashable, Sendable, Identifiable";
const responses = [
  {
    swift: "ProjectSummary",
    binding: "ProjectSummary",
    conforms: identifiable,
    doc: "`ProjectSummary`. `settings` and `counts` are desktop-only and dropped.",
    fields: ["id", "name", "repoPath", "currentBranch", "defaultBranch", "latestActivityAt"],
  },
  {
    swift: "WorkspaceSummary",
    binding: "WorkspaceSummary",
    conforms: identifiable,
    doc: "`WorkspaceSummary`: the unit of work a chat list row stands for. The PR and priority columns are here because the Priority section reads them directly: a red check or an open pull request is the workspace's business, not any one session's.",
    fields: [
      "id",
      "projectId",
      {
        name: "projectFolderId",
        note: 'The project folder this chat works in. Nil for side chats and for hosts older than named projects. "New chat here" sends it back so the new chat starts in the same folder.',
      },
      "taskLabel",
      "branch",
      "baseRef",
      "path",
      { name: "state", as: "WorkspaceState" },
      { name: "kind", as: "WorkspaceKind" },
      "sharedWorkspace",
      "dirty",
      "changedFiles",
      "lastActivityAt",
      "pinned",
      "priorityDismissedAt",
      "priorityAddedAt",
      {
        name: "snoozedUntil",
        note: "RFC 3339 instant the desktop's snooze shelf holds this row until. Display metadata only: a snooze never changes the chat's state. The phone decodes it so the field survives a round trip; it does not shelve rows.",
      },
      "prState",
      "prNumber",
      "prCheckState",
      "prActivityAt",
      {
        name: "icon",
        note: "The glyph the desktop's icon picker put on this row, as a curated Lucide name (`src/renderer/lib/sessionIcons.ts`).",
      },
      {
        name: "iconColor",
        note: 'The palette entry paired with `icon`: a name ("violet"), not a colour. Both clients resolve the token against their own theme, which is how one pick reads right on paper and on charcoal.',
      },
      {
        name: "lastViewedAt",
        note: "Shared host acknowledgement of the activity actually shown on a device.",
      },
      "prs",
    ],
  },
  {
    swift: "WorkspacePullRequest",
    binding: "SessionPrSummary",
    conforms: "Codable, Hashable, Sendable",
    fields: ["prNumber", "url"],
  },
  {
    swift: "SessionSummary",
    binding: "SessionSummary",
    conforms: identifiable,
    doc: "`SessionSummary`: one chat with one provider. `launchKind` and `launchedBySessionId` are the multitask linkage: a multitask belongs to the chat that dispatched it and has no row of its own.",
    fields: [
      "id",
      "workspaceId",
      "provider",
      "modelLabel",
      "modelId",
      "prompt",
      "state",
      "attention",
      {
        name: "attentionChangedAt",
        note: 'When `attention` last changed. Null on rows written before the column existed, which the Priority rules treat as "not yet a reason".',
      },
      "startedAt",
      "completedAt",
      "lastActivityAt",
      "imported",
      "launchKind",
      "launchedBySessionId",
      {
        name: "reasoningEffort",
        note: "Read on open so the composer's effort chip starts right instead of showing the first option until the metadata read lands.",
      },
      { name: "arcId", note: "The Arc this chat belongs to, as its coordinator or a member." },
      {
        name: "autoTier",
        note: "The Router tier while the router picks this chat's model; absent once a model is picked by hand.",
      },
    ],
  },
  {
    swift: "DashboardDelta",
    binding: "DashboardDelta",
    conforms: "Codable, Hashable, Sendable",
    doc: '`DashboardDelta`: whole-object replacement per row, plus the two removal lists, which are the only way the protocol can say "gone". A remote host may omit any slice, so every field is optional here.',
    fields: [
      { name: "projects", older: true },
      { name: "workspaces", older: true },
      { name: "sessions", older: true },
      { name: "removedSessionIds", older: true },
      { name: "removedWorkspaceIds", older: true },
      {
        name: "dashboardChanged",
        older: true,
        note: 'Hints rather than rows: the host says "the dashboard moved, read it again" instead of shipping the changed rows, and names the sessions whose transcripts advanced.',
      },
      { name: "changedSessionIds", older: true },
      {
        name: "resyncRequired",
        older: true,
        note: "The event stream dropped frames and the whole snapshot must be reloaded.",
      },
    ],
  },
  {
    swift: "TranscriptEvent",
    binding: "TimelineEvent",
    conforms: identifiable,
    fields: [
      "id",
      "sessionId",
      "type",
      "message",
      "payload",
      {
        name: "semantic",
        older: true,
        note: "Absent from a saved transcript this app wrote before semantics existed.",
      },
      "createdAt",
      { name: "rowCursor", as: "Int64" },
    ],
  },
  {
    swift: "TranscriptRawOutput",
    binding: "RawProviderOutput",
    conforms: identifiable,
    fields: [
      "id",
      "sessionId",
      "stream",
      "content",
      "createdAt",
      { name: "rowCursor", as: "Int64" },
    ],
  },
  {
    swift: "TranscriptPage",
    binding: "SessionEventsSinceResult",
    conforms: "Codable, Hashable, Sendable",
    fields: [
      "events",
      "rawOutputs",
      { name: "eventCursor", as: "Int64" },
      { name: "rawOutputCursor", as: "Int64" },
      { name: "changeCursor", as: "Int64" },
      "deletedEventIds",
      "deletedRawOutputIds",
      "resetRequired",
      "hasMore",
    ],
  },
  {
    swift: "TranscriptPendingMessage",
    binding: "PendingMessage",
    conforms: "Decodable, Hashable, Sendable, Identifiable",
    fields: [
      "id",
      "sessionId",
      "content",
      {
        name: "provider",
        note: "The provider this follow-up runs under once it drains. Nil is the chat's provider at that moment.",
      },
      "modelLabel",
      "modelId",
      "reasoningEffort",
      "recoveryStatus",
      "queuedAt",
    ],
  },
  {
    swift: "TranscriptSessionMetadata",
    binding: "SessionSummary",
    conforms: identifiable,
    fields: [
      "id",
      "workspaceId",
      "provider",
      "modelLabel",
      "modelId",
      "prompt",
      "state",
      "attention",
      "reasoningEffort",
      { name: "contextTokens", older: true },
      "contextWindow",
      {
        name: "autoTier",
        note: "The Router tier while the router picks this chat's model; cleared once a model is picked by hand.",
      },
    ],
  },
  {
    swift: "TranscriptWorkspaceMetadata",
    binding: "WorkspaceSummary",
    conforms: "Decodable, Hashable, Sendable, Identifiable",
    fields: [
      "id",
      "taskLabel",
      {
        name: "path",
        older: true,
        note: "Optional for the older hosts this read has always tolerated.",
      },
    ],
  },
];
// Two Swift views can read one binding. A reference to it means the first, fuller one.
const swiftNames = new Map([...responses].reverse().map(({ binding, swift }) => [binding, swift]));

function responseBaseType(node, owner, fieldName, as) {
  if (ts.isParenthesizedTypeNode(node)) return responseBaseType(node.type, owner, fieldName, as);
  if (ts.isArrayTypeNode(node))
    return `[${responseBaseType(node.elementType, owner, fieldName, as)}]`;
  if (as) {
    if (swiftReadsWire.has(as)) {
      if (node.kind !== swiftReadsWire.get(as)) {
        throw new Error(
          `${owner}.${fieldName}: ${as} reads ${ts.SyntaxKind[swiftReadsWire.get(as)]}, the binding is now ${node.getText(source)}`,
        );
      }
      return as;
    }
    if (!ts.isTypeReferenceNode(node) && !ts.isTypeLiteralNode(node)) {
      throw new Error(
        `${owner}.${fieldName}: ${as} reads an object, the binding is now ${node.getText(source)}`,
      );
    }
    return as;
  }
  if (node.kind === ts.SyntaxKind.StringKeyword) return "String";
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return "Bool";
  if (node.kind === ts.SyntaxKind.NumberKeyword) return "Int";
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText(source);
    const known = swiftNameForBinding.get(name) ?? swiftNames.get(name);
    if (known) return known;
    const target = alias(name);
    // An id newtype or a closed string union reads as a string: a value the
    // phone has not heard of must still decode.
    if (literalValues(target)) return "String";
    return responseBaseType(target, owner, fieldName);
  }
  throw new Error(
    `${owner}.${fieldName}: no Swift type for ${node.getText(source)}. Add one to the response list.`,
  );
}

function responseFields({ swift, binding, fields: specs }) {
  const node = alias(binding);
  if (!ts.isTypeLiteralNode(node)) throw new Error(`${binding} is not a Rust object binding`);
  const members = new Map(node.members.map((member) => [member.name?.getText(source), member]));
  return specs.map((spec) => {
    const { name, as, older, note } = typeof spec === "string" ? { name: spec } : spec;
    const member = members.get(name);
    if (!member) throw new Error(`${swift}.${name} is gone from the Rust binding ${binding}`);
    const { type, nullable } = removeNull(member.type);
    const optional = Boolean(member.questionToken) || nullable || Boolean(older);
    return { name, note, type: `${responseBaseType(type, swift, name, as)}${optional ? "?" : ""}` };
  });
}

function wrappedComment(text, indent) {
  const words = text.split(" ");
  const out = [];
  let line = `${indent}///`;
  for (const word of words) {
    if (line.length + word.length + 1 > 88 && line !== `${indent}///`) {
      out.push(line);
      line = `${indent}///`;
    }
    line += ` ${word}`;
  }
  out.push(line);
  return out;
}

const responseLines = [
  "// Generated from src/shared/bindings.d.ts by scripts/export-swift-contracts.mjs.",
  "// Change the Rust contract, or the response list in that script, and run",
  "// `npm run generate:contracts`. Unlisted keys on the wire are ignored.",
  "import Foundation",
  "",
];
for (const response of responses) {
  if (response.doc) responseLines.push(...wrappedComment(response.doc, ""));
  responseLines.push(`struct ${response.swift}: ${response.conforms} {`);
  for (const field of responseFields(response)) {
    if (field.note) responseLines.push(...wrappedComment(field.note, "    "));
    responseLines.push(`    var ${field.name}: ${field.type}`);
  }
  responseLines.push("}", "");
}
const responseOutput = `${responseLines.join("\n").trimEnd()}\n`;

function semanticType(node) {
  const { type, nullable } = removeNull(node);
  let value;
  if (type.kind === ts.SyntaxKind.StringKeyword) value = "String";
  else if (type.kind === ts.SyntaxKind.BooleanKeyword) value = "Bool";
  else if (type.kind === ts.SyntaxKind.NumberKeyword) value = "Int";
  else if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) value = "String";
  else if (literalValues(type)) value = "String";
  else if (ts.isTypeReferenceNode(type)) {
    const name = type.typeName.getText(source);
    value =
      name === "TimelineContext"
        ? "Context"
        : name === "SemanticEvent"
          ? "Event"
          : semanticType(alias(name));
  } else throw new Error(`Unsupported semantic type: ${node.getText(source)}`);
  return `${value}${nullable ? "?" : ""}`;
}

function semanticFields(node) {
  if (!ts.isTypeLiteralNode(node)) throw new Error(`Expected object: ${node.getText(source)}`);
  return node.members.map((field) => {
    if (!ts.isPropertySignature(field) || !field.type || !ts.isIdentifier(field.name)) {
      throw new Error(`Unsupported semantic field: ${field.getText(source)}`);
    }
    return { name: field.name.text, type: semanticType(field.type) };
  });
}

const semanticUnion = alias("SemanticEvent");
if (!ts.isUnionTypeNode(semanticUnion)) throw new Error("SemanticEvent must be a tagged union");
const semanticVariants = semanticUnion.types.map((member) => {
  const properties = semanticFields(member);
  const kind = member.members.find((field) => field.name.getText(source) === "kind");
  if (!kind || !ts.isLiteralTypeNode(kind.type) || !ts.isStringLiteral(kind.type.literal)) {
    throw new Error("SemanticEvent variant must have literal kind");
  }
  return { name: kind.type.literal.text, properties };
});
const semanticLines = [
  "// Generated from src/shared/bindings.d.ts by scripts/export-swift-contracts.mjs.",
  "// Change the Rust contract and run `npm run generate:contracts`.",
  "import Foundation",
  "",
  "/// Host-owned meaning for a timeline row. Raw payload remains diagnostic.",
  "struct TimelineSemantics: Codable, Hashable, Sendable {",
  ...semanticFields(alias("TimelineSemantics")).map(
    (field) => `    var ${field.name}: ${field.type}`,
  ),
  "",
  "    struct Context: Codable, Hashable, Sendable {",
  ...semanticFields(alias("TimelineContext")).map(
    (field) => `        var ${field.name}: ${field.type}`,
  ),
  "    }",
  "",
  "    enum Event: Codable, Hashable, Sendable {",
  ...semanticVariants
    .filter((variant) => variant.name !== "unknown")
    .map(
      (variant) =>
        `        case ${variant.name}(${variant.name[0].toUpperCase()}${variant.name.slice(1)})`,
    ),
  "        case unknown",
  "",
  "        private enum CodingKeys: String, CodingKey { case kind }",
  "",
  "        init(from decoder: Decoder) throws {",
  "            let container = try decoder.container(keyedBy: CodingKeys.self)",
  "            switch try container.decode(String.self, forKey: .kind) {",
  ...semanticVariants
    .filter((variant) => variant.name !== "unknown")
    .map(
      (variant) =>
        `            case \"${variant.name}\": self = .${variant.name}(try ${variant.name[0].toUpperCase()}${variant.name.slice(1)}(from: decoder))`,
    ),
  "            default: self = .unknown",
  "            }",
  "        }",
  "",
  "        func encode(to encoder: Encoder) throws {",
  "            switch self {",
  ...semanticVariants
    .filter((variant) => variant.name !== "unknown")
    .map(
      (variant) => `            case .${variant.name}(let value): try value.encode(to: encoder)`,
    ),
  "            case .unknown:",
  "                var container = encoder.container(keyedBy: CodingKeys.self)",
  '                try container.encode("unknown", forKey: .kind)',
  "            }",
  "        }",
  "    }",
  "",
];
for (const variant of semanticVariants.filter((variant) => variant.name !== "unknown")) {
  const name = `${variant.name[0].toUpperCase()}${variant.name.slice(1)}`;
  semanticLines.push(`    struct ${name}: Codable, Hashable, Sendable {`);
  for (const field of variant.properties)
    semanticLines.push(`        var ${field.name}: ${field.type}`);
  semanticLines.push("    }", "");
}
semanticLines.push("}");
const semanticOutput = `${semanticLines.join("\n")}\n`;
if (process.argv.includes("--check")) {
  for (const [path, expected] of [
    [outputPath, output],
    [semanticOutputPath, semanticOutput],
    [responseOutputPath, responseOutput],
  ]) {
    if (readFileSync(path, "utf8") !== expected) {
      throw new Error(`${path} is stale. Run npm run generate:contracts.`);
    }
  }
} else {
  writeFileSync(outputPath, output);
  writeFileSync(semanticOutputPath, semanticOutput);
  writeFileSync(responseOutputPath, responseOutput);
  process.stdout.write(`wrote ${outputPath}, ${semanticOutputPath} and ${responseOutputPath}\n`);
}
