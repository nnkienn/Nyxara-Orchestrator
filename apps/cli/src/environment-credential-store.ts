import type { CredentialStore } from "@nyxara/provider-sdk";

export class EnvironmentCredentialStore implements CredentialStore {
  constructor(private readonly environment: NodeJS.ProcessEnv) {}

  async get(key: string): Promise<string | undefined> {
    return this.environment[key];
  }

  async set(key: string, value: string): Promise<void> {
    this.environment[key] = value;
  }

  async delete(key: string): Promise<void> {
    delete this.environment[key];
  }
}

