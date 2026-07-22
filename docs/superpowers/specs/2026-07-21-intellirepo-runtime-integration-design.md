# IntelliRepo Runtime Integration Design

**Status:** Approved

**Date:** 2026-07-21

**Delivery position:** Runtime-integration completion pass before Week 11

## 1. Objective

This implementation pass connects IntelliRepo's completed parsing, framework intelligence, PostgreSQL fact model, documentation analysis, impact analysis, Q&A, and dashboard foundations into one working local product flow.

The result must let a user register a medium-sized local repository, start an initial or incremental scan, observe durable progress, explore the resulting facts, review documentation and impact analysis, and ask grounded questions. The normal runtime uses PostgreSQL, Redis, and BullMQ. An explicit local-demo mode runs the same scan executor in process when Redis is intentionally unavailable. Ollama enriches embeddings and generated answers when available, while every deterministic workflow continues to work without it.

## 2. Scope

### Included

- A shared indexing runtime used by both the API and worker applications.
- Durable scan submission, dispatch, execution, status, diagnostics, and retry behavior.
- BullMQ and Redis as the normal asynchronous dispatch path.
- An explicit in-process dispatch adapter for local demo mode.
- Repository discovery, incremental extraction, relationship resolution, canonical PostgreSQL activation, selective pgvector projection, and revision-scoped analysis in one executable pipeline.
- PostgreSQL as the only canonical and traversal database.
- Ollama capability detection, selective embeddings, grounded answer generation, and deterministic fallback behavior.
- Durable question tasks and documentation review/apply state.
- Live dashboard data for repository overview, scan progress, graph exploration, documentation health, impact, Q&A, and runtime capabilities.
- Explicit fixture-backed demo routes that cannot be confused with live repository routes.
- Integration and end-to-end verification for initial scans, small incremental changes, degraded Ollama behavior, and both dispatch modes.
- Optional GitHub PR metadata ingestion and idempotent impact-comment publication for base/head commits that are already indexed locally.

### Excluded

- Neo4j storage, projection, traversal, configuration, health reporting, and benchmarks.
- Generated documentation pull requests.
- Production deployment hardening, distributed tracing, long-term metrics retention, and hosted multi-tenancy.
- Embedding every entity or relationship.
- Replacing the existing deterministic parsers with model-generated facts.

## 3. Architectural Decisions

### 3.1 PostgreSQL is the product database

PostgreSQL owns repositories, revisions, artifacts, entities, relationships, scan jobs, outbox records, documentation reviews, impact reports, question tasks, chunks, and embeddings. Graph exploration uses bounded recursive PostgreSQL queries over the canonical relationship tables. pgvector remains an extension inside the same database rather than a separate service.

No product feature depends on Neo4j. The existing `PROJECTING_GRAPH` scan stage remains temporarily in the public stage sequence for compatibility with stored jobs and UI contracts, but its executor is a deterministic no-op that records completion and performs no external projection. Neo4j is removed from the capability matrix and is not instantiated by the API or worker. A later contract-breaking cleanup may remove the compatibility stage.

### 3.2 One deep indexing runtime, two dispatch adapters

The shared runtime exposes a small interface:

```typescript
interface IndexingRuntime {
  submit(input: SubmitScanInput): Promise<ScanSubmission>;
  status(scanJobId: string): Promise<ScanStatus>;
  retry(scanJobId: string): Promise<ScanSubmission>;
}
```

`IndexingRuntime` owns scan lifecycle semantics. API controllers do not create partial job records, call parsers, or know BullMQ details. The runtime delegates delivery through a narrow `ScanDispatcher` interface with two implementations:

- `BullMqScanDispatcher` is the default. It publishes one deterministic queue job per scan and lets the standalone worker execute it.
- `InlineScanDispatcher` is selected only through explicit local-demo configuration. It schedules the same executor in the API process and returns immediately after durable submission.

Both adapters invoke the same `ScanExecutor`; they do not implement separate pipelines. The dispatch mode changes where execution occurs, not scan semantics, persistence, results, or status shape.

### 3.3 One queue job owns one scan

The BullMQ design uses one queue job for the complete scan rather than one dependent queue job per pipeline stage. `ScanExecutor` advances and persists stage transitions itself. This keeps retry and idempotency rules in one place, avoids partially reconstructed BullMQ flows, and makes inline and asynchronous execution behavior equivalent.

The BullMQ job identifier is derived from the durable scan job identifier. Publishing the same outbox event more than once therefore cannot create concurrent duplicate scans. A worker must acquire the durable job lease before execution, renew its heartbeat while active, and release or expire the lease on completion or failure.

### 3.4 Deterministic facts are independent of Ollama

Parsing, framework extraction, relationship resolution, canonical fact activation, PostgreSQL traversal, impact calculation, documentation claim checks, risk rules, and evidence-pack construction are deterministic. Ollama is allowed to:

- Embed selected source and documentation chunks for semantic retrieval.
- Turn a deterministic evidence pack into a more readable grounded answer.
- Enhance documentation wording after deterministic facts and citations are established.

An Ollama outage never prevents a revision from becoming canonical. It produces a visible degraded capability state, skips or retries semantic projection, and falls back to structural retrieval and deterministic answer or documentation rendering.

## 4. Module Boundaries

### 4.1 Shared indexing package

The reusable orchestration code belongs in `packages/indexing/`. It owns:

- `IndexingRuntime` and its PostgreSQL implementation.
- `ScanDispatcher` and dispatch result contracts.
- `ScanExecutor` and the scan stage registry.
- Durable leases, stage transitions, retry validation, and diagnostics.
- BullMQ and inline dispatcher adapters.
- Outbox dispatch reconciliation.

The package composes existing repository, parsing, catalog, graph, embeddings, impact, documentation, Q&A, AI, and contracts packages. It exposes orchestration behavior without exposing database clients, queue clients, or parser implementation details to controllers.

### 4.2 Worker application

`apps/worker` becomes the BullMQ consumer composition root. It constructs PostgreSQL repositories, the repository source adapter, the extraction pipeline, the canonical activator, embedding and analysis services, and `ScanExecutor`. Its queue processor performs lease acquisition and delegates the entire job to the executor.

The worker does not contain a second state machine. Existing worker-only queue-flow scaffolding is replaced or reduced to adapters around the shared runtime contracts.

### 4.3 API application

`apps/api` constructs `IndexingRuntime` with a dispatcher chosen by validated configuration:

- `INDEXING_MODE=bullmq` is the default and requires Redis.
- `INDEXING_MODE=inline` is allowed for local demo operation and is reported visibly.

Scan endpoints call `submit`, `status`, and `retry`. Repository, graph, documentation, impact, and Q&A endpoints read revision-scoped PostgreSQL state. The API runs an outbox reconciliation loop so durable scan requests that were committed before a transient dispatch failure are eventually published.

### 4.4 Web application

`apps/web` uses product API responses for every live repository route. Route-level loaders or view-model hooks own loading, error, empty, progress, and degraded states. Fixture data remains available only beneath an explicit `/demo` route tree.

## 5. Scan Lifecycle

### 5.1 Submission

When a scan is requested, the runtime performs one PostgreSQL transaction that:

1. Validates the repository and requested base or target revision.
2. Creates an indexing revision in a pending state.
3. Creates a scan job with a deterministic identifier and initial stage.
4. Inserts a `scan.requested` outbox event containing only identifiers and immutable scan options.

The transaction returns a submission immediately. Queue availability is not part of database commit success. The outbox dispatcher publishes pending events and marks them published only after the selected dispatch adapter accepts them.

Repeated submissions for the same repository, target fingerprint, and scan mode return the existing active or recoverable job rather than generating duplicate work.

### 5.2 Execution stages

`ScanExecutor` advances the durable job through these stages:

1. `DISCOVERING` inventories repository files, detects languages and frameworks, computes fingerprints, and determines added, modified, deleted, renamed, unchanged, skipped, and unsupported artifacts.
2. `PARSING` loads supported changed artifacts safely and runs the registered deterministic extractors. Initial scans parse all supported artifacts; incremental scans parse only added, modified, and relevant renamed artifacts.
3. `RESOLVING` resolves repository-local symbols and recalculates relationships whose sources or targets intersect the affected artifact set.
4. `COMMITTING_FACTS` stages artifact-owned facts and atomically activates the new canonical revision. Deleted-artifact facts are removed and unaffected artifact facts are preserved.
5. `PROJECTING_GRAPH` records a compatibility no-op because PostgreSQL tables are directly queryable.
6. `EMBEDDING` chunks and embeds only useful source and Markdown documentation regions when Ollama embeddings are available.
7. `ANALYZING` computes revision-scoped affected components, API/test/documentation impact, stale or missing documentation findings, risk explanations, and dashboard aggregates.

Every stage writes start time, completion time, counts, structured diagnostics, and capability degradations. Stage handlers are idempotent against the scan job and revision identifiers.

### 5.3 Canonical activation and post-activation analysis

Canonical activation occurs atomically during `COMMITTING_FACTS`. Until that transaction succeeds, readers continue to see the previous active revision. This matches the existing artifact-scoped activation model and prevents partially committed facts from becoming visible.

Embedding and analysis run after activation because they consume canonical, revision-scoped facts. If either stage fails, the new canonical revision remains active; the scan job becomes recoverable with an explicit `semantic projection incomplete` or `analysis incomplete` diagnostic. Retrying resumes the incomplete idempotent stage without rolling back correct facts. Dashboard endpoints expose this distinction instead of representing the repository as wholly unindexed.

## 6. Repository Access and Incremental Behavior

The executor receives a repository source adapter capable of listing and reading files within the registered repository root. It must:

- Reject path traversal and symlink escapes outside the repository root.
- Respect inventory size and file-count limits.
- Read only supported changed files for parsing.
- Record binary, oversized, ignored, unsupported, and unreadable artifacts as diagnostics rather than aborting the repository scan.
- Capture the Git commit when present and a deterministic working-tree fingerprint when local changes are included.

Incremental comparison uses stored artifact fingerprints and repository change information. Facts remain artifact-owned so replacement of one changed artifact cannot delete facts from another. Resolution recalculation includes changed declarations plus known callers, callees, imports, endpoint flows, tests, documentation links, and configuration consumers in the affected neighborhood.

If the repository changes after discovery, the executor detects a fingerprint conflict before activation. It fails the pending revision as stale and invites a new scan instead of activating facts assembled from inconsistent content.

## 7. Selective Embeddings and Ollama

### 7.1 Chunk selection

Embedding projection includes only chunks that improve semantic retrieval:

- Public or externally relevant classes, functions, methods, endpoints, and configuration consumers with their local source context.
- Module or file summaries derived from deterministic facts.
- Markdown headings and substantive documentation sections.
- Changed high-impact regions needed by current impact or documentation analysis.

Imports alone, punctuation-only regions, generated files, vendor code, lockfiles, duplicate boilerplate, and one-row graph entities are not embedded. Chunks carry repository, revision, artifact, source range, content hash, chunk kind, and model identity. Unchanged content hashes reuse existing embeddings when the model identity matches.

### 7.2 Runtime capability

`OllamaRuntime` performs bounded health and model checks and reports one of `available`, `degraded`, or `unavailable`. Timeouts and circuit-breaking prevent model calls from blocking deterministic requests indefinitely.

When embeddings are unavailable, pgvector retrieval is omitted and structural PostgreSQL evidence is still returned. When answer generation is unavailable, Q&A returns a deterministic evidence summary with citations and an explicit note that local generation is degraded. Low-confidence evidence remains labeled and is never rewritten as confirmed.

## 8. Durable Product State

A runtime integration migration extends the database model without introducing another data service.

### 8.1 Scan state

Scan jobs persist dispatch mode, attempt, lease owner, heartbeat, recoverability, stage timings, counts, diagnostics, and degradation metadata. The existing outbox stores scan dispatch requests. Stale active leases are recoverable after a bounded timeout; a live lease prevents concurrent execution.

### 8.2 Question tasks

Question tasks persist the repository, revision, question, state, evidence metadata, answer payload, error payload, and timestamps. API polling therefore survives process restarts. Completed answers preserve source references, confidence labels, retrieval modes used, and Ollama capability state.

### 8.3 Documentation reviews

Documentation review records persist the target path, base revision, original checksum, proposed content or patch, supporting claims, citations, explanations, and review state. Apply validates the repository, target path, active revision, and original checksum before writing. A restart cannot make an approved preview impossible to apply, and a changed target is rejected as a conflict rather than overwritten.

### 8.4 Analysis outputs

Impact, stale-documentation, missing-documentation, risk, and aggregate health outputs are stored with their source revision. Readers never combine analysis from one revision with facts from another.

## 9. Failure, Retry, and Recovery Rules

- **PostgreSQL unavailable:** submission or reads fail explicitly; no in-memory substitute is used on live routes.
- **Redis unavailable in BullMQ mode:** the durable submission remains pending in the outbox, the API reports dispatch delay, and reconciliation retries with backoff.
- **Worker interruption:** the lease expires after its heartbeat window and the same deterministic BullMQ job can resume idempotently.
- **Inline execution failure:** the durable job records the same stage failure as a worker job and can be retried; inline mode remains visibly labeled as demo mode.
- **Parser failure in one artifact:** the artifact records a diagnostic while valid artifacts continue, unless a configured scan-wide invariant is violated.
- **Canonical commit failure:** the previous revision remains active and the pending revision is safe to retry or abandon.
- **Embedding or Ollama failure:** deterministic indexing and analysis remain usable; semantic status is degraded and retryable.
- **Analysis failure after activation:** canonical facts remain active; the analysis stage is recoverable and the dashboard shows incomplete analysis.
- **Repository changed during scan:** activation is rejected with a stale-revision conflict.
- **Repeated requests or deliveries:** deterministic identifiers and database guards return or resume the same job rather than duplicate it.

Retries resume from the earliest incomplete stage whose inputs remain valid. Operators can inspect the stored reason, affected stage, attempt count, last heartbeat, and next permitted action.

## 10. API and Dashboard Behavior

### 10.1 Live repository routes

Live routes use only API data and expose:

- Repository identity, root, detected languages/frameworks, active revision, and last scan.
- Live scan stage, progress counts, diagnostics, retry state, and dispatch mode.
- Bounded PostgreSQL graph neighborhoods with explicit truncation metadata.
- API, module, configuration, dependency, test, and source-reference views.
- Revision-scoped impact, documentation health, stale claims, missing docs, and risk explanations.
- Durable question submission and polling with structural, semantic, and generation capability labels.
- Documentation preview, review explanation, conflict validation, and apply status.

A live API error renders a clear error and recovery action. It never falls back silently to sample fixture data.

### 10.2 Explicit demo routes

Fixture-backed screens live under `/demo/*`. Existing sample routes may redirect to the equivalent demo location, but a live repository identifier is never resolved from fixtures. The demo banner explains whether the route is showing fixture data or an inline scan of a real local sample repository.

### 10.3 Capability and degraded-mode display

The dashboard capability matrix reports:

- PostgreSQL canonical store and traversal health.
- pgvector extension and semantic projection status.
- BullMQ/Redis worker health or explicit inline demo mode.
- Ollama health, configured chat model, configured embedding model, and last failure summary.

Neo4j is not displayed. Projection lag means the age or revision gap of optional pgvector chunks and revision-scoped analysis relative to the active canonical revision. Canonical PostgreSQL facts have no separate graph-projection lag.

## 11. Configuration

Configuration contracts validate at startup:

- PostgreSQL connection and pgvector expectations.
- `INDEXING_MODE` with values `bullmq` or `inline`.
- Redis connection settings required in BullMQ mode.
- Repository root allow-list and scan size limits.
- Ollama base URL, chat model, embedding model, request timeouts, and optional capability flags.
- Worker concurrency, lease duration, heartbeat cadence, retry count, and backoff bounds.

Inline mode cannot be selected implicitly because Redis happens to be down. This prevents a production-like deployment from accidentally running expensive scans inside the API process.

## 12. Verification Strategy

### 12.1 Contract and unit tests

- `IndexingRuntime` submission, idempotency, status, retry, and invalid transition tests.
- BullMQ and inline dispatcher contract tests against the same dispatcher behavior suite.
- Scan executor stage ordering, resumption, diagnostics, capability degradation, and stale-fingerprint tests.
- Selective chunking, embedding reuse, Ollama timeout, structural fallback, and confidence-label tests.
- Durable question and documentation-review state tests.

### 12.2 PostgreSQL integration tests

- Atomic revision creation and canonical activation.
- Preservation of unaffected artifact facts and removal of deleted-artifact facts.
- Recursive bounded traversal with cycle and truncation handling.
- pgvector chunk upsert, revision filtering, reuse, and degraded retrieval.
- Outbox reconciliation, lease acquisition, heartbeat expiry, and retry recovery.
- Revision-scoped impact, documentation, question, and health reads.

### 12.3 Redis and worker integration tests

- API submission publishes one deterministic BullMQ job.
- Duplicate outbox publication does not duplicate execution.
- Worker execution advances durable stages and survives retryable interruption.
- Redis outage leaves an observable pending dispatch that publishes after recovery.

### 12.4 Ollama verification

- Automated tests use a fake Ollama server for health, embeddings, generation, timeout, malformed response, and outage paths.
- An opt-in local smoke test uses the configured real Ollama models on this machine and verifies one embedding plus one grounded answer.
- Normal continuous integration does not require Ollama.

### 12.5 End-to-end acceptance

Two acceptance paths run against a versioned sample repository:

1. **Normal mode:** PostgreSQL, Redis, API, worker, and web start; an initial scan completes through BullMQ; the dashboard shows live graph, APIs, docs, impact, and a grounded question answer.
2. **Local demo mode:** PostgreSQL, API, and web start with `INDEXING_MODE=inline`; the same scan completes without Redis and the dashboard visibly identifies inline execution.

Each path then modifies fewer than twenty supported files and verifies that only the affected artifacts are parsed, unaffected facts survive, affected relationships and analyses refresh, and the active revision changes atomically. The normal path also runs once with Ollama unavailable to prove deterministic usefulness and visible degraded mode.

## 13. Completion Criteria

This runtime-integration pass is complete when:

- A live dashboard can submit and observe a real repository scan without manual database steps.
- BullMQ is the working default dispatch path and the standalone worker executes the shared pipeline.
- Explicit inline mode executes the same pipeline without Redis.
- Initial and incremental scans activate correct PostgreSQL facts with durable, retryable job state.
- Graph exploration uses PostgreSQL only and returns bounded, traceable relationships.
- Ollama provides selective embeddings and grounded generation when available, while its outage leaves deterministic workflows usable.
- Question tasks and documentation previews survive API restarts.
- Live pages no longer import fixture data, and fixtures remain available through explicit demo routes.
- Projection lag, analysis lag, dispatch mode, and degraded capabilities are visible.
- Unit, integration, end-to-end, formatting, lint, type-check, and build checks pass for the affected workspace.
