import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseDoctorArgs } from "../../scripts/doctor.mjs";
import { parseScratchArgs } from "../../scripts/scratch-app.mjs";
import { parseVerifyArgs } from "../../scripts/verify.mjs";
import { checkoutFingerprint, runChecked } from "../../scripts/verification/common.mjs";
import { redact } from "../../scripts/verification/evidence.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("verification script arguments", () => {
  it("defaults to the deterministic resume scenario with required native verification", () => {
    expect(parseVerifyArgs([])).toMatchObject({
      scenario: "chat-resume",
      native: "required",
      keep: false,
    });
  });

  it("rejects unknown scenarios and invalid scratch ports", () => {
    expect(() => parseVerifyArgs(["--scenario", "live-provider"])).toThrow(/scenario/);
    expect(parseVerifyArgs(["--scenario", "persistent-subagent", "--native", "off"])).toMatchObject({
      scenario: "persistent-subagent",
      native: "off",
    });
    expect(parseVerifyArgs(["--scenario", "persistent-codex-subagent", "--native", "off"])).toMatchObject({
      scenario: "persistent-codex-subagent",
      native: "off",
    });
    expect(parseVerifyArgs(["--scenario", "persistent-opencode-subagent", "--native", "off"])).toMatchObject({
      scenario: "persistent-opencode-subagent",
      native: "off",
    });
    expect(parseVerifyArgs(["--scenario", "persistent-cursor-subagent", "--native", "off"])).toMatchObject({
      scenario: "persistent-cursor-subagent",
      native: "off",
    });
    expect(() => parseVerifyArgs(["--out"])).toThrow(/requires a value/);
    expect(() => parseScratchArgs(["--port", "70000"])).toThrow(/between 1 and 65535/);
    expect(() => parseScratchArgs(["--data-dir"])).toThrow(/requires a value/);
    expect(() => parseDoctorArgs(["--out"])).toThrow(/requires a value/);
  });

  it("parses explicit evidence destinations", () => {
    expect(parseDoctorArgs(["--out", "scratch/doctor.json"])).toEqual({ output: "scratch/doctor.json" });
  });
});

describe("verification evidence", () => {
  it("redacts nested credentials, bearer values, and pairing tokens", () => {
    expect(
      redact({
        token: "pairing-token",
        nested: { apiKey: "provider-key" },
        message: 'Authorization: Bearer abc.def and http://localhost/#token=secret {"ARGMAX_SESSION_CONTROL_TOKEN":"control-secret"} {\\"ARGMAX_SESSION_LAUNCH_TOKEN\\":\\"escaped-secret\\"}',
      }),
    ).toEqual({
      token: "[redacted]",
      nested: { apiKey: "[redacted]" },
      message: 'Authorization: Bearer [redacted] and http://localhost/#token=[redacted] {"ARGMAX_SESSION_CONTROL_TOKEN":"[redacted]"} {\\"ARGMAX_SESSION_LAUNCH_TOKEN\\":\\"[redacted]\\"}',
    });
  });

  it("fingerprints untracked content and symlink identity without following the target", async () => {
    const repository = await mkdtemp(path.join(tmpdir(), "argmax-fingerprint-test-"));
    temporaryDirectories.push(repository);
    await runChecked("git", ["init", "-q"], { cwd: repository });
    await writeFile(path.join(repository, "tracked.txt"), "one\n");
    await runChecked("git", ["add", "tracked.txt"], { cwd: repository });
    await runChecked("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "fixture"], {
      cwd: repository,
    });
    const first = await checkoutFingerprint(repository);

    await writeFile(path.join(repository, "untracked.txt"), "two\n");
    const second = await checkoutFingerprint(repository);
    expect(second.sha256).not.toBe(first.sha256);

    await symlink("missing-outside-target", path.join(repository, "link"));
    const third = await checkoutFingerprint(repository);
    expect(third.sha256).not.toBe(second.sha256);
  });
});
