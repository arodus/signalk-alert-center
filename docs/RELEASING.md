# Releasing

npm is the authoritative package source and supplies the Signal K App Store.
Each published version also has an annotated Git tag and a GitHub Release with
the exact npm tarball and its SHA-256 checksum.

## One-time repository setup

1. Create a protected GitHub environment named `release` and require maintainer
   approval for deployments to it.
2. Protect `main`, require the CI checks, and require reviewed pull requests.
3. A brand-new npm package cannot have a trusted publisher until it exists. For
   the first publication only, create a narrowly scoped granular npm token that
   can create the new public package, save it as the `NPM_BOOTSTRAP_TOKEN` release
   environment secret, and keep the protected-environment approval in place.
4. Immediately after that first publication, configure GitHub Actions as the npm
   trusted publisher for the package, `.github/workflows/release.yml`, and the
   `release` environment. Delete the GitHub secret and revoke the bootstrap token.
   All later releases authenticate only through short-lived OIDC credentials.

## Version policy

Before 1.0, patch versions contain compatible fixes. Minor versions contain
features or breaking configuration, API, compatibility, or database changes.
Prereleases use `-alpha.N`, `-beta.N`, or `-rc.N` and publish to the npm `next`
distribution tag. Stable versions publish to `latest`.

Only release PRs edit `CHANGELOG.md`. To prepare one:

1. Fetch `origin/main` and tags, and start the release branch from current
   `origin/main`. Update the version in `package.json` and `package-lock.json`.
2. With GitHub CLI authenticated, run `npm run release:notes`. It drafts the
   dated section from merged PRs between the previous changelog version's tag
   and the release branch's common commit with `origin/main`. GitHub groups
   entries by PR label and includes PR links. The command preserves existing
   unreleased text. It does not create a tag, publish a release or bump versions.
3. Read the linked PRs that affect storage, configuration or compatibility.
   Replace the review marker under **Upgrade and rollback** with instructions
   for the entire release: required actions and backups, what the previous
   version can read, when a restore is required, and what was actually tested.
   If no action is needed, say so after review. Flag untested downgrade paths.
4. Review the generated list for accuracy and overlap with any legacy
   unreleased entries. If the release base changes, refresh the draft from
   the updated base changelog and reapply reviewed wording. Commit the reviewed
   changelog with the version bump. Publishing uses this exact release section.

Run the fast release checks locally with:

```sh
npm ci
npm run release:check
```

The pull request CI additionally runs transport integration, both Signal K
acceptance targets, browser coverage, restart recovery, and package inspection.
The package check permits only `dist`, `public`, `README.md`, `LICENSE`, and
`package.json`, and rejects databases, credentials, source, tests, and stale
removed audio output.

## Publishing

After the reviewed release pull request is merged and `main` is green, create and
push an annotated tag from the exact merge commit:

```sh
git switch main
git pull --ff-only
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

The tag starts `.github/workflows/release.yml`. It verifies that the annotated
tag matches `package.json` and the release notes, confirms the commit belongs to
`main`, and requires successful `main` push runs of both `ci.yml` and
`signalk-ci.yml` for that exact commit. It checks the latest run and its current
attempt; PR checks, another commit's checks, or older successful runs cannot
replace a missing, pending, failed, or cancelled main run. If verification is
blocked, finish or repair main CI, then rerun the release workflow.

The check uses GitHub's [workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow)
with read-only Actions access. Tag builds do not repeat the platform matrix,
unit/integration, acceptance/security, browser, or restart suites already covered
by main CI. They still build from a clean checkout, inspect the package, run the
packed-plugin installation smoke test, and validate the tag and release notes.

The workflow then stamps the reviewed tarball with the exact release commit as
npm `gitHead`,
publishes it through npm trusted publishing, verifies the published commit
metadata, and creates the matching GitHub Release. The Signal K Plugin Registry
uses `gitHead` to associate the npm version with its canonical plugin CI run. Do
not create the GitHub Release manually before this workflow finishes.

If validation fails before npm publication, fix the release through another
reviewed pull request, delete the unpublished tag, and tag the corrected commit.
Never move a tag after a package has been published.

If npm publication succeeds but GitHub Release creation fails, do not republish
or change the tag. Download the immutable package from npm, verify it against the
workflow artifact, and create the GitHub Release from that exact tarball and the
reviewed changelog section.

## Operator installation and rollback

The normal installation path is the Signal K App Store. The GitHub Release
tarball supports a manual installation without resolving the project from a
moving Git branch:

```sh
npm install --prefix ~/.signalk ./signalk-alert-center-X.Y.Z.tgz
```

Before an upgrade containing a database migration, stop Signal K and back up the
SQLite database. Release notes must say whether the previous version can read the
migrated database. If it cannot, rollback requires both the older package and the
pre-upgrade database backup.

Do not overwrite or unpublish a bad release. Deprecate it on npm, document the
problem, and publish a corrected patch. Operators can reinstall an exact older
version through the App Store/npm or its matching GitHub Release tarball.
