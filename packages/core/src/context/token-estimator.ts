export interface TokenEstimator {
  estimate(text: string): number;
}

export class ApproximateTokenEstimator implements TokenEstimator {
  estimate(text: string): number {
    return text.length === 0 ? 0 : Math.ceil(text.length / 4);
  }
}

