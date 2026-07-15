import { createRequire } from "node:module";

import { Language, Parser, type Tree } from "web-tree-sitter-legacy";

export type JvmLanguage = "java" | "kotlin";

const require = createRequire(import.meta.url);
let runtimeInitialization: Promise<void> | undefined;
const languages = new Map<JvmLanguage, Promise<Language>>();

function grammarPath(language: JvmLanguage): string {
  return require.resolve(`tree-sitter-wasms/out/tree-sitter-${language}.wasm`);
}

async function initializeRuntime(): Promise<void> {
  runtimeInitialization ??= Parser.init();
  await runtimeInitialization;
}

async function loadLanguage(language: JvmLanguage): Promise<Language> {
  await initializeRuntime();
  let loaded = languages.get(language);
  if (loaded === undefined) {
    loaded = Language.load(grammarPath(language));
    languages.set(language, loaded);
  }
  return loaded;
}

export async function parseJvmSource(language: JvmLanguage, content: string): Promise<Tree> {
  const loadedLanguage = await loadLanguage(language);
  const parser = new Parser();
  try {
    parser.setLanguage(loadedLanguage);
    const tree = parser.parse(content);
    if (tree === null) throw new Error(`Tree-sitter returned no ${language} syntax tree`);
    return tree;
  } finally {
    parser.delete();
  }
}
