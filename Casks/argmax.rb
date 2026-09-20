# Source of truth for the cask published to adamthuvesen/homebrew-tap.
# Copy it there as Casks/argmax.rb on each release; see docs/homebrew.md.
cask "argmax" do
  version "0.5.0"
  # Replace on every release: shasum -a 256 Argmax_<version>_universal.dmg
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  # Confirm the asset name against the first published release before
  # tagging a second one — the bundler writes {productName}_{version}_{arch}.dmg.
  url "https://github.com/adamthuvesen/argmax/releases/download/v#{version}/Argmax_#{version}_universal.dmg",
      verified: "github.com/adamthuvesen/argmax/"
  name "Argmax"
  desc "Runs AI coding agents in parallel git worktrees"
  homepage "https://github.com/adamthuvesen/argmax"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :big_sur"

  app "Argmax.app"

  # Chats, settings and the SQLite database. ~/.argmax is deliberately absent:
  # it holds the git worktrees Argmax created, and those carry the user's own
  # commits and uncommitted work. Uninstalling the app must not delete them.
  zap trash: [
    "~/Library/Application Support/com.argmax.rs",
    "~/Library/Caches/com.argmax.rs",
    "~/Library/Preferences/com.argmax.rs.plist",
    "~/Library/Saved Application State/com.argmax.rs.savedState",
    "~/Library/WebKit/com.argmax.rs",
  ]
end
