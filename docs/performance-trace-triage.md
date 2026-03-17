# TcView Performance Trace Triage

Use this checklist when reviewing `Export TcView Performance Trace` output.

## 1. Capture Checklist

Before collecting a trace, record:

- TwinCAT/XAE version
- VS Code version
- workspace shape (standalone PLC project vs solution)
- active TcView settings:
  - `twincat.performanceLogging`
  - `twincat.performanceTraceThresholdMs`

Attach both:

- `runtime-trace.json`
- `runtime-baseline.json` (from `Export TcView Performance Baseline`)

## 2. Event Family Classification

Classify slow events by metric family:

- `open.*`: file open / conversion / virtual document setup
- `reindex.*`: analyzer index refresh work
- `tree.*`: tree discovery, refresh, and folder/model rebuild
- `save.*`: ST-to-XML writeback and post-save refresh

## 3. Triage Rules

1. Sort by `durationMs` descending.
2. Group top events by family.
3. Flag any event with duration > 2x family average from baseline.
4. Flag recurring events (same name/path) appearing 3+ times in one session.
5. Confirm whether events map to expected user actions.

## 4. What Makes a Trace Actionable

An actionable trace includes:

- reproducible user steps
- workspace size/context
- top 5 slow events with duration and operation name
- whether slowness was one-time or repeatable

## 5. Issue Template Snippet

Include this summary in the issue body:

- scenario: `<open/save/reindex/tree>`
- expected duration: `<from baseline>`
- observed duration: `<from trace>`
- top event names: `<event1, event2, ...>`
- reproducible: `<always/intermittent>`
