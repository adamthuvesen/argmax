import SwaTex
import SwaTexRender
import SwiftUI
import UIKit
import XCTest

@testable import Argmax

@MainActor
final class TranscriptRichPreviewTests: XCTestCase {
    func testNativePreviewRendersRealMath() throws {
        let source = #"\frac{-b \pm \sqrt{b^2-4ac}}{2a}"#
        let support = TranscriptRichSupport(kind: .math, source: source)
        XCTAssertEqual(support.presentation, .native(sourceNote: nil))

        let displayList = try SwaTexEngine.displayList(for: source, cache: .shared)
        XCTAssertGreaterThan(displayList.width, 1)
        XCTAssertGreaterThan(displayList.items.count, 4)
        let renderedMath = try XCTUnwrap(
            ImageRenderer(content: MathView(source).font(size: 22).mathColor(Color.black)).uiImage
        )
        assertVisibleContent(in: renderedMath)
        attach(renderedMath, named: "Native equation pixels")

        let view = TranscriptNativeRichPreview(
            kind: .math,
            source: source,
            display: true,
            support: support
        )
        .frame(width: 390)
        let preview = try XCTUnwrap(ImageRenderer(content: view).uiImage)
        XCTAssertEqual(preview.size.width, 390, accuracy: 1)
        XCTAssertGreaterThan(preview.size.height, 10)
    }

    func testNativePreviewRendersRealDiagramInBothAppearances() throws {
        let source = "flowchart LR\nInput[Prompt] --> Model{Ready?}\nModel -->|yes| Output[Answer]"
        let support = TranscriptRichSupport(kind: .mermaid, source: source)
        XCTAssertEqual(support.presentation, .native(sourceNote: nil))

        for colorScheme in [ColorScheme.light, .dark] {
            let view = TranscriptNativeRichPreview(
                kind: .mermaid,
                source: source,
                display: true,
                support: support
            )
            .frame(width: 390)
            .environment(\.colorScheme, colorScheme)
            let image = try XCTUnwrap(ImageRenderer(content: view).uiImage)
            assertVisibleContent(in: image)
            attach(image, named: "Native diagram \(colorScheme)")
        }
    }

    func testUnrecognizedDiagramFallsBackToItsSource() {
        let support = TranscriptRichSupport(
            kind: .mermaid,
            source: "flowchar LR\nInput --> Output"
        )

        XCTAssertEqual(
            support.presentation,
            .sourceFallback(message: "This Mermaid syntax is not supported by the native renderer")
        )
        XCTAssertTrue(support.showsSource)
    }

    func testLongUnsupportedDiagramStaysInsideScrollableFallback() throws {
        let body = (1...40).map { "Unknown node \($0)" }.joined(separator: "\n")
        let source = "nonesuchDiagram\n\(body)"
        let support = TranscriptRichSupport(kind: .mermaid, source: source)
        guard case .sourceFallback = support.presentation else {
            return XCTFail("Unsupported source must use the inspectable fallback")
        }

        let view = TranscriptNativeRichPreview(
            kind: .mermaid,
            source: source,
            display: true,
            support: support
        )
        .frame(width: 390)
        let image = try XCTUnwrap(ImageRenderer(content: view).uiImage)
        XCTAssertEqual(image.size.width, 390, accuracy: 1)
        XCTAssertLessThanOrEqual(image.size.height, 260)
        XCTAssertGreaterThan(image.size.height, 40)
    }

    func testIgnoredMermaidFeaturesAreDisclosedBesideTheRenderedDiagram() {
        let support = TranscriptRichSupport(
            kind: .mermaid,
            source: """
            %%{init: {'theme': 'forest'}}%%
            flowchart LR
            A[Start] --> B[Finish]
            classDef urgent fill:#f00
            class A urgent
            click B "https://example.com"
            """
        )

        guard case .native(let sourceNote) = support.presentation else {
            return XCTFail("Core diagram syntax should still render")
        }
        guard let sourceNote else {
            return XCTFail("Ignored syntax must be disclosed")
        }
        XCTAssertTrue(sourceNote.contains("configuration"))
        XCTAssertTrue(sourceNote.contains("custom styling"))
        XCTAssertTrue(sourceNote.contains("click interactions"))
        XCTAssertTrue(support.showsSource)
    }

    func testClassDiagramDeclarationIsNotMistakenForAStyleDirective() {
        let support = TranscriptRichSupport(
            kind: .mermaid,
            source: "classDiagram\nclass Animal\nAnimal : +String name"
        )

        XCTAssertEqual(support.presentation, .native(sourceNote: nil))
    }

    func testUnsupportedMathExtensionFallsBackToItsSource() {
        let source = #"\includegraphics{chart.png}"#
        let support = TranscriptRichSupport(
            kind: .math,
            source: source
        )

        guard case .sourceFallback(let message) = support.presentation else {
            return XCTFail("Unsupported math must show its source")
        }
        XCTAssertTrue(message.contains("includegraphics"))
        XCTAssertTrue(support.showsSource)
    }

    func testMalformedMathFallsBackToItsOriginalSource() throws {
        let source = #"\frac{1"#
        let support = TranscriptRichSupport(kind: .math, source: source)

        guard case .sourceFallback(let message) = support.presentation else {
            return XCTFail("Malformed math must show its source")
        }
        XCTAssertTrue(message.contains("Equation could not be rendered"))

        let view = TranscriptNativeRichPreview(
            kind: .math,
            source: source,
            display: true,
            support: support
        )
        .frame(width: 390)
        let image = try XCTUnwrap(ImageRenderer(content: view).uiImage)
        XCTAssertEqual(image.size.width, 390, accuracy: 1)
        XCTAssertGreaterThan(image.size.height, 40)
        XCTAssertLessThanOrEqual(image.size.height, 260)

        let fallback = TranscriptRichSourceFallback(message: message, source: source)
            .frame(width: 390)
        let fallbackImage = try XCTUnwrap(ImageRenderer(content: fallback).uiImage)
        assertVisibleContent(in: fallbackImage)
        attach(fallbackImage, named: "Malformed equation source fallback")
    }

    func testLongMathAndTallDiagramStayInsideTranscriptPreview() throws {
        let longMath = #"\sum_{n=1}^{\infty}\frac{1}{n^2}+\int_{-\infty}^{\infty}e^{-x^2}\,dx+\prod_{k=1}^{20}(x-k)"#
        let math = TranscriptRichSupport(kind: .math, source: longMath)
        let mathView = TranscriptNativeRichPreview(
            kind: .math,
            source: longMath,
            display: true,
            support: math
        )
        .frame(width: 390)
        let mathImage = try XCTUnwrap(ImageRenderer(content: mathView).uiImage)
        XCTAssertEqual(mathImage.size.width, 390, accuracy: 1)
        XCTAssertLessThanOrEqual(mathImage.size.height, 372)
        let mathDisplayList = try SwaTexEngine.displayList(for: longMath, cache: .shared)
        XCTAssertGreaterThan(mathDisplayList.width, 10)
        XCTAssertGreaterThan(mathDisplayList.items.count, 20)
        let renderedMath = try XCTUnwrap(
            ImageRenderer(content: MathView(longMath).font(size: 22).mathColor(Color.black)).uiImage
        )
        assertVisibleContent(in: renderedMath)

        let edges = (1...24).map { "Node\($0) --> Node\($0 + 1)" }.joined(separator: "\n")
        let diagramSource = "flowchart TD\n\(edges)"
        let diagram = TranscriptRichSupport(kind: .mermaid, source: diagramSource)
        let diagramView = TranscriptNativeRichPreview(
            kind: .mermaid,
            source: diagramSource,
            display: true,
            support: diagram
        )
        .frame(width: 390)
        let diagramImage = try XCTUnwrap(ImageRenderer(content: diagramView).uiImage)
        XCTAssertEqual(diagramImage.size.width, 390, accuracy: 1)
        XCTAssertLessThanOrEqual(diagramImage.size.height, 372)
        assertVisibleContent(in: diagramImage)
        attach(diagramImage, named: "Tall diagram preview")
    }

    private func assertVisibleContent(in image: UIImage, file: StaticString = #filePath, line: UInt = #line) {
        guard let cgImage = image.cgImage else {
            return XCTFail("Rendered image has no pixels", file: file, line: line)
        }
        let width = cgImage.width
        let height = cgImage.height
        XCTAssertGreaterThan(width, 10, file: file, line: line)
        XCTAssertGreaterThan(height, 10, file: file, line: line)

        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return XCTFail("Could not inspect rendered pixels", file: file, line: line)
        }
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

        var visiblePixels = 0
        var colors: Set<UInt32> = []
        for index in stride(from: 0, to: pixels.count, by: 4) where pixels[index + 3] > 8 {
            visiblePixels += 1
            if colors.count < 32 {
                colors.insert(
                    UInt32(pixels[index]) << 24
                        | UInt32(pixels[index + 1]) << 16
                        | UInt32(pixels[index + 2]) << 8
                        | UInt32(pixels[index + 3])
                )
            }
        }
        XCTAssertGreaterThan(visiblePixels, 20, "Renderer produced no visible marks", file: file, line: line)
        XCTAssertGreaterThan(colors.count, 1, "Renderer produced a flat blank image", file: file, line: line)
    }

    private func attach(_ image: UIImage, named name: String) {
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
