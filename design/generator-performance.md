# Generator Performance Optimization

Design doc covering the optimization of `bun run generate` from ~150s down to ~50s.

## Problem Statement

The generator parses ~4100 Objective-C SDK headers via `clang -ast-dump=json`, extracts
class/protocol/enum/struct declarations, and emits TypeScript declaration files. The
original single-header-per-clang-process approach took ~150s. The goal was to reach ~30s
parse time (~50s total including discovery and emission).

## Architecture

### Pipeline Overview

```
Phase 1: Discovery (0.2s)
  Scan SDK for frameworks, regex-scan headers for class/protocol/enum names

Phase 2: Task Building (<0.1s)
  Group all headers per framework into batch tasks (153 framework batches + 1 extra)

Phase 3: Parallel Parsing (31s)
  Worker pool dispatches batch tasks to threads:
    clang subprocess -> stdout -> JSON.parse -> pruneAST -> 5 parse passes -> postMessage

Phase 4: Emission (2.8s)
  Collect results, resolve string enum values, emit .ts files
```

### Worker Architecture

Workers are Bun threads (not processes), sharing the same V8 heap. The `WorkerPool`
uses a first-available (LIFO) dispatch pattern with a work-stealing queue. Tasks are
sorted largest-first so expensive frameworks (AppKit, Foundation) start immediately and
don't create tail latency.

Each batch task:
1. Creates a temp `.m` file with `#include` directives for all framework headers
2. Runs `clang -Xclang -ast-dump=json` (without `-fmodules`, using pre-includes)
3. Reads stdout as text (~200-800MB JSON per batch)
4. `JSON.parse()` into a full AST object
5. `pruneAST()` filters top-level nodes to 7 relevant kinds, allowing GC of ~50-70%
6. Runs 5 extraction passes: parseAST, parseProtocols, parseIntegerEnums, parseStringEnums, parseStructs
7. Sends results back to main thread via `postMessage` (structured clone)

## Optimization History

### Iteration 1: Batched Clang Invocations

**Before:** ~3400 individual clang processes (one per header).
**After:** ~153 batch tasks (one per framework) + 1 extra header task.

Each batch creates a temp `.m` file that `#include`s all framework headers, producing a
single clang invocation per framework. This eliminated subprocess startup overhead
(~40ms per clang process x 3400 = ~136s of pure overhead).

Trade-off: batched mode cannot use `-fmodules` (modules deduplicate content across
includes, producing incomplete ASTs). Instead, `Foundation/Foundation.h` and
per-framework pre-includes are used to ensure macros expand correctly.

**Result:** ~150s -> ~72s with 4 workers.

### Iteration 2: Secondary Optimizations

Applied several smaller improvements:
- **Sorted tasks largest-first** to reduce tail latency from work imbalance
- **Overlapped header file reads with clang** via `Promise.all` in workers
- **Removed `Bun.gc(true)`** that was synchronously blocking worker threads after each batch
- **Removed unnecessary cleanup** (`ast = null`, `headerLinesMap.clear()`)

**Result:** ~72s -> ~55s with 4 workers.

### Iteration 3: Streaming Parser Experiment (Reverted)

Attempted to reduce memory by using `@streamparser/json` (SAX-style streaming parser)
instead of `JSON.parse()`. This would process the JSON byte-by-byte, only materializing
nodes matching the 7 relevant kinds.

| Approach | Parse Time | Peak RSS |
|----------|-----------|----------|
| `JSON.parse` + `pruneAST` (4 workers) | ~55s | ~28 GB |
| `@streamparser/json` (4 workers) | ~141s | ~6.2 GB |

The streaming parser was ~2.5x slower because V8's native `JSON.parse()` is implemented
in optimized C++, while the streaming parser is pure JavaScript processing byte-by-byte.
At 400MB per batch, this difference is dramatic.

**Decision:** Reverted. Speed is more valuable than memory savings for this use case
(any Xcode-capable Mac has sufficient RAM).

### Iteration 4: jq Pre-filter Experiment (Reverted)

Attempted to use `jq` as a subprocess to pre-filter the clang JSON output before it
reaches JavaScript. The idea was to strip irrelevant nodes at the JSON level before
`JSON.parse()`.

| Approach | Parse Time | Peak RSS |
|----------|-----------|----------|
| `JSON.parse` + `pruneAST` (4 workers) | ~55s | ~28 GB |
| `jq` pre-filter pipeline (8 workers) | ~171s | ~13.4 GB |

`jq` itself is slow on 400MB files (~3-5s per invocation), making the cure worse than
the disease.

**Decision:** Reverted.

### Iteration 5: Per-Task Profiling and Worker Scaling

Added timing instrumentation to workers to understand the per-task time breakdown:

```
[worker] 297 headers (AppKit):
  clang+read+JSON.parse: 1737ms (95%)
  parseAST:                48ms
  parseProtocols:           22ms
  parseIntegerEnums:        15ms
  parseStringEnums:         21ms
  parseStructs:             24ms
  --- total parse passes:  130ms (5%)
```

Key findings:
- **95% of per-task time is clang execution + JSON.parse** (irreducible without fewer/smaller clang invocations)
- **5% is the 5 AST extraction passes** (merging them into a single pass would save ~2-3s total across all 154 tasks -- not worth the complexity)
- The memory pressure per worker is **transient** -- each worker only holds the full AST during `JSON.parse()` + `pruneAST()`, after which ~50-70% is GC-eligible

This meant the planned single-pass merge optimization was cancelled, and instead the
focus shifted to increasing parallelism.

Increased worker pool from 4 to 8 threads. On a 16-core / 48GB system:

| Workers | Parse Time | Total Time |
|---------|-----------|------------|
| 2 | ~107s | ~122s |
| 4 | ~55s | ~73s |
| 8 | ~31s | ~50s |

The scaling is nearly linear (4->8 workers gives ~1.8x speedup) because the workload
is dominated by independent clang subprocesses with minimal shared-state contention.

**Result:** ~55s -> ~31s parsing, ~73s -> ~50s total.

## Final Performance Breakdown

```
=== objcjs-types generator (8 workers) ===

Phase 1 - Discovery:     0.2s   (scan SDK, regex-scan headers)
Phase 2 - Task building: <0.1s  (group into 154 tasks)
Phase 3 - Parsing:       31s    (clang + JSON.parse + AST extraction)
Phase 4 - Emission:      2.8s   (string enum resolution + .ts file writes)
                         -----
Total:                   ~50s
```

Output: 5452 classes, 1026 protocols, 2647 enums across ~100 frameworks.

## Key Design Decisions

### Why `JSON.parse()` over streaming/subprocess alternatives

Native `JSON.parse()` is implemented in V8's C++ layer with SIMD optimizations. At
400MB scale, it is ~3x faster than any JavaScript-based alternative and ~2x faster
than piping through `jq`. The memory cost (~1-2GB per batch during parse) is acceptable
because:
1. `pruneAST()` immediately filters to relevant nodes, allowing GC
2. The memory spike is transient (parse + prune takes ~200-500ms)
3. Target machines have 32+GB RAM (Xcode requirement)

### Why 8 workers (not 4, not 16)

- 4 workers: CPU-bound on clang subprocesses, cores underutilized
- 8 workers: near-linear scaling, peak memory stays within 32GB
- 16 workers: diminishing returns (clang processes compete for I/O, and simultaneous
  JSON.parse of 16 x 400MB would spike to ~40GB+)

The pool size is capped at `Math.min(navigator.hardwareConcurrency, 8)`.

### Why batched mode uses pre-includes instead of `-fmodules`

With `-fmodules`, clang deduplicates module content across `#include` directives. When
batching 100+ headers into one translation unit, this causes declarations from one
header's module to be "consumed" by an earlier include, producing incomplete ASTs for
later headers. Without modules, every `#include` independently expands its content,
ensuring all declarations are present (at the cost of larger JSON output).

### Why 5 separate parse passes (not merged)

The 5 extraction functions (`parseAST`, `parseProtocols`, `parseIntegerEnums`,
`parseStringEnums`, `parseStructs`) each walk the pruned AST independently. Merging
them would eliminate ~4 redundant iterations over `ast.inner`, but profiling showed
this accounts for only ~5% of total task time (~100ms out of ~1800ms). The code clarity
benefit of separate, focused functions outweighs the minor performance gain.

## Files Modified

| File | Change |
|------|--------|
| `generator/index.ts` | Worker pool sizing (4->8), batch task sorting, phase 2-4 rewrite for batched tasks |
| `generator/clang.ts` | `clangBatchASTDump()` function, `pruneAST()` filter |
| `generator/parse-worker.ts` | `parse-batch` message handler, overlapped I/O, removed sync GC |
| `generator/worker-pool.ts` | `parseBatch()` dispatch method |
| `package.json` | Removed unused `@streamparser/json` dependency |

## Future Optimization Opportunities

1. **Reduce clang JSON output size** -- investigate clang flags that suppress `loc`,
   `range`, or other metadata we don't use. This would reduce the 200-800MB per batch,
   speeding up both I/O and `JSON.parse()`.

2. **AST caching** -- cache parsed AST results keyed by header content hash. Most SDK
   headers don't change between runs; only re-parse changed ones.

3. **Incremental generation** -- only regenerate frameworks whose headers changed since
   the last run, using file modification timestamps or content hashes.

4. **Shared Foundation AST** -- Foundation pre-includes dominate the JSON output
   (~200MB of the ~400MB per batch is Foundation content). Parsing Foundation once and
   sharing the pruned result across workers could cut total clang work in half.
