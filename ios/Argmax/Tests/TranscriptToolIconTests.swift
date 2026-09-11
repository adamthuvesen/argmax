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
        XCTAssertEqual(names.count, 14)
        XCTAssertEqual(Set(names).count, names.count)
        for name in names {
            let image = try XCTUnwrap(UIImage(named: name), "\(name) is missing from Assets.xcassets")
            XCTAssertGreaterThan(image.size.width, 0, "\(name) has no intrinsic width")
            XCTAssertGreaterThan(image.size.height, 0, "\(name) has no intrinsic height")
            XCTAssertNotNil(image.imageAsset, "\(name) is not backed by an asset catalogue image")
        }
    }
}
