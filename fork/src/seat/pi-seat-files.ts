// SPDX-License-Identifier: Apache-2.0
// Writes a Pi seat's models.json and settings.json for one worker class, before the seat launches.
// Pi reads them from PI_CODING_AGENT_DIR = $OPENRIG_HOME/state/pi/<session>/agent. Upstream setup
// only knows claude/codex, so the fork renders these files instead of editing upstream setup.
// The class caps are enforced on the Pi side through contextWindow/maxTokens, and on the wire by
// the PW-11 governor, which is the only baseUrl Pi sees. No key is written: the governor adds it.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classByName, type WorkerClass } from "../llm/classes.ts";

export const PROVIDER = "plantworks";
/** Pi needs some apiKey for an openai-completions provider; the governor replaces it with the real one. */
export const PLACEHOLDER_KEY = "governor-supplied";

/** `workerClass` is the class's limits, for example a team spec class (classFromSpec); without it, the built-in class of that name. */
export type SeatFilesInput = { openrigHome: string; session: string; className: string; governorUrl: string; workerClass?: WorkerClass };

export function seatAgentDir(openrigHome: string, session: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(session) || session.includes("..")) throw new Error(`unsafe session name: ${JSON.stringify(session)}`);
  return join(openrigHome, "state", "pi", session, "agent");
}

export function renderSeatFiles({ className, governorUrl, workerClass }: Pick<SeatFilesInput, "className" | "governorUrl" | "workerClass">) {
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
  const settingsJson = { defaultProvider: PROVIDER, defaultModel: c.model, defaultThinkingLevel: "off" };
  return { "models.json": modelsJson, "settings.json": settingsJson };
}

/** Writes both files (each atomically) and returns the directory to export as PI_CODING_AGENT_DIR. */
export function writeSeatFiles(input: SeatFilesInput): string {
  const dir = seatAgentDir(input.openrigHome, input.session);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(renderSeatFiles(input))) {
    const tmp = join(dir, `.${name}.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`);
    renameSync(tmp, join(dir, name));
  }
  return dir;
}
