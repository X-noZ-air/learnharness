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

The fork's default branch is `werft`, and release workflows are dispatched there.

Both triggers build the `werft` commit that GitHub assigns to the run. A push
builds the pushed commit. The M2.1 update automation dispatches
`.github/workflows/werft-release.yml` on `werft` after merging with the built-in
GitHub token. It supplies the full merged commit as `merge_sha` and can include
the informational `upstream_tag` input.

The dispatch accepts the run commit itself or an ancestor as `merge_sha`.
When `werft` has advanced, the newer run commit covers the merge. For either
trigger, the workflow derives the upstream tag from the run commit's package
version, checks that the tag is a published stable release whose commit is
contained in the run commit, and records both commits in the release metadata.

Release runs queue and skip commits with a published release. The workflow
allocates `werft-<major>.<minor>.<patch>.<revision>` from existing tags and
verifies the draft's downloaded assets before publication. An interrupted
upload may leave a reserved revision and a draft. Rerun the full workflow to
retry an interrupted upload.

If GitHub refuses to create the release tag, publication stops and the run
reports the tag and commit that failed. When a newer workflow change on
`werft` causes the refusal, the run for the newer commit builds and publishes
its own release after checks pass. That commit contains the older commit.
Consumers take only published server releases by their versioned `werft-*`
tag and use the commit from the successful run.

## Verify and run

Run the trusted verifier with Python 3.12+, GNU coreutils, curl and GitHub CLI
with artifact-attestation support. Use the verified release workflow's run
commit as the expected fork SHA. The destination's parent must exist. The
verifier checks the public release, tag, SHA-256, source commit, GitHub
provenance for the checksum list, and the exact version and module ABI of the
supplied Node binary before it stages the server.

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
inside the standalone archive. It lists the packages physically present in
the payload with their available version, license and source information
from the shipped package metadata. Incomplete metadata is marked. The client
bundles are built from the dependencies pinned by the commit's lockfile,
which is part of the source archive.

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
