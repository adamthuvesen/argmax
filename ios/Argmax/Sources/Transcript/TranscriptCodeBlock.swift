import SwiftUI
import UIKit

struct TranscriptCodeBlock: View {
    let language: String?
    let source: String
    @State private var expanded = false

    private var isMermaid: Bool {
        guard let language else { return false }
        return language.lowercased() == "mermaid" || language.lowercased() == "mmd"
    }

    var body: some View {
        if isMermaid {
            TranscriptRichBlock(kind: .mermaid, source: source, display: true)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 2) {
                    Text(language?.isEmpty == false ? language! : "Code")
                        .typeStyle(.footnote, weight: .semibold)
                        .foregroundStyle(Theme.muted)
                    Spacer()
                    Button { UIPasteboard.general.string = source } label: {
                        Image(systemName: "doc.on.doc").frame(width: 32, height: 32)
                    }
                    .accessibilityLabel("Copy code")
                    Button { expanded = true } label: {
                        Image(systemName: "arrow.up.left.and.arrow.down.right").frame(width: 32, height: 32)
                    }
                    .accessibilityLabel("View code full screen")
                }
                .foregroundStyle(Theme.muted)
                .padding(.horizontal, 10)
                ScrollView(.horizontal) {
                    code.padding(.horizontal, 10).padding(.bottom, 12)
                }
            }
            .background(Theme.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .fullScreenCover(isPresented: $expanded) {
                NavigationStack {
                    ScrollView([.horizontal, .vertical]) { code.padding(16) }
                        .background(Theme.ground)
                        .navigationTitle(language?.isEmpty == false ? language! : "Code")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) { Button("Done") { expanded = false } }
                            ToolbarItem(placement: .topBarTrailing) {
                                Button { UIPasteboard.general.string = source } label: {
                                    Label("Copy", systemImage: "doc.on.doc")
                                }
                            }
                        }
                }
            }
        }
    }

    private var code: some View {
        Text(source)
            .typeStyle(.footnote, mono: true)
            .foregroundStyle(Theme.ink)
            .textSelection(.enabled)
            .fixedSize(horizontal: true, vertical: true)
    }
}
