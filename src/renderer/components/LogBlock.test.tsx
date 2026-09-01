import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LogBlock } from "./LogBlock.js";

afterEach(() => {
  cleanup();
});

const FIRST =
  '2026-09-01T07:21:37.004170Z ERROR codex_core::session: stream disconnected session_id="abc"';
const SECOND =
  '2026-09-01T07:21:37.017965Z ERROR codex_core::session: stream disconnected session_id="def"';
const MCP =
  '2026-09-01T07:21:37.004170Z ERROR rmcp::transport::streamable_http_client: fail to delete session: Auth error: OAuth token refresh failed: Server returned error response: invalid_refresh_token session_id="abc"';

describe("<LogBlock />", () => {
  it("splits glued tracing records into two rows under an Error label", () => {
    render(<LogBlock text={`${FIRST}${SECOND}`} />);

    const block = screen.getByRole("status", { name: "Error" });
    const rows = within(block).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("ERROR")).toBeInTheDocument();
    expect(within(rows[0]).getByText(/stream disconnected/)).toBeInTheDocument();
    expect(within(rows[0]).getByText(/session_id="abc"/)).toBeInTheDocument();
    expect(within(rows[1]).getByText("2026-09-01T07:21:37.017965Z")).toBeInTheDocument();
  });

  it("renders a plain error sentence with the Error label", () => {
    render(<LogBlock text="Provider exited" tone="error" />);

    const block = screen.getByRole("status", { name: "Error" });
    expect(within(block).getByText("Provider exited")).toBeInTheDocument();
  });

  it("renders nothing for MCP HTTP client teardown tracing", () => {
    const { container } = render(<LogBlock text={MCP} />);
    expect(container).toBeEmptyDOMElement();
  });
});
