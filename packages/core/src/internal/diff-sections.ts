const DIFF_HEADER = /^diff --git a\/(.+) b\/(.+)$/gm;

export interface DiffSection {
  readonly path: string;
  readonly content: string;
}

/**
 * Splits a unified diff into per-file sections keyed by the post-image path
 * (the `b/` side), which is what Git status and the executor report as changed.
 */
export function splitDiffSections(diff: string): DiffSection[] {
  const matches = [...diff.matchAll(DIFF_HEADER)];
  return matches.map((match, index) => ({
    path: match[2]!,
    content: diff.slice(match.index!, matches[index + 1]?.index ?? diff.length),
  }));
}

export function diffSectionMap(diff: string): ReadonlyMap<string, string> {
  return new Map(
    splitDiffSections(diff).map((section) => [section.path, section.content]),
  );
}

/**
 * Keeps only the sections for files the current execution actually changed, so
 * historical or unrelated patch text is not resent every cycle. A diff without
 * recognizable headers is returned unchanged.
 */
export function relevantDiffSections(
  diff: string,
  changedFiles: readonly string[],
): string {
  if (changedFiles.length === 0) return "";
  const sections = splitDiffSections(diff);
  if (sections.length === 0) return diff;
  const changed = new Set(changedFiles);
  return sections
    .filter((section) => changed.has(section.path))
    .map((section) => section.content)
    .join("");
}
