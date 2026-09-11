import Foundation
import XCTest
@testable import Argmax

final class TranscriptMarkdownTests: XCTestCase {
    func testFoundationStructureBecomesNativeBlocksWithoutFlatteningParagraphs() throws {
        let document = TranscriptMarkdownDocument(markdown: """
        # Result

        First **bold** paragraph with [a file](Sources/App.swift).

        - One
        - Two

        > A note

        ```swift
        let answer = 42
        ```
        """)

        XCTAssertEqual(document.blocks.count, 6)
        guard case .heading(let level, let heading) = document.blocks[0] else {
            return XCTFail("expected heading")
        }
        XCTAssertEqual(level, 1)
        XCTAssertEqual(String(heading.characters), "Result")
        guard case .paragraph(let paragraph) = document.blocks[1] else {
            return XCTFail("expected paragraph")
        }
        XCTAssertEqual(String(paragraph.characters), "First bold paragraph with a file.")
        XCTAssertTrue(paragraph.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        XCTAssertTrue(paragraph.runs.contains { $0.link?.relativeString == "Sources/App.swift" })
        guard case .listItem(nil, 1, let first) = document.blocks[2] else {
            return XCTFail("expected first list item")
        }
        XCTAssertEqual(String(first.characters), "One")
        guard case .quote(let quote) = document.blocks[4] else { return XCTFail("expected quote") }
        XCTAssertEqual(String(quote.characters), "A note")
        guard case .code(let language, let source) = document.blocks[5] else {
            return XCTFail("expected code")
        }
        XCTAssertEqual(language, "swift")
        XCTAssertEqual(source, "let answer = 42\n")
    }

    func testGFMTableIsLiftedAndPreservesPipesInsideCode() throws {
        let document = TranscriptMarkdownDocument(markdown: """
        | Name | Value |
        | :--- | ---: |
        | Alpha | `a|b` |
        | Beta | two |
        Afterward.
        """)

        guard case .table(let table) = document.blocks[0] else { return XCTFail("expected table") }
        XCTAssertEqual(table.headers, ["Name", "Value"])
        XCTAssertEqual(table.rows, [["Alpha", "`a|b`"], ["Beta", "two"]])
        XCTAssertEqual(table.tabSeparatedText, "Name\tValue\nAlpha\t`a|b`\nBeta\ttwo")
        guard case .paragraph(let after) = document.blocks[1] else { return XCTFail("expected trailing prose") }
        XCTAssertEqual(String(after.characters), "Afterward.")
    }

    func testStandaloneImageWithSpacesBecomesImageBlock() throws {
        let document = TranscriptMarkdownDocument(markdown: """
        Before.
        ![Build output](</Users/me/Library/Application Support/Argmax/shot 1.png>)
        After.
        """)

        XCTAssertEqual(document.blocks.count, 3)
        guard case .image(let image) = document.blocks[1] else { return XCTFail("expected image") }
        XCTAssertEqual(image.alt, "Build output")
        XCTAssertEqual(image.target, "/Users/me/Library/Application Support/Argmax/shot 1.png")
    }

    func testMathExtractionPreservesCurrencyAndFencedCode() throws {
        let document = TranscriptMarkdownDocument(markdown: """
        It costs $50 and $60, while $2x + 1$ and \\(y^2\\) are equations with \\tau.

        $$
        \\sum_{i=1}^n i
        $$

        ```text
        $not_math$
        ```
        """)

        XCTAssertEqual(document.math.count, 3)
        XCTAssertEqual(Set(document.math.values.map(\.source)), ["2x + 1", "y^2", "\\tau"])
        guard case .paragraph(let paragraph) = document.blocks[0] else { return XCTFail("expected prose") }
        XCTAssertTrue(String(paragraph.characters).contains("$50 and $60"))
        XCTAssertEqual(TranscriptMarkdownDocument.inlinePieces(paragraph, math: document.math).count, 7)
        guard case .math(let source, true) = document.blocks[1] else { return XCTFail("expected display math") }
        XCTAssertEqual(source, "\\sum_{i=1}^n i")
        guard case .code(_, let code) = document.blocks[2] else { return XCTFail("expected code") }
        XCTAssertEqual(code, "$not_math$\n")
    }

    func testMermaidFenceRemainsTypedCodeForTheRichRenderer() throws {
        let document = TranscriptMarkdownDocument(markdown: """
        ```mermaid
        graph LR
          A --> B
        ```
        """)
        guard case .code(let language, let source) = document.blocks.first else {
            return XCTFail("expected code")
        }
        XCTAssertEqual(language, "mermaid")
        XCTAssertTrue(source.contains("A --> B"))
    }

    func testAttachmentDecoderDefaultsOlderMissingMetadata() throws {
        let data = try XCTUnwrap(#"{"filePath":"/tmp/shot.png"}"#.data(using: .utf8))
        let attachment = try JSONDecoder().decode(TranscriptAttachment.self, from: data)
        XCTAssertEqual(attachment.mimeType, "application/octet-stream")
        XCTAssertEqual(attachment.sizeBytes, 0)
        XCTAssertTrue(attachment.isImage)
    }

    func testLocalLinkRouting() throws {
        XCTAssertTrue(TranscriptMarkdownDocument.isLocalLink(try XCTUnwrap(URL(string: "argmax-asset://file/tmp/a.png"))))
        XCTAssertTrue(TranscriptMarkdownDocument.isLocalLink(try XCTUnwrap(URL(string: "argmax-attachment://file/tmp/a.png"))))
        XCTAssertTrue(TranscriptMarkdownDocument.isLocalLink(try XCTUnwrap(URL(string: "Sources/App.swift"))))
        XCTAssertTrue(TranscriptMarkdownDocument.isLocalLink(try XCTUnwrap(URL(string: "file:///tmp/a.swift"))))
        XCTAssertFalse(TranscriptMarkdownDocument.isLocalLink(try XCTUnwrap(URL(string: "https://example.com"))))
        XCTAssertFalse(TranscriptMarkdownDocument.isLocalLink(try XCTUnwrap(URL(string: "#details"))))
        XCTAssertTrue(TranscriptMarkdownDocument.isAnchorLink(try XCTUnwrap(URL(string: "#details"))))
        let protocolRelative = try XCTUnwrap(URL(string: "//example.com/path"))
        XCTAssertFalse(TranscriptMarkdownDocument.isLocalLink(protocolRelative))
        XCTAssertEqual(
            TranscriptMarkdownDocument.httpsURL(forProtocolRelative: protocolRelative)?.absoluteString,
            "https://example.com/path"
        )
        XCTAssertEqual(
            TranscriptMarkdownDocument.localPath(from: try XCTUnwrap(URL(string: "argmax-attachment://file/tmp/a.png"))),
            "/tmp/a.png"
        )
    }

    func testInlineCodeLinksOnlyConservativeFilePaths() throws {
        let document = TranscriptMarkdownDocument(markdown: """
        Open `src/index.ts`, `src/feature/view.tsx:42`, and `package.json`.
        """)
        guard case .paragraph(let paragraph) = document.blocks.first else {
            return XCTFail("expected paragraph")
        }

        let codeRuns = paragraph.runs.filter {
            $0.inlinePresentationIntent?.contains(.code) == true
        }
        let links = Dictionary(uniqueKeysWithValues: codeRuns.compactMap { run -> (String, String)? in
            guard let link = run.link else { return nil }
            return (String(paragraph[run.range].characters), link.relativeString)
        })
        XCTAssertEqual(links["src/index.ts"], "src/index.ts")
        XCTAssertEqual(links["src/feature/view.tsx:42"], "src/feature/view.tsx")
        XCTAssertEqual(links["package.json"], "package.json")
        XCTAssertNil(TranscriptMarkdownDocument.inlineFilePath("README"))
        XCTAssertNil(TranscriptMarkdownDocument.inlineFilePath("hello world.ts"))
        XCTAssertNil(TranscriptMarkdownDocument.inlineFilePath(".ts"))
        XCTAssertNil(TranscriptMarkdownDocument.inlineFilePath("x + y"))
    }

    func testLocalFileLinksDropLineLocationsBeforeOpeningReview() throws {
        XCTAssertEqual(
            TranscriptMarkdownDocument.localPath(from: try XCTUnwrap(URL(string: "Sources/App.swift:42"))),
            "Sources/App.swift"
        )
        XCTAssertEqual(
            TranscriptMarkdownDocument.localPath(from: try XCTUnwrap(URL(string: "Sources/App.swift#L42"))),
            "Sources/App.swift"
        )
        XCTAssertEqual(
            TranscriptMarkdownDocument.localPath(from: try XCTUnwrap(URL(string: "file:///tmp/App.swift:42#L7"))),
            "/tmp/App.swift"
        )
    }
}
