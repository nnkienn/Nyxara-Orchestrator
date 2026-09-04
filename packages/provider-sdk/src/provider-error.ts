export type ProviderErrorCode =
  | "authentication_error"
  | "rate_limit_error"
  | "network_error"
  | "timeout_error"
  | "provider_not_installed"
  | "provider_error"
  | "invalid_model"
  | "invalid_response";

export interface ProviderErrorOptions {
  readonly code: ProviderErrorCode;
  readonly providerId: string;
  readonly statusCode?: number;
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly providerId: string;
  readonly statusCode?: number;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message);
    this.name = "ProviderError";
    this.code = options.code;
    this.providerId = options.providerId;

    if (options.statusCode !== undefined) {
      this.statusCode = options.statusCode;
    }
  }
}
