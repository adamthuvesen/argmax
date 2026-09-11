import Foundation

/// The pairing link, and everything derived from it.
///
/// The link is the whole credential — `https://<mac>.<tailnet>.ts.net/mobile.html#token=…`
/// — which is why the app asks for it verbatim rather than for a host and a
/// token separately: it is what Settings → Integrations → Remote access puts
/// on the clipboard and in the QR code, and splitting it invites a mistyped
/// token.
enum PairingLink {
    /// Accepts only what the app can load. App Transport Security is at its
    /// default, so a plain-http link would fail later and less clearly; and
    /// the page is only a secure context over TLS, which its service worker
    /// and `crypto.randomUUID` both depend on.
    static func validate(_ text: String?) -> URL? {
        guard let raw = text?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
              let url = URL(string: raw),
              url.scheme?.lowercased() == "https",
              url.host?.isEmpty == false,
              token(in: url) != nil
        else { return nil }
        return url
    }

    /// The bearer token, which rides in the fragment so it never reaches a
    /// server log as a query parameter.
    static func token(in url: URL) -> String? {
        guard let fragment = URLComponents(url: url, resolvingAgainstBaseURL: false)?.fragment,
              !fragment.isEmpty
        else { return nil }
        // The fragment is query-shaped (`token=…&theme=…`), so parse it as one.
        var parser = URLComponents()
        parser.percentEncodedQuery = fragment
        guard let token = parser.queryItems?.first(where: { $0.name == "token" })?.value,
              !token.isEmpty
        else { return nil }
        return token
    }

    /// `https://host/mobile.html#token=…` → the same page in embed mode.
    ///
    /// `embed=1` is what tells the renderer the native shell is the chrome:
    /// no list screen, no web header, no history mirroring, and a transparent
    /// body so the container's colour shows through the load. The fragment
    /// rides along unchanged — it is the credential.
    static func embeddedTranscriptURL(for url: URL) -> URL? {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              token(in: url) != nil
        else { return nil }
        components.path = "/mobile.html"
        components.queryItems = [URLQueryItem(name: "embed", value: "1")]
        return components.url
    }

    /// `https://host/mobile.html#token=…` → `wss://host/api/ws`.
    ///
    /// Plain http maps to ws even though `validate` refuses it: a tailnet
    /// without certificates can still run the bridge, and a debug build
    /// pointed at one should reach it rather than fail obscurely.
    static func socketURL(for url: URL) -> URL? {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased()
        else { return nil }
        switch scheme {
        case "https", "wss": components.scheme = "wss"
        case "http", "ws": components.scheme = "ws"
        default: return nil
        }
        components.path = "/api/ws"
        components.query = nil
        components.fragment = nil
        return components.url
    }
}
