# Multi-agent design proposal

**Status:** Proposed
**Last reviewed:** 2026-09-12
**Canonical for:** Future specialist-agent architecture

This is a design proposal, not a description of a completed feature. Current Nyxara runs Planner, Executor, deterministic Validation, Reviewer, and bounded Repair under Core authority.

## Roles and contracts

Candidate roles are Architect/Planner, Explorer/Localizer, Implementer, deterministic Validator, Reviewer, and Recovery agent. Every run receives one structured task contract: objective, acceptance criteria, owned files/components, dependencies, repository revision, applicable rules, required evidence, and an explicit completion signal. Agents exchange contracts and evidence references, not hidden shared transcripts.

## Isolation and scheduling

Each role receives an isolated working view projected from shared structured state. Ownership is explicit at file/component level; dependency-aware scheduling permits parallel work only where edits and prerequisites are safe. Git revision and validation evidence attach to every result. Core remains the sole authority for workflow state, verification, and termination; no agent can declare global completion.

## Specialist spawning

Spawn a specialist only when localization uncertainty, architecture complexity, recovery alternatives, or another measurable signal predicts benefit. Compare monolithic, always-multi-agent, and conditional configurations. More agents are not inherently better: coordination, duplicated context, alignment failures, and verification cost can increase outcome-adjusted cost.

## Failure modes and controls

Plan for specification drift, inter-agent misalignment, ownership conflicts, stale repository revisions, duplicated work, no-progress loops, unverifiable claims, unsafe tool requests, and premature termination. Deterministic validation, permission gates, revision checks, bounded retries, and Core termination authority are mandatory. Taxonomy and experiment gates are detailed in [ROADMAP Phase 6](ROADMAP.md#phase-6--conditional-multi-agent-execution).
