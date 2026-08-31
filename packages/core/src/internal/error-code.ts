/**
 * Single extraction point for the `code` carried by Nyxara's typed domain
 * errors. Each subsystem keeps its own fallback so an untyped failure is still
 * attributed to the subsystem that observed it.
 */
export function getErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { readonly code: unknown }).code === "string"
  ) {
    return (error as { readonly code: string }).code;
  }
  return undefined;
}

export function errorCodeOr(error: unknown, fallback: string): string {
  return getErrorCode(error) ?? fallback;
}

export function errorMessageOr(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
