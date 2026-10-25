<!-- SPDX-License-Identifier: Apache-2.0 -->
# Router compatibility (PW-28)

Phase 2 points `PLANTWORKS_LLM_URL` at a router in front of one vLLM per GPU. The two candidates are the
[vLLM production-stack](https://github.com/vllm-project/production-stack) router and the
[LiteLLM](https://docs.litellm.ai/) proxy. This page records how the fork's endpoint contract behaves
behind each. The router choice belongs to HarnessHG.

**Scope: stub level only.** The results below come from stand-ins on 127.0.0.1
(`fork/src/llm/fixtures/routers.ts`), exercised by `fork/src/llm/router-compat.test.ts`. Each stand-in
models only behaviour read from that router's source, at these commits:
- vLLM router: `production-stack@cd5c5fc2`, `src/vllm_router/`
- LiteLLM: `litellm@de5dc5b2`

These are recent main-branch commits, not releases, so recheck against the deployed version. **No real router, vLLM or inference was run.** The in-cluster run is
gated (factory-server; the PW-28 proof item): run `plantworks pw llm preflight --teams` and one Pi streaming,
tool-call job through each router, then record the results here.

## Results

| Fork behaviour | vLLM production-stack router | LiteLLM proxy |
|---|---|---|
| Preflight (`GET /models`) | Pass. Lists the backends' models, deduplicated (`main_router.py:134-181`). No router auth found (unverified) | Pass, with `PLANTWORKS_LLM_API_KEY` set to the proxy's master or virtual key. Without it: `GET /models returned 401` |
| Unknown model | `404`, `{"error": "Model 'x' not found…"}`, a plain string (`request.py:503-588`) | `400`, "Invalid model name passed in model=x" (`route_llm_request.py:218-226`) |
| Backend `503` (queue full) | Passed through unchanged; the router doesn't retry HTTP statuses (`request.py:336-342, 641-703`). The governor waits it out, not counted as an attempt. **Pass** | Retried by the proxy, `num_retries` 2 by default (`router.py:1512-1517, 9139-9200`). The governor sees a `200` when a retry succeeds. **Pass** |
| Backend busy for longer | Each `503` reaches the governor, which keeps waiting. **Pass** | After its retries, the proxy cools the deployment down and answers `429` "No deployments available" with `retry-after` (`types/router.py:909, 1145-1146`; medium confidence). **Finding 1** |
| D13 deadline rule | No router timeout (`request.py:334`): the governor cuts the call at the class deadline, and three in a row fail the job with `call-deadline`. **Pass** | The router timeout defaults to 6000 s (`constants.py:654-663`), far above any class deadline, so the governor cuts first. **Pass** |
| Priority (`PLANTWORKS_LLM_PRIORITY=1`) | The body is forwarded unchanged, so `priority` reaches vLLM `--scheduling-policy priority` (`request.py:330-335`). **Pass** | The proxy consumes `priority` and strips it (`router.py:5278-5290`), so vLLM never sees it. **Finding 2** |
| LiteLLM priority queue | n/a: the router has no queue | Requests wait only while no deployment is healthy, until the router timeout, then `408` (`scheduler.py:58-108`, `exceptions.py:379`). **Finding 3** |
| Streaming and usage | Bytes relayed unparsed (`request.py:344-353`). The governor counts usage. **Pass** | Re-chunked SSE that honours `include_usage` (`streaming_handler.py:547, 1935`); the stub relays it as is. **Pass** at stub level |
| Tool calls | Unchanged. **Pass** | For `hosted_vllm`, `additionalProperties` and `strict` are stripped from tool schemas (`llms/hosted_vllm/chat/transformation.py:89-96`). Not modelled; needs the real run |
| Request cancellation | The upstream request closes when the client goes away (`request.py:395`); whether vLLM then aborts is unverified | Streams close on disconnect. For non-streaming calls, cancelling upstream is opt-in (`cancel_on_disconnect`, `common_request_processing.py:1881-1893`). Not modelled |
| Headers | `X-Request-Id` is kept from the request or minted | `x-litellm-call-id`, `x-litellm-model-id`, and `x-litellm-request-prioritization-used` when prioritised |

Not tested at stub level: long contexts up to the class cap (needs real models), and LiteLLM's
tool-schema rewrite and SSE re-chunking.

## Findings for HarnessHG

1. **LiteLLM turns a busy backend into `429`, which the fork doesn't wait out.** The governor waits out only
   `503` (`fork/src/llm/governor.ts:159`). A `429` goes straight to Pi, which retries 3 times (2 s, 4 s,
   8 s) and then fails the turn as an error, not as `call-deadline`. Options:
   - configure LiteLLM so a busy backend doesn't exhaust its retries (more `num_retries`, a longer cooldown);
   - choose the vLLM router;
   - extend the governor to treat a proxy `429` with `retry-after` like `503`. That is a fork code change and needs its own card.
2. **LiteLLM swallows the per-job priority.** PW-29 hints reach vLLM through the vLLM router, but not
   through LiteLLM, whose own priority queue only orders requests while no deployment is healthy. Passing
   it on via `extra_body` is unverified.
3. **LiteLLM's priority queue can answer `408`.** A prioritised request queued while no deployment is
   healthy fails with `408` at the router timeout, which Pi treats as an error. With the default
   timeout (6000 s) the governor's deadline cuts the call first, so this only shows if
   `request_timeout` is set below the class deadline.

Preflight (PW-11) passes against both, given the key for LiteLLM. `plantworks doctor` is upstream's
`rig doctor`, which doesn't check the model endpoint (`packages/cli/src/commands/doctor.ts` has no
endpoint check). The PW-11 endpoint check is `plantworks pw llm preflight`.

## Unverified

- vLLM router authentication.
- LiteLLM's exact error envelope and `/models` list envelope.
- Whether a single-deployment LiteLLM group cools down on a `429`.
- LiteLLM forwarding `priority` via `extra_body`.
- vLLM aborting work after a router disconnect.

Each needs the real router.
