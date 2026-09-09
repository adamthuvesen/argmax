import UIKit

/// First run, and the way back after a token changes.
///
/// The pairing link is the whole credential, so this asks for it verbatim
/// rather than for a host and a token separately — it is what Settings →
/// Integrations → Remote access already puts on the clipboard and in the QR
/// code, and splitting it invites a mistyped token.
final class PairingViewController: UIViewController {
    private let onPaired: (URL) -> Void
    private let field = UITextField()
    private let hint = UILabel()

    init(onPaired: @escaping (URL) -> Void) {
        self.onPaired = onPaired
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let title = UILabel()
        title.text = "Connect to your Mac"
        title.font = .systemFont(ofSize: 24, weight: .semibold)
        title.textColor = .white

        let body = UILabel()
        body.text = "Argmax → Settings → Integrations → Remote access. Copy the pairing link and paste it here."
        body.font = .systemFont(ofSize: 15)
        body.textColor = .secondaryLabel
        body.numberOfLines = 0

        field.placeholder = "http://your-mac.tailnet.ts.net:8790/mobile.html#token=…"
        field.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        field.textColor = .white
        field.backgroundColor = .secondarySystemBackground
        field.borderStyle = .roundedRect
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.keyboardType = .URL
        field.clearButtonMode = .whileEditing

        hint.font = .systemFont(ofSize: 13)
        hint.textColor = .systemRed
        hint.numberOfLines = 0

        let paste = UIButton(configuration: .bordered())
        paste.setTitle("Paste from clipboard", for: .normal)
        paste.addTarget(self, action: #selector(pasteTapped), for: .touchUpInside)

        let connect = UIButton(configuration: .filled())
        connect.setTitle("Connect", for: .normal)
        connect.addTarget(self, action: #selector(connectTapped), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [title, body, field, hint, paste, connect])
        stack.axis = .vertical
        stack.spacing = 14
        stack.setCustomSpacing(24, after: hint)
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
    }

    @objc private func pasteTapped() {
        field.text = UIPasteboard.general.string
        hint.text = nil
    }

    @objc private func connectTapped() {
        guard let url = Self.validate(field.text) else {
            // The port is the trap: `tailscale serve` and the bridge both
            // answer on 8790, and a link without it silently goes to :80.
            hint.text = "That is not a pairing link. It should include the port and the #token= fragment."
            return
        }
        HostCredential.save(url)
        onPaired(url)
    }

    /// Accepts only what the bridge actually serves.
    static func validate(_ text: String?) -> URL? {
        guard let raw = text?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty,
              let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              url.host?.isEmpty == false,
              url.fragment?.contains("token=") == true
        else { return nil }
        return url
    }
}
