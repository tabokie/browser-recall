# Plan archive

These documents preserve proposals, decisions, and implementation records. Many
plans describe the earlier extension-only architecture; paths, APIs, schemas, and
checklists may be obsolete. Use [Architecture](../docs/ARCHITECTURE.md),
[Codebase Map](../docs/CODEBASE_MAP.md), and [Development](../DEVELOPMENT.md) for
current behavior and commands.

| Group                                                        | Subject                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| `00`–`03`                                                    | Imports, search, authentication proposals                    |
| [10 — Release plan](10-master.md), `11`–`19`                 | Extension reliability, onboarding, theme, store preparation  |
| [20 — Refactoring plan](20-master-refactoring.md), `21`–`28` | Extension module extraction and error/cache contracts        |
| [29 — Desktop split](29-desktop-split-master.md), `30`–`34`  | Repository reshape, protocol, replay/UI ports, distribution  |
| [35 — Runtime](35-log-batch-runtime.md)                      | Central write authority and asynchronous checkpoints         |
| `architecture-01`–`architecture-05`                          | Completed module/transport changes recorded in each document |
| [Sync](sync-plan.md)                                         | Historical multi-device design and conflict scenarios        |
| [Design](design.md), [Search research](research-fuzz.md)     | Product ideas and exploratory measurements                   |
| [Coverage method](e2e-coverage-method.md)                    | Coverage-selection rationale and past additions              |

Keep historical evidence separate from current instructions. New plans should
state the problem, decisions, scope, and validation without repeating system-wide
rules. Link to the current guides and update those guides when implementation lands.
