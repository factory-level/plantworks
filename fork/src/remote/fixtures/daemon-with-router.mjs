// SPDX-License-Identifier: Apache-2.0
// Test fixture: the unmodified upstream daemon, started through the PW-31 seam with the PW-32 router
// injected. "Local" tmux is a private socket; the one remote seat's agent drives a second private
// socket in this process. The agent is unreachable while the file <home>/agent-down exists.
// argv: <port> <local socket> <remote socket> <remote session>
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execArgvCommand, execCommand } from "../../../../packages/daemon/dist/adapters/tmux-exec.js";
import { createSeatRouter } from "../router.ts";
import { createSeatAgent, runTmux } from "../seat-agent.ts";
import { inProcessTransport } from "../transport.ts";

const [port, localSocket, remoteSocket, session] = process.argv.slice(2);
const onSocket = (socket, argv) => (argv[0] === "tmux" ? ["tmux", "-L", socket, ...argv.slice(1)] : argv);
const agent = createSeatAgent({ prefix: "rs-", run: (argv, stdin) => runTmux(onSocket(remoteSocket, argv), stdin) });
const wire = inProcessTransport(agent);
const transport = (req) => (existsSync(join(process.env.OPENRIG_HOME, "agent-down")) ? Promise.reject(new Error("agent down")) : wire(req));
const router = createSeatRouter({
  routes: new Map([[session, transport]]),
  local: {
    argv: (argv) => execArgvCommand(onSocket(localSocket, argv)),
    shell: (cmd) => execCommand(cmd.startsWith("tmux ") ? `tmux -L ${localSocket} ${cmd.slice(5)}` : cmd),
  },
});
const { startServer } = await import("../../../../packages/daemon/dist/index.js");
await startServer(Number(port), { argvExec: router.argvExec, tmuxExec: router.tmuxExec });
console.log("ready");
