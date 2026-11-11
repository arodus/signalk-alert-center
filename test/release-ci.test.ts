import { execFileSync } from "node:child_process";
import { beforeEach, expect, it, vi } from "vitest";

import { verifyReleaseCi } from "../scripts/verify-release-ci.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const repository = "example/alert-center";
const sha = "a".repeat(40);
const success = (workflow: string, overrides = {}) => ({
  id: 100,
  head_sha: sha,
  head_branch: "main",
  event: "push",
  repository: { full_name: repository },
  path: `.github/workflows/${workflow}`,
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/example/alert-center/actions/runs/100",
  ...overrides,
});

beforeEach(() => vi.resetAllMocks());

it("requires both workflows and queries the exact commit across API pages", () => {
  vi.mocked(execFileSync).mockImplementation((_command, args) => {
    const workflow = args[3].includes("signalk-ci.yml")
      ? "signalk-ci.yml"
      : "ci.yml";
    return JSON.stringify([
      { workflow_runs: [success(workflow, { id: 90, conclusion: "failure" })] },
      { workflow_runs: [success(workflow)] },
    ]);
  });
  expect(verifyReleaseCi(repository, sha)).toHaveLength(2);
  expect(execFileSync).toHaveBeenCalledTimes(2);
  for (const [, args] of vi.mocked(execFileSync).mock.calls) {
    expect(args).toEqual(
      expect.arrayContaining([
        "branch=main",
        "event=push",
        `head_sha=${sha}`,
        "--paginate",
        "--slurp",
      ]),
    );
    expect(args).not.toContain("status=success");
  }
});

it.each(["ci.yml", "signalk-ci.yml"])(
  "rejects missing %s even when the other workflow passed",
  (missing) => {
    expect(() =>
      verifyReleaseCi(repository, sha, (_repo, workflow) =>
        workflow === missing ? [] : [success(workflow)],
      ),
    ).toThrow(`${missing}: no main push run exists`);
  },
);

it.each([
  { head_sha: "b".repeat(40) },
  { head_branch: "feature/example" },
  { event: "pull_request" },
  { event: "workflow_dispatch" },
  { repository: { full_name: "someone-else/alert-center" } },
  { path: ".github/workflows/unrelated.yml" },
])("rejects a successful run with the wrong identity: %j", (overrides) => {
  expect(() =>
    verifyReleaseCi(repository, sha, (_repo, workflow) => [
      success(workflow, overrides),
    ]),
  ).toThrow("no main push run exists");
});

it.each([
  { status: "queued", conclusion: null },
  { status: "in_progress", conclusion: null, run_attempt: 2 },
  { conclusion: "failure" },
  { conclusion: "cancelled" },
  { conclusion: "skipped" },
  { conclusion: "neutral" },
  { conclusion: "timed_out" },
])(
  "rejects the latest unsuccessful run despite an older success: %j",
  (state) => {
    expect(() =>
      verifyReleaseCi(repository, sha, (_repo, workflow) => [
        success(workflow),
        success(workflow, { id: 101, ...state }),
      ]),
    ).toThrow("Wait for successful main CI, then rerun the release");
  },
);

it("accepts a successful rerun's current result", () => {
  expect(
    verifyReleaseCi(repository, sha, (_repo, workflow) => [
      success(workflow, { run_attempt: 2 }),
    ]),
  ).toHaveLength(2);
});

it("blocks publication when the API cannot be read", () => {
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error("GitHub API unavailable");
  });
  expect(() => verifyReleaseCi(repository, sha)).toThrow(
    "GitHub API unavailable",
  );
});

it("rejects malformed API responses", () => {
  vi.mocked(execFileSync).mockReturnValue("{}");
  expect(() => verifyReleaseCi(repository, sha)).toThrow();
});

it.each([
  [undefined, sha],
  ["invalid", sha],
  [repository, undefined],
  [repository, "main"],
])(
  "rejects invalid release identity before querying GitHub",
  (repo, commit) => {
    expect(() => verifyReleaseCi(repo, commit)).toThrow();
    expect(execFileSync).not.toHaveBeenCalled();
  },
);
