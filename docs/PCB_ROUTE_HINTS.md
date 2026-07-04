# PCB Route Hints and the Two Autorouters

`@tscircuit/core` routes a subcircuit's PCB in one of two modes, selected by
`autorouter.groupMode`:

- **`subcircuit`** (the default) — the whole subcircuit is handed to
  `@tscircuit/capacity-autorouter` as a single `SimpleRouteJson` problem.
- **`sequential-trace`** — each `<trace>` is routed on its own with the built-in
  multilayer ijump A\* router, in `Trace_doInitialPcbTraceRender`.

There are also two ways to supply *route hints* — waypoints a trace should pass
through. They are **not** honored the same way in the two modes, which is a common
source of confusion.

## The two hint mechanisms

1. **`pcbRouteHints`** — a `<trace>` prop:

   ```tsx
   <trace from=".U1 > .pin1" to=".U2 > .pin1" pcbRouteHints={[{ x: 5, y: 2 }]} />
   ```

   An array of `{ x, y, via?, to_layer? }` points in global PCB coordinates. Read in
   `Trace_doInitialPcbTraceRender` — the `sequential-trace` path.

2. **`pcb_trace_hint`** — a port-anchored circuit-json element, produced by the
   `<tracehint>` primitive and by `manualEdits.manual_trace_hints` (the manual-edit
   round-trip format):

   ```tsx
   <tracehint for=".U1 > .pin1" offsets={[{ x: 5, y: 2 }]} />
   ```

   The element carries `{ pcb_port_id, route: RouteHintPoint[] }`; `TraceHint` inserts
   it, keyed to the matched port.

## Which mode honors which

| hint | `sequential-trace` | `subcircuit` (default, capacity) |
|---|---|---|
| `pcbRouteHints` (trace prop) | honored | **ignored** |
| `pcb_trace_hint` (`<tracehint>` / `manual_trace_hints`) | honored | honored |

`Trace_doInitialPcbTraceRender` reads *both* the trace's own `pcbRouteHints` and the
`TraceHint`s matched to its ports, so the sequential-trace router honors either
spelling.

The capacity path builds its input with `getSimpleRouteJsonFromCircuitJson`, which
reads `pcb_trace_hint` elements (`db.pcb_trace_hint.list()`) and splices their route
points into the matching connection's `pointsToConnect`, between the two endpoints.
`pcbRouteHints` is a prop that never becomes a circuit-json element, so this builder
never sees it — which is why it is silently dropped under the default autorouter.

## How the capacity router treats a hint waypoint

A connection's `pointsToConnect` are joined as a tree. A waypoint placed roughly
*between* the two endpoints is threaded through — the trace detours to it and
continues (a pass-through). A waypoint placed off to one side, or beyond an endpoint,
is reached by a short branch off the otherwise-direct path (a stub). Placing hint
waypoints between the pads gives the pass-through behavior usually intended.

## Limitation: the capacity path forwards position only

When `getSimpleRouteJsonFromCircuitJson` copies a hint's route points into
`pointsToConnect`, it forwards only `{ x, y }` (on the anchor port's layer). The `via`
and `to_layer` fields on a `RouteHintPoint` are dropped. So under the capacity router
a hint can *position* a waypoint but cannot force a via or a layer transition there.

## For deterministic geometry, use the manual-trace props

Route hints are advisory — the router still chooses the exact path (and, under
capacity, the layers and vias). For a fixed, guaranteed shape use the manual-trace
props, which run in the `PcbManualTraceRender` phase *before* the autorouter and are
excluded from it, so they behave identically in both modes:

- **`pcbStraightLine`** — a straight two-point trace.
- **`pcbPath`** — an explicit path of waypoints, where a `{ …, via: true }` point
  carries `fromLayer` / `toLayer` and emits a real `pcb_via`, with full per-segment
  layer control.

These produce exact geometry, vias, and layers regardless of which autorouter runs.
