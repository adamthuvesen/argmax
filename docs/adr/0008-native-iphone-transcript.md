# The iPhone owns its transcript presentation

The iPhone transcript moves from an embedded React page to native SwiftUI
content in reusable UIKit cells. The user chose to maintain a second
transcript renderer to improve mobile reading, scrolling, keyboard behavior,
and interaction design. This supersedes the boundary in ADR 0007.

Rust remains the source of normalized timeline events and durable state.
The native transcript shares the dashboard's bridge connection, follows
mutation cursors, and reconstructs its presentation from those events.
Projection and action tests pin the behavior that must agree with the desktop.

Prose, tools, questions, plans, approvals, and navigation are native. Mermaid
and math use small local WebKit viewers bundled from the existing locked
dependencies. They hold neither the transcript nor a bridge connection.
Rich rendering can therefore retain its existing libraries without coupling
the phone UI to the Mac's renderer bundle.

The first target is iPhone. iPad layout and a native macOS transcript are
separate decisions.
