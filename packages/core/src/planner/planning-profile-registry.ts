import {
  BUILT_IN_PLANNING_PROFILES,
  DEFAULT_PLANNING_PROFILE,
  PLANNING_PROFILE_LIMITS,
  PlanningProfileError,
  parsePlanningProfile,
  type PlanningProfile,
} from "./planning-profile.js";

/** Core-owned, bounded, process-local planning configuration. */
export class PlanningProfileRegistry {
  private readonly profiles = new Map<string, PlanningProfile>();

  constructor(profiles: readonly unknown[] = []) {
    for (const profile of BUILT_IN_PLANNING_PROFILES) this.profiles.set(profile.id, profile);
    for (const profile of profiles) this.register(profile);
  }

  register(profile: unknown): PlanningProfile {
    const validated = parsePlanningProfile(profile);
    if (this.profiles.has(validated.id)) {
      throw new PlanningProfileError("duplicate_planning_profile", `Planning profile already exists: ${validated.id}`);
    }
    if (this.profiles.size >= PLANNING_PROFILE_LIMITS.maxProfiles) {
      throw new PlanningProfileError("planning_profile_limit_exceeded", `Planning profile registry is limited to ${PLANNING_PROFILE_LIMITS.maxProfiles} profiles`);
    }
    this.profiles.set(validated.id, validated);
    return validated;
  }

  get(id: string): PlanningProfile {
    const profile = this.profiles.get(id.trim());
    if (!profile) throw new PlanningProfileError("unknown_planning_profile", `Unknown planning profile: ${id}`);
    return profile;
  }

  resolve(id?: string): PlanningProfile {
    return id === undefined ? DEFAULT_PLANNING_PROFILE : this.get(id);
  }

  has(id: string): boolean {
    return this.profiles.has(id.trim());
  }

  list(): PlanningProfile[] {
    return [...this.profiles.values()];
  }
}
