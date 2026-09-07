// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { SCRATCH_PROJECT_ID } from "../../shared/types.js";
import {
  LAUNCH_PROJECT_RECENCY_KEY,
  launchProjectIdFrom,
  persistLaunchProjectId,
  readLaunchProjectRecency,
  sortProjectsByLaunchRecency
} from "./launchProjectPreference.js";

afterEach(() => {
  window.localStorage.removeItem(LAUNCH_PROJECT_RECENCY_KEY);
});

describe("launch project preference", () => {
  it("persists the last aimed-at project and ignores scratch", () => {
    persistLaunchProjectId("project-1");
    persistLaunchProjectId("project-2");
    persistLaunchProjectId(SCRATCH_PROJECT_ID);
    persistLaunchProjectId("");

    expect(readLaunchProjectRecency()).toEqual(["project-2", "project-1"]);
    expect(
      launchProjectIdFrom([{ id: "project-1" }, { id: "project-2" }, { id: SCRATCH_PROJECT_ID }])
    ).toBe("project-2");
  });

  it("skips a stored id that is no longer in the project list", () => {
    persistLaunchProjectId("gone");
    persistLaunchProjectId("project-1");
    persistLaunchProjectId("gone");

    expect(launchProjectIdFrom([{ id: "project-1" }])).toBe("project-1");
    expect(launchProjectIdFrom([])).toBeNull();
  });

  it("sorts projects with the last pick first", () => {
    persistLaunchProjectId("project-1");
    persistLaunchProjectId("project-2");

    expect(
      sortProjectsByLaunchRecency([{ id: "project-1" }, { id: "project-2" }, { id: "project-3" }]).map(
        (project) => project.id
      )
    ).toEqual(["project-2", "project-1", "project-3"]);
  });
});
