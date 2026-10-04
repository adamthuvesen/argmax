import XCTest
@testable import Argmax

final class ChatReferenceTextTests: XCTestCase {
    func testAReferenceReadsAsItsTitle() {
        XCTAssertEqual(
            ChatReferenceText.titlesOnly("compare with [Billing](argmax://chat/s-1?v=1&e=evt_2) please"),
            "compare with Billing please"
        )
        XCTAssertEqual(ChatReferenceText.titlesOnly("[A](argmax://chat/a) and [B](argmax://chat/b?v=1)"), "A and B")
    }

    func testWhatTheComposerWouldNotDrawStaysAsWritten() {
        for text in [
            "[x](argmax://chat/s1?v=2)",
            "[x](argmax://chat/s1?v=01)",
            "[x](argmax://chat/s1?v=)",
            "[x](argmax://chat/s1?v=1&e=)",
            "[x](argmax://chat/s1?e=bad.id)",
            "argmax://chat/s1",
            "[x](https://example.com)",
            "plain text"
        ] {
            XCTAssertEqual(ChatReferenceText.titlesOnly(text), text, text)
        }
    }

    func testTheFirstVersionKeyWins() {
        XCTAssertEqual(ChatReferenceText.titlesOnly("[x](argmax://chat/s1?v=1&v=2)"), "x")
        XCTAssertEqual(ChatReferenceText.titlesOnly("[x](argmax://chat/s1?v=2&v=1)"), "[x](argmax://chat/s1?v=2&v=1)")
    }

    func testTheTitleLimitCountsUtf16UnitsAsTheComposerDoes() {
        let edge = String(repeating: "😀", count: 60)
        let over = String(repeating: "😀", count: 61)
        XCTAssertEqual(ChatReferenceText.titlesOnly("[\(edge)](argmax://chat/s1)"), edge)
        XCTAssertEqual(ChatReferenceText.titlesOnly("[\(over)](argmax://chat/s1)"), "[\(over)](argmax://chat/s1)")
    }
}
