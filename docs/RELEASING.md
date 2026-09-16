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

Every release pull request must:

- update `version` in `package.json` and `package-lock.json`;
- move relevant entries from `Unreleased` into
  `## [X.Y.Z] - YYYY-MM-DD` in `CHANGELOG.md`;
- describe user-visible behavior, configuration and API changes, database
  migrations, compatibility, known limitations, and rollback constraints;
- pass all required CI checks from a clean checkout.

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

The tag starts `.github/workflows/release.yml`. The workflow reruns the complete
CI suite, verifies that the annotated tag matches `package.json`, confirms the
commit belongs to `main`, builds from a clean checkout, inspects the package,
publishes it through npm trusted publishing, and creates the matching GitHub
Release. Do not create the GitHub Release manually before this workflow finishes.

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
