# IOSM Init & Cycles

IOSM (**Improve → Optimize → Shrink → Modularize**) is an algorithmic methodology for systematic engineering improvement. This document covers workspace bootstrapping and cycle operations.

## Overview

Each IOSM cycle follows a fixed execution order:

```
PLAN → HYPOTHESIZE → IMPROVE → GATE_I → OPTIMIZE → GATE_O → SHRINK → GATE_S → MODULARIZE → GATE_M → SCORE → LEARN → DECIDE
```

Every phase is evaluated against a Quality Gate. The methodology tracks six canonical metrics, computes an IOSM-Index, and determines whether to continue, stop, or fail.

---

## `iosm init`

Bootstrap IOSM artifacts for a project:

```bash
iosm init [path] [--force] [--agent-verify|--no-agent-verify]
```

| Flag | Description |
|------|-------------|
| `path` | Target directory (default: current directory) |
| `--force` | Recreate artifacts even if they exist |
| `--agent-verify` | Run post-init agent verification (default) |
| `--no-agent-verify` | Skip the verification step |

### What It Creates

```bash
# Initialize current project
iosm init
```

This generates:

```
project/
├── iosm.yaml                         # ← Method configuration
├── IOSM.md                           # ← Operator/agent playbook
└── .iosm/
    ├── metrics-history.jsonl          # Longitudinal cycle metrics
    ├── decision-log.md                # Historical decisions and rationale
    ├── pattern-library.md             # Reusable implementation patterns
    ├── waivers.yaml                   # Governance exceptions
    ├── invariants.yaml                # Logic baseline (invariant catalog)
    ├── contracts.yaml                 # Boundary control (contract catalog)
    └── cycles/                        # Per-cycle artifact storage
```

### Example: Initialize with Verification

```bash
# Full init with agent-powered analysis
iosm init

# This will:
# 1. Analyze your codebase
# 2. Generate a tailored iosm.yaml with appropriate thresholds
# 3. Create an IOSM.md playbook with project-specific guidance
# 4. Verify the configuration is valid
```

### Example: Quick Init without Analysis

```bash
# Skip the agent verification
iosm init --no-agent-verify

# Force re-init for an existing workspace
iosm init --force
```

---

## Configuration: `iosm.yaml`

The `iosm.yaml` file controls all methodology parameters. Here's a fully annotated example:

```yaml
iosm:
  metadata:
    system_name: billing-api           # System under improvement
    scope: service                     # Scope level
    criticality_profile: standard      # standard | critical | exploratory
    delivery_boundary: billing-api     # Unit for delivery flow measurement

  planning:
    use_economic_decision: true        # Use WSJF-based prioritization
    prioritization_formula: wsjf_confidence
    min_confidence: 0.70               # Minimum confidence to select a goal
    hypothesis_required: true          # Require hypothesis cards
    cycle_scope_required: true         # Require explicit scope declaration

  cycle_capacity:
    max_goals: 3                       # Max goals per cycle
    max_scope_items: 5                 # Max scope elements
    max_expected_change_surface: 3     # Max coordinated changes

  cycle_policy:
    max_iterations_per_phase: 3        # Retry limit per phase
    stabilization:
      target_index: 0.98              # Target IOSM-Index for stabilization
      consecutive_cycles: 3           # Consecutive stable cycles needed
      global_metric_floor: 0.60       # Minimum for any metric
      max_consecutive_unexplained_declines: 2

  quality_gates:
    gate_I:                            # Improve gate
      semantic_min: 0.95
      logical_consistency_min: 1.00
      duplication_max: 0.05
    gate_O:                            # Optimize gate
      latency_ms:
        p50_max: 60
        p95_max: 150
        p99_max: 250
      error_budget_respected: true
    gate_S:                            # Shrink gate
      at_least_one_dimension: true
      api_surface_reduction_min: 0.20
      dependency_hygiene_min: 0.95
    gate_M:                            # Modularize gate
      change_surface_max: 3
      coupling_max: 0.20
      cohesion_min: 0.80
      contracts_pass: true

  guardrails:
    max_negative_delta:                # Maximum allowed regression per metric
      semantic: 0.02
      logic: 0.00                     # Zero tolerance for logic regression
      performance: 0.03
      simplicity: 0.03
      modularity: 0.02
      flow: 0.02

  index:
    weights:                           # Must sum to 1.0
      semantic: 0.15
      logic: 0.20
      performance: 0.25
      simplicity: 0.15
      modularity: 0.15
      flow: 0.10

  evidence:
    min_decision_confidence: 0.80
    freshness_sla_hours:
      tier_a: 24                      # Production evidence freshness
      tier_b: 168                     # Staging evidence freshness

  automation:
    allow_agents: true
    human_approval_required_for:
      - waivers
      - public_contract_changes
      - threshold_relaxation
      - destructive_data_changes
```

---

## Cycle Commands

### List Cycles

```bash
iosm cycle list
```

Shows all known cycles with their status, scope, and last decision.

### Plan a New Cycle

```bash
iosm cycle plan [--id <cycle-id>] [--force] <goal...>
```

**Examples:**

```bash
# Plan with auto-generated ID
iosm cycle plan "reduce checkout latency" "simplify auth flow"

# Plan with a specific cycle ID
iosm cycle plan --id cycle-2026-q1 "modernize API contracts"

# Force re-plan an existing cycle
iosm cycle plan --force "optimize database queries"
```

Planning creates:
- Cycle scope declaration
- Hypothesis cards with expected metric impacts
- Baseline report
- Empty phase report scaffolds

### View Cycle Report

```bash
iosm cycle report [cycle-id]
```

Outputs a full JSON cycle report including:
- Goals and scope
- All phase results
- Metric values (before/after)
- Quality gate pass/fail status
- IOSM-Index and decision confidence
- Guardrail violations (if any)

### Check Cycle Status

```bash
iosm cycle status [cycle-id]
```

Human-readable summary showing:
- Phase completion progress
- Gate pass/fail indicators
- Current metric values
- Blocking issues or waivers

---

## Six Canonical Metrics

Every cycle measures these normalized metrics (0.0–1.0):

| Metric | What It Measures | Example Indicators |
|--------|-----------------|-------------------|
| `semantic` | Terminology and naming coherence | Glossary coverage, naming consistency, ambiguity ratio |
| `logic` | Invariant correctness | Invariant pass rate, logical consistency |
| `performance` | Latency, reliability, resilience | p50/p95/p99 latency, error budget, chaos pass rate |
| `simplicity` | Cognitive load and interface size | Onboarding time, API surface area, dependency count |
| `modularity` | Decoupling and contract discipline | Change surface, coupling, cohesion, contract compliance |
| `flow` | Delivery throughput and safety | Lead time, deploy frequency, change failure rate |

### IOSM-Index

The aggregate health score is computed as a weighted sum:

```
IOSM-Index = Σ (weight[metric] × value[metric])
```

Default weights sum to 1.0 and can be customized in `iosm.yaml`.

---

## Cycle Lifecycle Example

### Step-by-Step Walkthrough

```bash
# 1. Initialize the workspace
iosm init
# → Creates iosm.yaml, IOSM.md, and .iosm/ workspace

# 2. Plan a cycle
iosm cycle plan "reduce API response time by 30%"
# → Creates baseline report, hypothesis cards, empty phase reports

# 3. Enter IOSM mode
iosm --profile iosm
# → Agent has full IOSM context and artifact awareness

# 4. Execute the cycle (within interactive mode)
# The agent will work through:
#   IMPROVE  → Focus on semantic clarity and correctness
#   OPTIMIZE → Target performance improvements
#   SHRINK   → Reduce complexity and surface area
#   MODULARIZE → Improve boundaries and contracts

# 5. Check progress
iosm cycle status
# → Shows which phases are complete and gate results

# 6. View final report
iosm cycle report
# → Full metrics, hypotheses evaluation, IOSM-Index, decision
```

---

## Hypothesis Cards

Each goal requires a formal hypothesis card:

```yaml
hypothesis:
  id: hyp-latency-001
  goal_id: reduce-checkout-latency
  owner: payments-team
  statement: >
    If cache miss paths are removed, p95 latency
    will decrease without harming API clarity.
  expected_positive_delta:
    performance: 0.05
  allowed_negative_delta:
    semantic: 0.00
    logic: 0.00
    simplicity: 0.02
    modularity: 0.01
    flow: 0.01
  expected_business_signal:
    metric: checkout_conversion
    direction: up
  validation:
    method: production_observation
    window: 7d
  rollback_trigger:
    - contracts_break
    - change_failure_rate_up_10_percent
  confidence: 0.80
```

---

## Post-Change Synchronization

When working through a cycle, keep IOSM artifacts in sync:

- **Update metrics** — Refresh cycle metrics and confidence fields after changes
- **Track hypotheses** — Record whether expected deltas were achieved
- **Phase reports** — Fill in phase reports with actual outcomes
- **Decision log** — Document decisions in `.iosm/decision-log.md`
- **Pattern library** — Record successful patterns in `.iosm/pattern-library.md`

The `iosm` profile automatically guides the agent to maintain this synchronization.

---

## Operating Profiles

| Profile | Use Case | Evidence Strictness |
|---------|----------|-------------------|
| `standard` | Most production systems | Normal |
| `critical` | Safety/revenue-critical systems | Strict — shorter waivers, higher confidence |
| `exploratory` | Prototyping and discovery | Relaxed — cannot claim stabilization |

Set in `iosm.yaml` under `metadata.criticality_profile`.

---

## Further Reading

- [IOSM Specification](../iosm-spec.md) — Full 1600-line methodology specification
- [Configuration](./configuration.md) — Complete config reference
- [Interactive Mode](./interactive-mode.md) — IOSM slash commands
