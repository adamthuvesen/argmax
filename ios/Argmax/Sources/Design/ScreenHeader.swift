import SwiftUI
import UIKit

/// Our header: 52pt under the safe area, title on the left, a slot on the
/// right, and a back chevron when the screen was pushed.
///
/// The system navigation bar is hidden everywhere in this app. Its large
/// title is 34pt of San Francisco that belongs to Mail and Settings, its
/// inline title centres a name that is usually too long for the space, and
/// its tint is blue. What it does own — the interactive pop gesture — is put
/// back by `interactivePop()` below, because hiding the bar is what takes it
/// away.
struct ScreenHeader<Trailing: View, Center: View>: View {
    let title: String
    var subtitle: String?
    /// Set on a pushed screen. Nil at the root, where there is nothing to go
    /// back to and a chevron would be a lie.
    var onBack: (() -> Void)?
    /// The fox beside the title. Only the root screen wears it — the app's
    /// name and its mark belong together once, not on every pushed screen.
    var showsMark = false
    @ViewBuilder var trailing: () -> Trailing
    /// Centred over the header, independent of what the sides take: the root
    /// screen puts the Mac it is talking to here.
    @ViewBuilder var center: () -> Center

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.row) {
            if let onBack {
                Button(action: onBack) {
                    Image(systemName: "chevron.left")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.ink)
                        // A thumb-sized target around a small glyph, pulled
                        // back into the gutter so the chevron itself sits on
                        // the column the title uses.
                        .frame(width: 32, height: 32)
                        .contentShape(.rect)
                }
                .padding(.leading, -6)
                .accessibilityLabel("Back")
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 6 }
            }
            if showsMark {
                FoxMark(size: 34)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 8 }
            }
            if !title.isEmpty {
                VStack(alignment: .leading, spacing: 1) {
                    Group {
                        if onBack == nil {
                            Text(title).typeScreenTitle()
                        } else {
                            Text(title).typePushedTitle()
                        }
                    }
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .typeSubtitle()
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
            }
            Spacer(minLength: Spacing.snug)
            trailing()
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 6 }
        }
        .frame(minHeight: Spacing.headerHeight, alignment: .center)
        .overlay { center() }
        .screenGutter()
        .padding(.bottom, Spacing.snug)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(alignment: .top) {
            // Rows dissolve under the header rather than being cut by a
            // line: the same rule the desktop's scrollers follow.
            VStack(spacing: 0) {
                Theme.ground
                LinearGradient(
                    colors: [Theme.ground, Theme.ground.opacity(0)],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: 14)
            }
            .ignoresSafeArea(edges: .top)
            .allowsHitTesting(false)
        }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isHeader)
    }
}

extension ScreenHeader where Trailing == EmptyView, Center == EmptyView {
    /// Title only.
    init(title: String, subtitle: String? = nil, onBack: (() -> Void)? = nil) {
        self.title = title
        self.subtitle = subtitle
        self.onBack = onBack
        self.showsMark = false
        self.trailing = { EmptyView() }
        self.center = { EmptyView() }
    }
}

/// A bare glyph in the header's trailing slot. No circle, no capsule, no
/// filled background — the "+" on the Chats screen is one accent stroke.
struct HeaderGlyphButton: View {
    let systemName: String
    let label: String
    var tint: Color?
    var weight: Font.Weight = .medium
    /// A 40pt raised disc behind the glyph — the web header's round buttons.
    /// The bare glyph is the default; the disc is for the one control that
    /// should read as a button at a glance.
    var filled = false
    let action: () -> Void

    @Environment(\.accentTint) private var accent

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.body.weight(weight))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(tint ?? accent.color)
                .frame(width: filled ? 40 : 32, height: filled ? 40 : 32)
                .background {
                    if filled { Circle().fill(Theme.raised) }
                }
                .contentShape(.rect)
        }
        .accessibilityLabel(label)
    }
}

// MARK: - The gesture the hidden bar takes with it

extension View {
    /// Keeps the edge swipe popping after `.toolbar(.hidden, for:
    /// .navigationBar)`.
    ///
    /// `UINavigationController` disables its `interactivePopGestureRecognizer`
    /// whenever the bar is hidden, on the reasoning that a screen with no
    /// bar may have drawn its own back affordance somewhere the swipe would
    /// fight. Ours has, and it does not fight — so the recogniser is turned
    /// back on with a delegate that begins only when there is something to
    /// pop and no transition already running.
    func interactivePop() -> some View {
        background(InteractivePopEnabler().frame(width: 0, height: 0))
    }
}

private struct InteractivePopEnabler: UIViewControllerRepresentable {
    func makeCoordinator() -> PopGestureDelegate { PopGestureDelegate() }

    func makeUIViewController(context: Context) -> UIViewController {
        Enabler(coordinator: context.coordinator)
    }

    func updateUIViewController(_ controller: UIViewController, context: Context) {}

    /// Parked in the hierarchy so it can find the navigation controller
    /// SwiftUI built. There is no public handle on it otherwise.
    final class Enabler: UIViewController {
        private let coordinator: PopGestureDelegate

        init(coordinator: PopGestureDelegate) {
            self.coordinator = coordinator
            super.init(nibName: nil, bundle: nil)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError("not from a nib") }

        override func didMove(toParent parent: UIViewController?) {
            super.didMove(toParent: parent)
            adopt()
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            adopt()
        }

        private func adopt() {
            guard let stack = navigationController,
                  let gesture = stack.interactivePopGestureRecognizer
            else { return }
            coordinator.stack = stack
            gesture.delegate = coordinator
            gesture.isEnabled = true
        }
    }
}

private final class PopGestureDelegate: NSObject, UIGestureRecognizerDelegate {
    weak var stack: UINavigationController?

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let stack else { return false }
        // At the root there is nothing behind the screen; mid-transition the
        // stack is already moving and a second pop corrupts it.
        return stack.viewControllers.count > 1 && stack.transitionCoordinator == nil
    }

    /// The transcript is a full-screen web view whose own scroller starts at
    /// the left edge. The pop has to win there, or the chat becomes the one
    /// screen you cannot swipe out of.
    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool {
        false
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldBeRequiredToFailBy other: UIGestureRecognizer
    ) -> Bool {
        false
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRequireFailureOf other: UIGestureRecognizer
    ) -> Bool {
        false
    }
}

extension ScreenHeader where Center == EmptyView {
    /// The common header: sides only.
    init(
        title: String,
        subtitle: String? = nil,
        onBack: (() -> Void)? = nil,
        showsMark: Bool = false,
        @ViewBuilder trailing: @escaping () -> Trailing
    ) {
        self.title = title
        self.subtitle = subtitle
        self.onBack = onBack
        self.showsMark = showsMark
        self.trailing = trailing
        self.center = { EmptyView() }
    }
}
