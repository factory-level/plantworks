<!-- SPDX-License-Identifier: Apache-2.0 -->
# plantworks pw job run

The Phase 0 runner: one job envelope on one Pi seat, with no OpenRig daemon and no broker.

```bash
PLANTWORKS_LLM_URL=http://127.0.0.1:11434/v1 \
PLANTWORKS_FRONTDOOR_CALLBACK=https://frontdoor.example.invalid/plantworks/events \
plantworks pw job run job.json --cwd ./workspace --pi /path/to/pi
```

1. Validates the envelope (`../contract/`). A bad envelope, an unknown class or a `timeoutSeconds`
   over the class ceiling is rejected (exit 2) before any event. So is a working directory that
   ships `.pi/SYSTEM.md` or `.pi/APPEND_SYSTEM.md`: Pi 1.4.0 prefers a trusted project's prompt
   files over the seat's own.
2. Emits `queued`, then `claimed`.
3. Starts the per-seat call governor (`../llm/`), writes the seat's `models.json` and
   `settings.json` pointing at it (`../seat/`), and starts Pi with
   `--mode rpc --no-session` and `PI_CODING_AGENT_DIR` set to the seat.
4. Emits `running`, sends the prompt, and waits for Pi's `agent_settled`.
5. Emits `done` (`outcome: succeeded`) or `failed`, then prints the result JSON
   (`jobId`, `state`, `detail`, `text`, `undelivered`). Exit 0 for `done`, 1 for `failed`, 2 for a
   rejected job, 3 for a runner error.

| Failure | Reason |
|---|---|
| 3 consecutive model calls cut at the class deadline (the governor) | `call-deadline` |
| The job runs past `timeoutSeconds` (default: the class ceiling, 900 s for `quick` or 3600 s for `long`) | `timeout` |
| Pi reports a model error, rejects the prompt or exits early; setup fails after the claim | `error` |
| The runner gets Ctrl-C or SIGTERM. Pi is stopped first (below), and `failed` is reported only once its process has exited | `interrupted` |

A setup failure, or a Pi that cannot start, moves `claimed -> failed` and never reports
`running`.
An interrupt before Pi runs does the same. A second Ctrl-C/SIGTERM gets the default action, so a
stop that hangs can still be killed; a runner killed with SIGKILL reports nothing. No branch is
created, so there is none to leave intact.

**One job at a time on the host (D14).** `pw job run` holds one lock per host while a job runs,
whatever home it uses. It is **per uid, not cross-user**: two users on one host each get their own.
The path is chosen in this order, and the refusal messages say which applied:
1. `PLANTWORKS_JOB_LOCK`, when set;
2. `$XDG_RUNTIME_DIR/plantworks/job.lock`, when `XDG_RUNTIME_DIR` is set and absolute;
3. `/tmp/plantworks-<uid>/job.lock`.

For 2 and 3 the directory is created mode 700, then checked without following symlinks. It must be a
real directory owned by this user with no group or world write. Every directory above it must be
owned by this user or root (or the kernel's overflow uid, normally 65534, which a user namespace
shows for an owner outside it, such as the host's root), and not group- or world-writable unless
sticky (as `/tmp` is), so nobody else can rename the lock directory away. The parent is resolved once
(`realpath`), and the checks, the directory and the lock all use that resolved path, so a symlink on
the way is never followed again after it was checked. Otherwise the job is refused, since another user could hold
or swap the lock. (`runJob()`, the library, takes an explicit `lockPath`;
without one it uses `<home>/plantworks/job.lock`.)

The lock is created exclusively, recording the runner's and Pi's PIDs. A second `pw job run` while
it is held is rejected (exit 2) before any event. Fail-closed:
- the lock is released when the run ends, and only if it is still this run's;
- it is stale, and replaced, only when the runner and the Pi it records are both gone, so a Pi left
  running by a killed runner still holds it. The lock says `starting` just before Pi is spawned and
  names its PID right after, so a runner that dies in between leaves a lock that is refused, not
  taken over (see below for how to clear it);
- a lock file that can't be read as one is refused and never removed.

To clear a lock the runner refuses (a runner died while starting Pi, or the file is unreadable), as
the refusal message also says:
1. Check that no runner Pi is left: `pgrep -af -- '--mode rpc --no-session'` prints nothing, or only
   Pis you can account for. Stop any stray one.
2. Delete the lock file the refusal names, exactly that path (the message also says how it was
   chosen). Don't rebuild the path by hand.

A PID can be reused, so a stale lock whose PIDs now belong to other processes is refused until it
is removed.

**Pi's environment** is an allow-list: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`,
`LC_*`, `TERM`, `TMPDIR`, `TZ`, Pi's own `PI_*`, and the seat's `PI_CODING_AGENT_DIR`, with
`PI_OFFLINE=1` and `PI_TELEMETRY=0` set. The endpoint URL, its key and the callback are never
passed, so a command the model runs cannot go around the governor.

**Stopping Pi** (at the end, or on a timeout or `call-deadline`):
1. Send Pi's RPC `abort`, which kills its tool processes.
2. Close Pi's stdin.
3. Send SIGTERM, then SIGKILL.

A Pi that has to be SIGKILLed cannot clean up its tool processes. In-cluster, the worker pod's
boundary does that.

Events go to `--callback` or `$PLANTWORKS_FRONTDOOR_CALLBACK`, which is operator config. Delivery
runs alongside the job, so a slow consumer never holds the seat. Events the consumer never
acknowledged are listed in `undelivered`, and the caller owns re-sending them
(`../events/README.md`).

**Results (Phase 0 scope):** the job's result is the runner's own return. The caller reads the
result JSON on stdout, or the value `runJob()` returns. State events carry only the state and
its detail (the settled PW-09/PW-10 contract), so **the callback alone is not a result channel**.
This fits Phase 0, where a script stands in for the front door. Storing and retrieving results
and artifacts for the broker and front door is a follow-up. It is needed before the full ADR 0204
flow ("result + artifacts" back to the front door) can be said to work.

Pi is `@earendil-works/pi-coding-agent`, pinned in the platform's `versions.json`. Tests use
a fake Pi (`fixtures/fake-pi.mjs`) and a stub OpenAI-compatible server. Set `PLANTWORKS_PI_BIN`
to run the same job through the real Pi.
