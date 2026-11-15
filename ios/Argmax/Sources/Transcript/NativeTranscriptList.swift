import SwiftUI

/// A SwiftUI transcript that follows live output until the reader moves away
/// from it. Stable row identities let SwiftUI retain the visible reading
/// position when older history arrives above the viewport.
struct NativeTranscriptList<Item: Identifiable & Equatable, Row: View, Footer: View>: View
where Item.ID == String {
    let items: [Item]
    let sessionID: String
    let scrollRequest: Int
    var turnAnchorID: String?
    var anchorInitialTurn = false
    var isReady = true
    var presentationID = ""
    @Binding var following: Bool
    var hasEarlier = false
    var hasLater = false
    var onLoadEarlier: () -> Void = {}
    var onLoadLater: () -> Void = {}
    @ViewBuilder var row: (Item) -> Row
    /// Live state under the last row: the thinking cue. It is not a row, so
    /// its coming and going never changes row identities or the tail scroll's
    /// target.
    @ViewBuilder var footer: () -> Footer

    @State private var position = ScrollPosition(idType: String.self)
    @State private var model = TranscriptScrollModel()
    @State private var layout = TranscriptScrollLayout()
    private static var contentSpace: String { "transcript-content" }

    private var inputs: TranscriptScrollModel.Inputs {
        TranscriptScrollModel.Inputs(
            turnAnchorID: turnAnchorID,
            anchorInitialTurn: anchorInitialTurn,
            hasEarlier: hasEarlier,
            hasLater: hasLater,
            firstItemID: items.first?.id,
            lastItemID: items.last?.id
        )
    }

    private var turnContext: TranscriptTurnContext {
        TranscriptTurnContext(sessionID: sessionID, anchorID: turnAnchorID, isReady: isReady)
    }

    private var turnFloorHeight: CGFloat {
        layout.turnFloorHeight(reservedAnchorID: layout.reservedTurnAnchorID(inputs))
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                VStack(spacing: 0) {
                    // Not a `LazyVStack`. A lazy stack sizes every row it has
                    // not realised at the average of the ones it has, and a
                    // chat is a few short rows around one very tall answer,
                    // so that average is thousands of points off. Eager rows
                    // have exact heights, so the content end is real.
                    VStack(spacing: 0) {
                        ForEach(items) { item in
                            row(item)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, Spacing.gutter)
                                .onGeometryChange(for: CGFloat.self) {
                                    $0.frame(in: .named(Self.contentSpace)).minY
                                } action: { top in
                                    send(.rowTop(id: item.id, top: top))
                                }
                        }
                    }
                    .scrollTargetLayout()
                    footer()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, Spacing.gutter)
                }
                .padding(.top, 16)
                .padding(.bottom, 20)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                    send(.contentHeight(height))
                }
                Color.clear.frame(height: turnFloorHeight)
            }
            .coordinateSpace(name: Self.contentSpace)
        }
        // The bottom initial-offset anchor is spent on the first layout, empty
        // or not. Content that lands after an empty first layout would start
        // at the top and be walked to the tail over several frames; a fresh
        // scroll view when the first rows arrive paints once, at the tail.
        .id(items.isEmpty)
        .background(.clear)
        // A transcript drag is a reading gesture, so give the screen back to
        // the conversation immediately. Interactive dismissal can stop
        // between keyboard frames and leave the manually inset composer
        // stranded above the bottom edge.
        .scrollDismissesKeyboard(.immediately)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(.top, for: .alignment)
        .defaultScrollAnchor(layout.holdsBottomOnResize(following: following) ? .bottom : .top, for: .sizeChanges)
        .scrollPosition($position)
        .accessibilityIdentifier("native-transcript")
        .onScrollGeometryChange(for: TranscriptScrollGeometry.self) { value in
            TranscriptScrollGeometry(value)
        } action: { previous, next in
            send(.geometry(previous: previous, next: next))
        }
        .onScrollPhaseChange { previous, next, context in
            send(.phase(previous: previous, next: next, geometry: TranscriptScrollGeometry(context.geometry)))
        }
        .onChange(of: following) { _, next in
            send(.followingChanged(next))
        }
        .onChange(of: items, initial: true) { _, items in
            send(.itemsChanged(items.map(\.id)))
        }
        .onChange(of: turnFloorHeight) { _, _ in
            send(.turnFloorChanged)
        }
        .onChange(of: turnContext) { previous, next in
            send(.turnContextChanged(previous: previous, next: next))
        }
        .onChange(of: presentationID) { _, _ in
            send(.presentationChanged)
        }
        .onChange(of: sessionID, initial: true) { _, _ in
            send(.sessionChanged)
        }
        .onChange(of: scrollRequest) { _, _ in
            send(.scrollRequested)
        }
    }

    private func send(_ event: TranscriptScrollModel.Event) {
        model.following = following
        let effects = model.handle(event, inputs)
        if layout != model.layout { layout = model.layout }
        for effect in effects {
            switch effect {
            case .setFollowing(let value): following = value
            case .scheduleTailScroll: sendAfterLayout(.tailScrollDue)
            case .scheduleAnchorScroll: sendAfterLayout(.anchorScrollDue)
            case .scrollToBottom:
                withTransaction(Transaction(animation: nil)) { position.scrollTo(edge: .bottom) }
            case .scrollTo(let y):
                withTransaction(Transaction(animation: nil)) { position.scrollTo(y: y) }
            case .loadEarlier: onLoadEarlier()
            case .loadLater: onLoadLater()
            }
        }
    }

    private func sendAfterLayout(_ event: TranscriptScrollModel.Event) {
        Task { @MainActor in
            await Task.yield()
            send(event)
        }
    }
}

extension NativeTranscriptList where Footer == EmptyView {
    init(
        items: [Item],
        sessionID: String,
        scrollRequest: Int,
        turnAnchorID: String? = nil,
        anchorInitialTurn: Bool = false,
        isReady: Bool = true,
        presentationID: String = "",
        following: Binding<Bool>,
        hasEarlier: Bool = false,
        hasLater: Bool = false,
        onLoadEarlier: @escaping () -> Void = {},
        onLoadLater: @escaping () -> Void = {},
        @ViewBuilder row: @escaping (Item) -> Row
    ) {
        self.init(items: items, sessionID: sessionID, scrollRequest: scrollRequest,
                  turnAnchorID: turnAnchorID, anchorInitialTurn: anchorInitialTurn, isReady: isReady,
                  presentationID: presentationID, following: following,
                  hasEarlier: hasEarlier, hasLater: hasLater,
                  onLoadEarlier: onLoadEarlier, onLoadLater: onLoadLater,
                  row: row) { EmptyView() }
    }
}
