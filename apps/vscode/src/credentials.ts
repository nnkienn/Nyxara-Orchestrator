import type { CredentialStore } from "@nyxara/provider-sdk";

/** VS Code SecretStorage adapter; credentials never enter settings or the view. */
export class VSCodeCredentialStore implements CredentialStore {
  constructor(private readonly secrets: { get(key: string): Promise<string | undefined>; store(key: string, value: string): Promise<void>; delete(key: string): Promise<void> }) {}
  get(key: string): Promise<string | undefined> { return this.secrets.get(key); }
  set(key: string, value: string): Promise<void> { return this.secrets.store(key, value); }
  delete(key: string): Promise<void> { return this.secrets.delete(key); }
}
