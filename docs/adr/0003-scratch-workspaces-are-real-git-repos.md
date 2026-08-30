# Scratch workspaces are real git repos

Side chats have no user repository behind them, but provider CLIs assume a checkout — Codex refuses to run outside one. Rather than gate every git-touching subsystem (status watcher, review plumbing, checks, file listing) on "is this a real repo?", each scratch workspace gets a genuine minimal repo under the app data dir's `local-state/side-chats/`: one empty commit on `main`, explicit identity, signing off.

With `HEAD` resolving, every subsystem works unmodified and the divergence collapses to one field — repo-coupled UI hides itself off `workspace.kind` instead of scattering null checks through the runtime. The surprise to absorb is that Argmax creates git repositories inside its own application data; that is intended, and the directories are app-owned and cheap.
