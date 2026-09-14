import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi } from "../../shared/types.js";
import {
  BROWSER_HISTORY_KEY,
  setBrowserHistoryStorageForTests,
  type BrowserHistoryEntry
} from "../lib/browserHistory.js";
import { BrowserHistoryImport } from "./BrowserHistoryImport.js";

const chromeProfiles = vi.fn();
const importChromeHistory = vi.fn();

beforeEach(() => {
  chromeProfiles.mockReset();
  importChromeHistory.mockReset();
  let entries: BrowserHistoryEntry[] | undefined;
  setBrowserHistoryStorageForTests({
    load: () => Promise.resolve(entries),
    save: (nextEntries) => {
      entries = structuredClone(nextEntries);
      return Promise.resolve();
    }
  });
  chromeProfiles.mockResolvedValue([
    { id: "Default", name: "Personal" },
    { id: "Profile 1", name: "Work" }
  ]);
  window.argmax = {
    browser: { chromeProfiles, importChromeHistory }
  } as unknown as ArgmaxApi;
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(BROWSER_HISTORY_KEY);
  delete (window as { argmax?: ArgmaxApi }).argmax;
});

describe("BrowserHistoryImport", () => {
  it("imports the selected profile and reports pages, new URLs, and the cap", async () => {
    importChromeHistory.mockResolvedValue({
      entries: [
        { url: "https://example.com/", title: "Example", visitedAt: 100, visitCount: 3 },
        { url: "https://github.com/", title: "GitHub", visitedAt: 90, visitCount: 2 }
      ],
      totalAvailable: 12_345
    });

    render(<BrowserHistoryImport onClose={() => undefined} />);

    const profile = await screen.findByRole("combobox", { name: "Chrome profile" });
    expect(profile).toHaveValue("Default");
    fireEvent.change(profile, { target: { value: "Profile 1" } });
    fireEvent.click(screen.getByRole("button", { name: "Import history" }));

    expect(importChromeHistory).toHaveBeenCalledWith("Profile 1");
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Imported 2 pages from Chrome");
    expect(status).toHaveTextContent("2 were new to Argmax");
    expect(status).toHaveTextContent("12,345 available pages");
    expect(status).toHaveTextContent("capped at 10,000");
    expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
  });

  it("explains that cookies are excluded and reports profile loading failures", async () => {
    chromeProfiles.mockRejectedValue(new Error("Chrome data is unavailable"));

    render(<BrowserHistoryImport onClose={() => undefined} />);

    expect(screen.getByText(/Cookies and saved logins are not included/)).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load Chrome profiles: Chrome data is unavailable"
    );
    expect(screen.getByRole("button", { name: "Import history" })).toBeDisabled();
  });

  it("keeps the dialog busy until the import settles and reports import failures", async () => {
    let rejectImport: ((error: Error) => void) | undefined;
    importChromeHistory.mockReturnValue(new Promise((_resolve, reject) => {
      rejectImport = reject;
    }));

    render(<BrowserHistoryImport onClose={() => undefined} />);
    await screen.findByRole("combobox", { name: "Chrome profile" });
    fireEvent.click(screen.getByRole("button", { name: "Import history" }));

    expect(screen.getByRole("dialog", { name: "Import from Chrome" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Importing…" })).toBeDisabled();
    rejectImport?.(new Error("History database is locked"));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Import failed: History database is locked");
    });
    expect(screen.getByRole("button", { name: "Import history" })).toBeEnabled();
  });
});
