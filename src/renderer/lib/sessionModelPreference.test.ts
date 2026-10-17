// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { FALLBACK_LAUNCH_MODEL } from "./models.js";
import { readStoredSessionModel } from "./sessionModelPreference.js";

const SESSION_ID = "saved-deepseek-selection";
const STORAGE_KEY = `argmax.sessionModel.${SESSION_ID}`;

afterEach(() => window.localStorage.removeItem(STORAGE_KEY));

it("restores a pending DeepSeek selection through its successor without losing effort", () => {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      provider: "opencode",
      modelId: "openrouter/deepseek/deepseek-v4.1-flash",
      reasoningEffort: "high"
    })
  );

  expect(readStoredSessionModel(SESSION_ID, FALLBACK_LAUNCH_MODEL)).toEqual({
    provider: "opencode",
    label: "DeepSeek V4.1 Flash 1017",
    modelId: "openrouter/deepseek/deepseek-v4.1-flash-1017",
    reasoningEffort: "high"
  });
});
