# Datum

> Every fact has a time and a place.

Datum is a lightweight, event-sourced agent runtime and workbench core. Every action an agent takes becomes a durable, ordered fact; every capability is a replaceable seam; every governance rule sits on a chokepoint that cannot be bypassed. The runtime ships no domain logic — domain agents are **compositions**, authored by the people who own the domain.

中文简介：Datum 是一套轻量级的事件溯源智能体运行时与工作台内核——上下文白盒可检、轨迹可重放、能力皆接缝可组合、治理皆配置化。运行时不含任何领域逻辑，领域智能体由领域专家以组合方式构建。

## Why

General-purpose agent tools are black boxes: nobody can answer what the model actually saw at step N, why a tool ran, or what to roll back. Datum's answer is architectural, not cosmetic — the log is the **only** source of truth, and everything else (context, UI, audit, forks) is a projection of it.

## Design pillars (the red lines)

1. **Registrations are reversible effects.** Every registration returns a disposer; teardown replays in reverse order. No irreversible API exists.
2. **The log is the single source of truth.** Message history is derived from the log, never stored twice. Fork, replay, audit, and crash recovery are projections, not features.
3. **Model-visible ⟺ logged.** Anything that reaches a model request must be reconstructable from the log. Runtime invariants assert it.
4. **Fail closed, fail loud.** Unknown event types refuse replay. Missing approvers refuse actions. Config errors refuse startup. Silence is never a success path.
5. **Capabilities are seams.** Definition / Provider / Consumer, complete in three roles; an abstraction is finished only after one end-to-end provider swap.
6. **Governance lives at chokepoints.** Default deny; one mandatory path per guarded action; every governance decision is itself a logged fact.

## Capability map

| Requirement | Where it lives |
|---|---|
| Reliable execution (可靠执行) | `@datum-runtime/loop` — turn/step state machine, AbortSignal threaded end-to-end |
| White-box context (白盒上下文) | `@datum-runtime/session` — every request derivable from the log |
| Traceable fact trajectories (事实可追溯) | `@datum-runtime/session` — append-only, monotonic seq, replayable |
| Environment awareness (环境可感知) | ingress rules + fold layer (continuous world → turn-based facts) |
| Configurable governance (配置化治理) | approval / permission chokepoints in `@datum-runtime/loop` + policy packages |
| Time series + spatial structure | every event carries `time` + ordered `seq`; observations carry source & freshness |
| Sandbox policy (沙箱策略) | execution seam — consumers hand over exact argv, backend wraps per policy |

## Repository layout

```
packages/
  kernel/   @datum-runtime/kernel   reversible effects, scoped registries, typed events
  session/  @datum-runtime/session  append-only event log, derived projections, fail-closed load
  tools/    @datum-runtime/tools    tool registry and guarded execution pipeline
  loop/     @datum-runtime/loop     agent contract, default turn/step driver (factory seam)
docs/
  ROADMAP.md                milestones and acceptance gates
AGENTS.md                   working conventions for humans and agents
```

## Status

Pre-alpha, scaffolding. See [docs/ROADMAP.md](docs/ROADMAP.md) for the build order and the acceptance gate each milestone must pass.

## Getting started

```sh
pnpm install
pnpm build
```

## Naming

Datum (Latin, "a given"): the atomic, auditable fact. Its plural is data — Datum exists to turn black-box data back into accountable datums. In surveying, a datum is the reference plane every measurement is taken from: governance sets the datum plane; agents measure and act relative to it.
