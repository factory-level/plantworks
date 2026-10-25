// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyHomeDefaults } from "./boot.ts";

test("explicit isolation drops dangling file and directory links to outside write paths", () => {
  const root = mkdtempSync(join(tmpdir(), "pw-dangling-"));
  const home = join(root, "pw"), other = join(root, "other");
  mkdirSync(home); mkdirSync(other);
  try {
    symlinkSync("../other/absent.sqlite", join(home, "db-link"));
    symlinkSync("../other/absent-dir", join(home, "dir-link"));
    symlinkSync("db-link", join(home, "chain"));
    for (const key of ["OPENRIG_DB", "RIGGED_DB", "OPENRIG_TRANSCRIPTS_PATH", "RIGGED_TRANSCRIPTS_PATH",
      "OPENRIG_SHARED_DOCS_ROOT", "OPENRIG_SLICES_ROOT", "OPENRIG_DOGFOOD_EVIDENCE_ROOT"]) {
      for (const path of [join(home, "db-link"), join(home, "chain"), join(home, "dir-link", "new.sqlite")]) {
        const env: Record<string, string | undefined> = { PLANTWORKS_HOME: home, [key]: path };
        assert.deepEqual(applyHomeDefaults(env), [key], `${key}: ${path}`);
        assert.equal(env[key], undefined);
      }
    }
    assert.deepEqual(readdirSync(other), [], "containment checks must not create the external targets");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("explicit isolation preserves deliberate paths inside home, including dangling internal links", () => {
  const home = mkdtempSync(join(tmpdir(), "pw-internal-"));
  try {
    symlinkSync("not-created.sqlite", join(home, "internal-link"));
    for (const path of [join(home, "internal-link"), join(home, "new", "db.sqlite"), join(home, "..cache", "db.sqlite")]) {
      const env = { PLANTWORKS_HOME: home, OPENRIG_DB: path };
      assert.deepEqual(applyHomeDefaults(env), [], path);
      assert.equal(env.OPENRIG_DB, path);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("unresolvable write paths fail closed rather than being treated as missing files", () => {
  const home = mkdtempSync(join(tmpdir(), "pw-unresolved-"));
  try {
    symlinkSync("cycle-b", join(home, "cycle-a"));
    symlinkSync("cycle-a", join(home, "cycle-b"));
    writeFileSync(join(home, "regular-file"), "sentinel");
    for (const path of [join(home, "cycle-a"), join(home, "regular-file", "db.sqlite")]) {
      assert.throws(() => applyHomeDefaults({ PLANTWORKS_HOME: home, OPENRIG_DB: path }));
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("symlinks are resolved before parent traversal, for existing and missing targets", () => {
  const root = mkdtempSync(join(tmpdir(), "pw-link-parent-"));
  const home = join(root, "pw"), other = join(root, "other");
  mkdirSync(home); mkdirSync(join(other, "child"), { recursive: true });
  try {
    symlinkSync(join(other, "child"), join(home, "link"));
    writeFileSync(join(other, "existing.sqlite"), "sentinel");
    for (const filename of ["existing.sqlite", "missing.sqlite"]) {
      // Do not use path.join: lexical normalization would erase the symlink before checking it.
      const path = `${home}/link/../${filename}`;
      assert.deepEqual(applyHomeDefaults({ PLANTWORKS_HOME: home, OPENRIG_DB: path }), ["OPENRIG_DB"]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
