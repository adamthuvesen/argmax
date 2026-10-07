# Durable interactive visualizations

Run `node .agents/skills/verify-argmax/verify.mjs drive visualizations` after launch.

The scenario uses production artifact IPC and a scripted provider. It captures
the same HTML at phone and desktop widths in isolated native WKWebViews.
The source contains an animated SVG chart, local image, saved widget state,
design control, and follow-up button.

It publishes a draft twice, deletes the source files, and checks one normalized
timeline card. It checks restored state, standalone export, opaque iframe
sandboxing, state persistence without a provider turn, and host design controls.
It verifies explicit follow-up preparation in the owning composer and renders a
child artifact in the multitask chat.

Draft assertions use the owning session ID because the verification app can
retain WebKit drafts across drives. Expanded capture delivers a DOM PageUp event
and scroll movement together. The native driver's key map omits PageUp.

Evidence includes preview PNGs, inline and expanded screenshots, artifact metadata,
assertions, timeline events, and the SQLite snapshot. Native iOS lifecycle and
WebKit rendering use XCTest evidence separately.
