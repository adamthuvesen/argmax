import UIKit
import XCTest
@testable import Argmax

final class TranscriptToolIconTests: XCTestCase {
    func testProviderSpecificMCPNamesResolveToBrandAssets() {
        XCTAssertEqual(
            TranscriptToolIcon.assetName(for: "mcp__claude_ai_Slack__conversations_history"),
            "Integrations/slack"
        )
        XCTAssertEqual(
            TranscriptToolIcon.assetName(for: "mcp__codex_apps__slack_slack_search"),
            "Integrations/slack"
        )
        XCTAssertEqual(
            TranscriptToolIcon.assetName(for: "mcp__linear__list_issues"),
            "Integrations/linear"
        )
        XCTAssertEqual(
            TranscriptToolIcon.assetName(for: "mcp.linear.list_issues"),
            "Integrations/linear"
        )
        XCTAssertEqual(
            TranscriptToolIcon.assetName(for: "google-drive_google-drive-list_recent_files"),
            "Integrations/google-drive"
        )
        XCTAssertEqual(TranscriptToolIcon.assetName(for: "slack_search"), "Integrations/slack")
    }

    func testPluginNamespacesUseTheDesktopServerAliases() {
        XCTAssertEqual(
            TranscriptToolIcon.assetName(for: "mcp__plugin-google-drive-google-drive__list_recent_files"),
            "Integrations/google-drive"
        )
        XCTAssertEqual(
            TranscriptToolIcon.assetName(for: "mcp__plugin-notion-workspace-notion__notion-fetch"),
            "Integrations/notion"
        )
        XCTAssertEqual(TranscriptToolIcon.assetName(for: "session_list"), "Integrations/argmax")
        XCTAssertEqual(
            TranscriptToolIcon.assetName(
                for: "mcp__linear__list_issues",
                activity: activity(.search)
            ),
            "Integrations/linear"
        )
    }

    func testEveryActivityKindHasTheExpectedSemanticSystemFallback() {
        let expectedSymbols: [TranscriptToolActivityKind: String] = [
            .read: "book", .edit: "square.and.pencil", .image: "photo.on.rectangle.angled",
            .search: "magnifyingglass", .list: "folder", .webSearch: "globe",
            .webFetch: "globe", .discovery: "wrench.adjustable", .command: "terminal",
            .computer: "desktopcomputer", .tool: "wrench.and.screwdriver", .agent: "cpu", .skill: "sparkles",
            .imageCapture: "camera", .imageGenerate: "sparkles", .agentMessage: "bubble.left",
            .agentWait: "hourglass", .agentStop: "stop.circle", .memoryRecall: "brain", .memorySave: "brain",
            .browser: "globe", .plan: "checklist"
        ]
        for kind in TranscriptToolActivityKind.allCases {
            if kind == .git {
                XCTAssertEqual(
                    TranscriptToolIcon.source(for: "plain", activity: activity(kind)),
                    .gitBranch
                )
                continue
            }
            XCTAssertEqual(
                TranscriptToolIcon.source(for: "plain", activity: activity(kind)),
                .system(name: expectedSymbols[kind]!)
            )
            XCTAssertNotNil(UIImage(systemName: expectedSymbols[kind]!))
        }

        // Looked at the project: reads, listings, and git share one colour.
        XCTAssertEqual(components(TranscriptToolIcon.uiColor(for: .read), style: .light), [27, 114, 73])
        XCTAssertEqual(components(TranscriptToolIcon.uiColor(for: .list), style: .light), [27, 114, 73])
        XCTAssertEqual(components(TranscriptToolIcon.uiColor(for: .git), style: .light), [27, 114, 73])
        // Went looking, in the files or on the web.
        XCTAssertEqual(components(TranscriptToolIcon.uiColor(for: .search), style: .light), [116, 73, 168])
        XCTAssertEqual(components(TranscriptToolIcon.uiColor(for: .webSearch), style: .dark), [173, 148, 208])
        XCTAssertEqual(components(TranscriptToolIcon.uiColor(for: .browser), style: .dark), [173, 148, 208])
        // The agent's own machinery shares blue with the fallback below.
        XCTAssertEqual(components(TranscriptToolIcon.uiColor(for: .skill), style: .light), [28, 101, 169])
        XCTAssertEqual(components(TranscriptToolIcon.uiColor(for: .plan), style: .light), [28, 101, 169])
        XCTAssertEqual(components(TranscriptToolIcon.uiColor(for: .agentWait), style: .dark), [126, 166, 207])
        // Ran a command, in gold.
        XCTAssertEqual(components(TranscriptToolIcon.uiColor(for: .command), style: .dark), [233, 195, 56])
        XCTAssertEqual(components(TranscriptToolIcon.uiColor(for: .computer), style: .light), [153, 106, 7])
        // Changed a file.
        XCTAssertEqual(components(TranscriptToolIcon.uiColor(for: .edit), style: .light), [167, 57, 36])
        // Nothing named it: the same blue.
        XCTAssertEqual(components(TranscriptToolIcon.uiColor(for: .image), style: .dark), [126, 166, 207])
        XCTAssertEqual(components(TranscriptToolIcon.uiColor(for: .tool), style: .dark), [126, 166, 207])
        XCTAssertEqual(
            components(TranscriptToolIcon.uiColor(for: .command, state: .failed), style: .dark),
            [240, 112, 127]
        )
        // A delete is a file change, not a failure.
        XCTAssertEqual(
            components(TranscriptToolIcon.uiColor(for: .edit), style: .light),
            [167, 57, 36]
        )
        XCTAssertEqual(
            components(TranscriptToolIcon.uiColor(for: .edit, colorMode: .monochrome), style: .light),
            [122, 118, 108]
        )
        XCTAssertEqual(
            components(TranscriptToolIcon.uiColor(for: .search, colorMode: .monochrome), style: .dark),
            [138, 133, 123]
        )
    }

    func testComputerActivityOverridesAnIntegrationBrand() {
        XCTAssertEqual(
            TranscriptToolIcon.source(for: "mcp__linear__computer_use", activity: activity(.computer)),
            .system(name: "desktopcomputer")
        )
        XCTAssertNil(TranscriptToolIcon.assetName(
            for: "mcp__linear__computer_use",
            activity: activity(.computer)
        ))
        XCTAssertEqual(
            TranscriptToolIcon.assetName(for: "mcp__linear__list_issues", activity: activity(.tool)),
            "Integrations/linear"
        )
        XCTAssertEqual(
            TranscriptToolIcon.assetName(for: "mcp__argmax__browser_click", activity: activity(.tool)),
            "Integrations/argmax"
        )
        XCTAssertEqual(
            TranscriptToolIcon.assetName(for: "argmax.browser_screenshot", activity: activity(.tool)),
            "Integrations/argmax"
        )
    }

    func testUnknownAndGenericToolsKeepDistinctFallbacks() {
        XCTAssertEqual(
            TranscriptToolIcon.source(for: "mcp__future_service__do_work"),
            .system(name: "powerplug")
        )
        XCTAssertEqual(TranscriptToolIcon.source(for: "context7_lookup"), .system(name: "powerplug"))
        XCTAssertEqual(TranscriptToolIcon.source(for: "WebFetch"), .system(name: "globe"))
        XCTAssertEqual(TranscriptToolIcon.source(for: "Bash"), .system(name: "terminal"))
        XCTAssertEqual(TranscriptToolIcon.source(for: "custom_mcp_tool"), .system(name: "terminal"))
        XCTAssertNotNil(UIImage(systemName: "powerplug"))
        XCTAssertNotNil(UIImage(systemName: "globe"))
        XCTAssertNotNil(UIImage(systemName: "terminal"))
    }

    func testEveryGeneratedKeyHasARealNamespacedAsset() throws {
        let names = TranscriptToolIcon.generatedAssetNames
        XCTAssertEqual(names.count, 16)
        XCTAssertEqual(Set(names).count, names.count)
        for name in names {
            let image = try XCTUnwrap(UIImage(named: name), "\(name) is missing from Assets.xcassets")
            XCTAssertGreaterThan(image.size.width, 0, "\(name) has no intrinsic width")
            XCTAssertGreaterThan(image.size.height, 0, "\(name) has no intrinsic height")
            XCTAssertNotNil(image.imageAsset, "\(name) is not backed by an asset catalogue image")
        }
    }

    /// The row tints an asset through its alpha, which turns a layered drawing
    /// into its own silhouette. The mascot is the only mark with layers to
    /// lose, so it is the only one that carries a second, alpha-stepped image.
    func testTheLayeredMascotSwapsToATintedRenditionInMonochrome() {
        XCTAssertEqual(
            TranscriptToolIcon.source(for: "session_list"),
            .asset(name: "Integrations/argmax", monochrome: "Integrations/argmax-mono", title: "Argmax")
        )
        XCTAssertEqual(
            TranscriptToolIcon.source(for: "mcp__linear__list_issues"),
            .asset(name: "Integrations/linear", monochrome: nil, title: "Linear")
        )
    }


    private func activity(_ kind: TranscriptToolActivityKind) -> TranscriptToolActivity {
        TranscriptToolActivity(
            version: 1, kind: kind, evidence: .native, targets: [], operation: nil, toolCount: nil
        )
    }

    private func components(_ color: UIColor, style: UIUserInterfaceStyle) -> [Int] {
        let resolved = color.resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        XCTAssertTrue(resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha))
        return [red, green, blue].map { Int(($0 * 255).rounded()) }
    }
}
