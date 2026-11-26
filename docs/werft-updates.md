# Werft upstream updates

`werft` is the fork's production and default branch. `main` mirrors upstream.
Feature branches target `werft` through a pull request and the normal CI matrix.
The upstream notification jobs are restricted to the original repository.

## Update and branch protection

**Werft upstream updates** runs at minutes 7, 22, 37, and 52 UTC and accepts manual
dispatches. It starts at upstream v0.7.0, lists published stable releases, pins
their GitHub release IDs and peeled commit SHAs, and considers them in version
order. GitHub can delay or drop scheduled runs. The next poll looks for the
entire backlog.

Each release gets one integration branch and one pull request. The branch is
built as a two-parent merge of the current base and the upstream tag. The poller
dispatches **CI** on its own trusted ref with the exact candidate SHA, base SHA,
and pull request. The quality job and all three platform jobs use that candidate
with read-only permissions and no persisted checkout credentials. The trusted
poller posts `werft/ci` only after it verifies the dispatched run and its jobs.
The separate **Werft feature CI status** reporter sets that context for ordinary
pull requests. A maintainer review at the current head is required for changes
to automation files. Rerun CI after that review to report the updated result.

The fork's default workflow permissions are read-only. GitHub combines the
switch for allowing Actions to create and approve pull requests. This repo uses
it for bot-created pull requests. The update workflows submit no approval
reviews and need only the built-in `GITHUB_TOKEN`.

The **Werft required CI and merge commits** ruleset applies to `werft`, with
merge commits, no force-push or bypass, and strict `werft/ci` from GitHub Actions
(app ID 15368). On initial setup, merge the delivery change, verify that the CI
reporter produces the context, then activate the staged ruleset and query the
effective branch rules before the first production replay. Both the ruleset and
workflow permissions can be managed through GitHub's API.

The poller rechecks the base and head before requesting a merge with the
expected head SHA. It verifies the merge parents before dispatching
`werft-release.yml` with `merge_sha` and `upstream_tag`. The journal records
`release workflow not present` if the merged commit has no such workflow.
Release dispatch can be retried if GitHub disconnects before returning a run ID;
the release workflow should deduplicate by merge SHA.

To turn off the update automation, disable **Werft upstream updates** on its
Actions page, or send `PUT /repos/X-noZ-air/learnharness/actions/workflows/werft-updates.yml/disable`.
Cancel an in-flight update run too when an immediate stop is required. The same
page, or the workflow's `enable` API endpoint, re-enables future polls.

## State and refusals

Read `state.json` from the `werft-updates/state/werft` branch. It records the
observed releases, the last accepted tag and merge, `last_successful_poll_at`,
the active candidate, the latest outcome, and `last_refusal`. The latter retains
the most recent refusal after a retry. Each refusal has a reason, upstream tag,
candidate commit (null before a candidate exists), step, timestamp, and run URL.
The Git history of the state branch retains prior outcomes.

| Reason | Meaning |
| --- | --- |
| `moved_tag`, `vanished_tag`, `vanished_release` | The recorded upstream identity changed or disappeared. |
| `non_descendant` | The release or the target branch lost required ancestry. |
| `merge_conflict` | Git could not build a clean candidate. |
| `automation_changed` | Upstream changed protected automation files. The record names the files. |
| `unknown_runtime_target` | The release introduced an unrecognized Node or platform requirement. |
| `red_checks`, `unexpected_check_run` | Required tests failed or the run could not be attributed to the exact candidate. |
| `earlier_release_found` | A lower stable tag appeared during CI. It is processed before the postponed candidate. |
| `base_moved` | The tested base advanced. The next poll can rebuild and retest the same pull request. |
| `missing_protection`, `operation_failed` | The branch rules or a Git/GitHub operation could not be verified. |

Use **Run workflow** on `werft` to run the poll immediately. An unchanged red
candidate stays stopped unless you select `retry_failed`, which dispatches new
checks on the same candidate and pull request. Repair conflicts or review
automation/runtime changes through the normal feature review process. Keep the
state branch as the source of the pinned upstream identities.

## Isolated replay

Create an expendable `werft-replay-*` base from a published stable tag and
apply an equivalent strict test ruleset to it. Select `werft` as the workflow
ref and supply `replay_base`, `replay_start`, and `replay_end`. The end tag
must be at or before v0.7.0. The historical v0.7.0 replay expects the reviewed
v0.7.0 versions of the two upstream workflow files and the plan-label smoke
script already on the test base.
Replay uses a separate state branch, posts checks in the fork, and skips release
dispatch. Re-run the same inputs to verify that no extra pull request is opened.
After recording results, close any outstanding test pull requests and remove
the temporary ruleset, test branches, and test state refs.
