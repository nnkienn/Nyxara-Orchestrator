import type { ValidationResult } from "./validation.types.js";

export class ValidationStore {
  private latest: ValidationResult | undefined;

  set(result: ValidationResult): void {
    this.latest = result;
  }

  getLatest(): ValidationResult | undefined {
    return this.latest;
  }
}
