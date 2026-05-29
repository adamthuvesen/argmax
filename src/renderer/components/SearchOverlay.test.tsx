import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi } from "../../shared/types.js";
import { SearchOverlay, type SearchHit } from "./SearchOverlay.js";

describe("SearchOverlay", () => {
  let search: ReturnType<typeof vi.fn<ArgmaxApi["session"]["search"]>>;

  beforeEach(() => {
    search = vi.fn<ArgmaxApi["session"]["search"]>().mockResolvedValue([]);
    (window as { argmax?: unknown }).argmax = { session: { search } };
  });

  afterEach(() => {
    delete (window as { argmax?: unknown }).argmax;
  });

  it("drops stale results after the query is cleared", async () => {
    let resolveSearch!: (hits: SearchHit[]) => void;
    search.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        })
    );
    render(
      <SearchOverlay
        open
        onClose={() => {}}
        onSelectSession={() => {}}
        sessionLabelById={new Map([["session-1", "Build search"]])}
      />
    );

    const input = screen.getByRole("searchbox", { name: "Search sessions" });
    fireEvent.change(input, { target: { value: "needle" } });
    await waitFor(() => expect(search).toHaveBeenCalledWith({ query: "needle", limit: 50 }));

    fireEvent.change(input, { target: { value: "" } });
    resolveSearch([
      {
        sessionId: "session-1",
        eventId: "event-1",
        snippet: "<b>needle</b>",
        rank: -1
      }
    ]);

    await waitFor(() => expect(screen.queryByText("Build search")).toBeNull());
  });
});
