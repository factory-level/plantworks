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
| `<out>/<team>/hermes-profile/config.yaml` | A Hermes profile `config.yaml` in Hermes' own format, for #991 to register |

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
- **`hermesProfile`** is derived, never written by hand: `name` = `team`, and
  `kanban.max_in_progress_per_profile` = `trains × orchestrators`.

## Validator rules (ADR 0204)

| # | Rule | Where |
|---|---|---|
| 1 | The sum of class `slots` is at most the platform cap for `endpoint.slotBudgetKey`. A missing cap counts as 0 | `--platform` `slotCaps` |
| 2 | Every model is served | `--platform` `models` |
| 3 | Context is at most the platform maximum. Once the Pi baseline is measured (`piBaselineTokens`, plus `reserveTokens`), baseline + output + reserve must be below the context | `--platform` |
| 4 | Worker seats ≥ slots, per class | |
| 5 | Envelope values stay within the class ceilings | Enforced by the broker at submit, not here |
| 6 | `approval: always` has a TTL. Every spec names an `events.approvalConsumer` | |
| 7 | Names are DNS-safe and unique | |
| 8 | Every class sets `perCall`, within the ceilings: 60 s, and 1536 output tokens (≤16K) or 1024 (32K) | `../llm/classes.ts` |

Without `--platform`, the Phase 0–1 platform applies: `qwen3.5:9b`, a 32768-token maximum and
**no slot caps**. So any team that wants a slot needs a platform file that grants one.

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

## Deliberately left out

- **Input is JSON only.** YAML is a superset of JSON, so `team.json` is also valid YAML for
  consumers. Add a YAML reader when people write definitions by hand.
- **Registration and removal.** Removing a spec deregisters the profile (#991).
