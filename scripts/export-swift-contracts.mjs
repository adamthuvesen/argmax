import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const sourcePath = resolve(root, "src/shared/bindings.d.ts");
const outputPath = resolve(root, "ios/Argmax/Sources/Bridge/GeneratedWireContracts.swift");
const semanticOutputPath = resolve(root, "ios/Argmax/Sources/Transcript/GeneratedTimelineSemantics.swift");
const source = ts.createSourceFile(sourcePath, readFileSync(sourcePath, "utf8"), ts.ScriptTarget.Latest, true);
const aliases = new Map(source.statements
  .filter(ts.isTypeAliasDeclaration)
  .map((declaration) => [declaration.name.text, declaration]));

// Only the phone's request contracts belong here. Presentation responses keep
// their own models, and the host's generated bindings remain the sole schema.
const requests = [
  "AgentReference", "ProjectsListBranchesInput", "ProvidersDiscoverInput",
  "WorkspacesCreateIsolatedInput", "WorkspacesCreateCurrentInput", "WorkspacesCreateScratchInput",
  "ProvidersLaunchInput", "WorkspacesAutotitleInput", "ComposerAttachmentInput",
  "AttachmentsSaveImageInput", "ProvidersSendInput", "QuestionsResolveInput",
  "ProvidersTerminateInput", "ProvidersCancelQueuedMessageInput",
  "ProvidersSendQueuedMessageNowInput", "SessionMultitaskInput",
  "WorkspacesSetPinnedInput", "WorkspacesSetLabelInput", "WorkspacesArchiveInput",
  "SessionForkInput", "GitViewOrCreatePrInput", "RemoteRegisterPushDeviceInput",
  "RemoteUnregisterPushDeviceInput"
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
  if (members.every((member) => ts.isLiteralTypeNode(member)
    && ts.isStringLiteral(member.literal))) {
    return members.map((member) => member.literal.text);
  }
  return null;
}

function removeNull(node) {
  if (!ts.isUnionTypeNode(node)) return { type: node, nullable: false };
  const members = node.types.filter((member) => member.kind !== ts.SyntaxKind.NullKeyword
    && !(ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword));
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
    if (name === "Partial" && node.typeArguments?.length === 1) return swiftType(node.typeArguments[0]);
    if (objects.has(name)) return `Wire${name}`;
    const target = alias(name);
    if (literalValues(target)) {
      enums.add(name);
      return `Wire${name}`;
    }
    return swiftType(target);
  }
  if (ts.isTypeLiteralNode(node) && node.members.length === 1
    && ts.isIndexSignatureDeclaration(node.members[0])) {
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
    if (!ts.isPropertySignature(member) || !member.type || !member.name || !ts.isIdentifier(member.name)) {
      throw new Error(`Unsupported field in ${name}: ${member.getText(source)}`);
    }
    const { type, nullable } = removeNull(member.type);
    return {
      name: member.name.text,
      type: swiftType(type),
      presence: Boolean(member.questionToken) || nullable
    };
  });
}

function enumCase(value) {
  const words = value.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const name = words.map((word, index) => index === 0
    ? word.toLowerCase()
    : word[0].toUpperCase() + word.slice(1).toLowerCase()).join("");
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
  "        throw EncodingError.invalidValue(raw, .init(codingPath: [], debugDescription: \"Unsupported wire enum value: \\(raw)\"))",
  "    }",
  "    return value",
  "}",
  ""
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
  lines.push("    }", "", "    func encode(to encoder: Encoder) throws {",
    "        var container = encoder.container(keyedBy: CodingKeys.self)");
  for (const property of properties) {
    lines.push(property.presence
      ? `        try ${property.name}.encode(into: &container, forKey: .${property.name})`
      : `        try container.encode(${property.name}, forKey: .${property.name})`);
  }
  lines.push("    }", "}", "");
}

const output = `${lines.join("\n").trimEnd()}\n`;
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
    value = name === "TimelineContext" ? "Context" : name === "SemanticEvent" ? "Event" : semanticType(alias(name));
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
  "import Foundation", "",
  "/// Host-owned meaning for a timeline row. Raw payload remains diagnostic.",
  "struct TimelineSemantics: Codable, Hashable, Sendable {",
  ...semanticFields(alias("TimelineSemantics")).map((field) => `    var ${field.name}: ${field.type}`),
  "", "    struct Context: Codable, Hashable, Sendable {",
  ...semanticFields(alias("TimelineContext")).map((field) => `        var ${field.name}: ${field.type}`),
  "    }", "",
  "    enum Event: Codable, Hashable, Sendable {",
  ...semanticVariants.filter((variant) => variant.name !== "unknown")
    .map((variant) => `        case ${variant.name}(${variant.name[0].toUpperCase()}${variant.name.slice(1)})`),
  "        case unknown", "",
  "        private enum CodingKeys: String, CodingKey { case kind }", "",
  "        init(from decoder: Decoder) throws {",
  "            let container = try decoder.container(keyedBy: CodingKeys.self)",
  "            switch try container.decode(String.self, forKey: .kind) {",
  ...semanticVariants.filter((variant) => variant.name !== "unknown")
    .map((variant) => `            case \"${variant.name}\": self = .${variant.name}(try ${variant.name[0].toUpperCase()}${variant.name.slice(1)}(from: decoder))`),
  "            default: self = .unknown", "            }", "        }", "",
  "        func encode(to encoder: Encoder) throws {", "            switch self {",
  ...semanticVariants.filter((variant) => variant.name !== "unknown")
    .map((variant) => `            case .${variant.name}(let value): try value.encode(to: encoder)`),
  "            case .unknown:",
  "                var container = encoder.container(keyedBy: CodingKeys.self)",
  "                try container.encode(\"unknown\", forKey: .kind)",
  "            }", "        }", "    }", ""
];
for (const variant of semanticVariants.filter((variant) => variant.name !== "unknown")) {
  const name = `${variant.name[0].toUpperCase()}${variant.name.slice(1)}`;
  semanticLines.push(`    struct ${name}: Codable, Hashable, Sendable {`);
  for (const field of variant.properties) semanticLines.push(`        var ${field.name}: ${field.type}`);
  semanticLines.push("    }", "");
}
semanticLines.push("}");
const semanticOutput = `${semanticLines.join("\n")}\n`;
if (process.argv.includes("--check")) {
  for (const [path, expected] of [[outputPath, output], [semanticOutputPath, semanticOutput]]) {
    if (readFileSync(path, "utf8") !== expected) {
      throw new Error(`${path} is stale. Run npm run generate:contracts.`);
    }
  }
} else {
  writeFileSync(outputPath, output);
  writeFileSync(semanticOutputPath, semanticOutput);
  process.stdout.write(`wrote ${outputPath} and ${semanticOutputPath}\n`);
}
