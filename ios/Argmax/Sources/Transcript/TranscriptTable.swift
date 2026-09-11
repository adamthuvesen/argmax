import Foundation
import SwiftUI

struct TranscriptTable: Sendable {
    let headers: [String]
    let rows: [[String]]

    static func parse(
        startingAt index: Int,
        lines: [String]
    ) -> (table: TranscriptTable, nextIndex: Int)? {
        guard index + 1 < lines.count else { return nil }
        let headers = cells(in: lines[index])
        let separator = cells(in: lines[index + 1])
        guard headers.count >= 2, separator.count == headers.count,
              separator.allSatisfy({ cell in
                  let rule = cell.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: ":"))
                  return rule.count >= 3 && rule.allSatisfy { $0 == "-" }
              })
        else { return nil }

        var rows: [[String]] = []
        var cursor = index + 2
        while cursor < lines.count {
            let row = cells(in: lines[cursor])
            guard !lines[cursor].trimmingCharacters(in: .whitespaces).isEmpty, row.count >= 2 else { break }
            rows.append(Array((row + Array(repeating: "", count: headers.count)).prefix(headers.count)))
            cursor += 1
        }
        return (TranscriptTable(headers: headers, rows: rows), cursor)
    }

    static func cells(in line: String) -> [String] {
        var source = line.trimmingCharacters(in: .whitespaces)
        if source.hasPrefix("|") { source.removeFirst() }
        if source.hasSuffix("|") { source.removeLast() }
        var cells: [String] = []
        var current = ""
        var escaped = false
        var inCode = false
        for character in source {
            if escaped {
                current.append(character)
                escaped = false
            } else if character == "\\" {
                current.append(character)
                escaped = true
            } else if character == "`" {
                inCode.toggle()
                current.append(character)
            } else if character == "|", !inCode {
                cells.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            } else {
                current.append(character)
            }
        }
        cells.append(current.trimmingCharacters(in: .whitespaces))
        return cells
    }

    var tabSeparatedText: String {
        ([headers] + rows).map { $0.joined(separator: "\t") }.joined(separator: "\n")
    }
}

struct TranscriptTableBlock: View {
    let table: TranscriptTable
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Table").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                Spacer()
                Button { UIPasteboard.general.string = table.tabSeparatedText } label: {
                    Image(systemName: "doc.on.doc").frame(width: 32, height: 32)
                }
                .accessibilityLabel("Copy table")
                Button { expanded = true } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right").frame(width: 32, height: 32)
                }
                .accessibilityLabel("View full table")
            }
            .foregroundStyle(Theme.muted)
            .padding(.horizontal, 10)
            ScrollView(.horizontal) { tableGrid.padding([.horizontal, .bottom], 10) }
        }
        .background(Theme.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .fullScreenCover(isPresented: $expanded) {
            NavigationStack {
                ScrollView([.horizontal, .vertical]) { tableGrid.padding(16) }
                    .background(Theme.ground)
                    .navigationTitle("Table")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Done") { expanded = false }
                        }
                        ToolbarItem(placement: .topBarTrailing) {
                            Button { UIPasteboard.general.string = table.tabSeparatedText } label: {
                                Label("Copy", systemImage: "doc.on.doc")
                            }
                        }
                    }
            }
        }
    }

    private var tableGrid: some View {
        Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
            tableRow(table.headers, header: true)
            ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                Divider().gridCellUnsizedAxes(.horizontal)
                tableRow(row, header: false)
            }
        }
        .background(Theme.ground.opacity(0.35), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(Theme.line, lineWidth: 0.5))
    }

    private func tableRow(_ cells: [String], header: Bool) -> some View {
        GridRow {
            ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                Text((try? AttributedString(markdown: cell, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(cell))
                    .font(header ? .footnote.weight(.semibold) : .footnote)
                    .foregroundStyle(Theme.ink)
                    .textSelection(.enabled)
                    .frame(minWidth: 104, maxWidth: 240, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
            }
        }
    }
}
