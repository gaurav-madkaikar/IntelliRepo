# Troubleshooting

## The API cannot connect to PostgreSQL

Check `podman compose ps` (or `docker compose ps`) and verify port 5432 is free. The API runs catalog migrations on startup, so no manual SQL should be needed.

## A scan remains queued

In the default `bullmq` mode, Redis and `@intellirepo/worker` must be running. Check `http://localhost:4101/health` and the scan's dispatch state. For a dependency-light demonstration, restart the API with `INDEXING_MODE=inline` and do not run the worker.

## Repository registration is rejected

The Git top-level directory must be inside one of `REPOSITORY_ALLOWED_ROOTS`. Run `pnpm demo:setup` for the supplied example, or add an explicit absolute root to `.env`. Symlinks cannot be used to escape an allowed root.

## A requested scan target conflicts

If a caller supplied `commitSha` or `worktreeFingerprint`, the repository changed before submission. Submit `{}` to let the server capture the current target, or retry with a newly inspected target. IntelliRepo also aborts a running scan if files change while its safe snapshot is in use.

## Ollama is degraded or unavailable

Run `ollama list` and confirm the exact models in `.env` are present. Some Ollama-compatible servers support generation but return HTTP 501 for embeddings; install/start an embedding-capable model endpoint or disable Ollama. Canonical indexing, PostgreSQL traversal, deterministic impact, and documentation health remain available.

## The live dashboard shows an error card

Live repository routes never fall back to fixtures. Verify the API is running at `INTELLIREPO_API_URL` (default `http://localhost:4100`), that the repository ID is correct, and that a scan has completed. Use `/demo` only for the labeled offline visual preview.
