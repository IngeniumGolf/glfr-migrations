# Releasing

`@ingeniumgolf/migrations` is published to the public npm registry under the [`ingeniumgolf`](https://www.npmjs.com/org/ingeniumgolf) organisation. Releases are published by GitHub Actions through npm **trusted publishing**: no npm tokens exist in this repository, in GitHub secrets, or on developer machines.

## Prerequisites

- Push access to `IngeniumGolf/glfr-migrations` (tags trigger releases).
- Only for the manual steps below: an npm account with two-factor authentication, added to the `ingeniumgolf` organisation.

## Release a new version

1. Make sure `master` is green in CI and your checkout is up to date:

   ```sh
   git checkout master && git pull
   ```

2. Bump the version. This updates `package.json`, commits, and creates a `v<version>` tag:

   ```sh
   npm version patch   # bug fixes
   npm version minor   # new, backwards-compatible features
   npm version major   # breaking changes (CLI flags, file format, API)
   ```

   While the package is on `0.x`, treat `minor` as breaking for consumers.

3. Push the commit and the tag:

   ```sh
   git push --follow-tags
   ```

4. Watch the [Release workflow](https://github.com/IngeniumGolf/glfr-migrations/actions/workflows/release.yml). It checks that the tag matches `package.json`, runs typecheck, build and tests against Postgres, then runs `npm publish` with provenance.

5. Verify the release:

   ```sh
   npm view @ingeniumgolf/migrations@<version> version --prefer-online
   ```

   `npm view @ingeniumgolf/migrations` and the npm website can show the previous version for a few minutes because the registry caches the package summary. The version-specific query above is authoritative.

## If a release fails

- **Tests or tag check failed:** nothing was published. Fix on `master`, then delete and recreate the tag, or bump to the next patch version:

  ```sh
  git tag -d v0.1.2 && git push origin :refs/tags/v0.1.2
  ```

- **`npm publish` returned `403 … OIDC permission denied`:** the trusted publisher on npm doesn't match or doesn't allow publishing. Check the package's **Settings → Trusted Publisher** on npmjs.com:
  - Repository `IngeniumGolf/glfr-migrations`, workflow file `release.yml`, no environment
  - Permissions include **npm publish** (not only _stage publish_)

  After fixing it, re-run the failed job from the Actions page. The tag can stay.

- **A published version is broken:** npm versions can't be overwritten. Publish a fixed patch version. Use `npm deprecate @ingeniumgolf/migrations@<version> "<reason>"` (requires `npm login`) to warn installers away from the broken one.

## Log in to npm (manual operations only)

Routine releases never need this. You need it to change package settings, deprecate a version, or publish by hand if Actions is unavailable.

```sh
npm login     # opens the browser; complete the 2FA prompt
npm whoami    # prints your npm username
```

The session token is stored in `~/.npmrc`. Run `npm logout` when you're done.

### Manual publish (emergency only)

Package settings require 2FA for publishing and disallow tokens, so a manual publish prompts for a one-time code:

```sh
pnpm install --frozen-lockfile
npm publish   # prepublishOnly runs typecheck + build
```

A manual publish has no provenance attestation. Prefer fixing the workflow.

## Package settings on npmjs.com

| Setting           | Value                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| Trusted Publisher | GitHub Actions, `IngeniumGolf/glfr-migrations`, `release.yml`, permissions `npm publish` + `npm stage publish` |
| Publishing access | Require two-factor authentication and disallow tokens                                                          |
| Access            | Public                                                                                                         |
