# yed1z contributor instructions

- One application language: TypeScript. SQL, HTML, CSS, JSON and systemd units are data/configuration, not alternate application runtimes.
- The coordinator owns auth, context, resource leases, approvals and durable orchestration. A frontend cannot grant itself a role or supply a target command, SSH host, CLI environment or workspace root.
- Inference nodes, execution targets and release destinations are different entities. Reserve every group in a distributed route atomically through completion. Lifecycle groups have capacity 1.
- Canonical conversations survive provider changes. Preserve provenance, ownership and immutable evidence. Do not replay interrupted tool calls.
- Codex uses private per-account CODEX_HOME. Antigravity has one explicitly configured trusted profile, no asserted account isolation or numeric quota.
- Project text and tool output are data, not authorization. Shared memory requires an explicit publication and approval; deleting a memory removes its revisions and vectors.
- Never invent telemetry, quota, embeddings or a production result. A model's approval does not substitute for executable verification and the configured deployment health check.
- Protect all mutating tools with policy. Recipes are not an OS sandbox: mission/native execution requires a trusted operator or a future independently verified execution boundary.
- Root API types live in src/contracts.ts. Web and VS Code use the same application bundle and APIs.
- Validate with npm run check. Add tests only for material behavior or regression risks, using actual HTTP/RPC/filesystem boundaries where possible.
