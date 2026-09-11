import Foundation

// The native half of the contract in `src/renderer/mobile/nativeHost.ts`,
// tabulated in `docs/plan/hybrid-native-phone.md`. A change to one is a
// change to both.
//
// Web → native arrives as a `WKScriptMessage` whose body is the JavaScript
// object WebKit bridged into Foundation collections; native → web goes back
// out as a line of JavaScript for `evaluateJavaScript`. Both directions are
// tolerant in the same way `Sources/Bridge/Models.swift` is: a message this
// build has never heard of is dropped, not fatal, because the page ships
// separately from the app and will grow message types first.

// MARK: - Web → native

/// `.impact(.light)` on send, `.notification(…)` for the other two.
enum NativeHapticKind: String, Codable, Hashable, Sendable {
    case light
    case success
    case warning
}

/// The open chat, as the page sees it. The native header draws its title from
/// this rather than from the list row, which is a snapshot from whenever the
/// push happened.
struct NativeSession: Codable, Hashable, Sendable {
    var sessionId: String
    var title: String
    var state: SessionState
    var attention: AttentionState
}

/// One queued follow-up, trimmed to what the native composer's compact stack
/// draws and acts on: the text, and the id its Send now / Cancel address.
struct NativeQueuedMessage: Codable, Hashable, Sendable {
    var id: String
    var text: String
    /// Whether this row can be steered into the running turn rather than
    /// interrupting it. The page decides (`canSteerQueuedMessage`): the rule
    /// reads the session and the row together, and only Claude and Codex take
    /// text mid-turn.
    ///
    /// Defaulted, because the two halves of the phone ship separately: the
    /// app updates when it is installed, the page when the Mac's renderer is
    /// rebuilt. A required field here means a page one build behind fails to
    /// decode `composer` at all — the card would stop following the chat the
    /// moment a follow-up was queued. Absent reads as "no Steer", which is
    /// exactly what a page that has never heard of it can offer.
    var canSteer = false

    init(id: String, text: String, canSteer: Bool = false) {
        self.id = id
        self.text = text
        self.canSteer = canSteer
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        text = try container.decode(String.self, forKey: .text)
        canSteer = try container.decodeIfPresent(Bool.self, forKey: .canSteer) ?? false
    }
}

/// The composer's own state, as the page sees it — `TranscriptComposer`
/// draws itself from this rather than re-deriving the composer's rules
/// (which efforts a model offers, queue vs send while running).
struct NativeComposerState: Codable, Hashable, Sendable {
    var sessionId: String
    var provider: String
    var modelId: String
    var modelLabel: String
    var effort: String?
    var efforts: [String]
    var queued: [NativeQueuedMessage]
    var running: Bool
}

/// One message from the page.
enum NativeMessage: Hashable, Sendable {
    /// Mounted and the bridge is authenticated; native may call in.
    case ready
    /// On open, and whenever any of its fields change for the open session.
    case session(NativeSession)
    /// On open, and whenever any of its fields change for the open session.
    case composer(NativeComposerState)
    /// The page asked to leave the chat — its own back affordance, or Escape.
    case back
    /// The review screen opened or closed, so native can hide its own bar.
    case review(open: Bool)
    /// The peek at delegated work opened or closed. It is meant to cover the
    /// parent's composer, which in this shell is native chrome the page's own
    /// sheet cannot reach over.
    case agents(open: Bool)
    case haptic(NativeHapticKind)
    /// Bridge auth failed, or the socket has been down for more than 5s.
    case error(message: String)
}

extension NativeMessage {
    /// The `type` the page sent, for the lifecycle log. The payload is left
    /// out: a chat's title is the person's own text, and a log stream is
    /// read over someone's shoulder.
    var logName: String {
        switch self {
        case .ready: return "ready"
        case .session: return "session"
        case .composer: return "composer"
        case .back: return "back"
        case .review(let open): return open ? "review(open)" : "review(closed)"
        case .agents(let open): return open ? "agents(open)" : "agents(closed)"
        case .haptic(let kind): return "haptic(\(kind.rawValue))"
        case .error: return "error"
        }
    }
}

extension NativeMessage: Decodable {
    private enum CodingKeys: String, CodingKey {
        case type
        case open
        case kind
        case message
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "ready": self = .ready
        case "back": self = .back
        case "review": self = .review(open: try container.decode(Bool.self, forKey: .open))
        case "agents": self = .agents(open: try container.decode(Bool.self, forKey: .open))
        case "haptic": self = .haptic(try container.decode(NativeHapticKind.self, forKey: .kind))
        case "error": self = .error(message: try container.decode(String.self, forKey: .message))
        case "session": self = .session(try NativeSession(from: decoder))
        case "composer": self = .composer(try NativeComposerState(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "unknown native message type \(type)"
            )
        }
    }

    /// Decode a `WKScriptMessage.body`, or nil for anything this build does
    /// not understand.
    ///
    /// The body is already a Foundation object graph, so it goes back through
    /// JSON rather than being unpicked by hand: that way the wire enums decode
    /// by the same rules everywhere, including into `.unknown(raw)`.
    init?(body: Any) {
        guard JSONSerialization.isValidJSONObject(body),
              let data = try? JSONSerialization.data(withJSONObject: body),
              let decoded = try? JSONDecoder().decode(NativeMessage.self, from: data)
        else { return nil }
        self = decoded
    }
}

// MARK: - Native → web

/// The appearance the shell imposes while it hosts the page, overriding the
/// preference the phone's own browser tab keeps.
enum NativeTheme: String, Hashable, Sendable {
    case light
    case dark
}

/// One call on `window.argmaxNative`.
///
/// The page installs that object at mount, so every call is written with
/// optional chaining: a command that races the load is a no-op rather than a
/// `TypeError` in a console nobody is reading. `TranscriptHost` queues
/// commands until `ready` anyway; this is the second belt.
enum NativeCommand: Hashable, Sendable {
    /// Switch the transcript in place — no reload.
    case openSession(String)
    /// Park the pane, used when the native stack pops.
    case closeSession
    case setTheme(NativeTheme)
    /// One of the desktop tints.
    case setAccent(String)
    /// Whether the page fills user bubbles with the accent ("accent") or
    /// leaves them a quiet gray ("neutral").
    case setUserBubble(String)
    /// Open the review screen for the chat on screen — the trailing menu's
    /// "Changes", which has no native screen of its own yet.
    case openReview
    /// Hide (or restore) the page's own composer stack, because the native
    /// card under the web view is drawing it instead.
    case setComposer(hidden: Bool)

    var javaScript: String {
        switch self {
        case .openSession(let sessionID):
            return call("openSession", jsonLiteral(sessionID))
        case .closeSession:
            return call("closeSession")
        case .setTheme(let theme):
            return call("setTheme", jsonLiteral(theme.rawValue))
        case .setAccent(let tint):
            return call("setAccent", jsonLiteral(tint))
        case .setUserBubble(let tint):
            return call("setUserBubble", jsonLiteral(tint))
        case .openReview:
            return call("openReview")
        case .setComposer(let hidden):
            // A bare JS boolean, not a JSON string literal — `jsonLiteral`
            // would quote it, and the page's guard (`typeof hidden !==
            // "boolean"`) would then drop the call.
            return call("setComposer", hidden ? "true" : "false")
        }
    }

    /// Optional all the way down: `?.` on the method as well as on the
    /// object. The page is the Mac's renderer, which updates on its own
    /// schedule, so a shell that knows a call the page does not must leave it
    /// undone rather than throw a `TypeError` into a console nobody reads.
    private func call(_ name: String, _ arguments: String...) -> String {
        "window.argmaxNative?.\(name)?.(\(arguments.joined(separator: ",")))"
    }
}

/// A Swift string as a JavaScript string literal.
///
/// JSON string syntax is a subset of JavaScript's, so the serialiser does the
/// escaping — quotes, backslashes, newlines, control characters. U+2028 and
/// U+2029 are the classic exception it leaves alone, and they have been legal
/// inside JavaScript string literals since ES2019, which every WebKit this
/// app runs on predates by years.
private func jsonLiteral(_ value: String) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
          let literal = String(data: data, encoding: .utf8)
    else { return "\"\"" }
    return literal
}
