import type { ContextBudget } from "./context.types.js";

/**
 * How much repository context a planning request is allowed to collect.
 *
 * The mode is decided by deterministic local signals only. Nyxara never spends a
 * provider call to decide whether to spend a provider call, so this module must
 * stay free of model access.
 */
export type PlanningContextMode = "none" | "minimal" | "targeted" | "normal";

/** The four deliberately small request classes understood by the local gate. */
export type PlanningRequestClassification =
  | "trivial"
  | "underspecified"
  | "targeted"
  | "normal_repository_task";

/** Why Nyxara asks the user for more detail instead of planning. */
export type PlanningClarificationReason = "trivial" | "underspecified";

/**
 * Cheap facts the client already has. Nothing here triggers retrieval by itself;
 * the policy only uses them to anchor a minimal or targeted request.
 */
export interface PlanningRequestSignals {
  readonly activeFilePath?: string;
  /** Selection metadata only. Selected source text is never part of the policy input. */
  readonly selection?: {
    readonly path?: string;
    readonly lineCount?: number;
    readonly characterCount?: number;
  };
  readonly attachedPaths?: readonly string[];
}

export interface PlanningContextDecision {
  readonly classification: PlanningRequestClassification;
  readonly mode: PlanningContextMode;
  /** True when Nyxara should ask locally for detail rather than call the Planner. */
  readonly clarificationRequired: boolean;
  readonly clarificationReason?: PlanningClarificationReason;
  /** False when the request is resolved locally without repository retrieval. */
  readonly repositoryRetrieval: boolean;
  /** Absent for `normal`, which keeps the existing bounded ContextEngine budget. */
  readonly contextBudget?: Partial<ContextBudget>;
  /** Paths the request named explicitly, or the cheap active-file anchor. */
  readonly focusPaths: readonly string[];
  readonly focusSymbols: readonly string[];
  /** True when retrieval must stay inside the focus set instead of filling budget. */
  readonly focusOnly: boolean;
  readonly plannerMaxOutputTokens: number;
}

/** Planner output bounds per mode. The floor keeps structured plan JSON valid. */
export const MIN_PLANNER_OUTPUT_TOKENS = 1_024;
export const DEFAULT_PLANNER_OUTPUT_TOKENS = 4_096;
export const MINIMAL_PLANNER_OUTPUT_TOKENS = 1_536;
export const TARGETED_PLANNER_OUTPUT_TOKENS = 2_560;
export const MAX_PLANNER_OUTPUT_TOKENS = 32_000;

export const MINIMAL_CONTEXT_BUDGET: Partial<ContextBudget> = Object.freeze({
  maxFiles: 2,
  maxBytes: 12 * 1024,
  maxBytesPerFile: 6 * 1024,
});

export const TARGETED_CONTEXT_BUDGET: Partial<ContextBudget> = Object.freeze({
  maxFiles: 4,
  maxBytes: 48 * 1024,
  maxBytesPerFile: 16 * 1024,
});

/** Conversational input that must never trigger repository work. */
const TRIVIAL_PHRASES = new Set([
  "?",
  "??",
  "ok",
  "okay",
  "k",
  "yes",
  "no",
  "hi",
  "hii",
  "hey",
  "helo",
  "hello",
  "hallo",
  "hola",
  "yo",
  "sup",
  "ping",
  "pong",
  "test",
  "testing",
  "test test",
  "thanks",
  "thank you",
  "thanks!",
  "thx",
  "ty",
  "cheers",
  "help",
  "can you help",
  "can you help me",
  "are you there",
  "hello there",
  "good morning",
  "good afternoon",
  "good evening",
  "how are you",
  "what can you do",
  "who are you",
]);

/** Intentionally small set of vague coding requests that need an anchor. */
const UNDERSPECIFIED_PHRASES = new Set([
  "fix this",
  "make it better",
  "update this",
  "help me",
]);

/** Verbs that mark a coding intent without naming a target on their own. */
const CODING_VERBS = new Set([
  "add",
  "audit",
  "build",
  "change",
  "clean",
  "convert",
  "create",
  "debug",
  "delete",
  "document",
  "extend",
  "extract",
  "fix",
  "handle",
  "implement",
  "improve",
  "introduce",
  "migrate",
  "modernize",
  "move",
  "optimize",
  "port",
  "refactor",
  "remove",
  "rename",
  "repair",
  "replace",
  "resolve",
  "review",
  "rewrite",
  "simplify",
  "split",
  "support",
  "test",
  "update",
  "upgrade",
  "validate",
  "wire",
  "write",
]);

/** Phrases that legitimately justify broad retrieval. */
const REPOSITORY_WIDE_PATTERNS: readonly RegExp[] = [
  /\bacross the (?:whole |entire )?(?:repo|repository|codebase|code base|project|workspace|monorepo)\b/i,
  /\b(?:whole|entire|full) (?:repo|repository|codebase|code base|project|workspace|monorepo)\b/i,
  /\b(?:repo|repository|codebase|code base|project)[- ]wide\b/i,
  /\ball (?:modules|services|packages|apps|providers|endpoints|routes|components)\b/i,
  /\beverywhere\b/i,
  /\baudit\b[\s\S]*\barchitecture\b/i,
  /\barchitecture\b[\s\S]*\baudit\b/i,
  /\bacross\b[\s\S]*\band\b[\s\S]*\b(?:crm|rem|hrm|modules|services|packages)\b/i,
];

const PATH_PATTERN = /(?:\.{0,2}\/|\/)?(?:[\w.@-]+\/)+[\w.@-]+|[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|rb|php|cs|cpp|cc|h|hpp|swift|scala|sql|css|scss|html|json|yaml|yml|toml|md|sh)\b/gi;
const SYMBOL_PATTERN = /\b[a-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b|\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b\w+\(\)/g;
const NAMED_MODULE_PATTERN = /\b([A-Za-z][\w.-]{2,})\s+(?:module|service|provider|registry|api|component|package|helper)\b/gi;
const EXPLICIT_SYMBOL_PATTERN = /\b(?:function|class|interface|type|method|symbol)\s+[`'"]?([A-Za-z_$][\w$]*)/gi;
const MAX_FOCUS_PATHS = 6;
const MAX_FOCUS_SYMBOLS = 4;
/** Word counts that separate a one-liner from a described requirement. */
const UNDERSPECIFIED_MAX_WORDS = 6;
const REPOSITORY_TASK_MIN_WORDS = 24;

function words(prompt: string): readonly string[] {
  return prompt.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function normalizedPhrase(prompt: string): string {
  const normalized = prompt.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  // Trailing punctuation is not meaning, but a bare "?" must stay recognisable.
  const stripped = normalized.replace(/[.!,?]+$/g, "");
  return stripped || normalized;
}

function extractPaths(prompt: string): readonly string[] {
  const matches = prompt.match(PATH_PATTERN) ?? [];
  const unique: string[] = [];
  for (const raw of matches) {
    const path = raw.replace(/^\.\//, "").replace(/[.,;:)]+$/, "");
    // A bare dotted word such as "node.js" is not a repository path.
    if (!path.includes("/") && !/\.[A-Za-z0-9]{1,6}$/.test(path)) continue;
    if (!unique.includes(path)) unique.push(path);
    if (unique.length >= MAX_FOCUS_PATHS) break;
  }
  return unique;
}

function extractSymbols(prompt: string): readonly string[] {
  const matches = [
    ...(prompt.match(SYMBOL_PATTERN) ?? []),
    ...[...prompt.matchAll(NAMED_MODULE_PATTERN)].flatMap((match) => match[1] ? [match[1]] : []),
    ...[...prompt.matchAll(EXPLICIT_SYMBOL_PATTERN)].flatMap((match) => match[1] ? [match[1]] : []),
  ];
  const unique: string[] = [];
  for (const raw of matches) {
    const symbol = raw.replace(/\(\)$/, "");
    if (symbol.length < 3 || symbol.includes("/")) continue;
    if (CODING_VERBS.has(symbol.toLocaleLowerCase())) continue;
    if (!unique.includes(symbol)) unique.push(symbol);
    if (unique.length >= MAX_FOCUS_SYMBOLS) break;
  }
  return unique;
}

/**
 * Extracts bounded repository anchors from task text without retrieving any
 * repository data. Planner and Executor use the same parser so a path or
 * symbol written into an approved task remains actionable after handoff.
 */
export function extractRepositoryTargetHints(text: string): {
  readonly paths: readonly string[];
  readonly symbols: readonly string[];
} {
  return Object.freeze({
    paths: Object.freeze([...extractPaths(text)]),
    symbols: Object.freeze([...extractSymbols(text)]),
  });
}

function anchors(signals: PlanningRequestSignals | undefined): readonly string[] {
  const values = [
    ...(signals?.attachedPaths ?? []),
    ...(signals?.selection?.path ? [signals.selection.path] : []),
    ...(signals?.activeFilePath ? [signals.activeFilePath] : []),
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)].slice(0, MAX_FOCUS_PATHS);
}

/**
 * Chooses whether, and how much, repository context a planning request deserves.
 * Retrieval, ranking, bounding, and truncation stay with ContextEngine; this
 * policy only selects the budget and the focus set it should honour.
 */
export function decidePlanningContext(input: {
  readonly prompt: string;
  readonly signals?: PlanningRequestSignals;
  readonly plannerMaxOutputTokens?: number;
}): PlanningContextDecision {
  const prompt = input.prompt.trim();
  const phrase = normalizedPhrase(prompt);
  const promptWords = words(prompt);
  const targets = extractRepositoryTargetHints(prompt);
  const promptPaths = targets.paths;
  const promptSymbols = targets.symbols;
  const signalAnchors = anchors(input.signals);
  const hasSelection = Boolean(
    input.signals?.selection &&
      ((input.signals.selection.lineCount ?? 0) > 0 ||
        (input.signals.selection.characterCount ?? 0) > 0 ||
        input.signals.selection.path),
  );
  const hasExplicitAttachment = (input.signals?.attachedPaths?.length ?? 0) > 0;
  const normalBound = boundPlannerOutputTokens(
    input.plannerMaxOutputTokens ?? DEFAULT_PLANNER_OUTPUT_TOKENS,
  );

  const trivial =
    prompt.length === 0 ||
    TRIVIAL_PHRASES.has(phrase);
  if (trivial) {
    return Object.freeze({
      classification: "trivial" as const,
      mode: "none" as const,
      clarificationRequired: true,
      clarificationReason: "trivial" as const,
      repositoryRetrieval: false,
      focusPaths: Object.freeze([]),
      focusSymbols: Object.freeze([]),
      focusOnly: true,
      plannerMaxOutputTokens: normalBound,
    });
  }

  const repositoryWide =
    REPOSITORY_WIDE_PATTERNS.some((pattern) => pattern.test(prompt)) ||
    promptWords.length >= REPOSITORY_TASK_MIN_WORDS;
  if (repositoryWide && promptPaths.length === 0) {
    return Object.freeze({
      classification: "normal_repository_task" as const,
      mode: "normal" as const,
      clarificationRequired: false,
      repositoryRetrieval: true,
      focusPaths: Object.freeze([...signalAnchors]),
      focusSymbols: Object.freeze([...promptSymbols]),
      focusOnly: false,
      plannerMaxOutputTokens: normalBound,
    });
  }

  if (promptPaths.length > 0) {
    return Object.freeze({
      classification: "targeted" as const,
      mode: "targeted" as const,
      clarificationRequired: false,
      repositoryRetrieval: true,
      contextBudget: TARGETED_CONTEXT_BUDGET,
      focusPaths: Object.freeze([
        ...new Set([...promptPaths, ...signalAnchors]),
      ].slice(0, MAX_FOCUS_PATHS)),
      focusSymbols: Object.freeze([...promptSymbols]),
      focusOnly: true,
      plannerMaxOutputTokens: Math.min(normalBound, TARGETED_PLANNER_OUTPUT_TOKENS),
    });
  }

  const explicitlyVague = UNDERSPECIFIED_PHRASES.has(phrase);
  const underspecified =
    explicitlyVague ||
    (promptWords.length <= UNDERSPECIFIED_MAX_WORDS &&
      promptSymbols.length === 0 &&
      (!promptWords.some((word) => CODING_VERBS.has(word)) || promptWords.length <= 4));
  if (underspecified) {
    // Minimal mode reads only what the client already pointed at, plus the cheap
    // workspace/Git summary. Broad retrieval stays unjustified until the request
    // names a target, so the focus is exclusive even when it is empty.
    // A bare active editor does not explain what "fix this" means. A concrete
    // selection or attachment can; less-vague short requests may use the active
    // file as their minimal anchor.
    const anchored = explicitlyVague
      ? hasSelection || hasExplicitAttachment
      : signalAnchors.length > 0 || hasSelection;
    return Object.freeze({
      classification: "underspecified" as const,
      mode: "minimal" as const,
      clarificationRequired: !anchored,
      ...(anchored ? {} : { clarificationReason: "underspecified" as const }),
      repositoryRetrieval: anchored,
      contextBudget: MINIMAL_CONTEXT_BUDGET,
      focusPaths: Object.freeze([...signalAnchors]),
      focusSymbols: Object.freeze([]),
      focusOnly: true,
      plannerMaxOutputTokens: Math.min(normalBound, MINIMAL_PLANNER_OUTPUT_TOKENS),
    });
  }

  if (promptSymbols.length > 0 && promptWords.length < REPOSITORY_TASK_MIN_WORDS) {
    return Object.freeze({
      classification: "targeted" as const,
      mode: "targeted" as const,
      clarificationRequired: false,
      repositoryRetrieval: true,
      contextBudget: TARGETED_CONTEXT_BUDGET,
      focusPaths: Object.freeze([...signalAnchors]),
      focusSymbols: Object.freeze([...promptSymbols]),
      focusOnly: true,
      plannerMaxOutputTokens: Math.min(normalBound, TARGETED_PLANNER_OUTPUT_TOKENS),
    });
  }

  return Object.freeze({
    classification: "normal_repository_task" as const,
    mode: "normal" as const,
    clarificationRequired: false,
    repositoryRetrieval: true,
    focusPaths: Object.freeze([...signalAnchors]),
    focusSymbols: Object.freeze([]),
    focusOnly: false,
    plannerMaxOutputTokens: normalBound,
  });
}

/**
 * Keeps a configured Planner output limit inside a range that can still hold a
 * valid structured plan. Extreme values are corrected instead of producing
 * malformed JSON through truncation.
 */
export function boundPlannerOutputTokens(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_PLANNER_OUTPUT_TOKENS;
  }
  return Math.min(
    MAX_PLANNER_OUTPUT_TOKENS,
    Math.max(MIN_PLANNER_OUTPUT_TOKENS, Math.floor(value)),
  );
}
