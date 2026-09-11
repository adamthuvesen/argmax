import SwiftUI
import UIKit

/// The mark beside a native transcript tool call.
///
/// Brand artwork is generated from the desktop's `serverIconFor` catalogue.
/// Provider-specific names are reduced to the MCP server before lookup, while
/// web, shell and unbranded MCP tools keep distinct system fallbacks.
struct TranscriptToolIcon: View {
    enum Source: Equatable {
        case asset(name: String, title: String)
        case system(name: String)
    }

    let name: String
    var size: CGFloat = 16
    var activity: TranscriptToolActivity? = nil

    var body: some View {
        Group {
            switch Self.source(for: name, activity: activity) {
            case .asset(let assetName, _):
                Image(assetName)
                    .renderingMode(.original)
                    .resizable()
                    .scaledToFit()
            case .system(let systemName):
                Image(systemName: systemName)
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(activity.map { Color(Self.uiColor(for: $0.kind)) } ?? Theme.muted)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    static func source(for toolName: String, activity: TranscriptToolActivity? = nil) -> Source {
        if activity?.kind == .computer { return .system(name: systemSymbol(for: .computer)) }
        if let server = serverName(in: toolName), let icon = catalogue.icon(for: server) {
            return .asset(name: "Integrations/\(icon.key)", title: icon.title)
        }
        if let activity { return .system(name: systemSymbol(for: activity.kind)) }
        if isWebTool(toolName) { return .system(name: "globe") }
        if serverName(in: toolName) != nil { return .system(name: "powerplug") }
        return .system(name: "terminal")
    }

    static func assetName(for toolName: String, activity: TranscriptToolActivity? = nil) -> String? {
        guard case .asset(let name, _) = source(for: toolName, activity: activity) else { return nil }
        return name
    }

    static func systemSymbol(for kind: TranscriptToolActivityKind) -> String {
        switch kind {
        case .read: return "book"
        case .edit: return "pencil"
        case .image: return "photo.on.rectangle.angled"
        case .search: return "magnifyingglass"
        case .list: return "folder"
        case .webSearch, .webFetch: return "globe"
        case .discovery: return "wrench.adjustable"
        case .command: return "terminal"
        case .computer: return "desktopcomputer"
        case .tool: return "wrench.and.screwdriver"
        case .agent: return "cpu"
        case .skill, .imageGenerate: return "sparkles"
        case .imageCapture: return "camera"
        case .agentMessage: return "bubble.left"
        case .agentWait: return "hourglass"
        case .agentStop: return "stop.circle"
        case .memoryRecall, .memorySave: return "brain"
        case .git: return "arrow.triangle.branch"
        case .browser: return "globe"
        case .plan: return "checklist"
        }
    }

    static func uiColor(for kind: TranscriptToolActivityKind) -> UIColor {
        switch kind {
        case .read, .command, .computer, .git: return Theme.activityBlueColor
        case .edit: return Theme.activityAmberColor
        case .search, .list, .webSearch, .webFetch, .browser: return Theme.activityTealColor
        case .image, .discovery, .tool, .agent, .skill, .imageCapture, .imageGenerate,
             .agentMessage, .agentWait, .agentStop, .memoryRecall, .memorySave, .plan:
            return Theme.activityVioletColor
        }
    }

    /// Used by the asset-integrity test so adding an exported mark cannot fail
    /// silently as an empty SwiftUI image.
    static var generatedAssetNames: [String] {
        catalogue.icons.map { "Integrations/\($0.key)" }
    }

    private static let argmaxToolNames: Set<String> = [
        "browser_back", "browser_click", "browser_close", "browser_evaluate", "browser_find",
        "browser_get_text", "browser_handle_dialog", "browser_hover", "browser_navigate", "browser_open",
        "browser_press_key", "browser_reload", "browser_screenshot", "browser_scroll", "browser_select",
        "browser_snapshot", "browser_tabs", "browser_type", "browser_wait_for", "inbox_read", "session_launch",
        "session_list", "session_message", "session_move", "session_read", "session_status", "session_stop",
        "session_wait"
    ]

    private static func serverName(in toolName: String) -> String? {
        let trimmed = toolName.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = trimmed.lowercased()
        if argmaxToolNames.contains(lower) { return "argmax" }

        let codexAppsPrefix = "mcp__codex_apps__"
        if lower.hasPrefix(codexAppsPrefix) {
            let remainder = String(lower.dropFirst(codexAppsPrefix.count))
            return catalogue.serverPrefix(in: remainder)
        }

        if lower.hasPrefix("mcp__") {
            let remainder = String(trimmed.dropFirst("mcp__".count))
            let segments = remainder.components(separatedBy: "__")
            guard segments.count >= 2 else { return nil }
            return normalizedNamespace(segments[0])
        }

        let dotted = trimmed.split(separator: ".", omittingEmptySubsequences: true).map(String.init)
        if dotted.count >= 3, dotted[0].lowercased() == "mcp" { return normalizedNamespace(dotted[1]) }
        if dotted.count >= 2 { return normalizedNamespace(dotted[0]) }

        return catalogue.serverPrefix(in: lower)
    }

    private static func normalizedNamespace(_ namespace: String) -> String {
        var server = namespace
        if server.lowercased().hasPrefix("claude_ai_") {
            server = String(server.dropFirst("claude_ai_".count))
        }
        if server.lowercased().hasPrefix("plugin-") {
            let parts = server.dropFirst("plugin-".count).split(separator: "-").map(String.init)
            let half = parts.count / 2
            if parts.count.isMultiple(of: 2), Array(parts[..<half]) == Array(parts[half...]) {
                server = parts[..<half].joined(separator: " ")
            } else if let last = parts.last {
                server = last
            }
        }
        return TranscriptToolIconCatalog.normalize(server)
    }

    private static func isWebTool(_ name: String) -> Bool {
        let lower = name.lowercased()
        return ["web", "browser", "navigate", "fetch", "url", "http"].contains { lower.contains($0) }
    }

    private static let catalogue = TranscriptToolIconCatalog.bundled
}

private final class TranscriptToolIconBundleMarker {}

private struct TranscriptToolIconCatalog: Decodable {
    struct Icon: Decodable {
        var key: String
        var title: String
        var aliases: [String]
    }

    var icons: [Icon]
    var mcpServersWithoutIcons: [String]

    static let bundled: TranscriptToolIconCatalog = {
        guard let url = Bundle(for: TranscriptToolIconBundleMarker.self)
            .url(forResource: "toolIcons", withExtension: "json")
        else {
            fatalError(
                "toolIcons.json is not in the app bundle. Run `node scripts/export-ios-tool-icons.mjs` "
                    + "from the repository root, then re-run xcodegen."
            )
        }
        do {
            return try JSONDecoder().decode(TranscriptToolIconCatalog.self, from: Data(contentsOf: url))
        } catch {
            fatalError("toolIcons.json is bundled but unreadable: \(error)")
        }
    }()

    func icon(for server: String) -> Icon? {
        let server = Self.normalize(server)
        return icons.first { icon in icon.aliases.contains { Self.normalize($0) == server } }
    }

    /// OpenCode calls MCP tools `<server>_<tool>` without an MCP marker.
    /// Longest first keeps `google-drive_*` ahead of its `drive` alias.
    func serverPrefix(in toolName: String) -> String? {
        let known = icons.flatMap(\.aliases) + mcpServersWithoutIcons
        for server in known.sorted(by: { $0.count > $1.count }) {
            for spelling in [Self.normalize(server).replacingOccurrences(of: " ", with: "-"),
                             Self.normalize(server).replacingOccurrences(of: " ", with: "_")] {
                if toolName == spelling || toolName.hasPrefix("\(spelling)_") {
                    return Self.normalize(server)
                }
            }
        }
        return nil
    }

    static func normalize(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
    }
}
