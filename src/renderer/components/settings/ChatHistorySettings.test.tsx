import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArgmaxApi } from "../../../shared/types.js";
import { ChatHistorySettings } from "./ChatHistorySettings.js";

const previewPayload = {
  cleanupId: "cleanup-1",
  cutoffAt: "2026-09-04T00:00:00Z",
  chatCount: 3
};

const deletePayload = {
  deletedChatCount: 2,
  skippedRecentCount: 1,
  skippedRunningCount: 0
};

const settingsStub = {
  previewChatCleanup: vi.fn(() => Promise.resolve(previewPayload)),
  deleteOldChats: vi.fn(() => Promise.resolve(deletePayload))
};

beforeEach(() => {
  window.localStorage.removeItem("argmax.chatHistory.lastCleanup");
  settingsStub.previewChatCleanup.mockClear();
  settingsStub.deleteOldChats.mockClear();
  settingsStub.previewChatCleanup.mockResolvedValue(previewPayload);
  settingsStub.deleteOldChats.mockResolvedValue(deletePayload);
  window.argmax = { settings: settingsStub } as unknown as ArgmaxApi;
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem("argmax.chatHistory.lastCleanup");
  delete (window as { argmax?: ArgmaxApi }).argmax;
});

describe("ChatHistorySettings", () => {
  it("initial click only previews", async () => {
    render(<ChatHistorySettings />);
    fireEvent.click(await screen.findByRole("button", { name: /delete old chats/i }));

    await waitFor(() => expect(settingsStub.previewChatCleanup).toHaveBeenCalledTimes(1));
    expect(settingsStub.deleteOldChats).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Delete 3 chats" })).toBeInTheDocument();
  });

  it("cancellation does not delete", async () => {
    render(<ChatHistorySettings />);
    fireEvent.click(await screen.findByRole("button", { name: /delete old chats/i }));
    await screen.findByRole("button", { name: "Delete 3 chats" });

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Delete 3 chats" })).not.toBeInTheDocument());
    expect(settingsStub.deleteOldChats).not.toHaveBeenCalled();
  });

  it("confirming uses preview id and reports actual deleted and skipped counts", async () => {
    render(<ChatHistorySettings />);
    fireEvent.click(await screen.findByRole("button", { name: /delete old chats/i }));
    await screen.findByRole("button", { name: "Delete 3 chats" });

    fireEvent.click(screen.getByRole("button", { name: "Delete 3 chats" }));

    await waitFor(() =>
      expect(settingsStub.deleteOldChats).toHaveBeenCalledWith({ cleanupId: "cleanup-1" })
    );
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Deleted 2 chats.");
    expect(status).toHaveTextContent("Kept 1 chat that is active or recently updated.");
  });

  it("keeps the successful count after checking again and reopening settings", async () => {
    const view = render(<ChatHistorySettings />);
    fireEvent.click(screen.getByRole("button", { name: /delete old chats/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete 3 chats" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Last cleanup: Deleted 2 chats.");

    settingsStub.previewChatCleanup.mockResolvedValue({ ...previewPayload, chatCount: 0 });
    fireEvent.click(screen.getByRole("button", { name: /delete old chats/i }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No inactive chats"));
    expect(screen.getByRole("status")).toHaveTextContent("Deleted 2 chats.");

    view.unmount();
    render(<ChatHistorySettings />);
    expect(screen.getByRole("status")).toHaveTextContent("Last cleanup: Deleted 2 chats.");
    expect(settingsStub.deleteOldChats).toHaveBeenCalledTimes(1);
  });

  it("zero count needs no confirmation", async () => {
    settingsStub.previewChatCleanup.mockResolvedValue({
      ...previewPayload,
      chatCount: 0
    });
    render(<ChatHistorySettings />);
    fireEvent.click(await screen.findByRole("button", { name: /delete old chats/i }));

    await waitFor(() => expect(settingsStub.previewChatCleanup).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Delete 3 chats" })).not.toBeInTheDocument();
    expect(settingsStub.deleteOldChats).not.toHaveBeenCalled();
  });

  it("surfaces preview failure in an alert", async () => {
    settingsStub.previewChatCleanup.mockRejectedValue(new Error("disk full"));
    render(<ChatHistorySettings />);
    fireEvent.click(await screen.findByRole("button", { name: /delete old chats/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    expect(settingsStub.deleteOldChats).not.toHaveBeenCalled();
  });

  it("surfaces delete failure in an alert and does not claim success", async () => {
    settingsStub.deleteOldChats.mockRejectedValue(new Error("locked"));
    render(<ChatHistorySettings />);
    fireEvent.click(await screen.findByRole("button", { name: /delete old chats/i }));
    await screen.findByRole("button", { name: "Delete 3 chats" });
    fireEvent.click(screen.getByRole("button", { name: "Delete 3 chats" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("locked");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("pending deletion disables controls and does not delete twice", async () => {
    let resolveDelete: (value: typeof deletePayload) => void = () => {};
    settingsStub.deleteOldChats.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve;
        })
    );
    render(<ChatHistorySettings />);
    fireEvent.click(await screen.findByRole("button", { name: /delete old chats/i }));
    await screen.findByRole("button", { name: "Delete 3 chats" });
    const confirm = screen.getByRole("button", { name: "Delete 3 chats" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(confirm).toBeDisabled());
    expect(settingsStub.deleteOldChats).toHaveBeenCalledTimes(1);

    resolveDelete(deletePayload);
    expect(await screen.findByRole("status")).toHaveTextContent("Deleted 2 chats.");
  });
});
