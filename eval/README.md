# Evaluating the AI Work Measurement Engine

`eval/dataset.json` holds 14 **fictional** cases (Northwind Freight; Alex Rivera is assessed, Sam Okafor is the
manager, Jordan Lee a teammate). They cover the 12 required kinds of work, plus two adversarial cases: routine work
described as very complex, and instructions hidden in the employee's text.

Each case has:

| Field | Meaning |
| --- | --- |
| `task` | The task as a manager would create it |
| `steps` | What happened, replayed through the real API: start, progress notes, comments, evidence links, blockers, submissions, reviews, reopenings, outcome records (incl. a teammate's shared outcome) |
| `expected.complexity` | The allowed complexity levels, or `insufficient` |
| `expected.dimensions` | Per dimension: a range, a maximum, a required state (`not_applicable`, `insufficient_evidence`), or `notAll5` |
| `expected.impactBasis` | verified / evidence_supported / claimed / none |
| `expected.mustNotAssume` | Regexes for things the model must not claim (e.g. a production deployment no one recorded) |
| `expected.missing` | Keyword groups the model's missing-information list should cover |

**Reference status: DRAFT.** The expectations were written by the developer from the rubric. They have **not been
reviewed by a human evaluator**. Until they are, every score is "agreement with draft expectations", not accuracy.
To review: read each case, adjust `expected`, and record the reviewer and date in the case (e.g. `"review":
{"by": "...", "at": "..."}`).

## Runner

```bash
npm run eval:measurement -- --dry-run
npm run eval:measurement -- --provider=simulated --repeats=2
AI_PROVIDER=anthropic ANTHROPIC_API_KEY=… npm run eval:measurement -- --provider=anthropic --repeats=3 --confirm-live
```

- Every case is replayed into a fresh **in-memory** TeamPulse (never a real database), and the evidence pack is built by the production code.
- Too-little-evidence cases are answered by rules, with no model call, exactly as in the app.
- The live provider is refused without `--confirm-live`. A full live run is about 13 calls per repeat; each prompt is about 2–3 KB of case data plus the rubric.
- Reports go to `eval/results/` (git-ignored), or to `--out=…`.

### What it measures, per run

| Metric | How |
| --- | --- |
| Schema validity | The raw model answer passes the strict validator |
| Citation validity | The share of cited `ref`s that exist in the evidence pack |
| Complexity calibration | The raw complexity is within the expected range; the guarded one is too |
| Dimension expectations | Raw and after guardrails |
| Unsupported claims | `mustNotAssume` patterns found in the model's understanding, summary, reasons or estimates |
| Missing-evidence detection | Expected keyword groups found in the model's own missing-information list (the app adds deterministic items on top) |
| Impact attribution | Shared case: whether the model mentions the shared contribution; whether the guarded output flags it as shared |
| Guardrail effectiveness | Expectation checks the raw answer failed and the guardrails fixed, and any they **broke** (should be 0) |
| Consistency | With `--repeats≥2`: complexity agreement across repeats, and the spread of each dimension's level |
| Impact basis | Deterministic basis matches the expectation |

Ticket counts are never measured.

The simulated provider only exercises the harness. Its scores say nothing about a real model.
