import Foundation
import SwiftUI

struct TranscriptVisualizationLegacyReference: Codable, Hashable, Sendable {
    var path: String
    var mode: String?
    var title: String?
    var sourceEventID: String? = nil
}

enum TranscriptVisualizationMarker: Sendable {
    case ready(TranscriptVisualizationLegacyReference)
    case pending
    case invalid

    init?(line: String) {
        let prefix = "\u{E200}visualize\u{E202}"
        guard line.hasPrefix(prefix) else { return nil }
        guard line.hasSuffix("\u{E201}") else { self = .pending; return }
        let json = String(line.dropFirst(prefix.count).dropLast())
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys).isSubset(of: ["path", "mode", "title"]),
              let reference = try? JSONDecoder().decode(TranscriptVisualizationLegacyReference.self, from: data),
              reference.path.hasPrefix("/"),
              ["html", "htm"].contains(URL(fileURLWithPath: reference.path).pathExtension.lowercased()),
              reference.path.rangeOfCharacter(from: .controlCharacters) == nil,
              object["mode"] == nil || object["mode"] as? String == "wide",
              object["title"] == nil || object["title"] is String,
              (reference.title?.utf16.count ?? 0) <= 250
        else { self = .invalid; return }
        self = .ready(reference)
    }
}

enum TranscriptVisualizationReference: Hashable {
    case artifact(String)
    case legacy(TranscriptVisualizationLegacyReference)
}

struct TranscriptVisualizationArtifact: Decodable, Sendable {
    var id: String
    var sessionId: String
    var title: String
    var summary: String
    var format: String
    var mode: String?
    var runtimeVersion: Int
    var externalDependencies: [String]
}

struct TranscriptVisualizationState: Codable, Sendable {
    var modelContent: TranscriptJSONValue
    var privateContent: TranscriptJSONValue
}

struct TranscriptVisualizationDocument: Decodable, Sendable {
    var artifact: TranscriptVisualizationArtifact
    var source: String
    var document: String
    var state: TranscriptVisualizationState
    var controlValues: [String: TranscriptJSONValue] = [:]
}

struct TranscriptVisualizationIdentity: Encodable, Sendable {
    var sessionId: String
    var artifactId: String
}

private struct TranscriptVisualizationImport: Encodable, Sendable {
    var sessionId: String
    var path: String
    var title: String?
    var summary: String?
    var mode: String?
    var sourceEventId: String?
}

private struct TranscriptVisualizationControlsInput: Encodable, Sendable {
    var sessionId: String
    var artifactId: String
    var controlValues: [String: TranscriptJSONValue]
}

private struct TranscriptVisualizationStateInput: Encodable, Sendable {
    var sessionId: String
    var artifactId: String
    var state: TranscriptVisualizationState
}

extension BridgeClient {
    func visualizationDocument(sessionID: String, reference: TranscriptVisualizationReference) async throws -> TranscriptVisualizationDocument {
        let artifactID: String
        switch reference {
        case .artifact(let id): artifactID = id
        case .legacy(let reference):
            let artifact = try await request("visualization:import", input: TranscriptVisualizationImport(
                sessionId: sessionID, path: reference.path, title: reference.title, summary: nil, mode: reference.mode, sourceEventId: reference.sourceEventID
            ), as: TranscriptVisualizationArtifact.self)
            artifactID = artifact.id
        }
        return try await request("visualization:read", input: TranscriptVisualizationIdentity(sessionId: sessionID, artifactId: artifactID), as: TranscriptVisualizationDocument.self)
    }

    func visualizationSaveControls(sessionID: String, artifactID: String, controlValues: [String: TranscriptJSONValue]) async throws {
        _ = try await request("visualization:set-controls", input: TranscriptVisualizationControlsInput(
            sessionId: sessionID, artifactId: artifactID, controlValues: controlValues
        ), as: [String: TranscriptJSONValue].self)
    }

    func visualizationExport(sessionID: String, artifactID: String) async throws -> String {
        try await request("visualization:export", input: TranscriptVisualizationIdentity(sessionId: sessionID, artifactId: artifactID), as: String.self)
    }

    func visualizationSaveState(sessionID: String, artifactID: String, state: TranscriptVisualizationState) async throws {
        _ = try await request("visualization:set-state", input: TranscriptVisualizationStateInput(
            sessionId: sessionID, artifactId: artifactID, state: state
        ), as: TranscriptVisualizationState.self)
    }
}

private struct VisualizationSessionKey: EnvironmentKey { static let defaultValue: String? = nil }
private struct VisualizationFollowUpKey: EnvironmentKey { static let defaultValue: ((String) -> Void)? = nil }
extension EnvironmentValues {
    var visualizationSessionID: String? {
        get { self[VisualizationSessionKey.self] }
        set { self[VisualizationSessionKey.self] = newValue }
    }
    var visualizationFollowUp: ((String) -> Void)? {
        get { self[VisualizationFollowUpKey.self] }
        set { self[VisualizationFollowUpKey.self] = newValue }
    }
}

struct TranscriptVisualizationControls: Decodable {
    static func decodeGroups(_ raw: Any) -> [Self]? {
        guard JSONSerialization.isValidJSONObject(raw),
              let data = try? JSONSerialization.data(withJSONObject: raw),
              let groups = try? JSONDecoder().decode([Self].self, from: data),
              groups.count <= 32, groups.reduce(0, { $0 + $1.controls.count }) <= 384,
              Set(groups.map(\.id)).count == groups.count,
              groups.allSatisfy({ $0.controls.count <= 12 && Set($0.controls.map(\.id)).count == $0.controls.count })
        else { return nil }
        return groups
    }

    struct Control: Decodable, Identifiable {
        struct Option: Decodable { var label: String; var value: TranscriptJSONValue }
        var id: String
        var kind: String
        var label: String
        var value: TranscriptJSONValue
        var min: Double?
        var max: Double?
        var step: Double?
        var unit: String?
        var options: [Option]?

        func accepts(_ value: TranscriptJSONValue) -> Bool {
            switch kind {
            case "toggle": return value.bool != nil
            case "slider":
                guard case .number(let number) = value, number.isFinite else { return false }
                return number >= (min ?? 0) && number <= (max ?? 100)
            case "color":
                return value.string?.range(of: "^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$", options: .regularExpression) != nil
            case "select": return value.string != nil && options?.contains { $0.value == value } == true
            default: return false
            }
        }
    }
    var id: String
    var label: String
    var variant: String?
    var controls: [Control]
}

/// The web document may request actions, but only native controls perform them.
enum TranscriptVisualizationMessage {
    static func validated(_ body: Any, instanceID: String, mainFrame: Bool) -> [String: Any]? {
        guard mainFrame, let message = body as? [String: Any],
              message["instanceId"] as? String == instanceID,
              let type = message["type"] as? String,
              type.hasPrefix("argmax:visualization-"),
              JSONSerialization.isValidJSONObject(message),
              let data = try? JSONSerialization.data(withJSONObject: message), data.count <= 131_072
        else { return nil }
        return message
    }
}
