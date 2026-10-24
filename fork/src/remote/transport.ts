// SPDX-License-Identifier: Apache-2.0
// The wire between the router (daemon side) and a seat agent (the host that runs the seats).
// Only the in-process fake ships: there is no real transport, listener or auth (PW-32 non-goal).

/** One tmux command for the agent: argv[0] is "tmux". `stdin` carries what upstream staged in a local temp file. */
export type SeatRequest = { argv: string[]; stdin?: string };
/** tmux's own exit code and output, unmodified. */
export type SeatResponse = { code: number; stdout: string; stderr: string };
/** Resolves with tmux's answer, whatever its exit code. Rejects only when the agent could not be reached. */
export type SeatTransport = (req: SeatRequest) => Promise<SeatResponse>;

/** The test fake: calls an agent in this process, copying the request as a wire would. */
export function inProcessTransport(agent: { handle(req: SeatRequest): Promise<SeatResponse> }): SeatTransport {
  return (req) => agent.handle(structuredClone(req));
}
