<!-- SPDX-License-Identifier: Apache-2.0 -->
# Team spec (plantworks/v1)

The one contract between the fork and the platform (ADR 0204, "Team spec contract"). The fork
reads a team definition and emits files. It knows nothing about Kubernetes or Pulumi: Hermes
profile registration belongs to harness-hg #991, and deployment to #993.

```
plantworks pw team emit team.json --out out/ [--platform platform.json]
plantworks pw team validate out/<team>/team.json [--platform platform.json]
```

`emit` validates first and writes nothing when the definition is invalid. Otherwise it writes:

| File | Read by |
|---|---|
| `<out>/<team>/team.json` | The team spec: the definition, plus `specVersion` and the derived `hermesProfile`. Schema: `../../schema/fleet.schema.json` |
| `<out>/<team>/hermes-profile/config.yaml` | A Hermes profile `config.yaml` in Hermes' own format, for #991 to register. It includes the `mcp_servers.plantworks` entry of the Hermes kit (`../hermes/README.md`) |
| `<out>/<team>/hermes-profile/skills/plantworks-bridge/SKILL.md` | The kit's bridge skill, copied as is |

- `spec.ts` holds the types, `buildSpec()`, `validateSpec()` and `hermesProfileConfig()`.
- `command.ts` holds `emitTeam()` and the CLI.
- `spec.test.ts` covers each validator rule. It also fails if the schema drifts from the validator.

## Shape

- **Train.** A train is one Hermes orchestrator cycle plus K worker seats, split across classes
  (`perTrain.workers`). `trains × perTrain.workers[class]` is that class's seat count.
- **`defaultClass`** names the class a job without a class runs in. The ADR sample marks it only
  in a comment, so it is a field here.
- **`approvalTtlSeconds`** is the TTL that rule 6 requires for `approval: always`. The ADR
  doesn't name the field.
- **`priority`** (optional, -100..100, default 0) is a class's base job priority. The broker adds
  the job's own `priority` offset (urgent -3, high -1, normal 0, low +2) and claim-next takes the
  lowest first. claim-next serves one class per call, so today the class base is stored in the
  effective priority but doesn't change claim order; only the job offsets do.
- **`hermesProfile`** is derived, never written by hand: `name` = `team`, and
  `kanban.max_in_progress_per_profile` = `trains × orchestrators`.

## Validator rules (ADR 0204)

| # | Rule | Where |
|---|---|---|
| 1 | The sum of class `slots` is at most the platform cap for `endpoint.slotBudgetKey`. A missing cap counts as 0 | `--platform` `slotCaps` |
| 2 | Every model is served | `--platform` `models` |
| 3 | Context is at most the platform maximum. Once the Pi baseline is measured (`piBaselineTokens`, plus `reserveTokens`), baseline + output + reserve must be below the context | `--platform` |
| 4 | Worker seats ≥ slots, per class | |
| 5 | Envelope values stay within the class ceilings: `timeoutSeconds` ≤ the class's (`timeout_over_ceiling`), `contextBudget` ≤ its `context.maxContextTokens` (`context_over_ceiling`). The envelope has no output-token field, so there is nothing to compare with `perCall.maxOutputTokens` | Enforced by the broker at submit, not here |
| 6 | `approval: always` has a TTL. Every spec names an `events.approvalConsumer` | |
| 7 | Names are DNS-safe and unique | |
| — | The `defaultClass` has at most a 16384-token context (ADR 0204: 16K is the default, 32K is opt-in by class) | |
| 8 | Every class sets `perCall`, within the ceilings: 60 s, and 1536 output tokens (≤16K) or 1024 (32K) | `../llm/classes.ts` |

Without `--platform`, the Phase 0–1 platform applies: `qwen3.5:9b` and a 32768-token maximum.
It grants no slot caps, and rule 1 counts a missing cap as 0, so **validation refuses any class
with `slots` > 0**. That is the opposite of unlimited: the emitter can't approve slots against
platform limits nobody stated, so a team that wants a slot needs a platform file that grants one.

**Validation caps and runtime caps are separate.** The platform file only decides whether a spec
is valid. How many jobs actually run at once is the broker's cap (PW-19): `PLANTWORKS_SLOT_CAP`
per `slotBudgetKey`. When that is unset, the Phase 0–1 default is **1 in flight** per key, never
unlimited. Nothing in this directory selects runtime concurrency.

## Hermes profile: what the file does and doesn't do

The value is checked against the pinned Hermes, `NousResearch/hermes-agent` v0.22.5
(harness-hg `versions.json`).

- **It is one integer.** `hermes_cli/kanban_ops.py:69` reads
  `_positive_int(cfg["kanban"]["max_in_progress_per_profile"], None)`, and
  `hermes_cli/kanban_db_dispatch.py:2368` types it `Optional[int]`. The ADR sample's map
  `{ social-media: 1 }` makes `int()` fail, which reads as **no cap**. So the spec carries an
  integer, and the validator rejects any other value.
- **It is home-wide.** Hermes reads the value from the config of the home that runs the kanban
  dispatcher, and applies it to every profile on that home. The emitted `config.yaml` states
  this team's intended cap. **It does not by itself enforce a cap on a shared Hermes home.**
- **Unresolved, for #991.** Where the value is applied on the shared Hermes, and how several
  teams' values combine (for example the minimum across teams), is platform integration that
  #991 must decide.
- **Broker caps are separate.** The broker's slot cap (PW-19, `PLANTWORKS_SLOT_CAP` per
  `slotBudgetKey`) doesn't depend on this setting.
- **Profile layout.** A Hermes profile is its own home: `profiles/<name>/` with `config.yaml`
  and directories such as `skills/` (`hermes_cli/profiles.py:35`). PW-24 adds its MCP server
  block and bridge skill to the emitted profile.

## Render (PW-20, `render.ts`)

The card names this verb `plantworks fleet render`; here it is `pw team render`, beside emit and
validate. A usage example:

```
plantworks pw team render --teams <dir> --out <fresh dir> --governor-url <url> [--platform <file>]
```

It loads every `<team>/team.json` under `--teams` with the broker's own loader, so it applies the
same validation and directory rules the broker starts with. For each team it writes:

- **`<out>/<team>/fleet.json`.** `{team, classes: {<class>: {workersMax, seats}}}`, where
  `workersMax` = `trains × perTrain.workers[class]`. Seats are named `<class>-NN@<team>`, starting
  at `01`.
- **Each seat's Pi files.** `models.json` and `settings.json` go to
  `<out>/<team>/state/pi/<seat>/agent`, written by PW-12's `writeSeatFiles` from the spec's class
  (`classFromSpec`) and pointed at `--governor-url`. That is the layout a worker writes under its
  home.

Output goes only to `--out`. A render refuses, before writing anything:
- an `--out` inside a live home: `$OPENRIG_HOME`, the directory of `$OPENRIG_DB`, `~/.openrig` or
  `~/.plantworks`;
- an existing `<out>/<team>`.

It never deletes or rewrites a file it did not create.

**Removing a team.** Delete its `<team>/` directory from the spec set. A re-render no longer
contains it. The broker reads specs only at start, so after a restart it answers the team's jobs
`400 unknown_team`. Deregistering the Hermes profile is #991's, outside the fork. The removed
team's existing jobs stay in the broker's file, and their events have no callback left, so the
emitter keeps retrying them. Cancel or finish the team's live jobs before removing it.

## Deliberately left out

- **Input is JSON only.** YAML is a superset of JSON, so `team.json` is also valid YAML for
  consumers. Add a YAML reader when people write definitions by hand.
- **Registration and removal.** Removing a spec deregisters the profile (#991).
