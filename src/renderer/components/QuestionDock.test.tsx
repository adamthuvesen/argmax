import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resetToastForTests, toastSnapshot } from "../state/toast.js";
import { QuestionDock } from "./QuestionDock.js";

afterEach(resetToastForTests);

it("toasts a failed answer and leaves the question ready to retry", async () => {
  const onAnswer = vi.fn().mockRejectedValueOnce(new Error("Provider disconnected")).mockResolvedValueOnce(true);
  render(
    <QuestionDock
      questions={[{ question: "Where?", header: "Place", options: [{ label: "Here" }], multiSelect: false }]}
      onAnswer={onAnswer}
      onDismiss={vi.fn()}
    />
  );

  fireEvent.click(screen.getByRole("option", { name: /Here/ }));
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));

  await waitFor(() => expect(toastSnapshot()?.message).toBe("Answer was not sent. Try again."));
  expect(screen.getByRole("button", { name: "Submit answer" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(2));
});
