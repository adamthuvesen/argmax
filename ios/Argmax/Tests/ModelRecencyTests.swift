import XCTest
@testable import Argmax

/// `argmax.launch.modelRecency` in `UserDefaults.standard` — cleared before
/// and after each test so this suite never leaks into (or reads from) a
/// developer's real recency list.
final class ModelRecencyTests: XCTestCase {
    private let key = "argmax.launch.modelRecency"

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: key)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: key)
        super.tearDown()
    }

    func testTouchMovesAnExistingIdToTheFront() {
        ModelRecency.touch("claude/claude-opus-5")
        ModelRecency.touch("codex/gpt-5.6-sol")
        ModelRecency.touch("claude/claude-opus-5")
        XCTAssertEqual(ModelRecency.read(), ["claude/claude-opus-5", "codex/gpt-5.6-sol"])
    }

    /// `prefixed` duplicates a recent pick under "Recent" and leaves the
    /// catalogue row exactly where it was — the point of the feature: a
    /// model shows up twice, not once moved.
    func testPrefixedDuplicatesRecentRowsWithoutRemovingTheCatalogueRow() {
        let claude = PickerOption(value: "claude/claude-fable-5-1", label: "Fable 5.1", group: "Claude")
        let codex = PickerOption(value: "codex/gpt-5.6-sol", label: "Sol", group: "Codex")
        ModelRecency.touch("claude/claude-fable-5-1")

        let result = ModelRecency.prefixed([claude, codex])

        XCTAssertEqual(result.map(\.value), ["claude/claude-fable-5-1", "claude/claude-fable-5-1", "codex/gpt-5.6-sol"])
        XCTAssertEqual(result[0].group, "Recent")
        XCTAssertEqual(result[1].group, "Claude", "the catalogue row keeps its own provider group")
    }

    /// A recency entry for a model no longer in the list (catalogue changed,
    /// or the running session locked the picker to one CLI) is skipped
    /// rather than shown as a row with nothing behind it.
    func testPrefixedSkipsRecentIdsMissingFromTheCurrentOptions() {
        let codex = PickerOption(value: "codex/gpt-5.6-sol", label: "Sol", group: "Codex")
        ModelRecency.touch("claude/claude-fable-5-1")

        let result = ModelRecency.prefixed([codex])

        XCTAssertEqual(result.map(\.value), ["codex/gpt-5.6-sol"])
    }

    func testPrefixedCapsAtThreeRecentRows() {
        let options = (1...5).map { PickerOption(value: "claude/model-\($0)", label: "Model \($0)", group: "Claude") }
        for option in options { ModelRecency.touch(option.value) }

        let result = ModelRecency.prefixed(options)

        let recentValues = result.prefix(while: { $0.group == "Recent" }).map(\.value)
        XCTAssertEqual(recentValues, ["claude/model-5", "claude/model-4", "claude/model-3"])
    }
}
