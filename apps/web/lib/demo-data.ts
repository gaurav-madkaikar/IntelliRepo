export const demoRepository = {
  id: "sample-auth-service",
  name: "sample-auth-service",
  path: "/examples/spring-auth-service",
  branch: "main",
  revision: "9f2c71a",
  indexedAt: "2 min ago",
};

export const capabilityData = [
  { detail: "Canonical facts current", label: "PostgreSQL", lag: "0 rev", state: "current" },
  {
    detail: "Selected chunks match canonical facts",
    label: "pgvector",
    lag: "0",
    state: "current",
  },
  { detail: "Selected source chunks current", label: "pgvector", lag: "0 rev", state: "current" },
  { detail: "Deterministic mode active", label: "Ollama", lag: "—", state: "degraded" },
] as const;

export const metrics = [
  { delta: "+12 this scan", label: "Entities", value: "1,284" },
  { delta: "18 public", label: "API routes", value: "24" },
  { delta: "3 need review", label: "Doc health", value: "82" },
  { delta: "0 failed", label: "Indexed files", value: "438" },
] as const;

export const scanStages = [
  ["Discover", "218 ms"],
  ["Parse", "4.2 s"],
  ["Resolve", "1.8 s"],
  ["Commit", "612 ms"],
  ["Project", "skipped"],
  ["Analyze", "903 ms"],
] as const;

export const graphNodes = [
  { id: "login", kind: "endpoint", label: "POST /api/login", x: 8, y: 42 },
  { id: "controller", kind: "class", label: "AuthController", x: 31, y: 20 },
  { id: "service", kind: "method", label: "AuthService.authenticate", x: 52, y: 46 },
  { id: "repo", kind: "interface", label: "UserRepository", x: 75, y: 18 },
  { id: "jwt", kind: "class", label: "JwtTokenProvider", x: 76, y: 70 },
  { id: "test", kind: "test", label: "LoginControllerTest", x: 28, y: 77 },
] as const;

export const graphEdges = [
  { from: "login", label: "HANDLED_BY", to: "controller" },
  { from: "controller", label: "CALLS", to: "service" },
  { from: "service", label: "CALLS", to: "repo" },
  { from: "service", label: "CALLS", to: "jwt" },
  { from: "test", label: "TESTS", to: "login" },
] as const;

export const findings = [
  {
    detail: "Docs say access tokens expire after 30 minutes; application.yml declares 15.",
    evidence: "application.yml:42 · docs/authentication.md:31",
    id: "DOC-014",
    kind: "Stale configuration",
    severity: "high",
    suggestion: "Replace “30 minutes” with “15 minutes”.",
  },
  {
    detail: "POST /api/refresh-token has no linked API documentation.",
    evidence: "AuthController.java:58",
    id: "DOC-019",
    kind: "Missing API documentation",
    severity: "medium",
    suggestion: "Generate docs/intellirepo/api/refresh-token.md.",
  },
  {
    detail: "Removed LegacyTokenService is still referenced in onboarding.",
    evidence: "docs/onboarding.md:74 · entity not present in 9f2c71a",
    id: "DOC-021",
    kind: "Removed entity",
    severity: "low",
    suggestion: "Remove the legacy token service paragraph.",
  },
] as const;

export const impact = {
  files: ["AuthService.java", "JwtTokenProvider.java", "application.yml"],
  routes: ["POST /api/login", "POST /api/refresh-token"],
  risk: 64,
  riskLevel: "MEDIUM",
  tests: [
    ["AuthServiceTest", "Directly tests AuthService.authenticate()", "high"],
    ["LoginControllerTest", "Covers POST /api/login traversal", "high"],
    ["TokenRefreshIntegrationTest", "Exercises changed expiry configuration", "medium"],
  ],
  factors: [
    ["Authentication boundary changed", "+25"],
    ["Two public APIs affected", "+18"],
    ["Runtime configuration changed", "+12"],
    ["Stale documentation detected", "+9"],
  ],
} as const;

export const diffLines = [
  { kind: "context", text: "## Token lifetime" },
  { kind: "remove", text: "JWT access tokens expire after 30 minutes." },
  { kind: "add", text: "JWT access tokens expire after 15 minutes." },
  { kind: "context", text: "" },
  { kind: "add", text: "Source: `src/main/resources/application.yml:42`" },
] as const;

export const answer = {
  confidence: "high",
  degraded: true,
  text: "POST /api/login is handled by AuthController.login(). The controller calls AuthService.authenticate(), which loads the user through UserRepository and creates the access token through JwtTokenProvider.",
  citations: [
    ["E1", "AuthController.java:31–47", "Direct endpoint declaration and service call"],
    ["E2", "AuthService.java:44–79", "Credential validation and token generation flow"],
    ["E3", "JwtTokenProvider.java:28–46", "JWT construction"],
  ],
} as const;
