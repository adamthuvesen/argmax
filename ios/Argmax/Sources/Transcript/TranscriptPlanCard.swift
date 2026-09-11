import SwiftUI
import UIKit

func transcriptPlanTitle(_ markdown: String) -> String {
    for rawLine in markdown.split(whereSeparator: \Character.isNewline) {
        let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty else { continue }
        let withoutHeading = line.drop(while: { $0 == "#" || $0 == " " })
        if !withoutHeading.isEmpty { return String(withoutHeading) }
    }
    return "Plan"
}

struct TranscriptPlanCard: View {
    let plan: TranscriptPlan
    var client: BridgeClient?
    var onOpenFile: (String) -> Void = { _ in }
    let onAccept: () async -> Bool
    let onRevise: () -> Void

    @State private var collapsed: Bool
    @State private var accepting = false
    @State private var submitted = false
    @State private var copied = false
    @State private var failure: String?

    init(
        plan: TranscriptPlan,
        client: BridgeClient? = nil,
        onOpenFile: @escaping (String) -> Void = { _ in },
        onAccept: @escaping () async -> Bool,
        onRevise: @escaping () -> Void
    ) {
        self.plan = plan
        self.client = client
        self.onOpenFile = onOpenFile
        self.onAccept = onAccept
        self.onRevise = onRevise
        _collapsed = State(initialValue: !plan.isOutstanding)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.row) {
            HStack(spacing: Spacing.snug) {
                Image(systemName: "list.bullet.clipboard")
                    .foregroundStyle(Theme.muted)
                Text(transcriptPlanTitle(plan.markdown))
                    .typeStyle(.footnote, weight: .semibold)
                    .foregroundStyle(Theme.ink)
                    .lineLimit(collapsed ? 1 : 2)
                Spacer(minLength: Spacing.tight)
                Button {
                    UIPasteboard.general.string = plan.markdown
                    copied = true
                    Haptics.light()
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .frame(width: 34, height: 34)
                }
                .buttonStyle(PressDim())
                .foregroundStyle(copied ? Theme.sage : Theme.muted)
                .accessibilityLabel(copied ? "Plan copied" : "Copy plan")

                Button {
                    withAnimation(.easeOut(duration: 0.16)) { collapsed.toggle() }
                } label: {
                    Image(systemName: collapsed ? "chevron.down" : "chevron.up")
                        .frame(width: 34, height: 34)
                }
                .buttonStyle(PressDim())
                .foregroundStyle(Theme.muted)
                .accessibilityLabel(collapsed ? "Expand plan" : "Collapse plan")
            }

            if !collapsed {
                TranscriptMarkdown(text: plan.markdown, client: client, onOpenFile: onOpenFile)
                    .textSelection(.enabled)

                if let failure {
                    Text(failure)
                        .typeStyle(.footnote)
                        .foregroundStyle(Theme.rose)
                        .accessibilityLabel("Could not accept plan. \(failure)")
                }

                if plan.isOutstanding && !submitted {
                    HStack(spacing: Spacing.snug) {
                        QuietButton(title: "Revise", systemImage: "pencil") {
                            Haptics.light()
                            onRevise()
                            withAnimation(.easeOut(duration: 0.16)) { collapsed = true }
                        }
                        .disabled(accepting)

                        PrimaryButton(
                            title: accepting ? "Starting…" : "Proceed",
                            systemImage: "arrow.right",
                            busy: accepting
                        ) {
                            accept()
                        }
                        .disabled(accepting)
                    }
                } else if submitted {
                    Label {
                        Text("Submitted").typeStyle(.footnote, weight: .medium)
                    } icon: {
                        Image(systemName: "checkmark.circle.fill").typeSymbol(.footnote, weight: .medium)
                    }
                        .foregroundStyle(Theme.sage)
                }
            }
        }
        .padding(Spacing.row)
        .background(Theme.raised, in: .rect(cornerRadius: Radius.card, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Plan: \(transcriptPlanTitle(plan.markdown))")
    }

    private func accept() {
        guard !accepting else { return }
        accepting = true
        failure = nil
        Task {
            if await onAccept() {
                submitted = true
                accepting = false
                Haptics.success()
                withAnimation(.easeOut(duration: 0.16)) { collapsed = true }
            } else {
                accepting = false
                failure = "The plan response was not sent. Try again."
                Haptics.warning()
            }
        }
    }
}
