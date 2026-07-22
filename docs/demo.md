# Portfolio demo

This is a task-oriented walkthrough for presenting IntelliRepo.

1. Follow the root README quick start and scan `.intellirepo-demo/portfolio-sample`.
2. Open the live overview and point out the canonical revision, PostgreSQL traversal adapter, worker mode, and Ollama/semantic state.
3. Search for `AuthController`, expand its graph neighborhood, and show the endpoint source reference.
4. Ask “What handles authentication?” and show that evidence and citations remain visible even when prose generation is degraded.
5. Run `pnpm demo:apply-change`, trigger a second scan, and wait for completion.
6. Open impact with the baseline and target revision IDs. Explain the affected API, suggested tests, documentation impact, and risk factors.
7. Open documentation health to show that the old login path is stale.
8. Create a documentation preview, inspect its exact target and diff, then explicitly apply it.

The strongest interview narrative is repeatability: a whole-repository agent can perform a useful one-off investigation, while IntelliRepo maintains a revisioned evidence product that supports the same impact, documentation, exploration, and Q&A semantics repeatedly without rescanning unchanged files or trusting unconstrained model output.
