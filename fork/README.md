<!-- SPDX-License-Identifier: Apache-2.0 -->
# fork/

Everything this fork owns lives here. Upstream OpenRig's root workspaces, lockfile, vitest
projects and `docs/` guard never look inside `fork/`, so upstream merges stay clean. The root
`package.json` and `package-lock.json` stay byte-identical to upstream.

The directory name is brand-neutral on purpose: renaming the product changes no paths.

## Layout

| Path | Holds |
|---|---|
| `NOTICE` | Attribution for the fork and for upstream OpenRig |
| `UPSTREAM.md` | Branches, remotes and how upstream changes come in |
| `package.json` | The fork's own package. Its lockfile, once it has dependencies, is `fork/package-lock.json` |
| `scripts/` | Fork tooling: upstream sync, header and seam checks |
| `src/<area>/` | Fork code, one directory per area (for example `src/contract/`) |
| `schema/` | JSON Schemas the fork publishes (for example `fleet.schema.json`) |

Directories appear when their first file lands; empty ones are not committed.

## Conventions

- **Licence headers.** Every new file under `fork/` starts with
  `SPDX-License-Identifier: Apache-2.0` in its first five lines, in that file type's comment
  syntax. JSON files and `NOTICE` are exempt. Check with `npm run check:headers` (from `fork/`).
- **Code.** TypeScript runs directly on Node's built-in type stripping (Node 22.18 or later), so
  use only erasable syntax: no `enum`, no `namespace`, and `import type` for type-only imports.
- **Tests.** `*.test.ts` or `*.test.mjs` next to the code, run with `npm test` (`node --test`)
  from `fork/`. Tests never reach shared inference. Use a local stub server.
