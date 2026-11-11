import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const requiredWorkflows = ["ci.yml", "signalk-ci.yml"];

function listRuns(repository, workflow, sha) {
  // Query by workflow identity, not its display name; do not filter by success,
  // which could hide a pending or failed rerun of the same commit.
  return JSON.parse(
    execFileSync(
      "gh",
      [
        "api",
        "--method",
        "GET",
        `repos/${repository}/actions/workflows/${workflow}/runs`,
        "-f",
        "branch=main",
        "-f",
        "event=push",
        "-f",
        `head_sha=${sha}`,
        "-f",
        "per_page=100",
        "--paginate",
        "--slurp",
      ],
      { encoding: "utf8" },
    ),
  ).flatMap((page) => page.workflow_runs);
}

export function verifyReleaseCi(repository, sha, getRuns = listRuns) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? ""))
    throw new Error("GITHUB_REPOSITORY must identify the release repository");
  if (!/^[a-f0-9]{40}$/.test(sha ?? ""))
    throw new Error("Pass the full tagged commit SHA");

  return requiredWorkflows.map((workflow) => {
    const runs = getRuns(repository, workflow, sha)
      .filter(
        (run) =>
          run.head_sha === sha &&
          run.head_branch === "main" &&
          run.event === "push" &&
          run.repository?.full_name === repository &&
          run.path === `.github/workflows/${workflow}`,
      )
      .sort((a, b) => b.id - a.id);
    const latest = runs[0];
    if (!latest)
      throw new Error(
        `${workflow}: no main push run exists for ${sha}. Run main CI before releasing.`,
      );
    if (latest.status !== "completed" || latest.conclusion !== "success")
      throw new Error(
        `${workflow}: latest main push run for ${sha} is ${latest.status}/${latest.conclusion ?? "pending"}. ` +
          `Wait for successful main CI, then rerun the release. ${latest.html_url}`,
      );
    return `${workflow}: verified successful main CI for ${sha}: ${latest.html_url}`;
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  for (const result of verifyReleaseCi(
    process.env.GITHUB_REPOSITORY,
    process.argv[2],
  ))
    console.log(result);
}
