import type { CircuitJsonUtilObjects } from "@tscircuit/circuit-json-util"
import { su } from "@tscircuit/circuit-json-util"
import type { AnyCircuitElement, PcbBoard } from "circuit-json"
import {
  ConnectivityMap,
  getFullConnectivityMapFromCircuitJson,
} from "circuit-json-to-connectivity-map"
import { getObstaclesFromCircuitJson } from "../obstacles/getObstaclesFromCircuitJson"
import type { SimpleRouteConnection, SimpleRouteJson } from "./SimpleRouteJson"
import { getDescendantSubcircuitIds } from "./getAncestorSubcircuitIds"
import { getPreservedRoutedSubcircuitTraces } from "./getPreservedRoutedSubcircuitTraces"
import { getUnbrokenCopperPourObstacles } from "./getUnbrokenCopperPourObstacles"

/**
 * This function can only be called in the PcbTraceRender phase or later
 */
export const getSimpleRouteJsonFromCircuitJson = ({
  db,
  circuitJson,
  subcircuit_id,
  minTraceWidth,
  minTraceToPadEdgeClearance,
  minViaEdgeToPadEdgeClearance,
  minViaHoleEdgeToViaHoleEdgeClearance,
  minPlatedHoleDrillEdgeToDrillEdgeClearance,
  minPadEdgeToPadEdgeClearance,
  minBoardEdgeClearance,
  minViaHoleDiameter,
  minViaPadDiameter,
  nominalTraceWidth,
  subcircuitComponent,
}: {
  db?: CircuitJsonUtilObjects
  circuitJson?: AnyCircuitElement[]
  subcircuit_id?: string | null
  minTraceWidth?: number
  nominalTraceWidth?: number
  minTraceToPadEdgeClearance?: number
  minViaEdgeToPadEdgeClearance?: number
  minViaHoleEdgeToViaHoleEdgeClearance?: number
  minPlatedHoleDrillEdgeToDrillEdgeClearance?: number
  minPadEdgeToPadEdgeClearance?: number
  minBoardEdgeClearance?: number
  minViaHoleDiameter?: number
  minViaPadDiameter?: number
  subcircuitComponent?: {
    selectAll(selector: string): unknown[]
  }
}): { simpleRouteJson: SimpleRouteJson; connMap: ConnectivityMap } => {
  if (!db && circuitJson) {
    db = su(circuitJson)
  }

  if (!db) {
    throw new Error("db or circuitJson is required")
  }

  const traceHints = db.pcb_trace_hint.list()

  const relevantSubcircuitIds: Set<string> | null = subcircuit_id
    ? new Set([subcircuit_id])
    : null
  if (subcircuit_id) {
    const descendantSubcircuitIds = getDescendantSubcircuitIds(
      db,
      subcircuit_id,
    )
    for (const id of descendantSubcircuitIds) {
      relevantSubcircuitIds!.add(id)
    }
  }

  const subcircuitElements = (circuitJson ?? db.toArray()).filter(
    (e) =>
      !subcircuit_id ||
      ("subcircuit_id" in e && relevantSubcircuitIds!.has(e.subcircuit_id!)),
  )

  let board: PcbBoard | undefined | null = null
  let subcircuitIsBoard = false
  if (subcircuit_id) {
    const source_group_id = subcircuit_id.replace(/^subcircuit_/, "")
    const source_board = db.source_board.getWhere({ source_group_id })
    if (source_board) {
      board = db.pcb_board.getWhere({
        source_board_id: source_board.source_board_id,
      })
      if (board) subcircuitIsBoard = true
    }
  }

  if (!board) {
    board = db.pcb_board.list()[0]
  }

  db = su(subcircuitElements)
  const pcbGroup = subcircuit_id
    ? db.pcb_group.getWhere({ subcircuit_id })
    : undefined

  const sharedConnMap =
    getFullConnectivityMapFromCircuitJson(subcircuitElements)

  const breakoutPoints = db.pcb_breakout_point
    .list()
    .filter(
      (bp) => !subcircuit_id || relevantSubcircuitIds?.has(bp.subcircuit_id!),
    )

  const obstacles = getObstaclesFromCircuitJson(
    [
      ...db.pcb_component.list(),
      ...db.pcb_smtpad.list(),
      ...db.pcb_plated_hole.list(),
      ...db.pcb_hole.list(),
      ...db.pcb_via.list(),
      ...db.pcb_keepout.list(),
      ...db.pcb_cutout.list(),
    ].filter(
      (e) => !subcircuit_id || relevantSubcircuitIds?.has(e.subcircuit_id!),
    ),
    sharedConnMap,
  )
  obstacles.push(
    ...getUnbrokenCopperPourObstacles({
      connMap: sharedConnMap,
      subcircuitComponent,
      board,
      group: pcbGroup,
    }),
  )
  // PATCH(homesodamachine): reserve each SMD-plane-pad stitch-via spot as a router obstacle.
  // An SMD pad whose net is poured on another layer gets a stitch via in the copper-pour
  // render — which runs AFTER autorouting — so the router doesn't know the via is coming and
  // will lay a different-net trace across that spot on the pour layer, shorting to the via.
  // Drop an obstacle (the via footprint, on the pour layer) at each such pad so the router
  // routes other nets around it; the pour render then drops the real via in the reserved gap.
  if (subcircuitComponent) {
    const _pourLayersByRep = /* @__PURE__ */ new Map<string, Set<string>>()
    for (const cp of (subcircuitComponent as any).selectAll("copperpour")) {
      let _pn: any
      try {
        _pn = cp.getSubcircuit().selectOne(cp._parsedProps.connectsTo)
      } catch {}
      const _ly = cp._parsedProps && cp._parsedProps.layer
      if (_pn?.source_net_id && typeof _ly === "string") {
        const _rep =
          sharedConnMap.getNetConnectedToId(_pn.source_net_id) ??
          _pn.source_net_id
        let _set = _pourLayersByRep.get(_rep)
        if (!_set) {
          _set = /* @__PURE__ */ new Set<string>()
          _pourLayersByRep.set(_rep, _set)
        }
        _set.add(_ly)
      }
    }
    if (_pourLayersByRep.size > 0) {
      const _viaPad = minViaPadDiameter ?? board?.min_via_pad_diameter ?? 0.5
      for (const sp of db.pcb_smtpad.list() as any[]) {
        if (!sp.pcb_port_id) continue
        const _rep = sharedConnMap.getNetConnectedToId(sp.pcb_port_id)
        const _set = _rep && _pourLayersByRep.get(_rep)
        if (!_set) continue
        // Pad's net poured on a layer other than the pad's? Then the pour render drops a
        // THROUGH (top<->bottom) stitch via. Reserve the via footprint on EVERY routable layer
        // except the pad's own (which already carries the SMD pad obstacle) so no foreign net
        // routes under the barrel on any layer — with all-layer routing a signal can otherwise
        // cross a stitch via on an inner layer (the barrel is conductive on every layer).
        let _needs = false
        for (const _pl of _set) if (_pl !== sp.layer) _needs = true
        if (!_needs) continue
        const _nl = board?.num_layers ?? 2
        const _resLy = ["top", "bottom"]
        for (let _i = 1; _i <= _nl - 2; _i++) _resLy.push("inner" + _i)
        const _reserve = _resLy.filter((l) => l !== sp.layer)
        obstacles.push({
          type: "oval",
          layers: _reserve,
          center: { x: sp.x, y: sp.y },
          width: _viaPad,
          height: _viaPad,
          connectedTo: [],
        } as any)
        if (process.env.POUR_SKIP_DEBUG)
          console.error(
            `[stitch-keepout] ${sp.pcb_smtpad_id} @(${sp.x.toFixed(2)},${sp.y.toFixed(2)}) reserve ${_reserve.join(",")}`,
          )
      }
    }
  }

  // SRJ uses two separate fields for routing state:
  // - connections: copper the current autorouter still needs to create.
  // - traces: copper that already exists and must be preserved.
  //
  // Child subcircuits are autorouted before their parent board. Those
  // child routes belong in `traces`, not `connections`; otherwise the parent
  // autorouter receives the same child-internal source_trace as new work and
  // may route it a second time.
  //
  // Keep connectivity metadata on preserved traces so parent routes can
  // legally touch child fanout copper that belongs to the same connected net.
  const preservedRoutedSubcircuitTraces = getPreservedRoutedSubcircuitTraces({
    scopedDb: db,
    currentSubcircuitId: subcircuit_id,
    relevantSubcircuitIds,
    sharedConnMap,
  })

  // Add every equivalent ID from the shared connectivity map to each obstacle.
  for (const obstacle of obstacles) {
    const additionalIds = obstacle.connectedTo.flatMap((id) =>
      sharedConnMap.getIdsConnectedToNet(id),
    )
    obstacle.connectedTo.push(...additionalIds)
  }

  // Build mapping from source_port_id to internal connection ID for interconnects
  const internalConnections = db.source_component_internal_connection.list()
  const sourcePortIdToInternalConnectionId = new Map<string, string>()
  for (const ic of internalConnections) {
    for (const sourcePortId of ic.source_port_ids) {
      sourcePortIdToInternalConnectionId.set(
        sourcePortId,
        ic.source_component_internal_connection_id,
      )
    }
  }

  // Build mapping from pcb_smtpad_id/pcb_plated_hole_id to source_port_id via pcb_port
  const pcbElementIdToSourcePortId = new Map<string, string>()
  for (const pcbPort of db.pcb_port.list()) {
    if (pcbPort.source_port_id) {
      // Find the smtpad or plated hole associated with this port
      const smtpad = db.pcb_smtpad.getWhere({
        pcb_port_id: pcbPort.pcb_port_id,
      })
      if (smtpad) {
        pcbElementIdToSourcePortId.set(
          smtpad.pcb_smtpad_id,
          pcbPort.source_port_id,
        )
      }
      const platedHole = db.pcb_plated_hole.getWhere({
        pcb_port_id: pcbPort.pcb_port_id,
      })
      if (platedHole) {
        pcbElementIdToSourcePortId.set(
          platedHole.pcb_plated_hole_id,
          pcbPort.source_port_id,
        )
      }
    }
  }

  // Set offBoardConnectsTo and netIsAssignable for obstacles that are part of internal connections
  for (const obstacle of obstacles) {
    for (const connectedId of obstacle.connectedTo) {
      const sourcePortId = pcbElementIdToSourcePortId.get(connectedId)
      if (sourcePortId) {
        const internalConnectionId =
          sourcePortIdToInternalConnectionId.get(sourcePortId)
        if (internalConnectionId) {
          obstacle.offBoardConnectsTo = [internalConnectionId]
          obstacle.netIsAssignable = true
          break
        }
      }
    }
  }

  // Calculate bounds
  const allPoints = obstacles
    .flatMap((o) => [
      {
        x: o.center.x - o.width / 2,
        y: o.center.y - o.height / 2,
      },
      {
        x: o.center.x + o.width / 2,
        y: o.center.y + o.height / 2,
      },
    ])
    .concat(board?.outline ?? [])

  let bounds: { minX: number; maxX: number; minY: number; maxY: number }

  // For non-board subcircuits (e.g. breakout regions), the pcb_group
  // defines the routing boundary, not the parent board.
  const useGroupBoundsAsSrjBounds = !!(
    pcbGroup?.width &&
    pcbGroup.height &&
    subcircuit_id &&
    !subcircuitIsBoard
  )

  if (useGroupBoundsAsSrjBounds) {
    bounds = {
      minX: pcbGroup!.center.x - pcbGroup!.width! / 2,
      maxX: pcbGroup!.center.x + pcbGroup!.width! / 2,
      minY: pcbGroup!.center.y - pcbGroup!.height! / 2,
      maxY: pcbGroup!.center.y + pcbGroup!.height! / 2,
    }
  } else if (board && !board.outline) {
    bounds = {
      minX: board.center.x - board.width! / 2,
      maxX: board.center.x + board.width! / 2,
      minY: board.center.y - board.height! / 2,
      maxY: board.center.y + board.height! / 2,
    }
  } else {
    bounds = {
      minX: Math.min(...allPoints.map((p) => p.x)) - 1,
      maxX: Math.max(...allPoints.map((p) => p.x)) + 1,
      minY: Math.min(...allPoints.map((p) => p.y)) - 1,
      maxY: Math.max(...allPoints.map((p) => p.y)) + 1,
    }
  }

  if (pcbGroup?.width && pcbGroup.height && !useGroupBoundsAsSrjBounds) {
    const groupBounds = {
      minX: pcbGroup.center.x - pcbGroup.width / 2,
      maxX: pcbGroup.center.x + pcbGroup.width / 2,
      minY: pcbGroup.center.y - pcbGroup.height / 2,
      maxY: pcbGroup.center.y + pcbGroup.height / 2,
    }
    bounds = {
      minX: Math.min(bounds.minX, groupBounds.minX),
      maxX: Math.max(bounds.maxX, groupBounds.maxX),
      minY: Math.min(bounds.minY, groupBounds.minY),
      maxY: Math.max(bounds.maxY, groupBounds.maxY),
    }
  }
  const sourceTraceIdsAlreadyPreservedAsSrjTraces = new Set(
    db.pcb_trace
      .list()
      .filter((t) => {
        if (!t.source_trace_id) return false

        // While routing one subcircuit, skip source_traces already routed in
        // that same subcircuit. Descendant routed traces are still preserved as
        // fixed SRJ traces above.
        if (subcircuit_id) return t.subcircuit_id === subcircuit_id

        // While routing the board, only skip a source_trace when the existing
        // pcb_trace is the child subcircuit's own routed copy. Cross-boundary
        // or board-owned source_traces must remain routable board connections.
        if (!t.subcircuit_id) return false

        const sourceTrace = db.source_trace.get(t.source_trace_id)
        return sourceTrace?.subcircuit_id === t.subcircuit_id
      })
      .map((t) => t.source_trace_id)
      .filter((id): id is string => Boolean(id)),
  )
  // Build a map of source_port_id → breakout point for adding breakout
  // waypoints to cross-boundary trace connections.
  const sourcePortIdToBreakoutPoint = new Map<
    string,
    (typeof breakoutPoints)[0]
  >()
  for (const bp of breakoutPoints) {
    const spId = (bp as any).source_port_id as string | undefined
    if (spId) sourcePortIdToBreakoutPoint.set(spId, bp)
  }

  // Create connections from source traces in this routing scope. Any
  // source_trace represented by `preservedRoutedSubcircuitTraces` is excluded
  // here so it is preserved as fixed copper instead of re-routed.
  // For cross-boundary traces, add breakout points as additional
  // waypoints so the autorouter routes through the boundary.
  const directTraceConnections = db.source_trace
    .list()
    .filter(
      (trace) =>
        !sourceTraceIdsAlreadyPreservedAsSrjTraces.has(trace.source_trace_id),
    )
    .filter(
      (trace) =>
        !subcircuit_id || (trace as any).subcircuit_id === subcircuit_id,
    )
    .map((trace) => {
      const connectedPorts = trace.connected_source_port_ids.map((id) => {
        const source_port = db.source_port.get(id)
        const pcb_port = db.pcb_port.getWhere({ source_port_id: id })
        return {
          ...source_port,
          ...pcb_port,
        }
      })

      if (connectedPorts.length < 2) return null

      // TODO handle trace.connected_source_net_ids
      const [portA, portB] = connectedPorts

      if (portA.x === undefined || portA.y === undefined) {
        console.error(
          `(source_port_id: ${portA.source_port_id}) for trace ${trace.source_trace_id} does not have x/y coordinates. Skipping this trace.`,
        )
        return null
      }
      if (portB.x === undefined || portB.y === undefined) {
        console.error(
          `(source_port_id: ${portB.source_port_id}) for trace ${trace.source_trace_id} does not have x/y coordinates. Skipping this trace.`,
        )
        return null
      }

      const layerA = portA.layers?.[0] ?? "top"
      const layerB = portB.layers?.[0] ?? "top"

      // Collect all traceHints that apply to either port
      const matchingHints = traceHints.filter(
        (hint) =>
          hint.pcb_port_id === portA.pcb_port_id ||
          hint.pcb_port_id === portB.pcb_port_id,
      )

      const hintPoints: { x: number; y: number; layer: string }[] = []

      for (const hint of matchingHints) {
        const port = db.pcb_port.get(hint.pcb_port_id)
        const layer = port?.layers?.[0] ?? "top"
        for (const pt of hint.route) {
          hintPoints.push({
            x: pt.x,
            y: pt.y,
            layer,
          })
        }
      }

      // For cross-boundary traces, use the breakout point instead of
      // the matched inner port so the autorouter routes to the breakout
      // boundary, not directly to the inner port.
      const getPortOrBreakoutPoint = (
        port: (typeof connectedPorts)[0],
        layer: string,
        sourcePortId: string,
      ) => {
        const bp = sourcePortIdToBreakoutPoint.get(sourcePortId)
        if (bp && bp.subcircuit_id !== subcircuit_id) {
          return { x: bp.x, y: bp.y, layer }
        }
        return {
          x: port.x!,
          y: port.y!,
          layer,
          pointId: port.pcb_port_id,
          pcb_port_id: port.pcb_port_id,
        }
      }
      return {
        name:
          trace.source_trace_id ??
          sharedConnMap.getNetConnectedToId(trace.source_trace_id) ??
          "",
        source_trace_id: trace.source_trace_id,
        nominalTraceWidth: trace.min_trace_thickness,
        width: trace.min_trace_thickness,
        pointsToConnect: [
          getPortOrBreakoutPoint(
            portA,
            layerA,
            trace.connected_source_port_ids[0],
          ),
          ...hintPoints,
          getPortOrBreakoutPoint(
            portB,
            layerB,
            trace.connected_source_port_ids[1],
          ),
        ],
      } as SimpleRouteConnection
    })
    .filter((c): c is SimpleRouteConnection => c !== null)

  const source_nets = db.source_net
    .list()
    .filter((e) => !subcircuit_id || e.subcircuit_id === subcircuit_id)

  const connectionsFromNets: SimpleRouteConnection[] = []
  const connectionFromNetId = new Map<string, SimpleRouteConnection>()
  const handledNetConnectivityKeys = new Set<string>()
  const sourceTracesEligibleForNetConnections = db.source_trace
    .list()
    .filter(
      (st) =>
        subcircuit_id ||
        !sourceTraceIdsAlreadyPreservedAsSrjTraces.has(st.source_trace_id),
    )
  const getSourceConnectivityKey = (id?: string | null) =>
    id ? (sharedConnMap.getNetConnectedToId(id) ?? id) : null
  for (const net of source_nets) {
    const netConnectivityKey = getSourceConnectivityKey(net.source_net_id)
    if (
      !netConnectivityKey ||
      handledNetConnectivityKeys.has(netConnectivityKey)
    ) {
      continue
    }
    handledNetConnectivityKeys.add(netConnectivityKey)

    const connectedSourceNetIds = source_nets
      .filter(
        (sourceNet) =>
          getSourceConnectivityKey(sourceNet.source_net_id) ===
          netConnectivityKey,
      )
      .map((sourceNet) => sourceNet.source_net_id)
    const connectedSourceTraces = sourceTracesEligibleForNetConnections.filter(
      (st) =>
        [st.source_trace_id, ...(st.connected_source_net_ids ?? [])].some(
          (id) => getSourceConnectivityKey(id) === netConnectivityKey,
        ),
    )

    let nominalTraceWidthFromConnectedTraces: number | undefined
    for (const sourceTrace of connectedSourceTraces) {
      if (sourceTrace.min_trace_thickness === undefined) continue
      nominalTraceWidthFromConnectedTraces = Math.max(
        nominalTraceWidthFromConnectedTraces ?? 0,
        sourceTrace.min_trace_thickness,
      )
    }

    const pointsToConnect: SimpleRouteConnection["pointsToConnect"] = []
    const addedPointIds = new Set<string>()
    for (const st of connectedSourceTraces) {
      const pcb_ports = db.pcb_port
        .list()
        .filter((p) => st.connected_source_port_ids.includes(p.source_port_id))

      for (const p of pcb_ports) {
        if (addedPointIds.has(p.pcb_port_id)) continue
        addedPointIds.add(p.pcb_port_id)
        pointsToConnect.push({
          x: p.x!,
          y: p.y!,
          layer: (p.layers?.[0] as any) ?? "top",
          pointId: p.pcb_port_id,
          pcb_port_id: p.pcb_port_id,
        })
      }
    }

    const connection: SimpleRouteConnection = {
      name:
        net.source_net_id ??
        sharedConnMap.getNetConnectedToId(net.source_net_id),
      nominalTraceWidth: nominalTraceWidthFromConnectedTraces,
      width: nominalTraceWidthFromConnectedTraces,
      pointsToConnect,
    }
    connectionsFromNets.push(connection)
    for (const sourceNetId of connectedSourceNetIds) {
      connectionFromNetId.set(sourceNetId, connection)
    }
  }

  const connectionsFromBreakoutPoints: SimpleRouteConnection[] = []

  for (const bp of breakoutPoints) {
    const bpSourcePortId = (bp as any).source_port_id as string | undefined
    const pt = { x: bp.x, y: bp.y, layer: "top" as const }

    if (bpSourcePortId) {
      const pcb_port = db.pcb_port.getWhere({
        source_port_id: bpSourcePortId,
      })
      if (!pcb_port) continue

      const portPt = {
        x: pcb_port.x!,
        y: pcb_port.y!,
        layer: (pcb_port.layers?.[0] as any) ?? "top",
        pointId: pcb_port.pcb_port_id,
        pcb_port_id: pcb_port.pcb_port_id,
      }

      // Inner routing (same subcircuit): create [port → bp] so the
      // inner autorouter connects the chip pin to the boundary.
      // Outer routing (parent): the cross-boundary trace already
      // uses the bp instead of the inner port — no connection needed.
      if (bp.subcircuit_id === subcircuit_id) {
        connectionsFromBreakoutPoints.push({
          name: bpSourcePortId,
          source_trace_id: bp.source_trace_id,
          pointsToConnect: [portPt, pt],
        })
        continue
      }

      // Manual breakout point with no cross-boundary trace — create a
      // direct [port, bp] connection as fallback.
      if (!bp.source_trace_id) {
        connectionsFromBreakoutPoints.push({
          name: bpSourcePortId,
          pointsToConnect: [portPt, pt],
        })
      }
      continue
    }

    // Net-based breakout points
    if (bp.source_net_id) {
      const conn = connectionFromNetId.get(bp.source_net_id)
      if (conn) {
        conn.pointsToConnect.push(pt)
      } else {
        connectionsFromBreakoutPoints.push({
          name: bp.source_net_id,
          pointsToConnect: [pt],
        })
      }
    }
  }

  // ----- 1. Gather all connections we are about to return
  const allConns: SimpleRouteConnection[] = [
    ...directTraceConnections,
    ...connectionsFromNets,
    ...connectionsFromBreakoutPoints,
  ]

  if (subcircuit_id) {
    const pointIdToConn = new Map<string, SimpleRouteConnection>()
    for (const conn of allConns) {
      for (const pt of conn.pointsToConnect) {
        if (pt.pointId) pointIdToConn.set(pt.pointId, conn)
      }
    }

    const existingTraces = db.pcb_trace.list().filter((t) => {
      return relevantSubcircuitIds?.has(t.subcircuit_id!)
    })

    for (const tr of existingTraces) {
      const tracePortIds = new Set<string>()
      for (const seg of tr.route as any[]) {
        if (seg.start_pcb_port_id) tracePortIds.add(seg.start_pcb_port_id)
        if (seg.end_pcb_port_id) tracePortIds.add(seg.end_pcb_port_id)
      }
      if (tracePortIds.size < 2) continue

      const firstId = tracePortIds.values().next().value
      if (!firstId) continue
      const conn = pointIdToConn.get(firstId)
      if (!conn) continue
      if (![...tracePortIds].every((pid) => pointIdToConn.get(pid) === conn)) {
        continue
      }

      conn.externallyConnectedPointIds ??= []
      conn.externallyConnectedPointIds.push([...tracePortIds])
    }
  }

  let routedConns = allConns
  if (subcircuitComponent) {
    const pouredReps = /* @__PURE__ */ new Set<string>()
    for (const cp of (subcircuitComponent as any).selectAll("copperpour")) {
      let pouredNet: any
      try {
        pouredNet = cp.getSubcircuit().selectOne(cp._parsedProps.connectsTo)
      } catch {}
      if (pouredNet?.source_net_id) {
        pouredReps.add(
          sharedConnMap.getNetConnectedToId(pouredNet.source_net_id) ??
            pouredNet.source_net_id,
        )
      }
    }
    // PATCH(homesodamachine): second-pass carve. A manual <pcbtrace> hand-routes a
    // connection the capacity autorouter packs badly; carve that connection out so
    // the autorouter leaves it alone and the clean pcbtrace copper is the only copper
    // on it. The pcbtrace's first/last wire points land on the connection's two pads,
    // so we match a connection's pointsToConnect xy against pcbtrace endpoints. The
    // <trace> stays as the canonical netlist. See clean-pass.ts (the route generator).
    const manualEnds: Array<[any, any]> = []
    for (const pt of (subcircuitComponent as any).selectAll("pcbtrace")) {
      const route = pt._parsedProps?.route
      if (!Array.isArray(route)) continue
      const w = route.filter(
        (p: any) =>
          p &&
          p.route_type === "wire" &&
          typeof p.x === "number" &&
          typeof p.y === "number",
      )
      if (w.length >= 2) manualEnds.push([w[0], w[w.length - 1]])
    }
    const nearPt = (a: any, b: any) =>
      a && b && Math.abs(a.x - b.x) < 0.06 && Math.abs(a.y - b.y) < 0.06
    const connIsManual = (conn: SimpleRouteConnection) => {
      const ps = conn.pointsToConnect
      if (!ps || ps.length !== 2) return false
      for (const [s, e] of manualEnds)
        if (
          (nearPt(ps[0], s) && nearPt(ps[1], e)) ||
          (nearPt(ps[0], e) && nearPt(ps[1], s))
        )
          return true
      return false
    }
    const connIsPoured = (conn: SimpleRouteConnection) => {
      for (const pt of conn.pointsToConnect) {
        const id = (pt as any).pcb_port_id ?? pt.pointId
        if (!id) continue
        const rep = sharedConnMap.getNetConnectedToId(id)
        if (rep && pouredReps.has(rep)) return true
      }
      return false
    }
    if (pouredReps.size > 0 || manualEnds.length > 0) {
      routedConns = allConns.filter(
        (conn) => !connIsPoured(conn) && !connIsManual(conn),
      )
      if (process.env.POUR_SKIP_DEBUG) {
        console.error(
          `[pour-skip] pouredReps=${pouredReps.size} manual=${manualEnds.length} allConns=${allConns.length} routed=${routedConns.length} skipped=${allConns.length - routedConns.length}`,
        )
      }
    }
  }

  const resolvedMinViaHoleDiameter =
    minViaHoleDiameter ?? board?.min_via_hole_diameter
  const resolvedMinViaPadDiameter =
    minViaPadDiameter ?? board?.min_via_pad_diameter
  const resolvedMinTraceToPadEdgeClearance =
    minTraceToPadEdgeClearance ?? board?.min_trace_to_pad_edge_clearance
  const resolvedMinViaEdgeToPadEdgeClearance =
    minViaEdgeToPadEdgeClearance ?? board?.min_via_edge_to_pad_edge_clearance
  const resolvedMinViaHoleEdgeToViaHoleEdgeClearance =
    minViaHoleEdgeToViaHoleEdgeClearance ??
    board?.min_via_hole_edge_to_via_hole_edge_clearance
  const resolvedMinPlatedHoleDrillEdgeToDrillEdgeClearance =
    minPlatedHoleDrillEdgeToDrillEdgeClearance ??
    board?.min_plated_hole_drill_edge_to_drill_edge_clearance
  const resolvedMinPadEdgeToPadEdgeClearance =
    minPadEdgeToPadEdgeClearance ?? board?.min_pad_edge_to_pad_edge_clearance
  const resolvedMinBoardEdgeClearance =
    minBoardEdgeClearance ?? board?.min_board_edge_clearance

  return {
    simpleRouteJson: {
      bounds,
      obstacles,
      connections: routedConns,
      traces:
        preservedRoutedSubcircuitTraces.length > 0
          ? preservedRoutedSubcircuitTraces
          : undefined,
      layerCount: board?.num_layers ?? 2,
      minTraceWidth: minTraceWidth ?? board?.min_trace_width ?? 0.1,
      minViaDiameter: resolvedMinViaPadDiameter,
      minViaHoleDiameter: resolvedMinViaHoleDiameter,
      minViaPadDiameter: resolvedMinViaPadDiameter,
      min_via_hole_diameter: resolvedMinViaHoleDiameter,
      min_via_pad_diameter: resolvedMinViaPadDiameter,
      minTraceToPadEdgeClearance: resolvedMinTraceToPadEdgeClearance,
      minViaEdgeToPadEdgeClearance: resolvedMinViaEdgeToPadEdgeClearance,
      minViaHoleEdgeToViaHoleEdgeClearance:
        resolvedMinViaHoleEdgeToViaHoleEdgeClearance,
      minPlatedHoleDrillEdgeToDrillEdgeClearance:
        resolvedMinPlatedHoleDrillEdgeToDrillEdgeClearance,
      minPadEdgeToPadEdgeClearance: resolvedMinPadEdgeToPadEdgeClearance,
      minBoardEdgeClearance: resolvedMinBoardEdgeClearance,
      nominalTraceWidth,
      outline: board?.outline?.map((point) => ({ ...point })),
    },
    connMap: sharedConnMap,
  }
}
