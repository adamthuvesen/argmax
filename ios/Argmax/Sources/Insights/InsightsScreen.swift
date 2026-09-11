import SwiftUI

// Insights: the desktop Usage and Activity pages, redrawn for a phone. One
// pushed screen with a Usage|Activity segment — fewer routes, one store, one
// refresh — and the desktop's card language: hero number, area charts,
// leaderboards, and hairline-divided ledgers.
//
// Reads are stale-while-revalidate (`InsightsStore.ensure`): the
// cached pair paints instantly, a foreground return or pull refreshes, and
// the pickers below never poll.

struct InsightsScreen: View {
    @EnvironmentObject var store: InsightsStore
    /// Warmed by `RootView` before this screen exists, so the card opens
    /// with numbers on it.
    @EnvironmentObject var limits: PlanLimitsStore
    let onBack: () -> Void

    var body: some View {
        ScrollView {
            pageBody
        }
        .background(Theme.ground.ignoresSafeArea())
        .safeAreaInset(edge: .top, spacing: 0) {
            ScreenHeader(
                title: store.tab == .usage ? "Usage" : "Activity",
                subtitle: rangeSubtitle,
                onBack: onBack
            )
        }
        .toolbar(.hidden, for: .navigationBar)
        .interactivePop()
        .task { await store.ensure(store.tab) }
        .refreshable { await store.reloadCurrent() }
        .onChange(of: store.tab) { _, tab in Task { await store.ensure(tab) } }
        .onChange(of: store.usageWindow) { Task { await store.reloadUsage() } }
        .onChange(of: store.activityWindow) { Task { await store.reloadActivity() } }
        .navigationTitle("")
    }

    // MARK: - Page

    private var pageBody: some View {
        VStack(alignment: .leading, spacing: Spacing.section) {
            Segmented(
                options: InsightsStore.Tab.allCases,
                selection: $store.tab,
                label: \.label
            )
            .background(
                Theme.raised,
                in: .rect(cornerRadius: Radius.control, style: .continuous)
            )
            filterRow
            updatingLine
            if showingSkeleton {
                InsightsSkeleton()
            } else if let failure = store.failure, store.usage == nil,
                store.activity == nil
            {
                EmptyState(
                    message: failure,
                    action: (title: "Retry", run: { Task { await store.reloadCurrent() } })
                )
            } else {
                content
            }
        }
        .screenGutter()
        .padding(.top, Spacing.snug)
        .padding(.bottom, Spacing.section)
    }

    private var filterRow: some View {
        HStack(spacing: Spacing.snug) {
            windowMenu
            if store.tab == .usage {
                providerMenu
            } else {
                projectMenu
            }
            Spacer(minLength: 0)
        }
    }

    private var windowMenu: some View {
        let windows = store.tab == .usage
            ? InsightsStore.usageWindows : InsightsStore.activityWindows
        let selection = store.tab == .usage ? store.usageWindow : store.activityWindow
        return Menu {
            ForEach(windows, id: \.self) { window in
                Button(windowTitle(window)) {
                    Haptics.light()
                    if store.tab == .usage {
                        store.usageWindow = window
                    } else {
                        store.activityWindow = window
                    }
                }
            }
        } label: {
            filterPill(icon: "calendar", text: windowTitle(selection))
        }
        .accessibilityLabel("Time range: \(windowTitle(selection))")
    }

    private var providerMenu: some View {
        let providers = store.usage?.providers ?? []
        return Menu {
            Button("All providers") {
                Haptics.light()
                withAnimation(.easeOut(duration: 0.2)) { store.providerFilter = nil }
            }
            ForEach(providers) { provider in
                Button(ProviderMark.displayName(provider.provider)) {
                    Haptics.light()
                    withAnimation(.easeOut(duration: 0.2)) {
                        store.providerFilter = provider.provider
                    }
                }
            }
        } label: {
            filterPill(
                icon: "line.3.horizontal.decrease.circle",
                text: store.providerFilter.map(ProviderMark.displayName) ?? "All providers"
            )
        }
        .accessibilityLabel(
            "Provider filter: \(store.providerFilter.map(ProviderMark.displayName) ?? "all providers")"
        )
    }

    private var projectMenu: some View {
        let repos = store.activity?.repositories ?? []
        return Menu {
            Button("All repositories") {
                Haptics.light()
                withAnimation(.easeOut(duration: 0.2)) { store.projectFilter = nil }
            }
            ForEach(repos.prefix(12)) { repo in
                Button(repo.name) {
                    Haptics.light()
                    withAnimation(.easeOut(duration: 0.2)) {
                        store.projectFilter = repo.projectId
                    }
                }
            }
        } label: {
            filterPill(icon: "folder", text: projectLabel)
        }
        .accessibilityLabel("Repository filter: \(projectLabel)")
    }

    private var projectLabel: String {
        guard let filter = store.projectFilter else { return "All repositories" }
        return store.activity?.repositories.first { $0.projectId == filter }?.name
            ?? "All repositories"
    }

    private func filterPill(icon: String, text: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.muted)
            Text(text)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.ink)
                .lineLimit(1)
            Image(systemName: "chevron.down")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Theme.muted)
        }
        .padding(.horizontal, Spacing.row)
        .frame(minHeight: 36)
        .background(Theme.raised, in: .capsule)
    }

    private func windowTitle(_ window: String) -> String {
        switch window {
        case "24h": return "Last 24 hours"
        case "7d": return "Last 7 days"
        case "30d": return "Last 30 days"
        case "12m": return "Last 12 months"
        case "year": return "This year"
        default: return window
        }
    }

    private func windowDeltaLabel(_ window: String) -> String {
        switch window {
        case "24h": return "24 hours"
        case "7d": return "7 days"
        case "30d": return "30 days"
        case "12m": return "12 months"
        case "year": return "year"
        default: return window
        }
    }

    private var rangeSubtitle: String? {
        if store.tab == .usage {
            return store.usage.map { _ in windowTitle(store.usageWindow).lowercased() }
        }
        return store.activity.map { _ in windowTitle(store.activityWindow).lowercased() }
    }

    private var showingSkeleton: Bool {
        // Bones only when there is nothing truthful to show: no data at all,
        // or data for a different window than the picker names. Same-window
        // stale numbers stay up behind a refresh — the "Updating…" line says
        // so — because a blank page is never faster than an old one.
        if store.tab == .usage {
            return store.usage == nil || store.usage?.window != store.usageWindow
        }
        return store.activity == nil || store.activity?.window != store.activityWindow
    }

    /// A quiet line under the filters while a background refresh lands. The
    /// numbers above it are the previous window's until the new one paints.
    private var updatingLine: some View {
        Group {
            if store.isLoading(store.tab), !showingSkeleton {
                HStack(spacing: 6) {
                    ProgressView()
                        .controlSize(.mini)
                    Text("Updating…")
                        .typeMeta().foregroundStyle(Theme.muted)
                }
                .accessibilityLabel("Updating insights")
            }
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if store.tab == .usage {
            usageContent
        } else {
            activityContent
        }
    }

    @ViewBuilder
    private var usageContent: some View {
        if let summary = store.usage {
            UsageHero(
                summary: summary,
                mode: store.usageMode,
                windowLabel: windowDeltaLabel(store.usageWindow)
            )
            Segmented(
                options: InsightsStore.UsageMode.allCases,
                selection: $store.usageMode,
                label: \.label
            )
            .background(
                Theme.raised,
                in: .rect(cornerRadius: Radius.control, style: .continuous)
            )
            UsageProviderCards(store: store)
            // Below the ledger, as on the desktop: what the plans have left
            // beside the spend it belongs to.
            InsightsCard(title: "Remaining on your plans", trailing: nil) {
                PlanLimitsSection(store: limits)
            }
            UsageDailyChart(store: store)
            UsageTokenFlow(summary: summary)
            UsageBreakdown(store: store)
        }
    }

    @ViewBuilder
    private var activityContent: some View {
        if let summary = store.activity {
            ActivityHero(
                summary: summary,
                mode: store.activityMode,
                windowLabel: windowDeltaLabel(store.activityWindow)
            )
            Segmented(
                options: InsightsStore.ActivityMode.allCases,
                selection: $store.activityMode,
                label: \.label
            )
            .background(
                Theme.raised,
                in: .rect(cornerRadius: Radius.control, style: .continuous)
            )
            ActivityHeatmap(summary: summary)
            ActivityDailyChart(store: store)
            ActivityRepositories(store: store)
            ActivityGithubNotice(state: summary.github)
            ActivityPullRequests(store: store)
            ActivityReviews(store: store)
            ActivityCadenceCard(summary: summary)
        }
    }
}
