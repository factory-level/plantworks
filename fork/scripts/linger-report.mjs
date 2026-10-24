// SPDX-License-Identifier: Apache-2.0
// CI-only diagnostic, loaded into every test process by `npm test` (--import). A no-op unless
// LINGER_REPORT_DIR is set. Then, if this process is still alive LINGER_REPORT_AFTER_MS (default
// 120 s) after it started, it writes what is keeping it alive to <dir>/<pid>.json: the handle
// types, sockets and servers with their ports, child processes with pid and arguments, timers with
// their delay. Fork CI's watchdog prints these files when the suite runs too long, so a test file
// that outlives its tests names the handle. The timer is unref'd, so it never keeps anything alive
// itself. Fork CI logs are public, so nothing secret-shaped is recorded: no environment, a command
// line as its program's basename, its argument count and only the basenames of the script files it
// runs, sockets and servers as address and port only.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/** A command line, reduced: no flags, values, URLs or paths, only which scripts it runs. */
export const redactArgs = (args) => {
  const list = Array.isArray(args) ? args.map(String) : [];
  return { program: list.length ? basename(list[0]) : null, argc: list.length, scripts: list.slice(1).filter((a) => /\.(m?[jt]s|cjs)$/.test(a) && !/[:=@]/.test(a)).map((a) => basename(a)) };
};

const dir = process.env.LINGER_REPORT_DIR;
if (dir) {
  const after = Number(process.env.LINGER_REPORT_AFTER_MS) || 120_000;
  const describe = (h) => {
    const type = h?.constructor?.name ?? typeof h;
    if (type === "Server") { const a = h.address?.(); return { type, address: a && typeof a === "object" ? `${a.address}:${a.port}` : null }; }
    if (type === "Socket") return { type, local: h.localPort ? `${h.localAddress}:${h.localPort}` : null, remote: h.remotePort ? `${h.remoteAddress}:${h.remotePort}` : null, stdio: h._handle?.fd === 1 ? "stdout" : h._handle?.fd === 2 ? "stderr" : undefined };
    if (type === "ChildProcess") return { type, pid: h.pid, command: redactArgs(h.spawnargs), exitCode: h.exitCode, signal: h.signalCode };
    if (type === "Timeout") return { type, ms: h._idleTimeout, callback: String(h._onTimeout).replace(/\s+/g, " ").slice(0, 120) };
    return { type };
  };
  setTimeout(() => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${process.pid}.json`), `${JSON.stringify({
        pid: process.pid, ppid: process.ppid, command: redactArgs(process.argv), aliveMs: Math.round(process.uptime() * 1000),
        resources: process.getActiveResourcesInfo(),
        handles: process._getActiveHandles().map(describe),
        requests: process._getActiveRequests().map((r) => r?.constructor?.name ?? typeof r),
      }, null, 1)}\n`);
    } catch { /* a diagnostic never fails the process it watches */ }
  }, after).unref();
}
