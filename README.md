# IntelliRepo

IntelliRepo is a local-first codebase intelligence platform for Java, Kotlin, and TypeScript repositories. It converts source and documentation into revision-scoped facts in PostgreSQL, then uses those facts for graph exploration, change impact, documentation health, test recommendations, and cited question answering.

The portfolio slice supports Spring Boot/Spring MVC, Ktor, Vert.x, NestJS, and Express. PostgreSQL is the canonical store, pgvector is the optional semantic index inside the same database, Redis/BullMQ provides asynchronous indexing, and Ollama adds local generation and embeddings. Deterministic indexing, graph traversal, impact, and documentation checks continue to work when Ollama is unavailable.

## Quick start

Prerequisites:

- Node.js 22 or newer and pnpm 11 or newer
- Podman Desktop/machine with `podman compose`, or Docker Compose
- Git
- Optional: Ollama for locally generated answers and semantic retrieval

Install dependencies and create a local environment:

```bash
pnpm install
cp .env.example .env
pnpm demo:setup
pnpm infra:up
```

If Docker is your container runtime, replace `pnpm infra:up` with:

```bash
docker compose up -d postgres redis
```

For the default asynchronous mode, start the API, worker, and dashboard together:

```bash
pnpm dev
```

Open the dashboard at [http://localhost:3000](http://localhost:3000), the API at [http://localhost:4100](http://localhost:4100), and OpenAPI at [http://localhost:4100/openapi](http://localhost:4100/openapi).

## Register and scan the demo repository

Register the generated repository. The response contains a stable `id` used by subsequent requests:

```bash
curl -sS -X POST http://localhost:4100/repositories \
  -H 'content-type: application/json' \
  -d "{\"rootPath\":\"$(pwd)/.intellirepo-demo/portfolio-sample\"}"
```

Set the returned identifier, then trigger a scan. IntelliRepo captures the current Git commit and content-sensitive worktree fingerprint on the server:

```bash
export REPOSITORY_ID='<returned-id>'
curl -sS -X POST "http://localhost:4100/repositories/$REPOSITORY_ID/scans" \
  -H 'content-type: application/json' \
  -d '{}'
```

In BullMQ mode the response initially reports a queued or running job. Poll `GET /repositories/$REPOSITORY_ID/scans/<job-id>` until it is `COMPLETED`, then open:

```text
http://localhost:3000/repositories/<repository-id>/overview
```

The live routes show canonical and semantic freshness, scan degradation, entity counts, documentation health, PostgreSQL graph traversal, change impact, reviewable documentation, and cited Q&A. `/demo` is an explicitly labeled offline UI preview and never substitutes fixture data into live routes.

## Ollama

Ollama is optional. For the example configuration:

```bash
ollama pull qwen3.5:9b
ollama pull nomic-embed-text
```

`qwen3.5:9b` generates bounded, evidence-backed prose. `nomic-embed-text` embeds selected explanatory source spans and Markdown sections; IntelliRepo does not embed every entity or relationship. Set model names in `.env` to models available on your machine.

If Ollama, the configured model, or an embedding-capable endpoint is unavailable, scans still activate canonical facts and deterministic analysis. The dashboard reports Ollama or semantic capability as disabled, degraded, failed, or stale instead of hiding the loss of capability.

## Inline mode without Redis

Inline mode is intended for a lightweight local demonstration. Start PostgreSQL only, set `INDEXING_MODE=inline`, and run the API and web app; do not start the worker:

```bash
podman compose up -d postgres
INDEXING_MODE=inline REDIS_URL= pnpm --filter @intellirepo/api dev
pnpm --filter @intellirepo/web dev
```

The API executes the same durable pipeline in-process. PostgreSQL remains mandatory in both modes.

## GitHub pull request analysis

GitHub is an optional adapter over the same locally indexed revision analysis. Index the PR base and head commits first, then submit their IntelliRepo revision IDs:

```bash
curl -sS -X POST "http://localhost:4100/repositories/$REPOSITORY_ID/github/pull-requests/analyze" \
  -H 'content-type: application/json' \
  -d '{
    "pullRequestUrl":"https://github.com/owner/repository/pull/123",
    "baseRevisionId":"<base-revision-id>",
    "targetRevisionId":"<head-revision-id>",
    "publishComment":false
  }'
```

IntelliRepo verifies that the indexed commit SHAs match GitHub's base and head before combining changed-file metadata with the canonical impact report. Renames, deletions, forks, omitted patches, and rate limits are explicit. Set `GITHUB_TOKEN` only when `publishComment` is `true`; publication creates or updates one comment identified by a hidden marker and never persists the token. Local-only operation does not require GitHub or a token.

## Demonstrate an incremental change

After the baseline scan:

```bash
pnpm demo:apply-change
curl -sS -X POST "http://localhost:4100/repositories/$REPOSITORY_ID/scans" \
  -H 'content-type: application/json' \
  -d '{}'
```

The prepared change replaces `POST /api/auth/login` with `POST /api/auth/sessions` while leaving the API document unchanged. A completed second scan demonstrates changed-file parsing, revision activation, impact analysis, and stale-document detection. Use the two revision IDs on the dashboard impact route.

Reset the sample and local services with:

```bash
pnpm demo:reset
pnpm infra:down
```

Add `-v` to the Compose down command only when you intentionally want to delete PostgreSQL and Redis data.

## Architecture and product rationale

PostgreSQL is the mandatory source of truth for repositories, revisions, artifacts, entities, relationships, jobs, findings, reviews, Q&A tasks, and selective vector chunks. The graph is a relational adjacency model queried through bounded repository-scoped traversals. There is no Neo4j runtime dependency.

This architecture does more than reduce prompt tokens. It computes expensive structural facts once per changed artifact, preserves them by revision, and makes repeated operations deterministic and inspectable. That matters when the product must answer “what changed?”, “which tests and docs are affected?”, and “is this documentation stale?” consistently across a dashboard, CI, and multiple users. A generic coding agent can inspect a repository for one conversation; IntelliRepo provides a durable, incremental evidence layer with stable citations, policy boundaries, reviewable outputs, and an offline deterministic path.

See [Architecture](docs/architecture.md), [Demo guide](docs/demo.md), [Supported patterns](docs/supported-patterns.md), and [Troubleshooting](docs/troubleshooting.md).

## Quality gates

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
```

Integration tests use Testcontainers and require a running Podman or Docker engine. The test wrapper detects the default Podman machine socket automatically; an explicit `DOCKER_HOST` takes precedence.

## Current limits

The target is a medium repository of up to 5,000 eligible files at 1 MiB each by default. Framework extraction supports common static declarations; dynamic route construction, runtime dependency injection, reflection-heavy call resolution, and arbitrary generated code are reported as diagnostics rather than guessed. GitHub analysis requires the matching commits to be indexed locally, and browser-level Playwright coverage is not part of the current release gate.
