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

## Native rendering follow-up, 2026-09-12

The iPhone now uses a lazy SwiftUI transcript instead of reusable UIKit cells.
SwaTex 0.5.0 and MermaidKit 2.2.0 replace the local WebKit viewers. The app
requires iOS 18 for SwaTex and SwiftUI's scroll geometry and phase APIs.
The native packages are pinned independently of the desktop's JavaScript
renderers, and the iPhone no longer bundles HTML or JavaScript.

This accepts MermaidKit's core-syntax coverage rather than full Mermaid
compatibility. Rich viewers keep their source available, and unsupported
content must remain readable. SwaTex's accessibility label is LaTeX source,
so spoken-math parity with MathML is not established. Tests exercise rendering
and scrolling in the iOS simulator.

Code and diff views retain TextKit 2 for continuous selection and large-file
layout. The UIKit gesture helpers retain the existing navigation and repair
shortcuts. These native integrations do not require web rendering.
