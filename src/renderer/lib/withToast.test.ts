import { describe, expect, it, vi } from "vitest";
import { withToast, type ToastMessage } from "./withToast.js";

function collect(): [ToastMessage[], (toast: ToastMessage) => void] {
  const toasts: ToastMessage[] = [];
  return [toasts, (toast) => toasts.push(toast)];
}

describe("withToast", () => {
  it("leaves no toast behind on success", async () => {
    const [toasts, setToast] = collect();

    await expect(withToast(() => Promise.resolve(), setToast, "Could not rename chat.")).resolves.toBe(
      true
    );
    expect(toasts).toEqual([]);
  });

  it("leads with the action and carries the backend string as detail", async () => {
    const [toasts, setToast] = collect();
    const failing = vi.fn(() => Promise.reject(new Error("no such column: pinned")));

    await expect(withToast(failing, setToast, "Could not rename chat.")).resolves.toBe(false);
    expect(toasts).toEqual([
      { kind: "error", message: "Could not rename chat.", detail: "no such column: pinned" }
    ]);
  });

  it("shows the action alone when the failure says nothing extra", async () => {
    const [toasts, setToast] = collect();

    await withToast(() => Promise.reject(new Error("")), setToast, "Could not rename chat.");
    await withToast(
      () => Promise.reject(new Error("Could not rename chat.")),
      setToast,
      "Could not rename chat."
    );

    expect(toasts).toEqual([
      { kind: "error", message: "Could not rename chat." },
      { kind: "error", message: "Could not rename chat." }
    ]);
  });
});
