export interface RedactionResult {
  readonly content: string;
  readonly redactionCount: number;
}

const SECRET_ASSIGNMENT =
  /\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|private[_-]?key|secret)\b(\s*[:=]\s*)(["']?)([^\s,"'\]}]+)\3/giu;
const BEARER_TOKEN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu;
const URI_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/]+:)([^@\s]+)(@)/giu;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu;

export function redactSecrets(content: string): RedactionResult {
  let redactionCount = 0;
  const replace = (
    value: string,
    pattern: RegExp,
    replacement: string | ((...args: string[]) => string),
  ) =>
    value.replace(pattern, (...arguments_) => {
      redactionCount += 1;
      return typeof replacement === "string"
        ? replacement
        : replacement(...(arguments_ as string[]));
    });
  let redacted = replace(content, PRIVATE_KEY_BLOCK, "[REDACTED PRIVATE KEY]");
  redacted = replace(redacted, SECRET_ASSIGNMENT, (...match) => {
    const key = match[1] ?? "secret";
    const separator = match[2] ?? "=";
    return `${key}${separator}[REDACTED]`;
  });
  redacted = replace(redacted, BEARER_TOKEN, (...match) => `${match[1] ?? "Bearer "}[REDACTED]`);
  redacted = replace(
    redacted,
    URI_CREDENTIALS,
    (...match) => `${match[1] ?? ""}[REDACTED]${match[3] ?? "@"}`,
  );
  return { content: redacted, redactionCount };
}
