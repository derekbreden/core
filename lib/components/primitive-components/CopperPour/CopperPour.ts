import { copperPourProps, type CopperPourProps } from "@tscircuit/props"
import {
  CopperPourPipelineSolver,
  convertCircuitJsonToInputProblem,
  initializeManifoldGeometry,
} from "@tscircuit/copper-pour-solver"
import { PrimitiveComponent } from "../../base-components/PrimitiveComponent"
import { createNetsFromProps } from "lib/utils/components/createNetsFromProps"
import type { Net } from "../Net"
import type { PcbCopperPour } from "circuit-json"
import { markTraceSegmentsInsideCopperPour } from "./utils/mark-trace-segments-inside-copper-pour"

export type { CopperPourProps }

export class CopperPour extends PrimitiveComponent<typeof copperPourProps> {
  isPcbPrimitive = true

  get config() {
    return {
      componentName: "CopperPour",
      zodProps: copperPourProps,
    }
  }

  getPcbSize(): { width: number; height: number } {
    return { width: 0, height: 0 }
  }

  doInitialCreateNetsFromProps(): void {
    const { _parsedProps: props } = this
    createNetsFromProps(this, [props.connectsTo])
  }

  doInitialPcbCopperPourRender() {
    if (this.root?.pcbDisabled) return
    this._queueAsyncEffect("PcbCopperPourRender", async () => {
      const { db } = this.root!
      const { _parsedProps: props } = this

      const net = this.getSubcircuit().selectOne(props.connectsTo) as Net | null
      if (!net || !net.source_net_id) {
        this.renderError(`Net "${props.connectsTo}" not found for copper pour`)
        return
      }
      const subcircuit = this.getSubcircuit()
      // PATCH(homesodamachine): the router's vias are already full-stack through-holes — the
      // homesodamachine @tscircuit/capacity-autorouter fork emits only top<->bottom vias (see its
      // convertHdRouteToSimplifiedRoute + the via-placement guard, gated by the board viaMode prop),
      // and the auto-stitch below spans opposite outer layers. So the former post-hoc re-span pass
      // is gone; the board DRC (clearance.ts) asserts no blind/buried via survives.
      // PATCH(homesodamachine): auto-stitch EVERY cross-layer SMD plane pad to its plane, in
      // ONE idempotent pass over ALL poured nets, before this pour's brep is solved. Why this
      // shape:
      //  - An SMD pad sits on one layer; a THT barrel reaches all layers for free. A pad whose
      //    plane net is poured on a DIFFERENT layer floats unless stitched, and DRC is
      //    pour-blind so it never flags it.
      //  - The via MUST carry the net or the pour solver rings it as foreign copper and it
      //    stays isolated (the trap bare <pcbtrace> vias fell into). So mirror an autorouter
      //    via: a pcb_trace on the pad's existing pad->net source_trace, referenced by the via
      //    (connectivity runs pad -> source_trace -> net -> via).
      //  - It is a THROUGH via (outer-to-outer), never a blind via to an inner plane — JLCPCB
      //    drills through-holes only; the through-via antipad guard (copper-pour-solver)
      //    connects it to its net's plane wherever that sits and antipads the rest.
      //  - ALL poured nets are stitched in this single pass (not just this pour's net): pours
      //    render in arbitrary order, so if a pad's via were created only by its own net's
      //    pour, a different-net pour solving first would flood over the not-yet-existing via.
      //    Creating them all up front (idempotent via _viaAt) means every pour brep antipads
      //    every foreign via. The router separately reserves each spot (getSimpleRouteJson
      //    stitch-keepout). Via-in-pad -> order the PCBA with epoxy filled+capped vias (POFV).
      //    See plane-stitching.md.
      {
        const _cj0 = db.toArray()
        const _pourLyByNet = /* @__PURE__ */ new Map<string, Set<string>>()
        let _allPours: any[] = []
        try {
          _allPours = subcircuit.selectAll("copperpour")
        } catch {}
        for (const _cp of _allPours) {
          let _pn: any
          try {
            _pn = _cp.getSubcircuit().selectOne(_cp._parsedProps.connectsTo)
          } catch {}
          const _ly = _cp._parsedProps && _cp._parsedProps.layer
          if (_pn?.source_net_id && typeof _ly === "string") {
            let _s = _pourLyByNet.get(_pn.source_net_id)
            if (!_s) {
              _s = /* @__PURE__ */ new Set<string>()
              _pourLyByNet.set(_pn.source_net_id, _s)
            }
            _s.add(_ly)
          }
        }
        if (_pourLyByNet.size > 0) {
          const _portToSrc = /* @__PURE__ */ new Map<string, string>()
          for (const e of _cj0)
            if (e.type === "pcb_port")
              _portToSrc.set(e.pcb_port_id, e.source_port_id)
          const _sTraces = _cj0.filter(
            (e) => e.type === "source_trace",
          ) as any[]
          const _bd = db.pcb_board.list()[0]
          const _hole = _bd?.min_via_hole_diameter ?? 0.3
          const _outer = _bd?.min_via_pad_diameter ?? 0.5
          const _viaAt = (x: number, y: number) =>
            db.pcb_via
              .list()
              .some((v) => Math.abs(v.x - x) < 0.05 && Math.abs(v.y - y) < 0.05)
          for (const sp of _cj0 as any[]) {
            if (sp.type !== "pcb_smtpad" || !sp.pcb_port_id) continue
            const _spid = _portToSrc.get(sp.pcb_port_id)
            if (!_spid) continue
            // the source_trace tying this pad to a plane net poured on a DIFFERENT layer
            let _st: any = null
            for (const t of _sTraces) {
              if (!(t.connected_source_port_ids || []).includes(_spid)) continue
              if (
                (t.connected_source_net_ids || []).some((nid: string) => {
                  const s = _pourLyByNet.get(nid)
                  return s && [...s].some((l) => l !== sp.layer)
                })
              ) {
                _st = t
                break
              }
            }
            if (!_st || _viaAt(sp.x, sp.y)) continue
            const _toLy = sp.layer === "top" ? "bottom" : "top"
            const _tr = db.pcb_trace.insert({
              source_trace_id: _st.source_trace_id,
              route: [
                {
                  route_type: "via",
                  x: sp.x,
                  y: sp.y,
                  from_layer: sp.layer,
                  to_layer: _toLy,
                },
              ],
              subcircuit_id: subcircuit?.subcircuit_id ?? undefined,
            } as any)
            db.pcb_via.insert({
              pcb_trace_id: _tr.pcb_trace_id,
              x: sp.x,
              y: sp.y,
              hole_diameter: _hole,
              outer_diameter: _outer,
              layers: [sp.layer, _toLy],
              from_layer: sp.layer,
              to_layer: _toLy,
            } as any)
            if (process.env.POUR_SKIP_DEBUG)
              console.error(
                `[pour-stitch] ${sp.pcb_smtpad_id} ${sp.layer}<->${_toLy} @(${sp.x.toFixed(3)},${sp.y.toFixed(3)}) net=${_st.source_trace_id}`,
              )
          }
        }
      }
      const circuitJson = db.toArray()

      const clearance = props.clearance ?? 0.2
      const inputProblem = convertCircuitJsonToInputProblem(db.toArray(), {
        layer: props.layer,
        subcircuit_id: subcircuit?.subcircuit_id ?? undefined,
        source_net_id: net.source_net_id,
        pad_margin: props.padMargin ?? clearance,
        trace_margin: props.traceMargin ?? clearance,
        board_edge_margin: props.boardEdgeMargin ?? clearance,
        cutout_margin: props.cutoutMargin ?? clearance,
        outline: props.outline,
      })

      await initializeManifoldGeometry()
      const solver = new CopperPourPipelineSolver(inputProblem)

      this.root!.emit("solver:started", {
        solverName: "CopperPourPipelineSolver",
        solverParams: inputProblem,
        componentName: this.props.name,
      })

      const { brep_shapes } = solver.getOutput()

      const coveredWithSolderMask = props.coveredWithSolderMask ?? false

      for (const brep_shape of brep_shapes) {
        const insertedPour = db.pcb_copper_pour.insert({
          shape: "brep",
          layer: props.layer,
          brep_shape,
          source_net_id: net.source_net_id,
          subcircuit_id: subcircuit?.subcircuit_id ?? undefined,
          covered_with_solder_mask: coveredWithSolderMask,
        } as PcbCopperPour)

        markTraceSegmentsInsideCopperPour({
          db,
          copperPour: insertedPour,
        })
      }
    })
  }
}
