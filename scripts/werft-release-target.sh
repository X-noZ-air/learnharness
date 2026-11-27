#!/usr/bin/env bash
set -euo pipefail

test "$(git rev-parse HEAD)" = "$GITHUB_SHA"
if [[ "$GITHUB_EVENT_NAME" == workflow_dispatch ]]; then
  if [[ ! "$MERGE_SHA" =~ ^[0-9a-f]{40}$ ]] || ! git merge-base --is-ancestor "$MERGE_SHA" "$GITHUB_SHA"; then
    echo "merge_sha must be a full commit SHA contained in the werft run commit" >&2
    exit 1
  fi
  if [[ -n "$UPSTREAM_TAG" ]]; then
    merged_version=$(git show "$MERGE_SHA:package.json" | jq -er '.version | strings')
    if [[ "$UPSTREAM_TAG" != "v$merged_version" ]]; then
      echo "upstream_tag must match the package version at merge_sha" >&2
      exit 1
    fi
  fi
fi

version=$(jq -er '.version | strings' package.json)
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
echo "v$version"
