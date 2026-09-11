// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshSessionPrs } from "./sessionPrs.js";

function stubRefresh(refresh: () => Promise<unknown>): void {
  (window as { argmax?: unknown }).argmax = { prs: { refresh } };
}

describe("refreshSessionPrs", () => {
  afterEach(() => {
    delete (window as { argmax?: unknown }).argmax;
  });

  it("collapses the callers that open a chat into one gh round trip", async () => {
    let settle = (): void => {};
    const refresh = vi.fn(() => new Promise((resolve) => { settle = () => resolve([]); }));
    stubRefresh(refresh);

    // The actions menu and the workspace card both ask on mount.
    const menu = refreshSessionPrs("session-a");
    const card = refreshSessionPrs("session-a");
    settle();

    expect(await menu).toEqual([]);
    expect(await card).toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("asks again once the previous refresh has finished", async () => {
    const refresh = vi.fn(() => Promise.resolve([]));
    stubRefresh(refresh);

    await refreshSessionPrs("session-a");
    await refreshSessionPrs("session-a");

    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
