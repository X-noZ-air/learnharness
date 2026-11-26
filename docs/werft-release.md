# Werft standalone releases

The fork's `Werft release` workflow builds the Linux x64 browser server on
Ubuntu 24.04 with **Node 26.13.1** (Node module ABI **147**). It uses the ordinary
CI test and renderer matrix, then boots the extracted release with real Node
and a throwaway profile before publishing. It also checks the archived native
PDF and SVG renderers, the core plugins, and a browser session backed by a
synthetic loopback model.

Fork changes first shipped in this workflow are recorded in the Git log. The
release workflow, verifier and source offer were added on 2026-11-26.

## Dispatch

Dispatch `.github/workflows/werft-release.yml` on the fork's `werft` branch, with
the full checked and merged head in `merge_sha` and the stable upstream tag in
`upstream_tag` (for example `v0.7.0`). Dispatch while that commit is the branch
tip, because GitHub signs the dispatch commit. The job rejects a different
commit, an unpublished or prerelease upstream tag, and a package version or
ancestor that does not match. Read the workflow result before treating the
candidate as delivered.

The workflow allocates `werft-<major>.<minor>.<patch>.<revision>` from existing
tags. It verifies the draft's downloaded assets before publication. An
interrupted upload may leave a reserved revision and a draft. Dispatch a new
run for a correction. Select published server releases by their versioned
`werft-*` tag, since these builds leave the desktop-style Latest marker alone.

## Verify and run

Run the trusted verifier with Python 3.12+, GNU coreutils, curl and GitHub CLI
with artifact-attestation support. The expected fork SHA comes from the checked
merge candidate. The destination's parent must exist. The verifier checks the
public release, tag, SHA-256, source commit, and GitHub provenance for the fixed
workflow, commit and hosted runner before it stages the server.

```sh
python3 /trusted/scripts/verify_werft_release.py \
  werft-0.7.0.1 "$expected_fork_sha" /path/to/new-release
```

On success, the command prints signed release metadata as JSON. The
`packed_bytes` and `unpacked_bytes` fields describe the compressed runtime
archive and the sum of its regular file sizes. `glibc_version` records the
build runner's runtime libc. Match the release's Node version and ABI before
starting `server.js`, keep the profile and auth paths outside the unpacked
tree, and restrict the listener to a trusted network or loopback.

```sh
HOSTNAME=127.0.0.1 PORT=3000 \
  LH_DATA_DIR=/path/to/profile/data LH_AUTH_FILE=/path/to/private/auth.json \
  /path/to/node-v26.13.1/bin/node /path/to/new-release/server.js
```

## Source and rebuilding

Download `learnharness-source.tar.gz` and
`learnharness-dependency-sources.tar.gz` from the same versioned release page.
The first is the Git archive of the exact fork commit shown in the sidebar
and Settings → About. It contains the core-plugin projects, local
adaptations, build and installation scripts, lockfiles and notices. The
second mirrors the versioned sources for the separately compiled dependencies
listed in [the source manifest](../scripts/werft-source-dependencies.json),
including the libvips packaging recipe and source patches, and the TikZJax
toolchain from which the plugin takes its TeX image. The packaging step checks
the listed dependency versions against the lockfiles. Update and review those
source pins together with a dependency upgrade. The plugin's
[third-party notices](../plugins/rich-code-blocks/THIRD-PARTY.md) describe its
local adaptations and font redistribution.

Extract the Git archive and run these commands from its root with the release's
Node version. The lockfiles identify the original registry packages used by
`npm ci` and the plugin setup step. Use standard Node, npm, and the system's
Linux C runtime from their respective distributions.

```sh
npm ci
npm run plugins:setup
NEXT_PUBLIC_LH_SOURCE_OFFER="$release_tag:$expected_fork_sha" npm run build
node scripts/smoke-provider-runtime.mjs
node scripts/build-server.mjs
node scripts/smoke-server.mjs --isolated
```

The runnable server is in `.next/standalone`. Builds with no source-offer
variable omit the source links and About section.
