# Maintenance of a single server process

A drain holds admission closed while work already accepted by this process finishes. Use it before a controlled stop of a server that exclusively owns its profile. Readiness applies only to this process and the generation in the response. An independent process with access to the same files is outside the contract.

## Enable local control

Set `LH_MAINTENANCE_SOCKET` to an absolute Unix socket path in an existing directory owned by the service user with mode 0700. Use a private runtime directory outside the profile. The socket is mode 0600. Leave this variable unset for ordinary operation. The control protocol is local to the socket.

Choose a fresh path for each server process or have the service manager clean an obsolete runtime directory after verifying that its previous owner has exited. Startup fails if the socket cannot be bound. Setting `LH_MAINTENANCE_STARTUP_HOLD=1` requests closed admission from startup and requires a socket. Plugin activation, recovery and new model requests wait until release.

## Operator commands

The client uses the same environment variable or an explicit `--socket PATH`.

```sh
node scripts/maintenance.mjs status
node scripts/maintenance.mjs drain --timeout-ms 30000
node scripts/maintenance.mjs resume --generation "$DRAIN_GENERATION"
node scripts/maintenance.mjs release --generation "$STARTUP_GENERATION"
```

The client writes one JSON object on stdout. An idle, held server can return

```json
{"version":1,"generation":"0ef24084-c188-4c38-b09e-d7fef5990abd","mode":"draining","counts":{},"reasons":[],"drained":true}
```

The socket accepts one JSON line per connection with an `op` and an optional `generation`, and returns one JSON line. The supported operations are `status`, `drain`, `resume` and `release`. A generation changes on entry to and exit from a hold, and on process replacement. Repeating a drain during a hold observes its current generation. Supplying a stale generation fails the command. Serialize operator actions for each profile.

* `drain` closes admission before returning its first status. The CLI waits for the same generation to report `drained: true`. Exit code 0 means the requested hold is ready. Exit code 2 returns the busy counts or a reason a guarantee is unavailable. Exit code 1 indicates a command or connection error.
* A timeout leaves the hold in place. Read the current status and use `resume` with the matching generation to postpone maintenance. A running lesson or sign-in continues.
* `release` opens a startup hold. `resume` opens a drain hold. Either invalidates the corresponding readiness result. An open server reports `drained: false` even when its counts are empty.
* For a switch, retain the hold, stop the process, and verify that it and its writers have exited before using the profile. Manage the snapshot, format compatibility and rollback of the program/profile pair outside the application.

## What the counts cover

The keys are bounded work categories. Status omits session, plugin, provider and file identifiers. An upload or write request covers the route from admission through completion, including reading its request body. The server also counts main turns, side chats, jobs, delivery, compaction, extraction, plugin tasks and writes, sign-in, private subscription operations that may refresh credentials, and startup. Counts can overlap during handoff. A closed browser tab or an acknowledged HTTP request can leave an active owner behind.

A new external mutation receives HTTP 503 with code `maintenance` and a user-facing error. Already admitted operations can finish their required writes and transfer responsibility to a child operation before releasing their own admission. A valid continuation of a pending sign-in remains usable during a drain. New sign-ins wait for normal service. If a delivery or sign-in needs learner input, an operator can time out and resume.

Loading a community backend makes the process report `unknown-plugin-lifecycle`. Arbitrary backend code can retain a timer or writer after deactivation. Disabling that package cannot establish quiescence for the current process. Audited bundled backends register detached writes through the host's `trackWork` callback. A change that adds a backend writer or a new mutation route must cover its admission and its last write.

On POSIX, run `node scripts/smoke-maintenance.mjs` in a development checkout to exercise the socket, delayed local model, real HTTP routes and restart with a disposable profile.
