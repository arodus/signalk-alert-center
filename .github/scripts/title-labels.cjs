// Keep the type mapping aligned with SignalK/signalk-server's require_pr_label.yml.
const labels = new Map(
  Object.entries({
    feat: "feature",
    fix: "fix",
    docs: "doc",
    chore: "chore",
    test: "test",
    refactor: "refactor",
    perf: "other",
    style: "other",
    build: "chore",
    ci: "chore",
  }),
);
const managed = new Set(labels.values());

function labelForTitle(title) {
  const match = /^([a-z]+)(?:\([^()\r\n]+\))?!?:\s+(\S.*)$/i.exec(title.trim());
  const label = match && labels.get(match[1].toLowerCase());
  if (!label)
    throw new Error(
      "Use a title such as 'fix: handle disconnects' or 'feat(audio): add playback'. Supported types: " +
        [...labels.keys()].join(", "),
    );
  return label;
}

async function reconcile(issues, target) {
  // Read current state because title and label events can queue up.
  const { data } = await issues.get(target);
  const wanted = labelForTitle(data.title);
  const current = data.labels.map((label) => label.name);
  if (!current.includes(wanted))
    await issues.addLabels({ ...target, labels: [wanted] });
  for (const name of current) {
    if (name !== wanted && managed.has(name))
      await issues.removeLabel({ ...target, name });
  }
}

module.exports = { labelForTitle, reconcile };
