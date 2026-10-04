/**
 * The branch a person picked in the launcher for one launch. Picking changes
 * nothing on disk: the choice is held in the launcher and sent with the launch,
 * which decides what to do with it (see `App.launchTask`).
 */
export interface LaunchCheckout {
  projectId: string;
  branch: string;
  /** The checkout that has `branch` checked out, or null when no checkout does. */
  path: string | null;
  /** That checkout is the project's own. */
  isMain: boolean;
}
