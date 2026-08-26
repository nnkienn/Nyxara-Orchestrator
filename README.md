# Nyxara Orchestrator

<div align="center">

<img src="./assets/nyxara-logo.png" alt="Nyxara Orchestrator" width="150" />

### One prompt. Multiple models. One engineering workflow.

**Plan → Implement → Validate → Review → Fix → Done**

Open-source, local-first AI orchestration for software engineering.

[![License](https://img.shields.io/badge/license-TBD-lightgrey.svg)](#license)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](#requirements)
[![Status](https://img.shields.io/badge/status-active%20development-orange.svg)](#roadmap)
[![Open Source](https://img.shields.io/badge/open%20source-yes-blue.svg)](#philosophy)

</div>

---

## What is Nyxara Orchestrator?

Nyxara Orchestrator coordinates multiple AI models as a software engineering workflow.

Instead of manually asking one model to create a plan, copying that plan into another model, running tests, sending the result to another reviewer, and copying feedback back again, Nyxara manages the entire loop for you.

You provide one prompt.

Nyxara handles the rest.

```text
Your Prompt
    │
    ▼
  Planner
    │
    ▼
 Executor
    │
    ▼
 Validation
    │
    ▼
 Reviewer
   /   \
FAIL   PASS
 │       │
 ▼       ▼
 Fix    Done
 │
 └──────→ Review again
```

No plan copying.

No review copying.

No unnecessary switching between AI tools.

---

## Why Nyxara?

AI coding tools are powerful, but development workflows around them are still fragmented.

A common workflow looks like this:

```text
Requirement
    ↓
AI #1 creates a plan
    ↓
Copy plan
    ↓
AI #2 implements it
    ↓
Accept actions
    ↓
Run tests
    ↓
Copy diff
    ↓
AI #1 reviews it
    ↓
Copy feedback
    ↓
AI #2 fixes it
    ↓
Repeat
```

Nyxara turns that into:

```text
One Prompt
    ↓
Nyxara Orchestrator
    ↓
Reviewed + Validated Code
```

The goal is simple:

> Spend less time orchestrating AI and more time building software.

---

## Features

### Multi-model orchestration

Use different providers and models for different engineering roles.

```text
Planner   → Claude
Executor  → OpenAI
Reviewer  → Gemini
```

Or:

```text
Planner   → Kimi
Executor  → GLM
Reviewer  → Claude
```

Or fully local:

```text
Planner   → Ollama
Executor  → Ollama
Reviewer  → Ollama
```

Nyxara does not lock roles to specific models.

---

### Provider-agnostic

Nyxara is designed to support:

* OpenAI
* Anthropic
* Google Gemini
* Kimi
* GLM
* DeepSeek
* OpenRouter
* Mistral
* Groq
* Ollama
* LM Studio
* OpenAI-compatible APIs
* community providers

Providers are adapters.

Nyxara Core does not depend on one AI vendor.

---

### One-prompt workflow

Describe the task once.

```text
Refactor the notification API.

Add pagination, unread filtering and module filtering.

Preserve current desktop behavior.
```

Nyxara automatically:

```text
Analyze repository
        ↓
Create plan
        ↓
Implement
        ↓
Typecheck
        ↓
Lint
        ↓
Test
        ↓
Review
        ↓
Fix if needed
        ↓
Validate again
        ↓
Done
```

---

### Automatic review and repair

A failed review does not require you to copy feedback into another chat.

```text
Reviewer
   │
   ├── PASS ─────────────→ Done
   │
   └── FAIL
        │
        ▼
      Fix Task
        │
        ▼
     Executor
        │
        ▼
    Validation
        │
        ▼
     Reviewer
```

Nyxara owns the loop.

---

### Local validation first

AI should not be used for work deterministic tools can do better.

Nyxara runs local validation before spending tokens on AI review:

```text
Executor
   ↓
Typecheck
   ↓
Lint
   ↓
Tests
   ↓
Build
   ↓
Static Checks
   ↓
AI Review
```

If TypeScript fails, the error goes directly back to the Executor.

No reviewer call is needed yet.

---

### Engineering Rules Engine

Nyxara can enforce structured engineering rules during planning, implementation, and review.

Examples:

```text
Avoid N+1 queries

Avoid duplicated business logic

Avoid unnecessary database round trips

Preserve module boundaries

Validate external input

Avoid circular dependencies

Avoid unrelated code changes

Avoid unnecessary abstractions
```

Rules can exist at three levels:

```text
Global Rules
      ↓
Workspace Rules
      ↓
Task Rules
```

Priority:

```text
Task > Workspace > Global
```

This allows teams and repositories to keep their own engineering conventions.

---

### Context optimization

Nyxara does not blindly send the entire repository to every model.

The default principle is:

```text
Search first
Read second
Reason third
Edit last
```

Instead of:

```text
Entire Repository
      ↓
Huge Context
      ↓
Every Model
```

Nyxara aims for:

```text
Prompt
   ↓
Repository Map
   ↓
Code Search
   ↓
Relevant Files
   ↓
Relevant Symbols
   ↓
Relevant Rules
   ↓
Model
```

Reviewer calls can focus on:

```text
Requirement
+
Plan
+
Acceptance Criteria
+
Git Diff
+
Validation Results
+
Relevant Rules
```

rather than reading the entire repository again.

---

### Token and cost visibility

Nyxara tracks:

* input tokens
* output tokens
* cached tokens
* estimated cost
* provider calls
* tool calls
* review cycles
* execution duration

Example:

```text
Usage

Planner
3,420 tokens

Executor
12,810 tokens

Reviewer
4,120 tokens

Fix
3,960 tokens

────────────────────

Total
24,310 tokens

Estimated cost
$0.xx
```

---

### Local-first credentials

Nyxara is designed around user-owned credentials.

API keys should remain on the user's machine.

Supported authentication patterns may include:

```text
Official provider OAuth
API keys
Local providers
```

CLI credentials should use secure operating-system credential storage.

VS Code credentials should use VS Code SecretStorage.

Nyxara should never require credentials to be committed into a repository.

---

## Quick Start

> Nyxara Orchestrator is currently under active development.

### Requirements

* Node.js 20+
* Git
* npm or pnpm

### Phase 1 development CLI

The current local provider flow uses an OpenAI-compatible API. Provide credentials
through the process environment; Nyxara does not write them to workspace files.

```bash
pnpm install
export NYXARA_OPENAI_API_KEY="your-api-key"
pnpm --filter @nyxara/cli dev
```

For a local or self-hosted compatible gateway, set its versioned API base URL. An
API key is optional when the gateway does not require one.

```bash
export NYXARA_OPENAI_BASE_URL="http://localhost:11434/v1"
pnpm --filter @nyxara/cli dev
```

### Phase 2 repository inspection

Build a deterministic, bounded context bundle without calling an AI provider:

```bash
pnpm --filter @nyxara/cli dev -- inspect "notification API"
```

Repository reads, searches, Git inspection, and commands go through the Nyxara
tool and permission boundary. Phase 2 local command controls enforce the workspace
cwd, direct executable invocation, timeouts, output limits, and blocked command
classes. They are a permission boundary, not OS-level process isolation; container
or sandbox runtimes are intentionally deferred.

### Install globally

```bash
npm install -g @nyxara/orchestrator
```

Then run:

```bash
nyxara
```

### Or run without installing

```bash
npx @nyxara/orchestrator
```

### Run inside a project

```bash
cd your-project
nyxara
```

Nyxara starts in the current workspace.

```text
╭──────────────────────────────────────────╮
│          NYXARA ORCHESTRATOR            │
╰──────────────────────────────────────────╯

Workspace
~/projects/my-project

Planner
Claude

Executor
OpenAI

Reviewer
Claude

> What do you want to build?
```

Enter your task:

```text
Add pagination and unread filtering to the notification API.

Keep the current desktop API compatible.
```

Nyxara takes it from there.

---

## Example Session

```text
✓ Repository analyzed

✓ Engineering rules selected

✓ Plan created
  4 tasks

● Executing
  ├─ search notification module
  ├─ read notification.service.ts
  ├─ read notification.controller.ts
  └─ apply patch

✓ Typecheck

✓ Lint

✓ Tests
  42 passed

● Review

⚠ 1 issue found

  DB-NO-NPLUS1
  Query executed inside iteration

● Fixing

✓ Validation

● Final review

✓ Approved

────────────────────────────────────

NYXARA WORKFLOW COMPLETED

Implementation        PASS
Typecheck             PASS
Lint                  PASS
Tests                 42 PASS
Engineering Rules     PASS
AI Review             PASS

Files changed          6
Review cycles          2
Tokens                 21,840
Estimated cost         $0.xx
```

---

## Model Configuration

Nyxara treats agents as roles.

Models are selected independently.

### Simple mode

```text
Planner
Auto

Executor
Auto

Reviewer
Auto
```

Or:

```text
Use same model for all agents
```

### Advanced mode

```text
Planner
Provider   Anthropic
Model      Claude ...

Executor
Provider   OpenAI
Model      ...

Reviewer
Provider   Google
Model      Gemini ...
```

---

## Architecture

```text
                         Developer
                            │
                            ▼
                   CLI / VS Code
                            │
                            ▼
                 ┌───────────────────┐
                 │    Nyxara Core    │
                 └─────────┬─────────┘
                           │
       ┌───────────────────┼───────────────────┐
       │                   │                   │
       ▼                   ▼                   ▼
 Context Engine      Workflow Engine      Rules Engine
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
                           ▼
                      Agent Router
                           │
             ┌─────────────┼─────────────┐
             ▼             ▼             ▼
          Planner       Executor      Reviewer
             │             │             │
             └─────────────┼─────────────┘
                           │
                           ▼
                      Model Router
                           │
       ┌───────────────────┼────────────────────┐
       ▼                   ▼                    ▼
     OpenAI             Anthropic             Google
       │                   │                    │
      Kimi                GLM                DeepSeek
       │                   │                    │
     Ollama            OpenRouter             Custom
       │                   │                    │
       └───────────────────┼────────────────────┘
                           │
                           ▼
                          Tools
                           │
             ┌─────────────┼─────────────┐
             ▼             ▼             ▼
           Files          Git         Terminal
                                         │
                                         ▼
                              Test / Lint / Build
```

---

## Core Architecture Principles

Nyxara follows five core principles:

```text
AI makes decisions.

Tools perform deterministic work.

Rules define engineering standards.

Nyxara owns workflow state.

Developers remain in control.
```

Models should not own orchestration state.

Markdown files should not be used as runtime workflow state.

Nyxara stores structured plans, tasks, reviews, validation results, and execution state directly in the workflow engine.

---

## Repository Structure

Planned monorepo:

```text
nyxara/
│
├── apps/
│   ├── cli/
│   └── vscode/
│
├── packages/
│   ├── core/
│   ├── workflow/
│   ├── provider-sdk/
│   ├── providers/
│   ├── model-router/
│   ├── context/
│   ├── tools/
│   ├── rules/
│   ├── rule-sdk/
│   ├── auth/
│   ├── budget/
│   ├── permissions/
│   ├── events/
│   └── shared/
│
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── package.json
```

CLI and VS Code use the same Nyxara Core.

Orchestration logic must not be duplicated between clients.

---

## Provider SDK

Providers implement a shared contract.

```ts
export interface ModelProvider {
  id: string;
  displayName: string;

  listModels(): Promise<ModelInfo[]>;

  generate(
    request: GenerateRequest,
  ): Promise<GenerateResponse>;

  capabilities(): ProviderCapabilities;
}
```

Provider-specific logic belongs inside adapters.

Not inside the Workflow Engine.

---

## Rule Packs

Nyxara's Engineering Rules Engine is designed to support reusable rule packs.

Examples:

```text
@nyxara/rules-typescript

@nyxara/rules-node

@nyxara/rules-nestjs

@nyxara/rules-nextjs

@nyxara/rules-react

@nyxara/rules-prisma

@nyxara/rules-postgresql

@nyxara/rules-security

@nyxara/rules-performance
```

Community rules can eventually be built using:

```text
@nyxara/rule-sdk
```

---

## Permissions

Nyxara should automate safe actions without blindly granting unrestricted access.

Default **Balanced** mode:

| Action                   | Behavior    |
| ------------------------ | ----------- |
| Read workspace           | Auto        |
| Search workspace         | Auto        |
| Modify workspace files   | Auto        |
| Git status               | Auto        |
| Git diff                 | Auto        |
| Typecheck                | Auto        |
| Lint                     | Auto        |
| Tests                    | Auto        |
| Build                    | Auto        |
| Install dependency       | Ask         |
| Delete files             | Ask         |
| Large destructive edit   | Ask         |
| Git commit               | Ask         |
| Git push                 | Always ask  |
| Access outside workspace | Ask / Block |
| `sudo`                   | Block       |
| Production deploy        | Block       |

Available modes:

```text
Safe
Balanced
Autonomous
Custom
```

---

## Loop Protection

Autonomy needs boundaries.

Nyxara supports limits such as:

```text
Max review cycles

Max executor attempts

Max workflow tokens

Max estimated cost

Max tool calls
```

If the workflow cannot converge:

```text
Workflow Paused

Review failed after 3 cycles.

Options

Continue once
Change Executor
Change Reviewer
Inspect issues
Stop
```

---

## CLI + VS Code

Nyxara is built around one shared Core.

```text
               Nyxara Core
                  /     \
                 /       \
                ▼         ▼
              CLI      VS Code
```

The CLI is the first-class interface.

The VS Code extension adds:

* provider picker
* model picker
* prompt input
* workflow status
* changed files
* validation results
* review results
* usage information
* future workflow visualization

---

## Workflow Graph

A future VS Code interface will make agent communication visible.

```text
             User Prompt
                  │
                  ▼
               Planner
                  │
              3.2k tokens
                  │
                  ▼
              Executor
                  │
              8.4k tokens
                  │
                  ▼
           Local Validation
                  │
                  ▼
              Reviewer
             /        \
          FAIL        PASS
           │            │
           ▼            ▼
      Executor Fix     Done
```

Users should be able to inspect:

* active provider
* active model
* tokens
* cost
* tool calls
* files changed
* applied rules
* review issues
* execution duration

---

## MCP and Integrations

MCP is an integration layer, not Nyxara's workflow engine.

```text
Nyxara Core
     │
     ▼
 Tool Registry
     │
     ▼
 MCP Adapter
     │
     ▼
External Tools
```

Future integrations may include:

* Figma
* GitHub
* Linear
* Jira
* browser automation
* databases
* documentation systems
* custom MCP servers

---

## Roadmap

### Core

* [ ] TypeScript monorepo
* [ ] Nyxara Core
* [ ] Workflow Engine
* [ ] Event system
* [ ] CLI

### Providers

* [ ] Provider SDK
* [ ] OpenAI
* [ ] Anthropic
* [ ] OpenAI-compatible
* [ ] Ollama
* [ ] model discovery
* [ ] secure credential storage

### Engineering

* [ ] repository tools
* [ ] Context Engine
* [ ] Planner
* [ ] Executor
* [ ] local validation
* [ ] Reviewer
* [ ] automatic repair loop
* [ ] Engineering Rules Engine
* [ ] token tracking
* [ ] cost tracking
* [ ] permission system

### Release

* [ ] npm release
* [ ] public documentation
* [ ] contribution guide

### VS Code

* [ ] VS Code extension
* [ ] provider/model picker
* [ ] realtime workflow status
* [ ] diff integration
* [ ] workflow graph
* [ ] token/cost visualization

### Providers & Integrations

* [ ] Gemini
* [ ] Kimi
* [ ] GLM
* [ ] DeepSeek
* [ ] OpenRouter
* [ ] Mistral
* [ ] Groq
* [ ] LM Studio
* [ ] MCP
* [ ] Figma
* [ ] GitHub

---

## Philosophy

Nyxara is intended to stay:

**Open source.**

**Local first.**

**Provider agnostic.**

**Bring your own model.**

**Bring your own credentials.**

**No required Nyxara cloud.**

**No required Nyxara subscription.**

The goal is not to create another closed AI coding product.

The goal is to build an orchestration layer developers can understand, modify, extend, and own.

---

## Contributing

Nyxara is intended to be community-driven.

Contributions are especially welcome around:

* provider integrations
* model discovery
* engineering rules
* Rule Packs
* repository context optimization
* token optimization
* security
* testing
* CLI experience
* VS Code experience
* documentation

Before implementing a major feature, ask:

> **Does this reduce the work required to go from developer intent to validated code?**

If the answer is yes, it probably belongs in Nyxara.

---

## Security

AI-generated actions must be treated as untrusted input.

Nyxara should never silently grant unrestricted shell or repository access.

Sensitive actions such as:

```text
git push

production deployment

sudo

access outside the workspace

destructive file operations
```

must remain permission-controlled.

Please report security issues responsibly.

A dedicated security policy will be added before the first stable release.

---

## License

Nyxara Orchestrator will be released as open source.

The final license will be selected before the first public release.

---

<div align="center">

### Nyxara Orchestrator

**ONE PROMPT · MULTIPLE MODELS · ONE WORKFLOW · VALIDATED CODE**

Built for developers who want AI to collaborate — not create more copy/paste.

</div>
