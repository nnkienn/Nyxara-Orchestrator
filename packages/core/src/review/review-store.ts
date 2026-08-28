import type { ReviewResult } from "./reviewer.types.js";

const DEFAULT_MAX_REVIEW_RESULTS = 100;

export class ReviewStore {
  private readonly results = new Map<string, ReviewResult>();

  constructor(private readonly maxResults = DEFAULT_MAX_REVIEW_RESULTS) {
    if (!Number.isInteger(maxResults) || maxResults <= 0) {
      throw new Error("Review store limit must be a positive integer");
    }
  }

  set(taskId: string, result: ReviewResult): void {
    this.results.delete(taskId);
    this.results.set(taskId, result);
    while (this.results.size > this.maxResults) {
      const oldest = this.results.keys().next().value as string | undefined;
      if (!oldest) break;
      this.results.delete(oldest);
    }
  }

  get(taskId: string): ReviewResult | undefined {
    return this.results.get(taskId);
  }
}
