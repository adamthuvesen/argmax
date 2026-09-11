import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The text input shared by both native composers.
///
/// SwiftUI's multiline `TextField` cannot accept an image through iOS's edit
/// menu. This small TextKit bridge keeps the ordinary selection, copy, and
/// text-paste behavior while routing an image chosen through Paste into the
/// composer's existing attachment flow.
struct ComposerTextInput: UIViewRepresentable {
    @Binding var text: String
    let placeholder: String
    let accessibilityLabel: String
    let lineLimits: ClosedRange<Int>
    let submitsOnReturn: Bool
    @Binding var focused: Bool
    let onSubmit: () -> Void
    let onPasteImages: ([NSItemProvider]) -> Void

    @Environment(\.typeScale) private var typeScale
    @Environment(\.accentTint) private var accent
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    init(
        _ placeholder: String,
        text: Binding<String>,
        accessibilityLabel: String,
        lineLimits: ClosedRange<Int>,
        submitsOnReturn: Bool = false,
        focused: Binding<Bool>,
        onSubmit: @escaping () -> Void = {},
        onPasteImages: @escaping ([NSItemProvider]) -> Void
    ) {
        self.placeholder = placeholder
        _text = text
        self.accessibilityLabel = accessibilityLabel
        self.lineLimits = lineLimits
        self.submitsOnReturn = submitsOnReturn
        _focused = focused
        self.onSubmit = onSubmit
        self.onPasteImages = onPasteImages
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> ComposerTextView {
        let textView = ComposerTextView()
        textView.delegate = context.coordinator
        textView.backgroundColor = .clear
        textView.isScrollEnabled = false
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        textView.setContentHuggingPriority(.required, for: .vertical)
        return textView
    }

    func updateUIView(_ textView: ComposerTextView, context: Context) {
        // Reading the environment value makes a Dynamic Type change update
        // this UIKit-backed field just as it updates neighboring SwiftUI text.
        _ = dynamicTypeSize
        context.coordinator.parent = self
        textView.onPasteImages = onPasteImages
        textView.placeholder = placeholder
        textView.accessibilityLabel = accessibilityLabel
        textView.minimumLines = lineLimits.lowerBound
        textView.returnKeyType = submitsOnReturn ? .send : .default
        textView.tintColor = accent.uiColor
        textView.textColor = Theme.inkColor

        let font = typeScale.uiFont(
            size: TypeScale.baseSize(.body),
            relativeTo: .body,
            compatibleWith: textView.traitCollection
        )
        textView.font = font
        textView.placeholderFont = font
        textView.invalidateIntrinsicContentSize()

        if textView.text != text {
            textView.text = text
            textView.selectedRange = NSRange(location: text.utf16.count, length: 0)
        }
        textView.placeholderHidden = !text.isEmpty

        if focused != context.coordinator.appliedFocus {
            context.coordinator.appliedFocus = focused
            DispatchQueue.main.async {
                if focused {
                    textView.becomeFirstResponder()
                } else {
                    textView.resignFirstResponder()
                }
            }
        }
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView textView: ComposerTextView,
        context: Context
    ) -> CGSize? {
        guard let font = textView.font else { return nil }
        let insets = textView.textContainerInset.top + textView.textContainerInset.bottom
        let minimum = ceil(font.lineHeight * CGFloat(lineLimits.lowerBound) + insets)
        let maximum = ceil(font.lineHeight * CGFloat(lineLimits.upperBound) + insets)
        let width = proposal.width ?? textView.bounds.width
        guard width > 0 else { return nil }
        let fitting = textView.sizeThatFits(
            CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)
        ).height
        textView.isScrollEnabled = fitting > maximum
        return CGSize(width: width, height: min(max(fitting, minimum), maximum))
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerTextInput
        var appliedFocus = false

        init(parent: ComposerTextInput) {
            self.parent = parent
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            appliedFocus = true
            parent.focused = true
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            appliedFocus = false
            parent.focused = false
        }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            (textView as? ComposerTextView)?.placeholderHidden = !textView.text.isEmpty
            textView.invalidateIntrinsicContentSize()
        }

        func textView(
            _ textView: UITextView,
            shouldChangeTextIn range: NSRange,
            replacementText text: String
        ) -> Bool {
            guard parent.submitsOnReturn, text == "\n" else { return true }
            parent.onSubmit()
            return false
        }
    }
}

/// A normal iOS text view with image-aware Paste behavior.
///
/// The clipboard is read only after the user chooses Paste from the standard
/// edit menu. Plain text falls through to `UITextView`, preserving the system
/// behavior and paste-permission semantics.
final class ComposerTextView: UITextView {
    var onPasteImages: ([NSItemProvider]) -> Void = { _ in }
    var minimumLines = 1

    var placeholder: String? {
        get { placeholderLabel.text }
        set { placeholderLabel.text = newValue }
    }

    var placeholderFont: UIFont? {
        get { placeholderLabel.font }
        set { placeholderLabel.font = newValue }
    }

    var placeholderHidden: Bool {
        get { placeholderLabel.isHidden }
        set { placeholderLabel.isHidden = newValue }
    }

    private let placeholderLabel = UILabel()

    override var intrinsicContentSize: CGSize {
        guard let font else { return super.intrinsicContentSize }
        let insets = textContainerInset.top + textContainerInset.bottom
        return CGSize(
            width: UIView.noIntrinsicMetric,
            height: ceil(font.lineHeight * CGFloat(minimumLines) + insets)
        )
    }

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        placeholderLabel.textColor = .placeholderText
        placeholderLabel.isAccessibilityElement = false
        placeholderLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(placeholderLabel)
        NSLayoutConstraint.activate([
            placeholderLabel.leadingAnchor.constraint(equalTo: leadingAnchor),
            placeholderLabel.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            placeholderLabel.topAnchor.constraint(equalTo: topAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), UIPasteboard.general.hasImages {
            return true
        }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        if routePastedImages(from: UIPasteboard.general.itemProviders) { return }
        super.paste(sender)
    }

    @discardableResult
    func routePastedImages(from providers: [NSItemProvider]) -> Bool {
        let images = providers.filter {
            $0.hasItemConformingToTypeIdentifier(UTType.image.identifier)
        }
        guard !images.isEmpty else { return false }
        onPasteImages(images)
        return true
    }
}
