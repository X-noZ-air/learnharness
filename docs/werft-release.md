# Werft standalone releases

The fork's `Werft release` workflow builds the Linux x64 browser server on
Ubuntu 24.04 with **Node 26.13.1** (Node module ABI **147**). The workflow runs
typechecking, tests and lint on Linux x64 and boots the extracted release with
Node and a throwaway profile before publishing. It also checks the archived native
PDF and SVG renderers, the core plugins, and a browser session backed by a
synthetic loopback model.

Fork changes first shipped in this workflow are recorded in the Git log. The
release workflow, verifier and source offer were added on 2026-11-26.

## Release triggers

A push to the fork's `werft` branch builds the pushed commit. Update automation
that merges using the built-in GitHub token dispatches
`.github/workflows/werft-release.yml` on `werft` with the full merged head in
`merge_sha`. Dispatch while that commit is the branch tip, because GitHub signs
the dispatch commit. The optional `upstream_tag` defaults to the commit's
package version with a `v` prefix. The job checks that the tag is a published
stable release, matches the package version, and is an ancestor of the build.

Release runs queue and skip commits with a published release. The workflow
allocates `werft-<major>.<minor>.<patch>.<revision>` from existing tags and
verifies the draft's downloaded assets before publication. An interrupted
upload may leave a reserved revision and a draft. Rerun the full workflow to
retry. Select published server releases by their versioned `werft-*` tag.

## Verify and run

Run the trusted verifier with Python 3.12+, GNU coreutils, curl and GitHub CLI
with artifact-attestation support. The expected fork SHA comes from the checked
merge candidate. The destination's parent must exist. The verifier checks the
public release, tag, SHA-256, source commit, GitHub provenance for the fixed
workflow, commit and hosted runner, and the exact version and module ABI of
the supplied Node binary before it stages the server.

```sh
python3 /trusted/scripts/verify_werft_release.py \
  werft-0.7.0.1 "$expected_fork_sha" /path/to/new-release \
  --node /path/to/node-v26.13.1/bin/node
```

On success, the command prints signed release metadata as JSON. The
`packed_bytes` and `unpacked_bytes` fields describe the compressed runtime
archive and the sum of its regular file sizes. `glibc_version` records the
build runner's runtime libc. Start `server.js` with the verified Node binary,
keep the profile and auth paths outside the unpacked tree, and restrict the
listener to a trusted network or loopback.

```sh
HOSTNAME=127.0.0.1 PORT=3000 \
  LH_DATA_DIR=/path/to/profile/data LH_AUTH_FILE=/path/to/private/auth.json \
  /path/to/node-v26.13.1/bin/node /path/to/new-release/server.js
```

## Source and rebuilding

Download `learnharness-source.tar.gz` from the versioned release page. It is a
Git archive of the same fork commit addressed by the sidebar link. It contains
the core-plugin projects, local adaptations, build and installation scripts,
lockfiles and notices.

`learnharness-third-party-notice.json` is available on the release page and
inside the standalone archive. The build generates it from the payload,
installed package metadata and lockfiles. It lists shipped npm packages and
installed production dependencies that can be bundled into JavaScript, with
the available license, source repository, revision and versioned package
distribution. Packages with incomplete metadata are marked. Bundled
attribution files list additional vendored assets.

Extract the Git archive and run these commands from its root with the release's
Node version. The lockfiles identify the original registry packages used by
`npm ci` and the plugin setup step. Use standard Node, npm, and the system's
Linux C runtime from their respective distributions.

```sh
npm ci
npm run plugins:setup
NEXT_PUBLIC_LH_SOURCE_OFFER="$expected_fork_sha" npm run build
node scripts/build-server.mjs
node scripts/smoke-server.mjs --isolated
```

The runnable server is in `.next/standalone`. Builds with no source-offer
variable omit the sidebar source link.
