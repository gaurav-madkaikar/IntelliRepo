# IntelliRepo Domain

IntelliRepo describes a repository as traceable facts and relationships that can be kept aligned with its documentation as the repository changes.

## Language

**Repository**:
A locally available Git working tree registered for analysis.
_Avoid_: Project, codebase

**Revision**:
The commit and working-tree state used as the input to one indexing run.
_Avoid_: Version, snapshot, scan

**Source artifact**:
A code, test, documentation, configuration, or build file from which IntelliRepo can derive facts.
_Avoid_: File, document

**Entity**:
A normalized repository concept such as a module, type, function, endpoint, test, configuration key, dependency, or documentation section.
_Avoid_: Node, symbol, object

**Relationship**:
A typed, directed connection between two entities.
_Avoid_: Edge, link

**Fact**:
An entity or relationship supported by evidence extracted from a source artifact.
_Avoid_: Finding, assertion

**Provenance**:
The revision, source location, extractor, and evidence that explain where a fact came from.
_Avoid_: Citation, origin

**Confidence**:
The degree to which evidence supports a fact, classified as confirmed, inferred, or tentative and accompanied by a numeric score.
_Avoid_: Certainty, probability

**Change set**:
The added, modified, deleted, and renamed source artifacts between two revisions.
_Avoid_: Diff, patch

**Affected subgraph**:
The changed entities and the bounded set of related entities relevant to downstream APIs, tests, configuration, and documentation.
_Avoid_: Blast radius, impact graph

**Documentation claim**:
A structured statement extracted from documentation that can be compared with current facts.
_Avoid_: Sentence, assertion

**Documentation gap**:
An important entity that has no sufficiently linked documentation.
_Avoid_: Missing page, undocumented code
