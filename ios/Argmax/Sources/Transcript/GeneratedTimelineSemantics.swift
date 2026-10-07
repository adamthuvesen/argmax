// Generated from src/shared/bindings.d.ts by scripts/export-swift-contracts.mjs.
// Change the Rust contract and run `npm run generate:contracts`.
import Foundation

/// Host-owned meaning for a timeline row. Raw payload remains diagnostic.
struct TimelineSemantics: Codable, Hashable, Sendable {
    var version: Int
    var context: Context
    var event: Event

    struct Context: Codable, Hashable, Sendable {
        var parentToolUseId: String?
        var providerThreadId: String?
        var providerInvocationId: String?
        var providerChildSessionId: String?
        var providerParentConversationId: String?
        var agentRunId: String?
        var agentRootToolUseId: String?
        var agentCodename: String?
        var agentModelId: String?
        var agentReasoningEffort: String?
        var isRaw: Bool
        var traceSuperseded: Bool
        var traceImported: Bool
    }

    enum Event: Codable, Hashable, Sendable {
        case message(Message)
        case tool(Tool)
        case approval(Approval)
        case agent(Agent)
        case lifecycle(Lifecycle)
        case multitask(Multitask)
        case visualization(Visualization)
        case error(Error)
        case unknown

        private enum CodingKeys: String, CodingKey { case kind }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            switch try container.decode(String.self, forKey: .kind) {
            case "message": self = .message(try Message(from: decoder))
            case "tool": self = .tool(try Tool(from: decoder))
            case "approval": self = .approval(try Approval(from: decoder))
            case "agent": self = .agent(try Agent(from: decoder))
            case "lifecycle": self = .lifecycle(try Lifecycle(from: decoder))
            case "multitask": self = .multitask(try Multitask(from: decoder))
            case "visualization": self = .visualization(try Visualization(from: decoder))
            case "error": self = .error(try Error(from: decoder))
            default: self = .unknown
            }
        }

        func encode(to encoder: Encoder) throws {
            switch self {
            case .message(let value): try value.encode(to: encoder)
            case .tool(let value): try value.encode(to: encoder)
            case .approval(let value): try value.encode(to: encoder)
            case .agent(let value): try value.encode(to: encoder)
            case .lifecycle(let value): try value.encode(to: encoder)
            case .multitask(let value): try value.encode(to: encoder)
            case .visualization(let value): try value.encode(to: encoder)
            case .error(let value): try value.encode(to: encoder)
            case .unknown:
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode("unknown", forKey: .kind)
            }
        }
    }

    struct Message: Codable, Hashable, Sendable {
        var kind: String
        var role: String
        var phase: String
        var content: String
        var delivery: String?
        var rawStream: Bool
        var cumulativeText: String?
    }

    struct Tool: Codable, Hashable, Sendable {
        var kind: String
        var phase: String
        var toolUseId: String?
        var name: String
        var providerName: String?
        var outcome: String?
        var running: Bool
        var surface: String?
        var traceSyntheticLaunch: Bool
    }

    struct Approval: Codable, Hashable, Sendable {
        var kind: String
        var phase: String
        var approvalId: String?
        var provider: String?
        var providerRequestId: String?
        var toolUseId: String?
        var resolution: String?
    }

    struct Agent: Codable, Hashable, Sendable {
        var kind: String
        var phase: String
        var status: String?
    }

    struct Lifecycle: Codable, Hashable, Sendable {
        var kind: String
        var name: String
    }

    struct Multitask: Codable, Hashable, Sendable {
        var kind: String
        var phase: String
        var childSessionId: String?
        var state: String?
        var taskLabel: String?
        var prompt: String?
        var worktree: Bool
        var answer: String?
    }

    struct Visualization: Codable, Hashable, Sendable {
        var kind: String
        var artifactId: String
        var title: String
        var format: String
        var summary: String
        var mode: String?
    }

    struct Error: Codable, Hashable, Sendable {
        var kind: String
        var code: String?
        var operation: String?
    }

}
