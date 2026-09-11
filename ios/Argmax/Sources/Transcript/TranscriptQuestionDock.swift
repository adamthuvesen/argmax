import SwiftUI

func transcriptQuestionAnswer(
    questions: [TranscriptQuestion],
    selections: [[Int]],
    otherText: [String]
) -> String {
    questions.enumerated().map { questionIndex, question in
        let picks = selections.indices.contains(questionIndex) ? selections[questionIndex] : []
        let labels = picks.compactMap { optionIndex -> String? in
            if question.options.indices.contains(optionIndex) {
                return question.options[optionIndex].label
            }
            if optionIndex == question.options.count,
               otherText.indices.contains(questionIndex) {
                let typed = otherText[questionIndex].trimmingCharacters(in: .whitespacesAndNewlines)
                return typed.isEmpty ? nil : typed
            }
            return nil
        }
        let header = question.header.isEmpty ? question.question : question.header
        return "\(header): \(labels.isEmpty ? "(no selection)" : labels.joined(separator: ", "))"
    }.joined(separator: "\n")
}

func transcriptQuestionIsAnswered(
    _ question: TranscriptQuestion,
    selections: [Int],
    otherText: String
) -> Bool {
    let hasRequiredCount = question.allowsMultiple ? !selections.isEmpty : selections.count == 1
    guard hasRequiredCount else { return false }
    if selections.contains(question.options.count) {
        return !otherText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    return true
}

/// A live provider question replaces the ordinary composer in the same slot.
/// Dismiss means “answer in my own words”: the card closes without sending so
/// the composer comes back with any draft the person already had.
struct TranscriptQuestionDock: View {
    let card: TranscriptQuestionCard
    let onAnswer: (String) async -> Bool
    let onDismiss: () -> Void

    @State private var page = 0
    @State private var selections: [[Int]]
    @State private var otherText: [String]
    @State private var sending = false
    @State private var failure: String?
    @FocusState private var focusedOtherPage: Int?

    init(
        card: TranscriptQuestionCard,
        onAnswer: @escaping (String) async -> Bool,
        onDismiss: @escaping () -> Void
    ) {
        self.card = card
        self.onAnswer = onAnswer
        self.onDismiss = onDismiss
        _selections = State(initialValue: Array(repeating: [], count: card.questions.count))
        _otherText = State(initialValue: Array(repeating: "", count: card.questions.count))
    }

    var body: some View {
        if let question = currentQuestion {
            VStack(alignment: .leading, spacing: Spacing.row) {
                header(question)
                Text(question.question)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)

                VStack(spacing: Spacing.snug) {
                    ForEach(Array(question.options.enumerated()), id: \.offset) { index, option in
                        optionRow(index: index, label: option.label, detail: option.detail)
                    }
                    optionRow(index: question.options.count, label: "Other", detail: nil)
                }

                if selectedOnPage.contains(question.options.count) {
                    TextField("Type your own answer", text: otherBinding)
                        .textFieldStyle(.plain)
                        .font(.body)
                        .foregroundStyle(Theme.ink)
                        .padding(.horizontal, Spacing.row)
                        .frame(minHeight: 48)
                        .background(Theme.ground, in: .rect(cornerRadius: Radius.control, style: .continuous))
                        .focused($focusedOtherPage, equals: page)
                        .submitLabel(page == card.questions.count - 1 ? .send : .next)
                        .onSubmit { advanceOrSubmit() }
                        .accessibilityLabel("Your own answer")
                }

                if question.allowsMultiple {
                    Text("Pick as many as apply")
                        .typeMeta()
                }
                if let failure {
                    Text(failure)
                        .font(.footnote)
                        .foregroundStyle(Theme.rose)
                        .accessibilityLabel("Could not send answer. \(failure)")
                }

                PrimaryButton(title: sending ? "Sending…" : "Send", busy: sending) {
                    submit()
                }
                .disabled(!allAnswered || sending)
            }
            .padding(Spacing.row)
            .background(Theme.raised, in: .rect(cornerRadius: Radius.composer, style: .continuous))
            .screenGutter()
            .padding(.bottom, Spacing.snug)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Question from agent")
        }
    }

    private var currentQuestion: TranscriptQuestion? {
        card.questions.indices.contains(page) ? card.questions[page] : nil
    }

    private var selectedOnPage: [Int] {
        selections.indices.contains(page) ? selections[page] : []
    }

    private var otherBinding: Binding<String> {
        Binding(
            get: { otherText.indices.contains(page) ? otherText[page] : "" },
            set: { if otherText.indices.contains(page) { otherText[page] = $0 } }
        )
    }

    private var allAnswered: Bool {
        card.questions.indices.allSatisfy { index in
            transcriptQuestionIsAnswered(
                card.questions[index],
                selections: selections[index],
                otherText: otherText[index]
            )
        }
    }

    @ViewBuilder
    private func header(_ question: TranscriptQuestion) -> some View {
        HStack(spacing: Spacing.snug) {
            Text(question.header.isEmpty ? "Question" : question.header)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.ink)
                .lineLimit(1)
            Spacer(minLength: Spacing.snug)
            if card.questions.count > 1 {
                Button { move(to: page - 1) } label: {
                    Image(systemName: "chevron.left").frame(width: 34, height: 34)
                }
                .buttonStyle(PressDim())
                .disabled(page == 0 || sending)
                .accessibilityLabel("Previous question")

                Text("\(page + 1) of \(card.questions.count)")
                    .typeChip()
                    .foregroundStyle(Theme.muted)
                    .monospacedDigit()

                Button { move(to: page + 1) } label: {
                    Image(systemName: "chevron.right").frame(width: 34, height: 34)
                }
                .buttonStyle(PressDim())
                .disabled(page == card.questions.count - 1 || sending)
                .accessibilityLabel("Next question")
            }
            Button {
                Haptics.light()
                onDismiss()
            } label: {
                Image(systemName: "xmark").frame(width: 34, height: 34)
            }
            .buttonStyle(PressDim())
            .disabled(sending)
            .accessibilityLabel("Answer in your own words")
        }
        .foregroundStyle(Theme.muted)
    }

    private func optionRow(index: Int, label: String, detail: String?) -> some View {
        let selected = selectedOnPage.contains(index)
        return Button {
            pick(index)
        } label: {
            HStack(alignment: .top, spacing: Spacing.row) {
                Image(systemName: selected
                    ? (currentQuestion?.allowsMultiple == true ? "checkmark.square.fill" : "largecircle.fill.circle")
                    : (currentQuestion?.allowsMultiple == true ? "square" : "circle"))
                    .font(.body)
                    .foregroundStyle(selected ? AnyShapeStyle(accentColor) : AnyShapeStyle(Theme.muted))
                    .frame(width: 22, height: 22)
                VStack(alignment: .leading, spacing: Spacing.hair) {
                    Text(label)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Theme.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let detail, !detail.isEmpty {
                        Text(detail)
                            .font(.footnote)
                            .foregroundStyle(Theme.muted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding(.horizontal, Spacing.row)
            .padding(.vertical, Spacing.snug)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .background(
                selected ? accentColor.opacity(0.12) : Theme.ground,
                in: .rect(cornerRadius: Radius.control, style: .continuous)
            )
            .contentShape(.rect)
        }
        .buttonStyle(PressDim())
        .disabled(sending)
        .accessibilityLabel(detail.map { "\(label). \($0)" } ?? label)
        .accessibilityValue(selected ? "Selected" : "Not selected")
    }

    @Environment(\.accentTint) private var accent
    private var accentColor: Color { accent.color }

    private func pick(_ index: Int) {
        guard let question = currentQuestion, selections.indices.contains(page) else { return }
        Haptics.light()
        if question.allowsMultiple {
            if let existing = selections[page].firstIndex(of: index) {
                selections[page].remove(at: existing)
            } else {
                selections[page].append(index)
                selections[page].sort()
            }
        } else {
            selections[page] = [index]
        }

        if index == question.options.count {
            focusedOtherPage = page
        } else if !question.allowsMultiple && page < card.questions.count - 1 {
            move(to: page + 1)
        }
    }

    private func move(to target: Int) {
        guard card.questions.indices.contains(target) else { return }
        focusedOtherPage = nil
        withAnimation(.easeOut(duration: 0.16)) { page = target }
    }

    private func advanceOrSubmit() {
        guard let question = currentQuestion,
              transcriptQuestionIsAnswered(
                question,
                selections: selectedOnPage,
                otherText: otherBinding.wrappedValue
              )
        else { return }
        if page < card.questions.count - 1 {
            move(to: page + 1)
        } else if allAnswered {
            submit()
        }
    }

    private func submit() {
        guard allAnswered, !sending else { return }
        sending = true
        focusedOtherPage = nil
        failure = nil
        let answer = transcriptQuestionAnswer(
            questions: card.questions,
            selections: selections,
            otherText: otherText
        )
        Task {
            if await onAnswer(answer) {
                Haptics.success()
            } else {
                sending = false
                failure = "Your answer was not sent. Try again."
                Haptics.warning()
            }
        }
    }
}
