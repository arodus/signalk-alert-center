import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const { labelForTitle, reconcile } = createRequire(import.meta.url)(
  "../.github/scripts/title-labels.cjs",
);
const target = { owner: "example", repo: "repo", issue_number: 42 };

function issues(title: string, labels: string[]) {
  return {
    get: vi.fn().mockResolvedValue({
      data: { title, labels: labels.map((name) => ({ name })) },
    }),
    addLabels: vi.fn(),
    removeLabel: vi.fn(),
  };
}

describe("issue and PR classification", () => {
  it.each([
    ["feat: add a notifier", "feature"],
    ["fix(api)!: change response", "fix"],
    ["docs: explain retry", "doc"],
    ["chore: tidy scripts", "chore"],
    ["test: cover retries", "test"],
    ["refactor: share setup", "refactor"],
    ["perf: batch reads", "other"],
    ["style: format output", "other"],
    ["build: package assets", "chore"],
    ["ci: test titles", "chore"],
  ])("maps %s to %s", (title, label) =>
    expect(labelForTitle(title)).toBe(label),
  );

  it.each([
    "Missing prefix",
    "feat:",
    "fix:   ",
    "unknown: summary",
    "constructor: summary",
  ])("rejects %s before changing labels", async (title) => {
    const api = issues(title, ["test"]);
    await expect(reconcile(api, target)).rejects.toThrow("Use a title");
    expect(api.addLabels).not.toHaveBeenCalled();
    expect(api.removeLabel).not.toHaveBeenCalled();
  });

  it("updates a renamed issue or PR and preserves unrelated labels", async () => {
    const api = issues("docs: describe settings", ["fix", "help wanted"]);
    await reconcile(api, target);
    expect(api.addLabels.mock.calls).toEqual([
      [{ ...target, labels: ["doc"] }],
    ]);
    expect(api.removeLabel.mock.calls).toEqual([[{ ...target, name: "fix" }]]);
  });

  it("leaves a correctly labeled item alone on repeated events", async () => {
    const api = issues("fix: handle retries", ["fix", "good first issue"]);
    await reconcile(api, target);
    expect(api.addLabels).not.toHaveBeenCalled();
    expect(api.removeLabel).not.toHaveBeenCalled();
  });
});
