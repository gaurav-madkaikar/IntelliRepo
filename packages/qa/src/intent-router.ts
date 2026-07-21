import type { QuestionIntent, QuestionIntentKind } from "./qa-model.js";

function searchTerm(question: string): string {
  const endpoint = /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s?]+)/iu.exec(question);
  if (endpoint !== null) return `${endpoint[0]?.split(/\s/u)[0]?.toUpperCase()} ${endpoint[1]}`;
  const quoted = /[`"']([^`"']{2,100})[`"']/u.exec(question)?.[1];
  if (quoted !== undefined) return quoted;
  const symbol = /\b([A-Z][A-Za-z0-9_$]*(?:\.[A-Za-z_$][\w$]*)?)\b/u.exec(question)?.[1];
  if (symbol !== undefined) return symbol;
  const afterKeyword =
    /\b(?:changing|configured|explain|uses?|calls?|for)\s+(?:the\s+)?([\w.$_/-]+)/iu.exec(
      question,
    )?.[1];
  return afterKeyword ?? question.trim();
}

function intentKind(question: string): QuestionIntentKind {
  if (/\b(which|what|who)\s+(?:functions?\s+)?calls?\b|\bcallers?\s+of\b/iu.test(question))
    return "callers";
  if (/\bwhat\s+does\b.*\bcall\b|\bcallees?\b|\bdepends?\s+on\b/iu.test(question)) return "callees";
  if (
    /\bwhat\s+happens\b|\brequest\s+flow\b|\bendpoint\s+flow\b|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\//iu.test(
      question,
    )
  )
    return "endpoint_flow";
  if (/\bconfigur(?:ed|ation)\b|\benvironment variable\b|\bwhere\s+is\b.*\bset\b/iu.test(question))
    return "configuration_usage";
  if (/\btests?\b.*\b(?:run|affected|impact)\b|\bwhich\s+tests?\b/iu.test(question))
    return "test_impact";
  if (/\bdocs?|documentation\b.*\b(?:affected|impact|stale)\b|\bwhich\s+docs?\b/iu.test(question))
    return "documentation_impact";
  if (/\bexplain\b.*\bmodule\b|\bmodule\s+overview\b/iu.test(question)) return "module_explanation";
  if (/\bwhere\s+is\b|\bfind\b|\bwhat\s+is\b/iu.test(question)) return "entity_lookup";
  return "semantic_unknown";
}

export function routeQuestion(question: string): QuestionIntent {
  const normalized = question.trim();
  if (normalized.length === 0) throw new Error("Question must not be empty");
  const kind = intentKind(normalized);
  return { kind, searchTerm: searchTerm(normalized), structural: kind !== "semantic_unknown" };
}
