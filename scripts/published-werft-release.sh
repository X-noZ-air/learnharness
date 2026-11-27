#!/usr/bin/env bash
set -euo pipefail

commit=$1
prefix=$2
commit_tags=$(git tag --contains "$commit" --list "$prefix*")
if [[ -z "$commit_tags" ]]; then
  exit 0
fi

published=$(gh api --paginate "repos/$GITHUB_REPOSITORY/releases?per_page=100" \
  --jq '.[] | select((.draft or .prerelease) | not) | .tag_name')
while IFS= read -r tag; do
  if [[ "${tag#"$prefix"}" =~ ^[1-9][0-9]*$ ]] && grep -Fxq -- "$tag" <<< "$published"; then
    echo "$tag"
    exit 0
  fi
done <<< "$commit_tags"
