<!-- SPDX-License-Identifier: Apache-2.0 -->
# plantworks pw job run

The Phase 0 runner: one job envelope on one Pi seat, with no OpenRig daemon and no broker.

```bash
PLANTWORKS_LLM_URL=http://127.0.0.1:11434/v1 \
PLANTWORKS_FRONTDOOR_CALLBACK=https://frontdoor.example.invalid/plantworks/events \
plantworks pw job run job.json --cwd ./workspace --pi /path/to/pi
```

1. Validates the envelope (`../contract/`). A bad envelope, an unknown class or a `timeoutSeconds`
   over the class ceiling is rejected (exit 2) before any event.
2. Emits `queued`, then `claimed`.
3. Starts the per-seat call governor (`../llm/`), writes the seat's `models.json` and
   `settings.json` pointing at it (`../seat/`), and starts Pi with
   `--mode rpc --no-session` and `PI_CODING_AGENT_DIR` set to the seat.
4. Emits `running`, sends the prompt, and waits for Pi's `agent_settled`.
5. Emits `done` (`outcome: succeeded`) or `failed`, then prints the result JSON
   (`jobId`, `state`, `detail`, `text`, `undelivered`). Exit 0 for `done`, 1 for `failed`.

| Failure | Reason |
|---|---|
| 3 consecutive model calls cut at the class deadline (the governor) | `call-deadline` |
| The job runs past `timeoutSeconds` (default: the class ceiling, 900 s for `quick` or 3600 s for `long`) | `timeout` |
| Pi reports a model error, rejects the prompt or exits early; setup fails after the claim | `error` |

A setup failure (for example `PLANTWORKS_LLM_URL` unset) moves `claimed -> failed` and never
reports `running`.

Events go to `--callback` or `$PLANTWORKS_FRONTDOOR_CALLBACK`, which is operator config. Delivery
runs alongside the job, so a slow consumer never holds the seat. Events the consumer never
acknowledged are listed in `undelivered`, and the caller owns re-sending them
(`../events/README.md`).

**Open question:** the `done` event carries no result. The text is only in the runner's
stdout, and artifacts are not collected yet. A result field in the event needs a contract
change (PW-09) and the front door's agreement.

Pi is `@earendil-works/pi-coding-agent`, pinned in the platform's `versions.json`. Tests use
a fake Pi (`fixtures/fake-pi.mjs`) and a stub OpenAI-compatible server. Set `PLANTWORKS_PI_BIN`
to run the same job through the real Pi.
