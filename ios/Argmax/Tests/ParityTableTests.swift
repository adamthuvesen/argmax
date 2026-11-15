import XCTest
@testable import Argmax

/// The phone half of fixtures/parity. `src/renderer/lib/parityTables.test.ts`
/// runs the same tables against the desktop's functions. A case that differs
/// by platform names its reason in the table, under `desktop` or `phone`.
final class ParityTableTests: XCTestCase {
    private func table<Table: Decodable>(_ name: String, as type: Table.Type = Table.self) throws -> Table {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: "json"))
        return try JSONDecoder().decode(Table.self, from: Data(contentsOf: url))
    }

    // MARK: - Workspace chat

    private struct WorkspaceChatTable: Decodable {
        struct Row: Decodable {
            struct Session: Decodable {
                var id: String
                var workspaceId: String
                var lastActivityAt: String
            }
            var name: String
            var sessions: [Session]
            var chats: [String: String]
        }
        var cases: [Row]
    }

    func testWorkspaceChatTable() throws {
        let rows = try table("workspace-chat", as: WorkspaceChatTable.self).cases
        XCTAssertFalse(rows.isEmpty)
        for row in rows {
            let sessions = row.sessions.map {
                makeSession(id: $0.id, workspaceId: $0.workspaceId, lastActivityAt: $0.lastActivityAt)
            }
            XCTAssertEqual(chatSessionByWorkspace(sessions).mapValues(\.id), row.chats, row.name)
        }
    }

    // MARK: - Inline math

    private struct InlineMathTable: Decodable {
        struct Override: Decodable {
            var math: [String]?
            var reason: String
        }
        struct Row: Decodable {
            var name: String
            var input: String
            var math: [String]
            var phone: Override?
        }
        var cases: [Row]
    }

    /// Every math region in reading order: inline regions and lifted display
    /// blocks leave a marker in the prepared Markdown.
    private func mathSources(_ markdown: String) throws -> [String] {
        let preparation = TranscriptMarkdownPreparation(markdown: markdown)
        let marker = try NSRegularExpression(pattern: "\u{E000}ARGMAX_(?:BLOCK|MATH)_[0-9]+\u{E001}")
        let text = preparation.markdown as NSString
        return marker.matches(in: preparation.markdown, range: NSRange(location: 0, length: text.length))
            .compactMap { match in
                let key = text.substring(with: match.range)
                if let math = preparation.math[key] { return math.source }
                if case .math(let source, _) = preparation.lifted[key] { return source }
                return nil
            }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    }

    func testInlineMathTable() throws {
        let rows = try table("inline-math", as: InlineMathTable.self).cases
        XCTAssertFalse(rows.isEmpty)
        for row in rows {
            XCTAssertEqual(try mathSources(row.input), row.phone?.math ?? row.math, row.name)
        }
    }

    // MARK: - Chat detail

    private struct ChatDetailTable: Decodable {
        struct LevelOverride: Decodable {
            var hidesSettledThoughts: Bool?
            var reason: String
        }
        struct Level: Decodable {
            var level: Int
            var label: String
            var foldsActivity: Bool
            var hidesNarration: Bool
            var thoughtDisplay: String
            var opensLatestOutputs: Bool
            var hidesSettledThoughts: Bool
            var phone: LevelOverride?
        }
        struct Narration: Decodable {
            var name: String
            var text: String
            var repeatToUtf16: Int?
            var isNarration: Bool
        }
        struct TurnItem: Decodable {
            var kind: String
            var id: String
            var text: String?
            var attachments: Bool?
        }
        struct TurnOverride: Decodable {
            var hidden: [String]?
            var reason: String
        }
        struct Turn: Decodable {
            var name: String
            var live: Bool?
            var items: [TurnItem]
            var hidden: [String]
            var phone: TurnOverride?
        }
        var levels: [Level]
        var narration: [Narration]
        var turns: [Turn]
    }

    private func transcriptItem(_ item: ChatDetailTable.TurnItem) -> TranscriptItem {
        func message(role: TranscriptMessageRole, steering: Bool) -> TranscriptMessage {
            TranscriptMessage(
                id: item.id, role: role, text: item.text ?? item.id, createdAt: "1", isStreaming: false,
                isSteering: steering, originLabel: nil,
                attachments: item.attachments == true ? [TranscriptAttachment(filePath: "image.png", mimeType: "image/png")] : []
            )
        }
        switch item.kind {
        case "user": return .user(message(role: .user, steering: false))
        case "steering": return .user(message(role: .user, steering: true))
        case "assistant": return .assistant(message(role: .assistant, steering: false))
        case "thought": return .thought(.init(id: item.id, text: "Reasoning", createdAt: "1", isStreaming: false))
        default:
            return .tools(.init(id: item.id, tools: [.init(
                id: item.id + "-tool", toolUseId: item.id, name: "Bash", summary: "Run command", input: nil,
                output: nil, error: nil, status: .done, createdAt: "1", completedAt: nil, filePath: nil, fileLabel: nil
            )], createdAt: "1"))
        }
    }

    func testChatDetailLevelTable() throws {
        let levels = try table("chat-detail", as: ChatDetailTable.self).levels
        XCTAssertEqual(levels.count, MobileChatDetail.allCases.count)
        let thought = [
            transcriptItem(.init(kind: "user", id: "user")),
            transcriptItem(.init(kind: "thought", id: "thought")),
            transcriptItem(.init(kind: "assistant", id: "answer"))
        ]
        let working = [
            transcriptItem(.init(kind: "user", id: "user")),
            transcriptItem(.init(kind: "tools", id: "work")),
            transcriptItem(.init(kind: "assistant", id: "answer"))
        ]
        for level in levels {
            let detail = try XCTUnwrap(MobileChatDetail(rawValue: level.level))
            let name = detail.label
            XCTAssertEqual(detail.label, level.label)
            XCTAssertEqual(detail.foldsActivity, level.foldsActivity, name)
            XCTAssertEqual(detail.hidesNarration, level.hidesNarration, name)
            XCTAssertEqual(detail.thoughtDisplay.rawValue, level.thoughtDisplay, name)
            XCTAssertEqual(detail.opensLatestOutputs, level.opensLatestOutputs, name)
            let folded = MobileTranscriptRow.rows(working, detail: detail, latestTurnIsLive: false)
                .contains { if case .activity = $0 { return true } else { return false } }
            XCTAssertEqual(folded, level.foldsActivity, name)
            let thoughtStays = MobileTranscriptRow.rows(thought, detail: detail, latestTurnIsLive: false)
                .contains(.item(thought[1]))
            XCTAssertEqual(!thoughtStays, level.phone?.hidesSettledThoughts ?? level.hidesSettledThoughts, name)
        }
    }

    func testChatDetailNarrationTable() throws {
        for row in try table("chat-detail", as: ChatDetailTable.self).narration {
            var text = row.text
            if let length = row.repeatToUtf16 {
                text = String(repeating: row.text, count: length / row.text.utf16.count + 1)
                text = String(decoding: Array(text.utf16.prefix(length)), as: UTF16.self)
            }
            XCTAssertEqual(MobileTranscriptRow.isProgressNarration(text), row.isNarration, row.name)
        }
    }

    func testChatDetailTurnTable() throws {
        let turns = try table("chat-detail", as: ChatDetailTable.self).turns
        XCTAssertFalse(turns.isEmpty)
        for turn in turns {
            let narration = MobileTranscriptRow.minimalNarrationIDs(
                turn.items.map(transcriptItem), latestTurnIsLive: turn.live ?? false
            )
            XCTAssertEqual(narration, Set(turn.phone?.hidden ?? turn.hidden), turn.name)
        }
    }
}
