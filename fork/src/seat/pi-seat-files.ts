// SPDX-License-Identifier: Apache-2.0
// Writes a Pi seat's models.json and settings.json for one worker class, before the seat launches.
// Pi reads them from PI_CODING_AGENT_DIR = $OPENRIG_HOME/state/pi/<session>/agent. Upstream setup
// only knows claude/codex, so the fork renders these files instead of editing upstream setup.
// The class caps are enforced on the Pi side through contextWindow/maxTokens, and on the wire by
// the PW-11 governor, which is the only baseUrl Pi sees. No key is written: the governor adds it.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classByName, type WorkerClass } from "../llm/classes.ts";

export const PROVIDER = "plantworks";
/** Pi needs some apiKey for an openai-completions provider; the governor replaces it with the real one. */
export const PLACEHOLDER_KEY = "governor-supplied";

/** `workerClass` is the class's limits, for example a team spec class (classFromSpec); without it, the built-in class of that name. */
export type SeatFilesInput = { openrigHome: string; session: string; className: string; governorUrl: string; workerClass?: WorkerClass; toolProfile?: ToolProfile };

/**
 * PW-12 tool profiles. `default` is Pi's own toolset and system prompt. `trimmed` (opt-in per class)
 * starts Pi with fewer tools and the short SYSTEM.md below, which Pi 1.4.0 reads from the agent
 * directory when no trusted project `.pi/SYSTEM.md` exists (dist/core/resource-loader.js:944-954).
 */
export type ToolProfile = "default" | "trimmed";
export const TRIMMED_TOOLS = ["read", "edit", "bash"];
/** The fork's generated SYSTEM.md. A file with exactly this content is the fork's; any other content is not. */
export const TRIMMED_SYSTEM_MD = `<!-- Written by Plantworks for the trimmed tool profile. Re-rendering the seat replaces or removes this exact file. -->
You are a coding agent working on one task in this repository. Use the read, edit and bash tools.
Keep changes to what the task asks. Check your work by running the relevant commands before you finish.
Answer with a short summary of what you changed and how you checked it.
`;

/**
 * Pi compaction for small windows (PW-12): Pi's defaults (reserve 16384, keep 20000) are sized for
 * large windows. The Phase 0-1 values are 4096/6144 at 16K and 8192/12288 at 32K, that is a quarter
 * and three eighths of the window; other class windows get the same ratio. [EST, tuned from the baseline]
 */
export function compactionFor(maxContextTokens: number) {
  return { reserveTokens: Math.floor(maxContextTokens / 4), keepRecentTokens: Math.floor((maxContextTokens * 3) / 8) };
}

export function seatAgentDir(openrigHome: string, session: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(session) || session.includes("..")) throw new Error(`unsafe session name: ${JSON.stringify(session)}`);
  return join(openrigHome, "state", "pi", session, "agent");
}

export function renderSeatFiles({ className, governorUrl, workerClass, toolProfile = "default" }: Pick<SeatFilesInput, "className" | "governorUrl" | "workerClass" | "toolProfile">) {
  const c = workerClass ?? classByName(className);
  const modelsJson = {
    providers: {
      [PROVIDER]: {
        baseUrl: governorUrl,
        api: "openai-completions",
        apiKey: PLACEHOLDER_KEY,
        models: [{ id: c.model, name: `${c.model} (${className})`, reasoning: false, input: ["text"], contextWindow: c.maxContextTokens, maxTokens: c.maxOutputTokens }],
      },
    },
  };
  const settingsJson = {
    defaultProvider: PROVIDER, defaultModel: c.model, defaultThinkingLevel: "off", compaction: compactionFor(c.maxContextTokens),
    ...(toolProfile === "trimmed" ? { defaultTools: TRIMMED_TOOLS } : {}),
  };
  return { "models.json": modelsJson, "settings.json": settingsJson };
}

/**
 * Writes both files (each atomically) and returns the directory to export as PI_CODING_AGENT_DIR.
 * The agent dir's SYSTEM.md is written for `trimmed` and removed for `default`, but only when it is
 * absent or exactly the fork's own file: anything else there is someone else's, so nothing is
 * written and this throws.
 */
export function writeSeatFiles(input: SeatFilesInput): string {
  const dir = seatAgentDir(input.openrigHome, input.session);
  mkdirSync(dir, { recursive: true });
  const files = renderSeatFiles(input);
  const systemMd = join(dir, "SYSTEM.md");
  let existing: string | null = null;
  try { existing = readFileSync(systemMd, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (existing !== null && existing !== TRIMMED_SYSTEM_MD) throw new Error(`${systemMd} was not written by Plantworks; refusing to replace or remove it, so the seat was not rendered. Move it away to let Plantworks manage this seat's system prompt`);
  const write = (name: string, text: string) => {
    const tmp = join(dir, `.${name}.${process.pid}.tmp`);
    writeFileSync(tmp, text);
    renameSync(tmp, join(dir, name));
  };
  for (const [name, content] of Object.entries(files)) write(name, `${JSON.stringify(content, null, 2)}\n`);
  if ((input.toolProfile ?? "default") === "trimmed") write("SYSTEM.md", TRIMMED_SYSTEM_MD);
  else if (existing !== null) unlinkSync(systemMd);
  return dir;
}
