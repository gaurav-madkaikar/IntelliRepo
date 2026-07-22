# Supported patterns

IntelliRepo targets common, statically declared patterns in medium repositories.

| Area          | Supported in this slice                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| Languages     | Java, Kotlin, TypeScript, JavaScript through the TypeScript pipeline                                           |
| Frameworks    | Spring Boot/MVC annotations, Ktor route blocks, Vert.x router chains, NestJS decorators, Express router calls  |
| Builds        | Maven, Gradle/Kotlin DSL, package.json, tsconfig.json                                                          |
| Configuration | Java/Kotlin properties and YAML, `.env.example`, `process.env` references                                      |
| Documentation | Markdown pages and sections; structured endpoint, entity, config, command, and source claims                   |
| Graph         | PostgreSQL entity/relationship adjacency, bounded neighborhood, endpoint-flow, and affected-subgraph traversal |
| AI            | Optional Ollama generation and embedding; selected source/documentation chunks only                            |
| GitHub        | Optional PR metadata and idempotent impact comments for indexed base/head commits                              |

Dynamic route expressions, runtime-generated modules, reflection-heavy call targets, overloaded ambiguous receivers, and unsupported syntax produce explicit diagnostics or tentative low-confidence relationships. IntelliRepo avoids inventing facts when a target cannot be resolved. GitHub does not perform a remote checkout: matching base and head revisions must already exist in the registered local repository's canonical history.

Default safety limits are 5,000 eligible files, 1 MiB per file, graph depth four, and 200 returned graph nodes. They are configurable in `.env` but should be raised only after measuring memory and latency.
