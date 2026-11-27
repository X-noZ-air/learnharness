# Maintenance of a single server process

A drain holds admission closed while work already accepted by this process finishes. Use it before a controlled stop of a server that exclusively owns its profile. Readiness applies only to this process and the generation in the response. An independent process with access to the same files is outside the contract.

## First switch from M1

Identify the old service, its data root and its auth directory from the service configuration. Include subscription credentials beside the auth file and any plugin data roots in the profile inventory. Make the first switch in one of these two situations:

* **Verified unused profile.** Verify from the service setup and access records that the profile has never been opened to learners, and inspect the configured paths for any sessions, jobs, settings or credentials from prior use. Keep learner access closed. Stop any M1 instance and verify that its processes and other profile writers have exited before starting the new server.
* **Controlled maintenance window.** Use this path for a used profile or if its history cannot be verified. Schedule a window, block new learner traffic, and have the learner confirm that active sessions, jobs and sign-ins have finished and queued input has appeared in the saved session. Stop the old service and verify that its process, its children and any other profile writers have exited. Take a consistent snapshot of the stopped profile before starting the new server.

The unchanged M1 process provides no atomic readiness check. In either case, keep learner access closed, start the new server with the startup hold, verify the expected profile configuration and confirm `startup-hold` with the socket's `status` command. Release that generation before reopening access. If the switch fails, stop the replacement and restore the compatible program/profile pair while access is still closed.

## Enable local control

Set `LH_MAINTENANCE_SOCKET` to an absolute Unix socket path in an existing directory owned by the service user with mode 0700. Use a private runtime directory outside the profile. The socket is mode 0600. Leave this variable unset for ordinary operation. The control protocol is local to the socket.

Choose a fresh path for each server process or have the service manager clean an obsolete runtime directory after verifying that its previous owner has exited. Startup fails if the socket cannot be bound. Setting `LH_MAINTENANCE_STARTUP_HOLD=1` requests closed admission from startup and requires a socket. Plugin activation, recovery and new model requests wait until release.

## Operator commands

The client uses the same environment variable or an explicit `--socket PATH`.

```sh
node scripts/maintenance.mjs status
node scripts/maintenance.mjs drain --timeout-ms 30000 --hold-ms 60000
node scripts/maintenance.mjs resume --generation "$DRAIN_GENERATION"
node scripts/maintenance.mjs release --generation "$STARTUP_GENERATION"
```

The client writes one JSON object on stdout. A successful `drain` can return

```json
{"version":1,"generation":"0ef24084-c188-4c38-b09e-d7fef5990abd","mode":"draining","counts":{},"reasons":[],"drained":true,"holdExpiresAtMs":1795795260000,"remainingHoldMs":59823}
```

The socket accepts one JSON line per connection and returns one JSON line. Operator operations are `status`, `drain`, `resume` and `release`. An initial `drain` requires an `attempt` with a unique `id` and a future `startByMs` Unix timestamp in milliseconds. A `drain` can specify `holdMs`. A generation changes on entry to and exit from a hold, and on process replacement. A startup hold accepts `status` and `release`. Release it before requesting a drain. Renewing an active drain, resuming a drain and releasing a startup hold each require the active hold's generation. Supplying a stale generation fails the command. Serialize operator actions for each profile.

* `drain` closes admission before returning its first status. The CLI waits for the same generation to report `drained: true`. Exit code 0 means the requested hold is ready. Exit code 2 returns the busy counts or a reason a guarantee is unavailable. Exit code 1 indicates a command or connection error.
* A drain hold has a deadline in the server. It lasts `holdMs` after the most recent `drain` command, 60000 by default and at most 600000. When the deadline passes, the server opens by itself, changes the generation and withdraws any readiness it reported. A caller that crashes or loses its session therefore cannot leave the service refusing writes. `status` does not renew a hold. While it waits, the CLI renews the hold with every poll. It discards a ready response that arrives after the requested hold could have expired. A transport timeout after confirmation also triggers a generation-bound release attempt and exit code 2.
* When the wait ends without readiness, because `--timeout-ms` elapsed or a reason is present, the CLI resumes its confirmed drain, prints the resulting status and exits with code 2. Maintenance is postponed and a running lesson or sign-in continues. The CLI sends its first drain with an `attempt` containing a random `id` and a `startByMs` Unix timestamp in milliseconds. If that reply times out, it sends `cancel-drain` with the same attempt ID. The server opens only the hold created by that attempt and rejects initial requests that arrive after their admission deadline. If the socket cannot confirm cancellation, the CLI reports that on stderr and the hold's server-side expiry remains in force.
* `release` opens a startup hold. `resume` opens a drain hold. Either invalidates the corresponding readiness result. An open server reports `drained: false` even when its counts are empty. A startup hold has no deadline and stays closed until it is released.
* A successful CLI drain reports `remainingHoldMs` when preparing the response and `holdExpiresAtMs` as a conservative Unix timestamp in milliseconds for the response's generation. Time spent receiving or processing the output consumes that budget. A plain `status` response supplies no deadline.
* Before stopping, require a successful CLI drain with a generation and a valid deadline, then confirm `draining` and `drained: true` with `status --generation "$DRAIN_GENERATION"` on the same socket. Immediately before issuing the stop, compare the current time on the same host with `holdExpiresAtMs` and require enough time for the process and its writers to exit. Abort the stop if the deadline has passed, the remaining time is insufficient, the clock is unreliable or the hold cannot be confirmed. Renew a still-held drain with its generation if more time is needed. Verify that the process and its writers exited before the deadline before using the profile. Manage the snapshot, format compatibility and rollback of the program/profile pair outside the application.

## What the counts cover

The keys are bounded work categories. Status omits session, plugin, provider and file identifiers. An upload or write request covers the route from admission through completion, including reading its request body. The server also counts main turns, side chats, jobs, delivery, compaction, extraction, plugin tasks and writes, sign-in, private subscription operations that may refresh credentials, and startup. Counts can overlap during handoff. A closed browser tab or an acknowledged HTTP request can leave an active owner behind.

New external work receives HTTP 503 with code `maintenance` and a user-facing error. Already admitted operations can finish their required writes and transfer responsibility to a child operation before releasing their own admission. Stops and cancellations can still reach running work. A dismissal of a live task is saved by its turn during settlement. A dismissal of an idle task, or cancellation of an orphaned job that requires a new write, waits until admission reopens. A pending sign-in can still be continued or canceled during a drain. New sign-ins wait for normal service. If a sign-in needs learner input, the wait times out and the server resumes.

`delivery` counts only a result that is being delivered. A finished background result that cannot continue until the learner acts holds no count: it waits behind an open question, a dismissed question, a failed automatic start or missing background consent. Its marker is already saved with the job in the profile. It stays there through a stop and is delivered after the restart, once the learner continues the session.

A probe-to-teacher handoff lives in memory until delivery. If its delivery pump is parked, the server reports `parked-probe-handoff` and postpones the switch.

A message the learner sent into a running lesson is kept only in memory until a lesson run saves it. If that run ended before it took the message, for example at a question or when the learner stopped it, the server reports the reason `parked-learner-steer` and `drained: false`. Stopping now would lose the accepted message, so an unattended switch is postponed. The reason clears when the learner's next run in that session saves the message.

Loading a community backend makes the process report `unknown-plugin-lifecycle`. Arbitrary backend code can retain a timer or writer after deactivation. Disabling that package cannot establish quiescence for the current process. Audited bundled backends register detached writes through the host's `trackWork` callback. A change that adds a backend writer or a new mutation route must cover its admission and its last write.

## Stop and cancellation controls

| Route | Actions checked during drain |
| --- | --- |
| `POST /api/activity/abort` | Stop work of kind `turn`, `plugin-worker`, `job` or `extraction`. Cancelling an orphaned job waits for admission before writing. |
| `POST /api/chats/[id]/side-chats/[threadId]/stop` | Stop the current side answer. Its owner saves the partial response. |
| `POST /api/chats/[id]/dismiss` | Dismiss a native question, a practice problem or a plugin question. A running practice dismissal must identify the viewed turn. An idle dismissal waits for admission before saving. |
| `POST /api/subscriptions` and `/api/subscriptions/browser` | Cancel an existing ChatGPT, Copilot or xAI sign-in. Bound browser and prompt continuations can complete that sign-in. Account, credential and background-consent changes require normal admission. |
| `POST /api/plugins/[id]/call` | Core Flashcards `cancel-generation` can continue under the targeted batch's owner. If no owner can cover the write, the request waits for admission. The other bundled backend operations require normal admission. |
| `PUT /api/plugins/[id]`, `POST /api/plugins`, `DELETE /api/chats/[id]` and `PATCH /api/chats/[id]/side-chats/[threadId]` | Plugin enablement and refresh, chat deletion, and side-chat view state change configuration or records. They use normal admission. |

On POSIX, run `node scripts/smoke-maintenance.mjs` in a development checkout to exercise the socket, delayed local model, real HTTP routes and restart with a disposable profile.
With Chrome installed, run `node scripts/smoke-maintenance-dismissals.mjs` to exercise the chat confirmation dialog during maintenance against live streamed turns.
