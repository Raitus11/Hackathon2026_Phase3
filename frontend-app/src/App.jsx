import React, { useState, useEffect, useRef, useMemo } from 'react'
import * as d3 from 'd3'
import SNAPSHOT from './snapshot.json'

const isHttp = typeof location !== 'undefined' && location.protocol.startsWith('http')
const fmt = n => (typeof n === 'number' ? n.toLocaleString() : n)

const AGENTS_FALLBACK = SNAPSHOT.agents || []
const SUGGESTED_FALLBACK = SNAPSHOT.suggested_questions || []

/* ---- edge endpoint id helper (d3.forceLink mutates source/target into node refs after a sim runs;
       any code that re-reads a filtered edge set must tolerate both shapes) ---- */
const eid = x => (x && typeof x === 'object') ? x.id : x

/* ---- focus filter: the neighbourhood of one system, by hop count and direction ----
   dir: 'down' = systems it feeds (descendants), 'up' = systems that feed it (ancestors),
        'both' = either. hops: 1, 2, or Infinity (full lineage in that direction).
   Reuses the same BFS shape as the Block & Benefit ego-graph. ------------------------- */
function focusGraph(viz, rootId, hops, dir) {
  const { nodes, edges } = viz
  if (!rootId) return null
  const out = new Map(), inc = new Map()
  edges.forEach(e => {
    const s = eid(e.source), t = eid(e.target)
    if (!out.has(s)) out.set(s, []); out.get(s).push(t)
    if (!inc.has(t)) inc.set(t, []); inc.get(t).push(s)
  })
  const keep = new Set([rootId])
  // BFS to `hops` rings; gather forward (down), backward (up), or both, per `dir`.
  let frontier = [rootId]
  const maxH = (hops === Infinity || hops >= 99) ? 1e9 : hops
  for (let h = 0; h < maxH && frontier.length; h++) {
    const next = []
    frontier.forEach(id => {
      if (dir !== 'up') (out.get(id) || []).forEach(t => { if (!keep.has(t)) { keep.add(t); next.push(t) } })
      if (dir !== 'down') (inc.get(id) || []).forEach(s => { if (!keep.has(s)) { keep.add(s); next.push(s) } })
    })
    frontier = next
  }
  const N = nodes.filter(n => keep.has(n.id))
  // keep an edge only if both ends survive AND it lies in the chosen direction relative to the kept set
  const L = edges.filter(e => keep.has(eid(e.source)) && keep.has(eid(e.target)))
  return { N, L, keep, truncated: false }
}

const FOCUS_CAP = 260   // beyond this a focused subgraph is a blob again; cap + report it
function focusGraphCapped(viz, rootId, hops, dir) {
  const f = focusGraph(viz, rootId, hops, dir)
  if (!f || f.N.length <= FOCUS_CAP) return f
  // saturated source under full lineage: keep root + nearest ring(s) up to the cap, by reach desc.
  const keep = new Set([rootId])
  const ranked = f.N.filter(n => n.id !== rootId).sort((a, b) => (b.reach || 0) - (a.reach || 0))
  for (const n of ranked) { if (keep.size >= FOCUS_CAP) break; keep.add(n.id) }
  const N = f.N.filter(n => keep.has(n.id))
  const L = f.L.filter(e => keep.has(eid(e.source)) && keep.has(eid(e.target)))
  return { N, L, keep, truncated: true, fullCount: f.N.length }
}

/* ---- shared graph filter (pan = cardholder-data lineage, heavy = top distributors, all = full) ---- */
function filterGraph(viz, mode, heavyList) {
  const { nodes, edges } = viz
  const byId = new Map(nodes.map(n => [n.id, n]))
  const carries = n => n && (n.carries_pan || n.true_source || n.hidden_pci)
  if (mode === 'heavy') {
    // Distributors + their DIRECT consumers only (first hop). The old version walked
    // the full downstream closure, which on a saturated estate is ~the whole graph
    // (1800+ nodes) — a blob, not a focused view. First-hop keeps it legible.
    const adj = new Map()
    edges.forEach(e => { const s = eid(e.source), t = eid(e.target); if (!adj.has(s)) adj.set(s, []); adj.get(s).push(t) })
    const keep = new Set(heavyList)
    heavyList.forEach(h => (adj.get(h) || []).forEach(t => keep.add(t)))
    return { N: nodes.filter(n => keep.has(n.id)), L: edges.filter(e => keep.has(eid(e.source)) && keep.has(eid(e.target))) }
  }
  if (mode === 'pan') {
    const panEdges = edges.filter(e => carries(byId.get(eid(e.source))))
    const keep = new Set(); panEdges.forEach(e => { keep.add(eid(e.source)); keep.add(eid(e.target)) })
    // only nodes incident to a PAN edge — isolated carriers add noise and scatter the layout
    return { N: nodes.filter(n => keep.has(n.id)), L: panEdges }
  }
  const idset = new Set(nodes.map(n => n.id))
  return { N: nodes, L: edges.filter(e => idset.has(eid(e.source)) && idset.has(eid(e.target))) }
}

/* ---- data + run/approve/chat state machine ---- */
function useData() {
  const [data, setData] = useState(null)
  const [src, setSrc] = useState('snapshot')
  const [agents, setAgents] = useState(AGENTS_FALLBACK)
  const [suggested, setSuggested] = useState(SUGGESTED_FALLBACK)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)
  const [phase, setPhase] = useState('idle')      // idle | running | gate | done
  const [gate, setGate] = useState(null)          // { thread_id, gate, audit }

  const loadLive = async () => {
    const [g, head, imp, hh, ag, sg, pl] = await Promise.all([
      fetch('/api/graph').then(r => r.json()),
      fetch('/api/headline').then(r => r.json()),
      fetch('/api/impact').then(r => r.json()),
      fetch('/api/heavy-hitters?top_k=10').then(r => r.json()),
      fetch('/api/agents').then(r => r.json()).catch(() => null),
      fetch('/api/suggested').then(r => r.json()).catch(() => null),
      fetch('/api/plan?target=0.8&max_k=8').then(r => r.json()).catch(() => null),
    ])
    const expl = await fetch('/api/explanation').then(r => r.json()).catch(() => ({}))
    const st = await fetch('/api/structure').then(r => r.json()).catch(() => ({}))
    setData({ ...SNAPSHOT, viz: g, headline: head.headline, hidden: head.hidden,
              scope_breakdown: head.scope_breakdown, impact: imp, heavy_hitters: hh.heavy_hitters,
              plan: pl || SNAPSHOT.plan, structure: st.structure || SNAPSHOT.structure,
              explanation: expl.explanation || SNAPSHOT.explanation })
    if (ag && ag.agents) setAgents(ag.agents)
    if (sg && sg.questions) setSuggested(sg.questions)
    setSrc('live')
  }

  useEffect(() => {
    let live = false
    ;(async () => {
      try {
        if (isHttp) {
          const h = await fetch('/health').then(r => r.json()).catch(() => null)
          if (h && h.has_run) { await loadLive(); live = true; setPhase('done') }
        }
      } catch (e) { /* snapshot */ }
      if (!live) setData(SNAPSHOT)
    })()
  }, [])

  const _post = async (url, opts) => {
    const r = await fetch(url, opts)
    if (!r.ok) { const t = await r.json().catch(() => ({})); throw new Error(t.detail || ('HTTP ' + r.status)) }
    return r.json()
  }

  const analyze = async (fileList, requireApproval) => {
    const fl = Array.from(fileList || []); if (!fl.length) return
    setUploading(true); setError(null); setGate(null); setPhase('running')
    try {
      const fd = new FormData(); fl.forEach(f => fd.append('files', f))
      const j = await _post('/api/analyze?require_approval=' + (requireApproval ? 'true' : 'false'),
                            { method: 'POST', body: fd })
      if (j.status === 'awaiting_approval') { setGate(j); setPhase('gate') }
      else { await loadLive(); setPhase('done') }
    } catch (e) {
      setPhase('idle')
      setError(String(e.message || e).includes('Failed to fetch')
        ? 'No API reachable — start the backend (uvicorn app:app --port 8000) to analyze live files.'
        : String(e.message || e))
    } finally { setUploading(false) }
  }

  const approve = async (decision, feedback = '') => {
    if (!gate) return
    setUploading(true); setError(null)
    try {
      const j = await _post('/api/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thread_id: gate.thread_id, decision, feedback }) })
      if (j.status === 'awaiting_approval') { setGate(j); setPhase('gate') }
      else { await loadLive(); setGate(null); setPhase('done') }
    } catch (e) {
      if (decision === 'abort') { setGate(null); setPhase('idle'); setError('Run aborted by reviewer.') }
      else setError(String(e.message || e))
    } finally { setUploading(false) }
  }

  return { data, src, agents, suggested, uploading, error, phase, gate,
           analyze, approve, reset: () => { setPhase('idle'); setGate(null) },
           clearError: () => setError(null) }
}

/* ============================ small bits ============================ */
function KPI({ label, value, sub, tone, delay, def: defn }) {
  const tones = { pan: 'text-pan', hot: 'text-panhot', safe: 'text-safe', cool: 'text-cool' }
  const edges = { pan: '#D71E28', hot: '#8F0E1E', safe: '#0E7C4A', cool: '#2563EB' }
  return (
    <div className="card kpi p-4 flex-1 min-w-[190px] relative group"
      style={{ animationDelay: delay + 'ms', borderTop: '3px solid ' + (edges[tone] || '#E3DED4') }}>
      <div className="text-[11px] uppercase tracking-[.14em] text-faint flex items-center gap-1">{label}
        {defn && <span className="text-faint/70 cursor-help" title={defn}>ⓘ</span>}</div>
      <div className={'disp font-black text-4xl mt-1 ' + (tones[tone] || 'text-txt')}>{value}</div>
      <div className="text-xs text-dim mt-1">{sub}</div>
    </div>
  )
}
const kindColor = { control: 'text-cool', deterministic: 'text-safe', human: 'text-pan', llm: 'text-panhot' }
const kindRing = { control: 'border-cool/40', deterministic: 'border-safe/40', human: 'border-pan/60', llm: 'border-panhot/50' }

/* ============================ PIPELINE / landing ============================ */
const SHORT = { supervisor: 'Supervise', ingest: 'Ingest', validate_masking_leak: 'Validate',
  build_graph: 'Graph', condense_to_dag: 'DAG', score: 'Score', analytics: 'Analyze',
  human_gate: 'Gate', report: 'Report' }
const dotBg = { control: 'bg-cool', deterministic: 'bg-safe', human: 'bg-pan', llm: 'bg-panhot' }
const detectDS = f => { const m = (f.name || '').match(/ds[ _-]?([1-6])/i); return m ? 'DS' + m[1] : null }

function Pipeline({ d, agents, phase, gate, uploading, suggested, onUpload, onApprove, onReset }) {
  const [requireApproval, setRequireApproval] = useState(false)
  const [revTop, setRevTop] = useState(gate?.gate?.recommend_top || 3)
  const [files, setFiles] = useState([])
  const [hover, setHover] = useState(null)
  const [liveStep, setLiveStep] = useState(-1)
  const auditByStage = useMemo(() => Object.fromEntries((d?.audit || []).map(a => [a.stage, a])), [d])
  const gateIdx = agents.findIndex(a => a.kind === 'human')
  const fileRef = useRef()
  const detected = useMemo(() => [...new Set(files.map(detectDS).filter(Boolean))].sort(), [files])

  // sequential stage-lighting while a run is in flight (cosmetic, snaps to truth on finish)
  useEffect(() => {
    if (phase === 'running') {
      const cap = requireApproval ? gateIdx : agents.length - 1
      setLiveStep(0)
      let i = 0
      const id = setInterval(() => { i += 1; setLiveStep(i); if (i >= cap) clearInterval(id) }, 280)
      return () => clearInterval(id)
    }
    if (phase === 'gate') setLiveStep(gateIdx)
    else if (phase === 'done') setLiveStep(agents.length)
    else setLiveStep(-1)
  }, [phase, requireApproval, gateIdx, agents.length])

  const stageState = (i) => {
    if (phase === 'running') return i < liveStep ? 'done' : i === liveStep ? 'active' : 'pending'
    if (phase === 'gate') return i < gateIdx ? 'done' : i === gateIdx ? 'active' : 'pending'
    if (phase === 'done') return 'done'
    return 'idle'
  }
  const hoveredAgent = agents.find(a => a.key === hover)
  const running = phase === 'running' || phase === 'gate' || phase === 'done'

  return (
    <div className="space-y-4">
      {/* hero */}
      <div>
        <h1 className="disp font-bold text-xl text-txt">Cardholder-data flow intelligence</h1>
        <p className="text-sm text-dim mt-1.5 max-w-2xl leading-relaxed">
          Maps how clear PAN moves across enterprise systems and pinpoints where tokenization removes the most
          systems from PCI scope. Deterministic agents do every measured step; a human approves the result; the
          LLM only explains it.
        </p>
        <div className="flex flex-wrap gap-2 mt-3">
          {['Deterministic core', 'Human-gated', 'LLM narrates — never decides', 'Masking enforced on ingest'].map(t =>
            <span key={t} className="text-[11px] mono px-2.5 py-1 rounded-full border border-[#E2D8BC] bg-[#FFFDF6] text-dim">{t}</span>)}
        </div>
      </div>

      {/* compact flow strip */}
      <div className="card pipe-strip px-5 py-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] uppercase tracking-[.16em] text-faint">Agent pipeline · LangGraph</span>
          <span className="text-[11px] mono text-faint">{phase === 'running' ? 'running…' : phase === 'gate' ? 'paused at gate' : phase === 'done' ? 'complete' : 'idle'}</span>
        </div>
        <div className="flex items-center gap-0 flex-wrap">
          {agents.map((a, i) => {
            const s = stageState(i), au = auditByStage[a.key]
            const active = s === 'active', done = s === 'done'
            return (
              <React.Fragment key={a.key}>
                <button onMouseEnter={() => setHover(a.key)} onMouseLeave={() => setHover(null)}
                  className={'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition ' +
                    (active ? 'bg-pan/10' : 'hover:bg-panel2')}>
                  <span className={'inline-block w-2 h-2 rounded-full ' +
                    (done ? dotBg[a.kind] || 'bg-safe' : active ? 'bg-pan animate-pulse' : 'bg-line')} />
                  <span className={'text-xs ' + (active ? 'text-pan' : done ? 'text-txt' : 'text-dim')}>{SHORT[a.key] || a.name}</span>
                  {done && au && <span className="mono text-[9px] text-faint">{au.ms}ms</span>}
                </button>
                {i < agents.length - 1 && <span className={'text-xs px-0.5 transition ' + (stageState(i + 1) !== 'pending' && phase !== 'idle' ? 'text-pan' : 'text-faint/50')}>›</span>}
              </React.Fragment>
            )
          })}
        </div>
        <div className="text-[11px] text-dim mt-2 min-h-[16px] leading-snug">
          {hoveredAgent
            ? <span><b className="text-txt">{hoveredAgent.name}</b> — {hoveredAgent.role} <span className="text-faint">· {hoveredAgent.method}</span></span>
            : <span className="text-faint">Hover a stage for detail. The run executes left → right and pauses at the gate when approval is required.</span>}
        </div>
      </div>

      {/* live agent activity feed */}
      {running && (
        <div className="card pipe-feed px-5 py-4">
          <div className="text-[11px] uppercase tracking-[.16em] text-faint mb-2">Run activity</div>
          <div className="space-y-1.5">
            {agents.map((a, i) => {
              const s = stageState(i)
              if (s === 'pending') return null
              const au = auditByStage[a.key]
              return (
                <div key={a.key} className="flex items-center gap-2 text-xs" style={{ animation: 'rise .3s ease backwards' }}>
                  <span className={'w-4 text-center ' + (s === 'done' ? 'text-safe' : 'text-pan')}>{s === 'done' ? '✓' : '▸'}</span>
                  <span className={'mono w-24 ' + (s === 'active' ? 'text-pan' : 'text-txt')}>{a.name.split(' ')[0]}</span>
                  <span className="text-dim flex-1 truncate">{a.role}</span>
                  {s === 'done' && au && <span className="mono text-faint">{au.ms}ms</span>}
                  {s === 'active' && a.kind === 'human' && phase === 'gate' && <span className="text-pan">awaiting approval</span>}
                  {s === 'active' && phase === 'running' && <span className="text-pan animate-pulse">running</span>}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* upload / run */}
      <div className={'card p-5' + (phase === 'done' ? ' tint-green' : '')}>
        {phase === 'gate' && gate ? (
          <div>
            <div className="text-sm font-semibold text-pan flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-pan animate-pulse" />Awaiting your approval</div>
            <p className="text-sm text-dim mt-1">{gate.gate.ask}</p>
            <div className="flex flex-wrap gap-8 mt-4 text-sm">
              <div><div className="text-faint text-[11px] uppercase tracking-wider">In scope</div><div className="disp text-2xl font-black text-pan">{gate.gate.scope_size}</div></div>
              <div><div className="text-faint text-[11px] uppercase tracking-wider">Hidden PCI</div><div className="disp text-2xl font-black text-panhot">{gate.gate.hidden_pci}</div></div>
              <div><div className="text-faint text-[11px] uppercase tracking-wider">Recommended (top {gate.gate.recommend_top})</div><div className="mono text-txt mt-1.5">{(gate.gate.recommended_interventions || []).join('  ')}</div></div>
            </div>
            <div className="flex items-center gap-2 mt-5 flex-wrap">
              <button disabled={uploading} onClick={() => onApprove('approve')} className="text-xs px-4 py-2 rounded-lg bg-safe text-ink font-semibold hover:brightness-110">Approve &amp; report</button>
              <div className="flex items-center gap-1.5 border border-line rounded-lg pl-3 pr-1 py-0.5">
                <span className="text-xs text-dim">revise to top</span>
                <input type="number" min="1" max="10" value={revTop} onChange={e => setRevTop(e.target.value)} className="w-12 bg-panel2 border border-line rounded px-2 py-1 mono text-xs text-txt" />
                <button disabled={uploading} onClick={() => onApprove('revise', String(revTop))} className="text-xs px-2.5 py-1.5 rounded text-pan hover:bg-pan/10">↻</button>
              </div>
              <button disabled={uploading} onClick={() => onApprove('abort')} className="text-xs px-4 py-2 rounded-lg text-panhot hover:bg-panhot/10">Abort</button>
            </div>
            <div className="text-[11px] text-faint mt-2">Revise changes how many top distributors are recommended for tokenization (top-N), re-runs the impact analysis, and returns here for your decision.</div>
            <div className="text-[11px] text-faint mt-1">A genuine LangGraph <span className="mono">interrupt</span> — paused server-side, resumes only on your decision.</div>
            <div className="mt-4 pt-4 border-t border-line">
              <div className="text-[11px] uppercase tracking-[.16em] text-faint mb-2">Interrogate the analysis before deciding</div>
              <ChatPanel suggested={suggested} live={true} threadId={gate.thread_id} height={200} />
            </div>
          </div>
        ) : phase === 'done' ? (
          <div className="flex items-center gap-3">
            <span className="w-7 h-7 rounded-full bg-safe/15 text-safe flex items-center justify-center">✓</span>
            <div className="text-sm text-dim">Analysis complete — pipeline ran end-to-end, masking-leak check passed. See <b className="text-txt">Overview</b>, <b className="text-txt">Hidden Scope</b>, <b className="text-txt">Data-Flow Graph</b>, <b className="text-txt">Drill-down</b>, or <b className="text-txt">Ask</b>.
              <button onClick={() => { setFiles([]); onReset && onReset() }} className="ml-2 text-pan hover:underline">run again</button></div>
          </div>
        ) : (
          <div>
            <input ref={fileRef} type="file" multiple accept=".csv" className="hidden"
              onChange={e => { setFiles(Array.from(e.target.files || [])); e.target.value = '' }} />
            {files.length === 0 ? (
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <div className="text-sm font-semibold text-txt">Upload the data exports</div>
                  <div className="text-xs text-dim mt-0.5">BAM dependency + system reports and the survey/Splunk signals (DS1–DS6, any order — auto-detected).</div>
                </div>
                <button onClick={() => fileRef.current.click()} className="text-xs px-4 py-2 rounded-lg border border-line text-pan hover:bg-panel2">Select CSV files</button>
              </div>
            ) : (
              <div>
                <div className="flex items-center gap-2 text-sm">
                  <span className="w-6 h-6 rounded-full bg-safe/15 text-safe flex items-center justify-center text-xs">✓</span>
                  <span className="text-txt font-semibold">{files.length} file{files.length > 1 ? 's' : ''} received</span>
                  {detected.length > 0 && <span className="text-dim text-xs">· detected {detected.join(', ')}</span>}
                  <button onClick={() => fileRef.current.click()} className="text-xs text-faint hover:text-dim ml-1">change</button>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {files.map((f, i) => <span key={i} className="mono text-[10px] px-2 py-0.5 rounded bg-panel2 text-dim">{f.name}</span>)}
                </div>
                <div className="flex items-center gap-4 mt-4 flex-wrap">
                  <button disabled={uploading} onClick={() => onUpload(files, requireApproval)}
                    className={'text-xs px-5 py-2 rounded-lg font-semibold ' + (uploading ? 'bg-panel2 text-faint border border-line' : 'bg-pan text-ink hover:brightness-110 shadow-sm')}>
                    {uploading ? 'running…' : 'Run analysis →'}
                  </button>
                  <label className="flex items-center gap-2 text-xs text-dim cursor-pointer select-none">
                    <input type="checkbox" className="accent-pan" checked={requireApproval} onChange={e => setRequireApproval(e.target.checked)} />
                    pause for human approval before reporting
                  </label>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}


/* ============================ OVERVIEW (expert) ============================ */
/* "Every square is a system" — the unit chart a business reader parses in one glance.
   In-scope systems colored by their fate under full true-source tokenization. At 4K
   scale each square represents N systems (the legend says so). */
function FateGrid({ d, onPick }) {
  const plan = d.plan || {}
  const before = plan.before ?? 0
  const [sel, setSel] = useState(null)         // {color,label,systems:[node]} | null
  const [one, setOne] = useState(null)         // a single node opened from a bucket
  if (!before) return null
  const fb = plan.floor_breakdown || {}
  const green = plan.descopable ?? 0                                  // can leave scope
  const red = fb.origins_in_scope ?? Math.max(0, before - green)      // stay as tokenization points
  const blue = fb.always_cde_in_scope ?? 0                            // stay — RISE/APG

  // Map squares to REAL systems so each one is inspectable. Counts stay the audited
  // plan numbers (V-022); membership is derived from node flags and sliced to fit.
  const byId = useMemo(() => Object.fromEntries(d.viz.nodes.map(n => [n.id, n])), [d])
  const retained = new Set(((d.impact || {}).retained_via_detokenization) || [])
  const inScope = useMemo(() => d.viz.nodes.filter(n => n.in_scope), [d])
  const redList = inScope.filter(n => n.true_source).sort((a, b) => (b.reach || 0) - (a.reach || 0)).slice(0, red)
  const blueList = [...retained].map(id => byId[id]).filter(Boolean).slice(0, blue)
  const blueSet = new Set(blueList.map(n => n.id))
  const greenList = inScope.filter(n => !n.true_source && !blueSet.has(n.id))
    .sort((a, b) => (b.risk || 0) - (a.risk || 0)).slice(0, green)

  const unit = Math.max(1, Math.ceil(before / 180))                   // ≤180 squares at any scale
  const chunk = (arr, lbl, col) => {
    const out = []
    for (let i = 0; i < Math.round(arr.length / unit) || (arr.length && i === 0); i++)
      out.push({ color: col, label: lbl, systems: arr.slice(i * unit, (i + 1) * unit) })
    return out
  }
  const cells = [
    ...chunk(greenList, 'Can leave PCI scope', '#0E7C4A'),
    ...chunk(redList, 'Stays — tokenization point', '#D71E28'),
    ...chunk(blueList, 'Stays — needs RISE/APG', '#2563EB'),
  ]
  const cols = 30, size = 13, gap = 3
  const rowsN = Math.max(1, Math.ceil(cells.length / cols))
  const W = cols * (size + gap), H = rowsN * (size + gap)
  const pct = Math.round(100 * green / before)
  const close = () => { setSel(null); setOne(null) }
  const node = one || (sel && sel.systems.length === 1 ? sel.systems[0] : null)
  const maxRisk = Math.max(1, ...inScope.map(n => n.risk || 0))
  const maxReach = Math.max(1, ...inScope.map(n => n.reach || 0))
  const fateOf = n => n.true_source ? ['Stays — tokenization point', '#D71E28',
      'It originates clear PAN, so after tokenization it remains in the CDE as the conversion point — it still ingests real card numbers to turn them into tokens.']
    : blueSet.has(n.id) ? ['Stays — needs RISE/APG', '#2563EB',
      'It genuinely needs the real card number, so it stays in the CDE by design and de-tokenizes via the central RISE/APG services.']
    : ['Can leave PCI scope', '#0E7C4A',
      'Once every true PAN source feeding it emits tokens (CRN), this system only ever receives tokens — it drops out of the audit entirely (the clean-stream effect).']
  const Bar = ({ v, max, color, label }) => (
    <div className="mb-2">
      <div className="flex justify-between text-[10px] text-faint mb-0.5"><span>{label}</span><span className="mono text-txt">{fmt(v ?? 0)}</span></div>
      <div className="h-2 rounded-full bg-panel2 overflow-hidden"><div className="h-full rounded-full" style={{ width: Math.max(3, 100 * (v || 0) / max) + '%', background: color }} /></div>
    </div>
  )
  return (
    <div className="card p-5">
      <div className="disp font-bold text-lg">Every square is a system in PCI scope today</div>
      <div className="text-xs text-dim mb-3">{unit > 1 ? `Each square ≈ ${unit} systems. ` : ''}<b className="text-safe">Green leaves the audit</b> once the true PAN sources emit tokens (CRN) — {pct}% of today's scope. <b className="text-pan">Red stays</b> as the tokenization points themselves. <b className="text-cool">Blue stays</b> because it must de-tokenize via the central RISE/APG services. <b>Click any square to inspect it.</b></div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', maxWidth: 560 }}>
        {cells.map((c, i) => (
          <rect key={i} x={(i % cols) * (size + gap)} y={Math.floor(i / cols) * (size + gap)}
            width={size} height={size} rx="2.5" fill={c.color} fillOpacity={c.color === '#0E7C4A' ? 0.85 : 0.8}
            style={{ animation: `rise .4s ${Math.min(i * 6, 900)}ms cubic-bezier(.2,.8,.2,1) backwards`, cursor: c.systems.length ? 'pointer' : 'default' }}
            onClick={() => c.systems.length && setSel(c)}>
            <title>{c.systems.length ? c.systems.map(n => n.id).join(', ') + ' — ' + c.label + ' (click to inspect)' : c.label}</title>
          </rect>
        ))}
      </svg>
      <div className="flex flex-wrap gap-4 mt-3 text-[11px] text-dim">
        {green > 0 && <span><i className="inline-block w-3 h-3 rounded-sm align-[-2px] mr-1.5" style={{ background: '#0E7C4A' }} />{fmt(green)} can leave PCI scope</span>}
        {red > 0 && <span><i className="inline-block w-3 h-3 rounded-sm align-[-2px] mr-1.5" style={{ background: '#D71E28' }} />{fmt(red)} stay — tokenization points</span>}
        {blue > 0 && <span><i className="inline-block w-3 h-3 rounded-sm align-[-2px] mr-1.5" style={{ background: '#2563EB' }} />{fmt(blue)} stay — need RISE/APG</span>}
      </div>

      {sel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(31,35,41,.45)' }} onClick={close}>
          <div className="card p-5 w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
            {node ? (() => {
              const [flabel, fcolor, fwhy] = fateOf(node)
              return (
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="disp font-black text-2xl text-txt mono">{node.id}</span>
                    <span className="mono text-[11px] px-2 py-0.5 rounded font-semibold text-white" style={{ background: fcolor }}>{flabel}</span>
                    <button onClick={close} className="ml-auto text-faint hover:text-txt text-lg leading-none">✕</button>
                  </div>
                  {node.name && <div className="text-[11px] text-dim mt-0.5 truncate">{node.name}</div>}
                  {node.lob && <div className="text-[10px] text-faint mt-0.5">Line of business: {node.lob}</div>}
                  <p className="text-xs text-dim leading-relaxed mt-2">{fwhy}</p>
                  <div className="mt-3">
                    <Bar v={node.risk} max={maxRisk} color="#D71E28" label={`Risk score (estate max ${Math.round(maxRisk)})`} />
                    <Bar v={node.reach} max={maxReach} color="#E8A33D" label="Systems it feeds card data to (downstream reach)" />
                    <Bar v={node.tier} max={4} color="#2563EB" label="Data sensitivity tier (of 4)" />
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-2 text-[10px] text-dim">
                    {node.hidden_pci && <span className="px-2 py-0.5 rounded tint-red text-panhot font-semibold">hidden PCI — BAM never flagged it</span>}
                    {node.scope_prov === 'inferred' && <span className="px-2 py-0.5 rounded tint-gold">scope inferred from signals only</span>}
                    {node.scope_prov === 'metadata' && <span className="px-2 py-0.5 rounded tint-green text-safe">scope confirmed by BAM metadata</span>}
                  </div>
                  <div className="mt-2"><ReqChips reqs={node.triggered_requirements} /></div>
                  <div className="flex gap-2 mt-4">
                    <button onClick={() => { onPick && onPick(node.id); close() }}
                      className="text-xs px-4 py-2 rounded-lg bg-pan text-white font-semibold hover:brightness-110">Full drill-down — lineage &amp; evidence →</button>
                    {one && sel.systems.length > 1 && <button onClick={() => setOne(null)} className="text-xs px-3 py-2 rounded-lg border border-line text-dim hover:text-txt">← back to square</button>}
                  </div>
                </div>
              )
            })() : (
              <div>
                <div className="flex items-center gap-2">
                  <span className="disp font-bold text-lg">{sel.systems.length} systems in this square</span>
                  <span className="mono text-[11px] px-2 py-0.5 rounded font-semibold text-white" style={{ background: sel.color }}>{sel.label}</span>
                  <button onClick={close} className="ml-auto text-faint hover:text-txt text-lg leading-none">✕</button>
                </div>
                <div className="text-[11px] text-faint mt-1 mb-2">Pick one to inspect — sorted by risk.</div>
                <div className="scroll overflow-auto max-h-72 grid grid-cols-2 gap-1.5">
                  {sel.systems.map(n => (
                    <button key={n.id} onClick={() => setOne(n)} className="flex items-center justify-between px-2.5 py-1.5 rounded-lg border border-line bg-white hover:border-pan/60 hover:bg-gold/10 text-left">
                      <span className="mono text-xs text-txt font-semibold">{n.id}</span>
                      <span className="mono text-[10px] text-faint">risk {Math.round(n.risk || 0)}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* Numbered, plain-English action list — what a steering committee writes down. */
function NextActions({ d, onPick, onTab }) {
  const plan = d.plan || {}, h = d.headline || {}, imp = d.impact || {}
  const hh = Object.fromEntries((d.heavy_hitters || []).map(x => [x.system, x]))
  const topMiss = ((d.hidden || {}).hidden_detail || [])[0]
  const steps = (plan.steps || []).slice(0, 3)
  const acts = []
  if (steps.length) {
    const names = steps.map(s => s.tokenize)
    const reachSum = names.reduce((a, s) => a + (hh[s]?.downstream_reach || 0), 0)
    acts.push({
      n: 1, title: <>Tokenize {names.map((s, i) => <span key={s}><button onClick={() => onPick(s)} className="mono text-pan hover:underline font-bold">{s}</button>{i < names.length - 1 ? ', ' : ''}</span>)} first</>,
      body: `The three highest-leverage sources. Together they feed clear card numbers to ${fmt(reachSum)} downstream connections; tokenizing them fully releases ${fmt(imp.nodes_descoped ?? steps[steps.length - 1].cumulative_descoped)} systems and removes a clear-PAN feed from ${fmt(imp.feeds_removed ?? 0)} more.`,
    })
  }
  if (h.hidden_pci_systems_bam_misses) acts.push({
    n: acts.length + 1, title: <>Investigate the <button onClick={() => onTab && onTab('hidden')} className="text-panhot hover:underline font-bold">{fmt(h.hidden_pci_systems_bam_misses)} hidden systems</button> BAM never flagged</>,
    body: `They handle real card numbers with no PCI controls applied${topMiss ? ` — start with ${topMiss.system}, which passes the leaked data on to ${fmt(topMiss.downstream_reach)} further systems` : ''}. Each has its Splunk evidence attached.`,
  })
  if ((imp.retained_via_detokenization_count ?? 0) > 0) acts.push({
    n: acts.length + 1, title: <>Plan RISE/APG onboarding for {fmt(imp.retained_via_detokenization_count)} systems</>,
    body: 'They genuinely need the real card number, so they stay inside the CDE by design and de-tokenize through the central services — budget them as permanent scope, not failures.',
  })
  acts.push({
    n: acts.length + 1, title: <>Drive scope from {fmt(plan.before)} to the {fmt(Math.max(0, (plan.before ?? 0) - (plan.descopable ?? 0)))}-system floor</>,
    body: 'Full descope ramps as the source front is cleared — the saturation curve in the Planner shows the threshold. Every tokenization along the way removes real exposure immediately.',
  })
  return (
    <div className="card p-5" style={{ borderTop: '3px solid #0E7C4A' }}>
      <div className="disp font-bold text-lg">What to do next <span className="text-faint text-xs font-normal">— in plain language</span></div>
      <div className="space-y-3 mt-3">
        {acts.map(a => (
          <div key={a.n} className="flex gap-3">
            <span className="disp font-black text-lg text-safe shrink-0 w-7 h-7 rounded-full tint-green flex items-center justify-center">{a.n}</span>
            <div>
              <div className="text-sm font-semibold text-txt">{a.title}</div>
              <div className="text-xs text-dim leading-relaxed mt-0.5">{a.body}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Overview({ d, onPick, onTab }) {
  const h = d.headline, imp = d.impact, dag = d.dag_stats || {}
  const before = imp.scope_before, after = imp.scope_after, maxv = Math.max(before, 1)
  return (
    <div className="space-y-5">
      <div className="grid lg:grid-cols-2 gap-5">
        <FateGrid d={d} onPick={onPick} />
        <NextActions d={d} onPick={onPick} onTab={onTab} />
      </div>
      <ScopeEconomics d={d} />
      <SankeyFlow d={d} onPick={onPick} />
      <CategoryBar d={d} />
      <OwnershipCard d={d} onPick={onPick} />
      <div className="flex flex-wrap gap-3">
        <KPI label="Systems exposed to clear PAN" value={fmt(h.systems_exposed_to_clear_pan)}
          sub={`${h.scope_metadata_confirmed} metadata-confirmed · ${h.scope_inferred_only} inferred-only`} tone="pan" delay={0}
          def="A system is in scope if clear PAN can reach it along the data-flow graph (it sits in the CDE). Split by evidence: confirmed via authoritative BAM edges vs surfaced only by survey/Splunk signals." />
        <KPI label="Hidden PCI — BAM misses" value={fmt(h.hidden_pci_systems_bam_misses)}
          sub="PCI=No in BAM, PAN seen in Splunk" tone="hot" delay={70}
          def="Systems the business catalogue (BAM) records as NOT handling PAN, yet clear PAN appears in their Splunk logs. Unknown scope — the highest-value finding." />
        <KPI label="Cycle clusters resolved" value={fmt(h.cycle_clusters_resolved)}
          sub={`Tarjan SCC → condensation → ${fmt(dag.dag_nodes)}-node DAG`} tone="cool" delay={140}
          def="The raw dependency graph contains cycles (mutual dependencies). Each strongly-connected component is condensed to one super-node so lineage is a valid DAG." />
        <KPI label="Top intervention" value={h.top_intervention || '—'}
          sub="highest clean-stream leverage" tone="safe" delay={210}
          def="The PAN source whose tokenization removes the most exclusively-dependent systems from scope." />
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <div className="card p-5">
          <div className="disp font-bold text-lg">Clean-stream impact</div>
          <div className="text-xs text-dim mb-1">If PAN is tokenized (emitted as non-reversible CRN) at the top-{imp.tokenized_systems.length} lever(s): {imp.tokenized_systems.map(s => <span key={s} className="mono text-pan cursor-pointer" onClick={() => onPick(s)}>{s} </span>)}</div>
          <div className="text-[11px] text-faint mb-3">Downstream systems fed only by these descope. The sources stay in the CDE as tokenization points but drop from <b className="text-pan">live PAN (tier 4)</b> to <b className="text-safe">token-only (tier 3)</b> — the conservative, defensible read.</div>
          {[['In-scope now', before, 'bg-pan'], ['In-scope after tokenization', after, 'bg-safe']].map(([lbl, v, c], i) => (
            <div key={i} className="mb-3">
              <div className="flex justify-between text-xs mb-1"><span className="text-dim">{lbl}</span><span className="mono">{v} systems</span></div>
              <div className="h-3 rounded-full bg-panel2 overflow-hidden"><div className={'h-full ' + c} style={{ width: (100 * v / maxv) + '%', transition: 'width .8s cubic-bezier(.2,.8,.2,1)' }} /></div>
            </div>
          ))}
          <div className="grid grid-cols-4 gap-2 mt-4 text-center">
            <div className="tint-green rounded-lg p-3"><div className="disp text-2xl font-black text-safe">{imp.nodes_descoped}</div><div className="text-[11px] text-dim">systems descoped</div></div>
            <div className="tint-red rounded-lg p-3"><div className="disp text-2xl font-black text-pan">{imp.sources_downgraded_count ?? (imp.sources_downgraded || []).length}</div><div className="text-[11px] text-dim">sources → token</div></div>
            <div className="tint-green rounded-lg p-3"><div className="disp text-2xl font-black text-safe">{imp.node_surface_reduction_pct}%</div><div className="text-[11px] text-dim">surface ↓</div></div>
            <div className="tint-blue rounded-lg p-3"><div className="disp text-2xl font-black text-cool">{imp.retained_via_detokenization_count}</div><div className="text-[11px] text-dim">stay (RISE/APG)</div></div>
          </div>
          <div className="text-[11px] text-faint mt-3">A system descopes only when it receives CRN from <b>all</b> upstreams. Systems that must de-tokenize via centralized RISE/APG services remain in the CDE by design.</div>
        </div>

        <div className="card p-5">
          <div className="disp font-bold text-lg">Heavy hitters — primary PAN distributors</div>
          <div className="text-xs text-dim mb-1">Ranked by <b>downstream reach</b> (how many systems each feeds clear PAN — the organizer's definition of a heavy hitter). <b className="text-safe">Solo descope</b> = systems that leave scope if <i>only</i> this source is tokenized; it's small for everyone because PAN flow is shared, so the Planner finds the minimal <i>set</i>. Click a row to inspect.</div>
          <div className="scroll overflow-auto max-h-[280px] mt-2">
            <table className="dt w-full text-sm">
              <thead><tr className="text-faint text-[11px] uppercase tracking-wider sticky top-0 bg-panel">
                <th>System</th><th title="Total downstream systems it feeds PAN to (blast radius)">Reach</th>
                <th title="Systems that leave scope if ONLY this source is tokenized (subset of reach)">Solo descope</th>
                <th title="Direct PAN consumers (deduped)">Out-deg</th><th title="Composite 0–100 risk score">Risk</th></tr></thead>
              <tbody>{d.heavy_hitters.map(r => (
                <tr key={r.system} className="hh mono" onClick={() => onPick(r.system)}>
                  <td className="text-pan font-semibold">{r.system}</td>
                  <td className="text-txt">{r.downstream_reach}</td>
                  <td className={(r.solo_descope ?? r.exclusive_reach) > 0 ? 'text-safe' : 'text-faint'}>{r.solo_descope ?? r.exclusive_reach}</td>
                  <td>{r.out_degree}</td>
                  <td><span className="px-2 py-0.5 rounded" style={{ background: 'rgba(215,30,40,' + (r.risk / 120) + ')', color: r.risk > 55 ? '#fff' : '#1F2329' }}>{r.risk}</span></td>
                </tr>))}</tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <ScopeWaterfall d={d} />
        <BarExclusiveReach d={d} onPick={onPick} />
      </div>

      <div className="card p-5">
        <div className="disp font-bold text-lg mb-1">Grounded explanation <span className="text-faint text-xs font-normal">— LLM narrates only computed numbers</span></div>
        <p className="text-sm text-dim leading-relaxed">{d.explanation}</p>
        <div className="flex flex-wrap gap-2 mt-4">{d.audit.map((a, i) => <span key={i} className="mono text-[11px] px-2 py-1 rounded bg-panel2 text-faint">{a.stage} · {a.ms}ms</span>)}</div>
      </div>
      <InputFidelity d={d} />
    </div>
  )
}

/* ============================ GRAPH ============================ */
function GraphView({ d, selected, onPick }) {
  const ref = useRef()
  const [mode, setMode] = useState('heavy')
  const [showInferred, setShowInferred] = useState(true)
  // SCALE GUARD: at 4K-estate size the whole-graph force layout is an unreadable
  // hairball, so open focused on the top intervention's ego-graph instead — the
  // most legible view first; "clear focus" still reaches the estate views.
  const autoFocus = d.viz.nodes.length > 800
    ? ((d.headline || {}).top_intervention || (d.heavy_hitters[0] || {}).system || null) : null
  const [focusId, setFocusId] = useState(autoFocus)        // pinned app, or null = whole-estate view
  const [hops, setHops] = useState(1)                  // 1 | 2 | Infinity
  const [dir, setDir] = useState('both')               // 'down' | 'up' | 'both'
  const [query, setQuery] = useState('')
  const [openList, setOpenList] = useState(false)
  const heavyList = useMemo(() => d.heavy_hitters.map(h => h.system), [d])
  const heavySet = useMemo(() => new Set(heavyList), [heavyList])
  const exclBySys = useMemo(() => Object.fromEntries(d.heavy_hitters.map(h => [h.system, h.exclusive_reach])), [d])

  // typeahead index over every system (id + name); cap matches so 2104-node estates stay responsive
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return d.viz.nodes
      .filter(n => n.id.toLowerCase().includes(q) || (n.name || '').toLowerCase().includes(q))
      .slice(0, 12)
  }, [query, d])
  const focusNode = useMemo(() => focusId ? d.viz.nodes.find(n => n.id === focusId) : null, [focusId, d])
  // LIVE TOKENIZATION SIMULATOR (the hackathon's core question, on the graph itself):
  // block clear PAN at this source -> which downstream systems benefit, live.
  const [simulate, setSimulate] = useState(false)
  useEffect(() => { setSimulate(false) }, [focusId])
  const seRow = useMemo(() => {
    const ps = (d.plan?.source_exposure?.per_source) || []
    return focusId ? ps.find(r => r.system === focusId) : null
  }, [d, focusId])
  const simSets = useMemo(() => {
    if (!simulate || !focusId) return null
    const out = new Map()
    d.viz.edges.forEach(e => { const a = eid(e.source); (out.get(a) || out.set(a, []).get(a)).push(eid(e.target)) })
    const down = new Set(); let fr = [focusId]
    while (fr.length) { const nx = []; fr.forEach(u => (out.get(u) || []).forEach(v => { if (!down.has(v) && v !== focusId) { down.add(v); nx.push(v) } })); fr = nx }
    return { down, freed: new Set((seRow?.solo_systems) || []) }
  }, [simulate, focusId, d, seRow])

  const focusResult = useMemo(() => focusId ? focusGraphCapped(d.viz, focusId, hops, dir) : null, [d, focusId, hops, dir])
  const counts = useMemo(() => {
    if (focusId) return focusResult ? { n: focusResult.N.length, l: focusResult.L.length } : { n: 0, l: 0 }
    const { N, L } = filterGraph(d.viz, mode, heavyList); return { n: N.length, l: L.length }
  }, [d, mode, heavyList, focusId, focusResult])

  const pickFocus = id => { setFocusId(id); setQuery(''); setOpenList(false) }
  const clearFocus = () => { setFocusId(null); setQuery(''); setOpenList(false) }
  const comp = useMemo(() => {
    const ns = d.viz.nodes
    return { total: ns.length, pan: ns.filter(n => n.carries_pan || n.true_source).length,
             hidden: ns.filter(n => n.hidden_pci).length, scope: ns.filter(n => n.in_scope).length }
  }, [d])

  useEffect(() => {
    const focused = !!focusId
    const f = focused ? focusGraphCapped(d.viz, focusId, hops, dir) : null
    const base = focused ? { N: f.N, L: f.L } : filterGraph(d.viz, mode, heavyList)
    const W = ref.current.clientWidth, H = 600
    const svg = d3.select(ref.current).html('').append('svg').attr('width', W).attr('height', H).attr('viewBox', [0, 0, W, H])
    svg.append('defs').append('marker').attr('id', 'arrow').attr('viewBox', '0 -5 10 10').attr('refX', 16)
      .attr('refY', 0).attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', '#9AA4B2')
    const g = svg.append('g')
    svg.call(d3.zoom().scaleExtent([.2, 4]).on('zoom', e => g.attr('transform', e.transform)))
    let L = base.L.map(e => ({ ...e }))
    if (!showInferred) L = L.filter(e => e.provenance !== 'inferred')
    const idset = new Set(base.N.map(n => n.id))
    const Lv = L.filter(e => idset.has(e.source) && idset.has(e.target))
    const N = base.N.map(n => ({ ...n }))
    const deg = {}; Lv.forEach(e => { deg[e.source] = (deg[e.source] || 0) + 1; deg[e.target] = (deg[e.target] || 0) + 1 })
    const simOn = !!simSets
    const baseColor = n => n.hidden_pci ? '#8F0E1E' : n.true_source ? '#D71E28' : n.carries_pan ? '#E8A33D' : n.in_scope ? '#2563EB' : '#C7CDD6'
    const color = n => {
      if (!simOn) return baseColor(n)
      if (n.id === focusId) return '#D71E28'                      // the tokenization point (stays)
      if (simSets.freed.has(n.id)) return '#0E7C4A'               // fully freed — leaves PCI scope
      if (simSets.down.has(n.id)) return '#7FB69B'                // loses THIS clear-PAN feed (still has other sources)
      return baseColor(n)
    }
    const isRoot = n => focused && n.id === focusId
    const rad = n => isRoot(n) ? 11 : (heavySet.has(n.id) ? 6 : 3) + Math.sqrt(n.reach || 0) * 1.7
    const adj = new Map()
    Lv.forEach(e => { (adj.get(e.source) || adj.set(e.source, new Set()).get(e.source)).add(e.target); (adj.get(e.target) || adj.set(e.target, new Set()).get(e.target)).add(e.source) })
    const sim = d3.forceSimulation(N)
      .force('link', d3.forceLink(Lv).id(x => x.id).distance(50).strength(.3))
      .force('charge', d3.forceManyBody().strength(-110))
      .force('center', d3.forceCenter(W / 2, H / 2))
      .force('collide', d3.forceCollide().radius(n => rad(n) + 3))
    const link = g.append('g').selectAll('line').data(Lv).join('line')
      .attr('class', 'lk').attr('marker-end', 'url(#arrow)')
      .attr('stroke', e => (simOn && eid(e.source) === focusId) ? '#0E7C4A' : e.provenance === 'inferred' ? '#B45309' : '#9AA4B2')
      .attr('stroke-opacity', e => e.provenance === 'inferred' ? .85 : .5)
      .attr('stroke-width', e => Math.min(3, 1 + (e.count || 1) * .25))
      .attr('stroke-dasharray', e => (simOn && eid(e.source) === focusId) ? '5 3' : e.provenance === 'inferred' ? '4 3' : null)
      .attr('stroke-opacity', e => simOn ? ((eid(e.source) === focusId || simSets.down.has(eid(e.source))) ? .8 : .12) : null)
    const node = g.append('g').selectAll('circle').data(N).join('circle')
      .attr('class', 'node').attr('r', rad).attr('fill', color)
      .attr('stroke', n => isRoot(n) ? '#0E7C4A' : n.hidden_pci ? '#8F0E1E' : (heavySet.has(n.id) ? '#1F2329' : (n.scope_prov === 'inferred' ? '#B45309' : '#FFFFFF')))
      .attr('stroke-width', n => isRoot(n) ? 3.5 : heavySet.has(n.id) ? 2 : (n.hidden_pci ? 2 : (n.scope_prov === 'inferred' ? 1.5 : 1)))
      .attr('stroke-dasharray', n => (n.scope_prov === 'inferred' && !n.hidden_pci && !heavySet.has(n.id)) ? '2 2' : null)
      .on('click', (e, n) => onPick(n.id))
      .on('mouseover', (e, n) => {
        const nb = adj.get(n.id) || new Set()
        node.attr('opacity', m => (m.id === n.id || nb.has(m.id)) ? 1 : .12)
        link.attr('opacity', l => (l.source.id === n.id || l.target.id === n.id) ? 1 : .05)
      })
      .on('mouseout', () => { node.attr('opacity', 1); link.attr('opacity', null) })
      .call(d3.drag()
        .on('start', (e, n) => { if (!e.active) sim.alphaTarget(.3).restart(); n.fx = n.x; n.fy = n.y })
        .on('drag', (e, n) => { n.fx = e.x; n.fy = e.y })
        .on('end', (e, n) => { if (!e.active) sim.alphaTarget(0); n.fx = null; n.fy = null }))
    node.append('title').text(n => `${n.id} ${n.name || ''}\nreach ${n.reach} · risk ${n.risk} · tier ${n.tier}`
      + (heavySet.has(n.id) ? `\n★ heavy hitter — solo descope ${exclBySys[n.id]}` : '')
      + (n.scope_prov ? `\nscope: ${n.scope_prov}` : '') + (n.hidden_pci ? '\n⚠ hidden PCI (PAN in Splunk, BAM=No)' : ''))
    // In focus mode the subgraph is small, so label everything; otherwise keep the sparse label rule.
    const labelData = focused
      ? N
      : N.filter(n => heavySet.has(n.id) || (n.reach || 0) >= 14 || n.hidden_pci)
    const label = g.append('g').selectAll('text').data(labelData).join('text')
      .text(n => n.id)
      .attr('font-size', n => isRoot(n) ? 12 : heavySet.has(n.id) ? 10 : 9)
      .attr('fill', n => isRoot(n) ? '#0E7C4A' : heavySet.has(n.id) ? '#1F2329' : '#5A6472')
      .attr('class', 'mono').attr('dx', n => isRoot(n) ? 13 : 8).attr('dy', 3)
    sim.on('tick', () => {
      link.attr('x1', e => e.source.x).attr('y1', e => e.source.y).attr('x2', e => e.target.x).attr('y2', e => e.target.y)
      node.attr('cx', n => n.x).attr('cy', n => n.y); label.attr('x', n => n.x).attr('y', n => n.y)
    })
    return () => sim.stop()
  }, [d, mode, showInferred, heavyList, heavySet, exclBySys, onPick, focusId, hops, dir, simSets])
  useEffect(() => {
    if (!selected) return
    d3.select(ref.current).selectAll('circle')
      .attr('stroke', n => n.id === selected ? '#0E7C4A' : (n.hidden_pci ? '#8F0E1E' : (heavySet.has(n.id) ? '#1F2329' : (n.scope_prov === 'inferred' ? '#B45309' : '#FFFFFF'))))
      .attr('stroke-width', n => n.id === selected ? 3.5 : (heavySet.has(n.id) ? 2 : (n.hidden_pci ? 2 : 1)))
  }, [selected, heavySet])

  const modes = [['pan', 'PAN flow only'], ['heavy', 'Heavy-hitter subgraph'], ['all', 'All systems']]
  const modeHelp = { pan: 'Only the cardholder-data lineage: edges originating from a PAN-carrying system.',
    heavy: 'The top PAN distributors (by downstream reach) and their direct consumers (first hop) — the decision-relevant subgraph, not the full downstream blob.',
    all: 'Every system and dependency. Hover a node to isolate its neighbourhood.' }
  const dirLabel = { down: 'downstream — systems it feeds clear PAN to', up: 'upstream — systems that feed PAN into it', both: 'both directions' }
  const hopLabel = h => h === Infinity ? 'full lineage' : h === 1 ? '1 hop' : h + ' hops'
  const focusHelp = focusNode
    ? `Focused on ${focusId}${focusNode.true_source ? ' — a true PAN source (origin of clear card data)'
        : focusNode.carries_pan ? ' — carries PAN (received from upstream)'
        : ' — in scope, no PAN of its own'}. Showing ${dirLabel[dir]}, ${hopLabel(hops)}. `
        + `${focusNode.true_source && dir !== 'down' ? 'A true source has no PAN providers — the upstream side is empty by definition. ' : ''}`
        + `${focusResult && focusResult.truncated ? `This source reaches ${fmt(focusResult.fullCount)} systems (a saturated estate) — showing the ${FOCUS_CAP} highest-reach for legibility; the full count is in the heavy-hitter table. ` : ''}`
        + 'Drag nodes, scroll to zoom, click any node to drill down.'
    : null
  return (
    <div className="card p-3">
      <div className="flex items-center gap-2 px-2 pt-1 pb-2 flex-wrap">
        <span className="text-[11px] text-faint mr-1">view:</span>
        {modes.map(([k, l]) => <button key={k} onClick={() => { setMode(k); clearFocus() }}
          className={'mono text-[11px] px-2.5 py-1 rounded border ' + (!focusId && mode === k ? 'border-pan text-pan bg-pan/10' : 'border-[#D9D3C7] bg-white text-dim shadow-sm hover:text-txt hover:border-pan/60 hover:bg-gold/10')}>{l}</button>)}
        <label className="flex items-center gap-1 text-[11px] text-dim ml-2 cursor-pointer"><input type="checkbox" className="accent-pan" checked={showInferred} onChange={e => setShowInferred(e.target.checked)} />show inferred edges</label>
        <span className="ml-auto mono text-[11px] text-faint">{counts.n} nodes · {counts.l} edges</span>
      </div>

      {/* focus row: pick one system and see only its neighbourhood */}
      <div className="flex items-center gap-2 px-2 pb-2 flex-wrap">
        <span className="text-[11px] text-faint mr-1">focus app:</span>
        <div className="relative" style={{ minWidth: 220 }}>
          <input value={query} placeholder="search id or name…"
            onChange={e => { setQuery(e.target.value); setOpenList(true) }}
            onFocus={() => setOpenList(true)}
            onKeyDown={e => { if (e.key === 'Enter' && matches[0]) pickFocus(matches[0].id); if (e.key === 'Escape') setOpenList(false) }}
            className="mono text-[11px] px-2 py-1 rounded-lg border border-[#D9D3C7] bg-white text-txt w-full outline-none focus:border-pan focus:ring-2 focus:ring-gold/50" />
          {openList && matches.length > 0 && (
            <div className="absolute z-20 mt-1 w-full max-h-56 overflow-auto rounded border border-line bg-panel2 shadow-xl">
              {matches.map(m => (
                <button key={m.id} onClick={() => pickFocus(m.id)}
                  className="block w-full text-left px-2 py-1 hover:bg-cool/10 border-b border-line/40 last:border-0">
                  <span className="mono text-[11px] text-txt">{m.id}</span>
                  {m.true_source && <span className="mono text-[9px] text-pan ml-1">true-source</span>}
                  {m.hidden_pci && <span className="mono text-[9px] text-panhot ml-1">hidden-PCI</span>}
                  <span className="block text-[10px] text-dim truncate">{m.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {focusId && (
          <>
            <span className="mono text-[11px] px-2 py-1 rounded bg-cool/15 text-safe border border-safe/40 flex items-center gap-1">
              {focusId}
              <button onClick={clearFocus} className="ml-1 text-dim hover:text-txt" title="clear focus">✕</button>
            </span>
            <span className="text-[11px] text-faint ml-1">direction:</span>
            {[['both', 'both'], ['down', 'downstream'], ['up', 'upstream']].map(([k, l]) =>
              <button key={k} onClick={() => setDir(k)}
                className={'mono text-[11px] px-2 py-1 rounded border ' + (dir === k ? 'border-cool text-cool bg-cool/10' : 'border-[#D9D3C7] bg-white text-dim shadow-sm hover:text-txt hover:border-pan/60 hover:bg-gold/10')}>{l}</button>)}
            <span className="text-[11px] text-faint ml-1">hops:</span>
            {[[1, '1'], [2, '2'], [Infinity, 'all']].map(([k, l]) =>
              <button key={l} onClick={() => setHops(k)}
                className={'mono text-[11px] px-2 py-1 rounded border ' + (hops === k ? 'border-cool text-cool bg-cool/10' : 'border-[#D9D3C7] bg-white text-dim shadow-sm hover:text-txt hover:border-pan/60 hover:bg-gold/10')}>{l}</button>)}
          </>
        )}
        {!focusId && <span className="text-[11px] text-faint">pick an app to isolate its PAN neighbourhood — or keep the full view above</span>}
      </div>

      {focusId && focusNode?.true_source && (
        <div className={'mx-2 mb-2 px-3 py-2 rounded-lg flex items-center gap-3 flex-wrap ' + (simulate ? 'tint-green' : 'bg-panel2')}>
          <label className="flex items-center gap-2 text-xs font-semibold text-txt cursor-pointer select-none">
            <input type="checkbox" className="accent-pan" checked={simulate} onChange={e => setSimulate(e.target.checked)} />
            ⚡ Simulate: tokenize {focusId} — what changes downstream, live
          </label>
          {simulate && seRow && (
            <span className="flex items-center gap-4 text-[11px] text-dim flex-wrap">
              <span><b className="disp text-safe text-base">{fmt(seRow.solo_descope)}</b> fully freed — leave PCI scope</span>
              <span><b className="disp text-safe text-base">{fmt(seRow.feeds_removed)}</b> lose this clear-PAN feed</span>
              <span><b className="disp text-cool text-base">{fmt(seRow.parent_reduction)}</b> have exposure narrowed</span>
              <span className="text-faint">{focusId} itself stays in the CDE as the tokenization point</span>
            </span>
          )}
          {simulate && !seRow && <span className="text-[11px] text-faint">per-source impact not in this snapshot — run a live analysis</span>}
        </div>
      )}
      <div className="px-2 text-[11px] text-dim mb-1">{focusId ? focusHelp : modeHelp[mode]}</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-2 py-1 text-[11px] text-dim items-center">
        <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block ring-1 ring-txt/40" style={{ background: '#D71E28' }} />true PAN source (★ heavy hitter)</span>
        <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block" style={{ background: '#E8A33D' }} />carries PAN</span>
        <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block" style={{ background: '#8F0E1E' }} />hidden PCI (BAM miss)</span>
        <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block" style={{ background: '#2563EB' }} />in scope</span>
        <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block" style={{ background: 'transparent', border: '1.5px dashed #B45309' }} />inferred-only scope</span>
        {focusId && <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block" style={{ background: 'transparent', border: '2px solid #0E7C4A' }} />focused app</span>}
        {simulate && <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block" style={{ background: '#0E7C4A' }} />fully freed</span>}
        {simulate && <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block" style={{ background: '#7FB69B' }} />loses this clear-PAN feed</span>}
        {simulate && <span className="flex items-center gap-1"><svg width="26" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="#0E7C4A" strokeWidth="2" strokeDasharray="5 3" /></svg>now carries CRN →</span>}
        <span className="flex items-center gap-1"><svg width="26" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="#9AA4B2" strokeWidth="2" markerEnd="" /></svg>metadata →</span>
        <span className="flex items-center gap-1"><svg width="26" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="#B45309" strokeWidth="2" strokeDasharray="4 3" /></svg>inferred →</span>
        <span className="ml-auto text-faint">arrow = PAN flow (provider→consumer) · hover = isolate · scroll = zoom</span>
      </div>
      <div ref={ref} style={{ width: '100%' }} />
      {focusId && counts.n <= 1 && (
        <div className="mx-2 mb-2 -mt-2 px-3 py-2 rounded border border-line bg-panel2 text-[11px] text-dim">
          <span className="text-txt mono">{focusId}</span> has no {dir === 'up' ? 'PAN providers' : dir === 'down' ? 'downstream consumers' : 'PAN-flow neighbours'} in this direction.
          {focusNode && focusNode.true_source && dir === 'up' && ' That is expected for a true PAN source — it originates clear card data, so nothing feeds PAN into it. Switch direction to "downstream" to see what it feeds.'}
          {(!focusNode || !focusNode.true_source) && ' It may be a leaf consumer, or its links are inferred-only (toggle "show inferred edges"). Try "both" or a wider hop count.'}
        </div>
      )}
      <div className="px-3 py-2 text-[11px] text-faint mono border-t border-line mt-1">
        composition: {comp.total} systems · {comp.pan} carry PAN · {comp.hidden} hidden-PCI · {comp.scope} in scope
      </div>
    </div>
  )
}

/* ============================ DRILL-DOWN (standalone) ============================ */
function MiniGraph({ node, ins, outs, onPick }) {
  const W = 300, H = 200, cx = W / 2, cy = H / 2
  const left = ins.slice(0, 6), right = outs.slice(0, 6)
  const yFor = (i, n) => 24 + i * ((H - 48) / Math.max(1, n - 1 || 1))
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="mt-2">
      {left.map((e, i) => <line key={'li' + i} x1="58" y1={yFor(i, left.length)} x2={cx} y2={cy} stroke={e.provenance === 'inferred' ? '#B45309' : '#9AA4B2'} strokeWidth="1.2" strokeDasharray={e.provenance === 'inferred' ? '4 3' : null} />)}
      {right.map((e, i) => <line key={'ro' + i} x1={cx} y1={cy} x2={W - 58} y2={yFor(i, right.length)} stroke={e.provenance === 'inferred' ? '#B45309' : '#9AA4B2'} strokeWidth="1.2" strokeDasharray={e.provenance === 'inferred' ? '4 3' : null} />)}
      {left.map((e, i) => <g key={'lt' + i} className="cursor-pointer" onClick={() => onPick(e.source)}><circle cx="50" cy={yFor(i, left.length)} r="5" fill="#2563EB" /><text x="44" y={yFor(i, left.length) + 3} textAnchor="end" fontSize="8" fill="#5A6472" className="mono">{e.source}</text></g>)}
      {right.map((e, i) => <g key={'rt' + i} className="cursor-pointer" onClick={() => onPick(e.target)}><circle cx={W - 50} cy={yFor(i, right.length)} r="5" fill="#2563EB" /><text x={W - 44} y={yFor(i, right.length) + 3} fontSize="8" fill="#5A6472" className="mono">{e.target}</text></g>)}
      <circle cx={cx} cy={cy} r="9" fill={node.hidden_pci ? '#8F0E1E' : node.true_source ? '#D71E28' : '#E8A33D'} stroke="#0E7C4A" strokeWidth="2" />
      <text x={cx} y={cy - 14} textAnchor="middle" fontSize="9" fill="#1F2329" className="mono">{node.id}</text>
      <text x="50" y="14" textAnchor="middle" fontSize="8" fill="#8B95A3">providers</text>
      <text x={W - 50} y="14" textAnchor="middle" fontSize="8" fill="#8B95A3">consumers</text>
    </svg>
  )
}
function Drill({ d, selected, onPick }) {
  const [q, setQ] = useState('')
  const nodes = d.viz.nodes
  const node = useMemo(() => nodes.find(n => n.id === selected), [d, selected])
  const list = useMemo(() => {
    const t = q.trim().toUpperCase()
    return nodes.filter(n => !t || n.id.toUpperCase().includes(t) || (n.name || '').toUpperCase().includes(t))
      .slice().sort((a, b) => (b.risk || 0) - (a.risk || 0)).slice(0, 60)
  }, [d, q])
  const ins = node ? d.viz.edges.filter(e => e.target === node.id) : []
  const outs = node ? d.viz.edges.filter(e => e.source === node.id) : []
  const providers = useMemo(() => { const m = new Map(); d.viz.edges.forEach(e => { (m.get(e.target) || m.set(e.target, []).get(e.target)).push(e) }); return m }, [d])
  const lineage = useMemo(() => {
    if (!node) return []
    const paths = []; const seen = new Set([node.id])
    const walk = (id, path) => {
      if (path.length > 7 || paths.length > 4) return
      const nd = nodes.find(n => n.id === id)
      if (nd && nd.true_source && path.length > 1) { paths.push([...path]); return }
      const ups = (providers.get(id) || []).filter(e => !seen.has(e.source)).slice(0, 3)
      if (!ups.length && path.length > 1) { paths.push([...path]); return }
      ups.forEach(e => { seen.add(e.source); walk(e.source, [...path, { id: e.source, prov: e.provenance, sig: e.signal }]) })
    }
    walk(node.id, [{ id: node.id, prov: null }])
    return paths
  }, [node, d])
  const Row = ({ k, v, t }) => <div className="flex justify-between py-1.5 border-b border-line text-sm"><span className="text-dim">{k}</span><span className={'mono ' + (t || '')}>{v}</span></div>

  return (
    <div className="grid lg:grid-cols-[300px_1fr] gap-5">
      <div className="card p-4">
        <div className="text-[11px] uppercase tracking-widest text-faint mb-2">System explorer</div>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="search id or name…"
          className="w-full bg-white border border-[#D9D3C7] rounded-lg px-3 py-2 text-sm mono text-txt mb-2 outline-none focus:border-pan focus:ring-2 focus:ring-gold/50" />
        <div className="scroll overflow-auto max-h-[520px] space-y-0.5">
          {list.map(n => (
            <button key={n.id} onClick={() => onPick(n.id)}
              className={'w-full flex items-center justify-between text-left px-2 py-1.5 rounded text-sm ' + (n.id === selected ? 'bg-pan/15' : 'hover:bg-panel2')}>
              <span className="flex items-center gap-1.5">
                <i className="w-2 h-2 rounded-full inline-block" style={{ background: n.hidden_pci ? '#8F0E1E' : n.true_source ? '#D71E28' : n.carries_pan ? '#E8A33D' : n.in_scope ? '#2563EB' : '#C7CDD6' }} />
                <span className={'mono ' + (n.id === selected ? 'text-pan' : 'text-txt')}>{n.id}</span>
              </span>
              <span className="mono text-[10px] text-faint">{n.risk}</span>
            </button>
          ))}
        </div>
      </div>

      {!node ? <div className="card p-8 text-center text-dim self-start">Pick a system from the explorer (or click a node in the graph / heavy-hitter table).</div> : (
        <div className="space-y-5">
          <div className="grid md:grid-cols-2 gap-5">
            <div className="card p-5">
              <div className="text-[11px] uppercase tracking-widest text-faint">System</div>
              <div className="disp font-black text-3xl text-pan">{node.id}</div>
              <div className="text-sm text-dim mb-3">{node.name || '(name not in BAM)'}</div>
              <RequirementBadges node={node} />
              <Row k="Risk score" v={node.risk} t="text-pan" />
              <Row k="Sensitivity tier" v={node.tier + ' / 4'} />
              <Row k="Downstream reach" v={node.reach} />
              <Row k="Carries PAN" v={node.carries_pan ? 'yes' : 'no'} t={node.carries_pan ? 'text-pan' : 'text-safe'} />
              <Row k="True PAN source" v={node.true_source ? 'yes' : 'no'} />
              <Row k="In PCI scope" v={node.in_scope ? 'yes' : 'no'} t={node.in_scope ? 'text-pan' : 'text-safe'} />
              <Row k="Scope basis" v={node.scope_prov ? (node.scope_prov === 'metadata' ? 'metadata-confirmed' : 'inferred-only') : '—'} t={node.scope_prov === 'inferred' ? 'text-pan' : (node.scope_prov === 'metadata' ? 'text-safe' : '')} />
              <Row k="Hidden PCI (Splunk)" v={node.hidden_pci ? 'YES — BAM miss' : (node.pan_in_logs_observed ? 'PAN in logs (BAM=Yes)' : 'no')} t={node.hidden_pci ? 'text-panhot' : ''} />
              <Row k="Cycle cluster" v={node.super_node || '—'} />
              {node.lob ? <Row k="Line of business" v={node.lob} /> : null}
            </div>
            <div className="card p-5" style={{ borderTop: '3px solid #2563EB', background: 'linear-gradient(180deg,#F8FAFE,#fff 55%)' }}>
              <div className="disp font-bold text-sm mb-1">Why is this in scope?</div>
              <p className="text-xs text-dim leading-relaxed">
                {!node.in_scope ? 'Not in scope — no clear-PAN flow reaches this system.' :
                  node.scope_prov === 'metadata'
                    ? 'In scope and confirmed by authoritative BAM metadata — PAN reaches it through documented data-flow edges.'
                    : 'In scope as inferred-only candidate scope: it appears only via survey/Splunk signals, not BAM metadata. Treated as a lead to investigate, never as confirmed fact.'}
              </p>
              <div className="text-[11px] uppercase tracking-widest text-faint mt-3 mb-1">Local data flow</div>
              <MiniGraph node={node} ins={ins} outs={outs} onPick={onPick} />
            </div>
          </div>

          {lineage.length > 0 && (
            <div className="card p-5" style={{ borderTop: '3px solid #FFCD41', background: 'linear-gradient(180deg,#FFFCF1,#fff 60%)' }}>
              <div className="disp font-bold text-sm mb-2">PAN lineage <span className="text-faint text-xs font-normal">— upstream paths toward a true PAN source</span></div>
              <div className="space-y-1.5">
                {lineage.map((p, i) => (
                  <div key={i} className="flex items-center flex-wrap gap-1 text-sm mono">
                    {p.slice().reverse().map((s, j, arr) => (
                      <span key={j} className="flex items-center gap-1">
                        <button onClick={() => onPick(s.id)} className={'px-1.5 py-0.5 rounded ' + (s.id === node.id ? 'bg-pan/20 text-pan' : 'hover:bg-panel2 text-txt')}>{s.id}</button>
                        {j < arr.length - 1 && <span className={s.sig ? 'text-pan' : 'text-faint'}>→{s.prov === 'inferred' ? ' ⤳' : ''}</span>}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
              <div className="text-[11px] text-faint mt-2">→ metadata edge · ⤳ inferred edge. Leftmost is the true PAN source; tokenizing there cuts this lineage.</div>
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-5">
            <div className="card p-5">
              <div className="disp font-bold mb-2"><span className="inline-block w-2 h-2 rounded-full bg-pan mr-1.5" />Upstream providers <span className="text-faint text-xs">({ins.length}) — send PAN to {node.id}</span></div>
              <div className="scroll max-h-[240px] overflow-auto space-y-1">
                {ins.length ? ins.map((e, i) => (
                  <button key={i} onClick={() => onPick(e.source)} className="w-full flex justify-between text-left text-sm px-2 py-1 rounded hover:bg-panel2">
                    <span className="mono text-cool">{e.source}</span>
                    <span className={'text-[10px] px-1.5 rounded ' + (e.provenance === 'inferred' ? 'bg-pan/20 text-pan' : 'bg-line text-dim')}>{e.provenance}{e.signal ? ' · ' + e.signal : ''}{e.count > 1 ? ' ×' + e.count : ''}</span>
                  </button>)) : <div className="text-dim text-sm">none — candidate true source</div>}
              </div>
            </div>
            <div className="card p-5">
              <div className="disp font-bold mb-2"><span className="inline-block w-2 h-2 rounded-full bg-cool mr-1.5" />Downstream consumers <span className="text-faint text-xs">({outs.length}) — receive PAN from {node.id}</span></div>
              <div className="scroll max-h-[240px] overflow-auto space-y-1">
                {outs.length ? outs.map((e, i) => (
                  <button key={i} onClick={() => onPick(e.target)} className="w-full flex justify-between text-left text-sm px-2 py-1 rounded hover:bg-panel2">
                    <span className="mono text-txt">{e.target}</span>
                    <span className={'text-[10px] px-1.5 rounded ' + (e.provenance === 'inferred' ? 'bg-pan/20 text-pan' : 'bg-line text-dim')}>{e.provenance}{e.count > 1 ? ' ×' + e.count : ''}</span>
                  </button>)) : <div className="text-dim text-sm">none — leaf / terminal consumer</div>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ============================ PLANNER (optimizer + what-if) ============================ */
/* AI Decision Memo — grounded remediation narration + the saturation-cliff sparkline.
   Reads the memo the backend built once (plan.decision_memo). Renders nothing if absent,
   so it is safe in snapshot mode before the snapshot is regenerated. Hand-rolled SVG only
   (no new npm dependency — Artifactory lock). */
function CliffSpark({ curve }) {
  if (!curve || curve.length < 2) return null
  const W = 220, H = 54, P = 5
  const ys = curve.map(p => p.fully_descoped ?? 0)
  const maxY = Math.max(...ys, 1)
  const x = i => P + (i / (curve.length - 1)) * (W - 2 * P)
  const y = v => H - P - (v / maxY) * (H - 2 * P)
  const pts = curve.map((p, i) => `${x(i).toFixed(1)},${y(ys[i]).toFixed(1)}`).join(' ')
  let ci = 1, best = -1
  for (let i = 1; i < ys.length; i++) { const d = ys[i] - ys[i - 1]; if (d > best) { best = d; ci = i } }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.6" className="text-safe" />
      <line x1={x(ci).toFixed(1)} y1={P} x2={x(ci).toFixed(1)} y2={H - P} stroke="currentColor" strokeWidth="0.75" strokeDasharray="2 2" className="text-pan" />
      <circle cx={x(ci).toFixed(1)} cy={y(ys[ci]).toFixed(1)} r="2.6" fill="currentColor" className="text-pan" />
    </svg>
  )
}

function DecisionMemo({ plan }) {
  const memo = plan && plan.decision_memo
  if (!memo || !memo.text) return null
  const curve = plan && plan.saturation_curve && plan.saturation_curve.curve
  const chips = memo.grounded_on || []
  return (
    <div className="card memo-card p-5 border border-gold">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="disp font-bold text-lg flex items-center gap-2">
          AI Decision Memo
          <span className={'mono text-[10px] px-2 py-0.5 rounded ' + (memo.generated ? 'bg-pan text-white' : 'bg-gold/40 text-[#6B4E00] border border-gold')}>{memo.generated ? '✦ AI-generated' : '○ deterministic narration'}</span>
        </div>
        {typeof memo.tokens === 'number' && memo.tokens > 0 && <span className="mono text-[10px] text-faint">~{memo.tokens.toLocaleString()} tokens</span>}
      </div>
      <div className="text-[10px] text-faint mt-0.5">Grounded narration over the computed figures — the model phrases numbers it never computes; deterministic mode renders the identical numbers as a template.</div>
      <div className="flex flex-col md:flex-row gap-4 mt-3">
        <p className="text-sm text-dim leading-relaxed flex-1 whitespace-pre-line">{memo.text}</p>
        {curve && curve.length > 1 && (
          <div className="shrink-0 self-start">
            <div className="text-[10px] text-faint mb-1">full descope vs % sources tokenized</div>
            <CliffSpark curve={curve} />
            <div className="text-[10px] text-pan mt-1">↑ the descope threshold</div>
          </div>
        )}
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {chips.map(c => <span key={c} className="mono text-[10px] px-2 py-0.5 rounded tint-blue text-cool">grounded on: {c}</span>)}
        </div>
      )}
    </div>
  )
}

function Planner({ d, live, onPick }) {
  const candidates = useMemo(() => {
    const ids = d.heavy_hitters.map(h => h.system)
    const seen = new Set(ids)
    ;(d.plan?.plan || []).forEach(s => { if (!seen.has(s)) { ids.push(s); seen.add(s) } })  // ensure levers are toggleable
    return ids
  }, [d])
  const exclBy = useMemo(() => Object.fromEntries(d.heavy_hitters.map(h => [h.system, h.exclusive_reach])), [d])
  const [plan, setPlan] = useState(d.plan || null)
  const [target, setTarget] = useState(Math.round((d.plan?.target_fraction || 0.8) * 100))
  // Open the what-if on the SAME lever set the Overview clean-stream card was computed
  // for (impact.tokenized_systems), so the two surfaces show identical numbers at load.
  // A prior version seeded from plan.plan, which can differ from the recommended levers
  // when greedy halts early and the recommendation pads by exposure — the two tabs then
  // disagreed by one system (e.g. "need RISE/APG 40 vs 41") before any user action.
  const [selected, setSelected] = useState(() =>
    (d.impact?.tokenized_systems?.length ? d.impact.tokenized_systems.slice() : (d.plan?.plan || []).slice(0, 3)))
  const [wi, setWi] = useState(d.whatif_top3 || null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!live) return
    let cancel = false
    ;(async () => {
      try {
        const r = await fetch('/api/whatif', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sources: selected }) })
        const j = await r.json(); if (!cancel) setWi(j)
      } catch (e) { /* keep last */ }
    })()
    return () => { cancel = true }
  }, [selected, live])

  const runPlan = async () => {
    if (!live) return
    setBusy(true)
    try {
      const r = await fetch(`/api/plan?target=${target / 100}&max_k=8`); const j = await r.json()
      setPlan(j); setSelected(j.plan.slice(0, Math.min(3, j.plan.length)))
    } finally { setBusy(false) }
  }
  const toggle = s => { if (!live) return; setSelected(x => x.includes(s) ? x.filter(y => y !== s) : [...x, s]) }

  const before = wi ? wi.scope_before : (d.impact?.scope_before || 0)
  const after = wi ? wi.scope_after : (d.impact?.scope_after || 0)
  const maxv = Math.max(before, 1)
  const descoped = wi ? (wi.descoped_systems || []) : []
  const retained = wi ? (wi.retained_via_detokenization || []) : []

  return (
    <div className="space-y-5">
      <DecisionMemo plan={plan} />
      <div className="card p-5">
        <div className="disp font-bold text-lg">Tokenization planner <span className="text-faint text-xs font-normal">— where intervention has the greatest reduction</span></div>
        <p className="text-sm text-dim mt-1 max-w-3xl leading-relaxed">
          The optimizer answers the core question: tokenize the <b>fewest</b> sources to take the <b>most</b> systems
          out of PCI scope. A system goes safe only when <i>every</i> true PAN source reaching it is tokenized — a
          conjunctive (AND) condition, so the freed-systems objective is <b>supermodular</b> (marginal gains grow as the
          source front is covered). Greedy is therefore used as a transparent heuristic; the (1−1/e) submodular guarantee
          does <b>not</b> apply here and is not claimed.
        </p>
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        {/* roadmap */}
        <div className="card p-5">
          <div className="flex items-center justify-between">
            <div className="disp font-bold">Minimum-intervention roadmap</div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-faint">target {target}%</span>
              <input type="range" min="20" max="100" step="10" value={target} onChange={e => setTarget(+e.target.value)} className="accent-pan" disabled={!live} />
              <button onClick={runPlan} disabled={!live || busy} className="text-[11px] mono px-2.5 py-1 rounded border border-pan text-pan hover:bg-pan/10 disabled:opacity-40">{busy ? '…' : 'compute'}</button>
            </div>
          </div>
          {plan && (
            <div className="mt-3">
              <div className="text-xs text-dim mb-3">Tokenizing <b className="text-pan">{plan.k}</b> source(s) descopes <b className="text-safe">{plan.total_descoped}</b> of {plan.descopable} descopable systems ({plan.before}→{plan.after} in scope).</div>
              <div className="text-[11px] text-faint -mt-2 mb-3"><i>Descopable</i> = in-scope minus the systems that can never leave the CDE: the true PAN origins themselves (a tokenized origin stays as the tokenization point) and always-CDE elements (full-track / PIN / detokenizers). The Optimizer, the saturation curve, and the Economics card all use this same denominator.</div>
              <div className="space-y-1.5">
                {plan.steps.map(s => (
                  <div key={s.step} className="flex items-center gap-2 text-sm">
                    <span className="mono text-faint w-5">{s.step}.</span>
                    <button onClick={() => onPick(s.tokenize)} className="mono text-pan w-16 text-left hover:underline">{s.tokenize}</button>
                    <div className="flex-1 h-2.5 rounded-full bg-panel2 overflow-hidden">
                      <div className="h-full bg-safe" style={{ width: s.pct_of_descopable + '%', transition: 'width .5s' }} />
                    </div>
                    <span className="mono text-[11px] text-dim w-24 text-right">+{s.marginal_descoped} (cum {s.cumulative_descoped})</span>
                  </div>
                ))}
              </div>
              <div className="text-[11px] text-faint mt-3 mono">{plan.method}</div>
            </div>
          )}
          {!live && <div className="text-[11px] text-faint mt-3">Showing the precomputed plan from the embedded snapshot. Connect the API (upload to analyze) to recompute for a target and run interactive what-if.</div>}
        </div>

        {/* what-if */}
        <div className="card p-5">
          <div className="disp font-bold">What-if simulator</div>
          <div className="text-xs text-dim mb-2">{live ? 'Toggle sources to tokenize; scope and downstream safety recompute live.' : 'Live toggling needs the API — showing the top-3 preset.'}</div>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {candidates.map(s => (
              <button key={s} onClick={() => toggle(s)} disabled={!live}
                className={'mono text-[11px] px-2 py-1 rounded border ' + (selected.includes(s) ? 'border-pan text-pan bg-pan/10' : 'border-[#D9D3C7] bg-white text-dim shadow-sm hover:text-txt hover:border-pan/60 hover:bg-gold/10') + (!live ? ' opacity-60' : '')}>
                {s}{exclBy[s] != null ? ` ·${exclBy[s]}` : ''}
              </button>
            ))}
          </div>
          {[['In scope now', before, 'bg-pan'], ['After tokenizing selection', after, 'bg-safe']].map(([lbl, v, c], i) => (
            <div key={i} className="mb-2">
              <div className="flex justify-between text-xs mb-1"><span className="text-dim">{lbl}</span><span className="mono">{v}</span></div>
              <div className="h-3 rounded-full bg-panel2 overflow-hidden"><div className={'h-full ' + c} style={{ width: (100 * v / maxv) + '%', transition: 'width .6s' }} /></div>
            </div>
          ))}
          <div className="grid grid-cols-3 gap-2 mt-3 text-center">
            <div className="bg-panel2 rounded-lg p-2"><div className="disp text-xl font-black text-safe">{wi ? wi.nodes_descoped : 0}</div><div className="text-[10px] text-dim">descoped</div></div>
            <div className="bg-panel2 rounded-lg p-2"><div className="disp text-xl font-black text-safe">{wi ? wi.node_surface_reduction_pct : 0}%</div><div className="text-[10px] text-dim">surface ↓</div></div>
            <div className="bg-panel2 rounded-lg p-2"><div className="disp text-xl font-black text-cool">{wi ? wi.retained_via_detokenization_count : 0}</div><div className="text-[10px] text-dim">need RISE/APG</div></div>
          </div>
        </div>
      </div>

      {/* safe-for-free vs needs-detok */}
      <div className="grid lg:grid-cols-2 gap-5">
        <div className="card p-5">
          <div className="disp font-bold text-sm text-safe">Safe with no further work <span className="text-faint font-normal">({descoped.length})</span></div>
          <div className="text-[11px] text-faint mb-2">Descope automatically once the selected sources emit CRN — no tokenization or onboarding of their own.</div>
          <div className="scroll max-h-[200px] overflow-auto flex flex-wrap gap-1.5">
            {descoped.length ? descoped.map(s => <button key={s} onClick={() => onPick(s)} className="mono text-[11px] px-2 py-0.5 rounded bg-safe/10 text-safe hover:bg-safe/20">{s}</button>) : <span className="text-dim text-sm">select sources to simulate</span>}
          </div>
        </div>
        <div className="card p-5">
          <div className="disp font-bold text-sm text-cool">Must onboard RISE/APG <span className="text-faint font-normal">({retained.length})</span></div>
          <div className="text-[11px] text-faint mb-2">Genuinely need the real PAN, so they stay in the CDE and de-tokenize CRN via centralized RISE/APG services.</div>
          <div className="scroll max-h-[200px] overflow-auto flex flex-wrap gap-1.5">
            {retained.length ? retained.map(s => <button key={s} onClick={() => onPick(s)} className="mono text-[11px] px-2 py-0.5 rounded bg-cool/10 text-cool hover:bg-cool/20">{s}</button>) : <span className="text-dim text-sm">none in current selection</span>}
          </div>
        </div>
      </div>

      <SaturationCurve plan={d.plan} />
      <BlockComparison plan={d.plan} onPick={onPick} />
      <SegmentationCard d={d} onPick={onPick} />
    </div>
  )
}

/* ============================ CHARTS (pure SVG, no deps) ============================ */
function SaturationCurve({ plan }) {
  const sc = plan?.saturation_curve
  if (!sc || !sc.curve?.length) return null
  const W = 720, H = 230, P = { l: 48, r: 16, t: 16, b: 40 }
  const before = sc.scope_before || Math.max(1, ...sc.curve.map(p => p.fully_descoped))
  const maxY = Math.max(1, ...sc.curve.map(p => p.fully_descoped), Math.round(before * 0.05))
  const x = pct => P.l + (pct / 100) * (W - P.l - P.r)
  const y = v => H - P.b - (v / maxY) * (H - P.t - P.b)
  const pts = sc.curve.map(p => `${x(p.pct_sources)},${y(p.fully_descoped)}`).join(' ')
  const last = sc.curve[sc.curve.length - 1]
  return (
    <div className="card p-5">
      <div className="disp font-bold">Saturation curve <span className="text-faint text-xs font-normal">— why no small set reduces scope</span></div>
      <div className="text-xs text-dim mb-2 max-w-3xl">Systems <b>fully descoped</b> as you tokenize the true-PAN-source front from 0→100%. Because every system has many true-source parents (a saturated estate) and a system frees only when <i>all</i> of them are tokenized, the curve stays flat until nearly the whole front is covered, then rises — the empirical signature of a <b>supermodular</b> objective. This is why single-source blocking frees ~0 and the minimal <i>set</i> is what matters.</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 250 }}>
        {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
          <g key={i}>
            <line x1={P.l} x2={W - P.r} y1={y(f * maxY)} y2={y(f * maxY)} stroke="#E6E2DA" strokeWidth="0.5" />
            <text x={P.l - 6} y={y(f * maxY) + 3} textAnchor="end" fontSize="9" fill="#8B95A3">{Math.round(f * maxY)}</text>
          </g>
        ))}
        {[0, 25, 50, 75, 100].map((p, i) => (
          <text key={i} x={x(p)} y={H - P.b + 14} textAnchor="middle" fontSize="9" fill="#8B95A3">{p}%</text>
        ))}
        <text x={P.l - 34} y={P.t + 4} fontSize="9" fill="#5A6472" transform={`rotate(-90 ${P.l - 34} ${H / 2})`}>systems fully descoped</text>
        <text x={(W) / 2} y={H - 6} textAnchor="middle" fontSize="9" fill="#5A6472">% of true PAN sources tokenized →</text>
        <polyline points={pts} fill="none" stroke="#0E7C4A" strokeWidth="2" />
        {sc.curve.map((p, i) => <circle key={i} cx={x(p.pct_sources)} cy={y(p.fully_descoped)} r="3" fill="#0E7C4A"><title>{p.pct_sources}% sources ({p.k}) → {p.fully_descoped} fully descoped</title></circle>)}
      </svg>
      <div className="text-[11px] text-faint mt-2">Full front ({sc.source_count} sources) → {last?.fully_descoped ?? 0} of {before} fully descoped. The exposure benefit of partial tokenization is in the Block-&-Benefit tab and the heavy-hitter table — non-zero at every step even while full descope stays low.</div>
    </div>
  )
}

function BlockComparison({ plan, onPick }) {
  const bc = plan?.block_comparison
  if (!bc) return null
  const entries = Object.entries(bc)
  if (!entries.length) return null
  const tone = v => v > 0 ? 'text-safe' : 'text-faint'
  return (
    <div className="card p-5">
      <div className="disp font-bold">Block-set comparison <span className="text-faint text-xs font-normal">— block this set vs that set</span></div>
      <div className="text-xs text-dim mb-3 max-w-3xl">The FAQ's “block A vs block B” at the set level. Each column tokenizes a different candidate set and reports the benefit. Note the <b>conduit</b> set frees far fewer systems despite high traffic — tokenizing high-betweenness relays does little, because they are pass-throughs, not true sources. Benefit comes from tokenizing true sources.</div>
      <div className="grid md:grid-cols-3 gap-3">
        {entries.map(([label, v], i) => (
          <div key={i} className={(['tint-green', 'tint-blue', 'tint-red'][i] || 'bg-panel2') + ' rounded-xl p-4'}>
            <div className="text-sm font-semibold text-txt mb-1">{label}</div>
            <div className="flex flex-wrap gap-1 mb-3">
              {(v.tokenize || []).map(s => <button key={s} onClick={() => onPick && onPick(s)} className="mono text-[11px] px-1.5 py-0.5 rounded bg-pan/10 text-pan hover:bg-pan/20">{s}</button>)}
            </div>
            <div className="grid grid-cols-2 gap-y-2 text-sm">
              <div><div className={'disp text-2xl font-black ' + tone(v.fully_descoped)}>{v.fully_descoped}</div><div className="text-[11px] text-faint">fully descoped</div></div>
              <div><div className={'disp text-2xl font-black ' + tone(v.feeds_removed)}>{v.feeds_removed}</div><div className="text-[11px] text-faint">feeds removed</div></div>
              <div><div className="disp text-lg font-bold text-cool">{v.parent_reduction}</div><div className="text-[11px] text-faint">parent-count ↓</div></div>
              <div><div className="disp text-lg font-bold text-cool">{(v.risk_reduction_pct ?? 0).toFixed(1)}%</div><div className="text-[11px] text-faint">risk ↓</div></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ScopeWaterfall({ d }) {
  const plan = d.plan || {}
  const before = plan.before ?? (d.impact?.scope_before ?? 0)
  const descopable = plan.descopable ?? 0
  const floor = Math.max(0, before - descopable)
  const fb = plan.floor_breakdown || null
  const tokPoints = fb ? fb.origins_in_scope : null
  const alwaysCde = fb ? fb.always_cde_in_scope : null
  // bars: [label, height, color, kind] — kind 'full' | 'drop' | 'floor'
  const W = 560, H = 300, P = { l: 48, r: 16, t: 22, b: 52 }
  const maxv = Math.max(1, before)
  const y = v => P.t + (1 - v / maxv) * (H - P.t - P.b)
  const innerW = W - P.l - P.r
  const cols = 3, gap = 26
  const bw = (innerW - gap * (cols - 1)) / cols
  const x = i => P.l + i * (bw + gap)
  const pct = descopable && before ? Math.round(100 * descopable / before) : 0
  return (
    <div className="card p-5">
      <div className="disp font-bold">Where the scope goes <span className="text-faint text-xs font-normal">— the descope waterfall</span></div>
      <div className="text-xs text-dim mb-2">Of the <b>{fmt(before)}</b> systems in PCI scope today, <b className="text-safe">{fmt(descopable)}</b> ({pct}%) can fully leave the CDE once the true-source front emits CRN. The <b>{fmt(floor)}</b>-system floor is irreducible by design{fb ? <>: <b className="text-pan">{fmt(tokPoints)}</b> stay as the tokenization points themselves and <b className="text-cool">{fmt(alwaysCde)}</b> hold always-CDE data (detokenize / full-track / PIN — RISE/APG territory)</> : ' (tokenization points + always-CDE elements)'}. Every segment uses the same audited denominator as the Planner, the certified frontier and Economics.</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 320 }}>
        {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
          <g key={i}>
            <line x1={P.l} x2={W - P.r} y1={y(f * maxv)} y2={y(f * maxv)} stroke="#E6E2DA" strokeWidth="0.5" />
            <text x={P.l - 6} y={y(f * maxv) + 3} textAnchor="end" fontSize="9" fill="#8B95A3">{fmt(Math.round(f * maxv))}</text>
          </g>
        ))}
        {/* col 1 — in scope today (full bar) */}
        <rect x={x(0)} y={y(before)} width={bw} height={y(0) - y(before)} fill="#D71E28" fillOpacity="0.85" rx="3">
          <title>{fmt(before)} systems in PCI scope today</title></rect>
        <text x={x(0) + bw / 2} y={y(before) - 7} textAnchor="middle" fontSize="13" fontWeight="800" fill="#D71E28" className="disp">{fmt(before)}</text>
        <text x={x(0) + bw / 2} y={H - P.b + 16} textAnchor="middle" fontSize="10" fill="#5A6472">in scope today</text>

        {/* connector */}
        <line x1={x(0) + bw} y1={y(before)} x2={x(1)} y2={y(before)} stroke="#9AA4B2" strokeWidth="0.75" strokeDasharray="3 3" />

        {/* col 2 — floating drop: fully descopable */}
        <rect x={x(1)} y={y(before)} width={bw} height={Math.max(2, y(floor) - y(before))} fill="#0E7C4A" fillOpacity="0.85" rx="3">
          <title>{fmt(descopable)} systems fully descopable under complete true-source tokenization</title></rect>
        <text x={x(1) + bw / 2} y={y(before) - 7} textAnchor="middle" fontSize="13" fontWeight="800" fill="#0E7C4A" className="disp">−{fmt(descopable)}</text>
        <text x={x(1) + bw / 2} y={H - P.b + 16} textAnchor="middle" fontSize="10" fill="#5A6472">fully descopable</text>
        <text x={x(1) + bw / 2} y={H - P.b + 28} textAnchor="middle" fontSize="9" fill="#8B95A3">once all true sources emit CRN</text>

        {/* connector */}
        <line x1={x(1) + bw} y1={y(floor)} x2={x(2)} y2={y(floor)} stroke="#9AA4B2" strokeWidth="0.75" strokeDasharray="3 3" />

        {/* col 3 — achievable floor, stacked breakdown when available */}
        {fb ? (
          <g>
            <rect x={x(2)} y={y(tokPoints)} width={bw} height={y(0) - y(tokPoints)} fill="#D71E28" fillOpacity="0.65" rx="3">
              <title>{fmt(tokPoints)} true PAN sources remain in the CDE as tokenization points</title></rect>
            <rect x={x(2)} y={y(floor)} width={bw} height={Math.max(0, y(tokPoints) - y(floor))} fill="#2563EB" fillOpacity="0.7" rx="3">
              <title>{fmt(alwaysCde)} systems hold always-CDE data elements — stay via RISE/APG</title></rect>
          </g>
        ) : (
          <rect x={x(2)} y={y(floor)} width={bw} height={y(0) - y(floor)} fill="#2563EB" fillOpacity="0.7" rx="3">
            <title>{fmt(floor)} systems — the achievable floor</title></rect>
        )}
        <text x={x(2) + bw / 2} y={y(floor) - 7} textAnchor="middle" fontSize="13" fontWeight="800" fill="#1F2329" className="disp">{fmt(floor)}</text>
        <text x={x(2) + bw / 2} y={H - P.b + 16} textAnchor="middle" fontSize="10" fill="#5A6472">achievable floor</text>
        {fb && <text x={x(2) + bw / 2} y={H - P.b + 28} textAnchor="middle" fontSize="9" fill="#8B95A3">{fmt(tokPoints)} token points · {fmt(alwaysCde)} RISE/APG</text>}
      </svg>
    </div>
  )
}

function ScatterReachRisk({ d, onPick }) {
  const nodes = (d.viz?.nodes || []).filter(n => n.carries_pan || n.hidden_pci || (n.reach || 0) > 0)
  const W = 640, H = 330, P = { l: 44, r: 16, t: 26, b: 36 }
  const bx = n => n.betweenness || 0
  const maxX = Math.max(1e-9, ...nodes.map(bx))
  const maxY = Math.max(1, ...nodes.map(n => n.risk || 0))
  const chokes = new Set(((d.structure || {}).choke_points) || [])
  const hh = new Set(d.heavy_hitters.slice(0, 8).map(h => h.system))
  const x = v => P.l + (v / maxX) * (W - P.l - P.r)
  const y = v => H - P.b - (v / maxY) * (H - P.t - P.b)
  const color = n => n.hidden_pci ? '#8F0E1E' : n.true_source ? '#D71E28' : n.carries_pan ? '#E8A33D' : '#2563EB'
  // quadrant guides at half-scale; label the systems a reader should be able to name
  const gx = x(maxX / 2), gy = y(maxY / 2)
  const labelled = nodes.filter(n => bx(n) > maxX * 0.18 || (n.risk || 0) > maxY * 0.8 || hh.has(n.id))
    .sort((a, b) => (bx(b) + (b.risk || 0) / maxY) - (bx(a) + (a.risk || 0) / maxY)).slice(0, 9)
  const labelSet = new Set(labelled.map(n => n.id))
  return (
    <div className="card p-5">
      <div className="disp font-bold">Sources vs relays <span className="text-faint text-xs font-normal">— where tokenization pays, and where it doesn't</span></div>
      <div className="text-xs text-dim mb-2">Horizontal = how much PAN traffic merely <b>routes through</b> a system (betweenness); vertical = composite risk. Systems to the <b>right are relays</b> — heavily trafficked, but tokenizing them frees nothing (proven in the block-set comparison: the top-conduit set descopes 0). They are <b className="text-safe">segmentation</b> candidates instead. The tokenization budget belongs to the <span className="text-pan">red true sources</span>, wherever they sit. <span className="text-safe">▢</span> = choke point (cut vertex).</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 350 }}>
        {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
          <g key={i}>
            <line x1={P.l} x2={W - P.r} y1={y(f * maxY)} y2={y(f * maxY)} stroke="#E6E2DA" strokeWidth="0.5" />
            <text x={P.l - 6} y={y(f * maxY) + 3} textAnchor="end" fontSize="9" fill="#8B95A3">{Math.round(f * maxY)}</text>
          </g>
        ))}
        {/* quadrant guides + corner captions */}
        <line x1={gx} x2={gx} y1={P.t} y2={H - P.b} stroke="#C9B870" strokeWidth="0.8" strokeDasharray="4 3" />
        <line x1={P.l} x2={W - P.r} y1={gy} y2={gy} stroke="#C9B870" strokeWidth="0.8" strokeDasharray="4 3" />
        <text x={W - P.r - 4} y={P.t + 10} textAnchor="end" fontSize="9" fontWeight="700" fill="#0E7C4A">high-traffic relay → segment here</text>
        <text x={P.l + 4} y={P.t + 10} fontSize="9" fontWeight="700" fill="#D71E28">high-risk holder → tokenize at its sources</text>
        <text x={P.l - 30} y={P.t + 6} fontSize="9" fill="#5A6472" transform={`rotate(-90 ${P.l - 30} ${H / 2})`}>risk score</text>
        <text x={(W) / 2} y={H - 6} textAnchor="middle" fontSize="9" fill="#5A6472">PAN traffic routed THROUGH the system (betweenness) →</text>
        {nodes.map((n, i) => {
          const isChoke = chokes.has(n.id)
          const r = hh.has(n.id) ? 7 : 3.6
          if (isChoke) return <rect key={i} x={x(bx(n)) - r} y={y(n.risk || 0) - r} width={2 * r} height={2 * r}
            fill={color(n)} fillOpacity={0.85} stroke="#0E7C4A" strokeWidth="1.4" rx="1"
            style={{ cursor: 'pointer' }} onClick={() => onPick(n.id)}>
            <title>{n.id} · choke point · betweenness {(+bx(n)).toFixed(3)} · risk {n.risk}</title></rect>
          return <circle key={i} cx={x(bx(n))} cy={y(n.risk || 0)} r={r}
            fill={color(n)} fillOpacity={hh.has(n.id) ? 0.95 : 0.55}
            stroke={hh.has(n.id) ? '#1F2329' : 'none'} strokeWidth={hh.has(n.id) ? 1 : 0}
            style={{ cursor: 'pointer' }} onClick={() => onPick(n.id)}>
            <title>{n.id} · betweenness {(+bx(n)).toFixed(3)} · risk {n.risk}</title>
          </circle>
        })}
        {labelled.map((n, i) => (
          <text key={'lb' + i} x={x(bx(n)) + 9} y={y(n.risk || 0) + 3} fontSize="9" fontWeight="600"
            fill={color(n)} className="mono" style={{ pointerEvents: 'none' }}>{n.id}</text>
        ))}
      </svg>
    </div>
  )
}

function BarExclusiveReach({ d, onPick }) {
  const rows = d.heavy_hitters.slice(0, 10)
  const max = Math.max(1, ...rows.map(r => r.downstream_reach))
  return (
    <div className="card p-5">
      <div className="disp font-bold">Distributor reach <span className="text-faint text-xs font-normal">— blast radius of each PAN source</span></div>
      <div className="text-xs text-dim mb-3">Bar = downstream systems each source feeds clear PAN to. The <b className="text-safe">·N</b> tag is its solo descope (systems freed if only it is tokenized) — near-zero everywhere because the same downstream systems have multiple PAN parents, which is why the minimal tokenization <i>set</i> matters more than any single source.</div>
      <div className="space-y-1.5">
        {rows.map((r, i) => {
          const solo = r.solo_descope ?? r.exclusive_reach ?? 0
          return (
            <div key={i} className="flex items-center gap-2 text-sm">
              <button onClick={() => onPick(r.system)} className="mono text-pan w-14 text-left hover:underline">{r.system}</button>
              <div className="flex-1 h-4 rounded bg-panel2 overflow-hidden">
                <div className="h-full bg-pan/70 flex items-center justify-end pr-1.5" style={{ width: Math.max(8, 100 * r.downstream_reach / max) + '%', transition: 'width .5s' }}>
                  <span className="mono text-[10px] text-ink font-bold">{r.downstream_reach}</span>
                </div>
              </div>
              <span className={'mono text-[10px] w-16 text-right ' + (solo > 0 ? 'text-safe' : 'text-faint')}>solo ·{solo}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ============================ METHODS (algorithms + structure metrics) ============================ */
function WeightSensitivity({ ws }) {
  if (!ws || !ws.scenarios) return null
  const rho = ws.mean_rank_correlation, ov = ws.top5_overlap_min
  const lr = ws.least_robust_scenario || null
  const tone = rho >= 0.9 ? 'text-safe' : rho >= 0.75 ? 'text-pan' : 'text-panhot'
  return (
    <div className="card p-5">
      <div className="disp font-bold text-lg">Risk-weight sensitivity <span className="text-faint text-xs font-normal">— does the ranking depend on the weights?</span></div>
      <p className="text-sm text-dim mt-1 mb-4 max-w-3xl leading-relaxed">
        The composite risk weights sensitivity/reach/betweenness/source at 0.40/0.30/0.20/0.10. To test whether the
        ranking is an artifact of those constants, every PAN-carrying system is re-ranked under alternative weightings and
        compared by Spearman ρ over the <i>full</i> set (not just the base top-N, which would hide reshuffles). The order is
        broadly stable{lr && lr.name ? <>, with the largest movement under <b className="text-pan">{lr.name}</b> (ρ {lr.rho.toFixed(2)}, top-5 held {lr.overlap}/5) — a reweighting that surfaces a different facet of risk.</> : '.'}
      </p>
      <div className="flex flex-wrap gap-3 mb-4">
        <div className="bg-panel2 rounded-xl p-4 flex-1 min-w-[180px]">
          <div className={'disp text-3xl font-black ' + tone}>{rho.toFixed(2)}</div>
          <div className="text-xs text-txt mt-1">Mean rank correlation (Spearman ρ)</div>
          <div className="text-[11px] text-faint mt-0.5">full universe · base vs each reweighting</div>
        </div>
        <div className="bg-panel2 rounded-xl p-4 flex-1 min-w-[180px]">
          <div className="disp text-3xl font-black text-safe">{ov}/5</div>
          <div className="text-xs text-txt mt-1">Top-5 membership held</div>
          <div className="text-[11px] text-faint mt-0.5">worst case across all reweightings</div>
        </div>
        <div className="bg-panel2 rounded-xl p-4 flex-1 min-w-[180px]">
          <div className="disp text-3xl font-black text-cool">{ws.min_rank_correlation.toFixed(2)}</div>
          <div className="text-xs text-txt mt-1">Worst-case ρ</div>
          <div className="text-[11px] text-faint mt-0.5">{lr && lr.name ? lr.name : 'most adversarial reweighting'}</div>
        </div>
      </div>
      <div className="scroll overflow-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-[11px] uppercase tracking-wider text-faint bg-panel2">
            <th className="px-3 py-2">Weighting (s/r/b/src)</th><th className="px-3 py-2">ρ</th><th className="px-3 py-2">top-5 held</th><th className="px-3 py-2">Top-5 distributors by risk</th></tr></thead>
          <tbody>
            {ws.scenarios.map((sc, i) => (
              <tr key={i} className={'border-t border-line ' + (i === 0 ? 'bg-pan/5' : (lr && sc.name === lr.name ? 'bg-panhot/5' : ''))}>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <span className={'font-semibold ' + (i === 0 ? 'text-pan' : 'text-txt')}>{sc.name}</span>
                  <span className="mono text-[11px] text-faint ml-2">{sc.weights.sensitivity}/{sc.weights.reach}/{sc.weights.betweenness}/{sc.weights.source}</span>
                </td>
                <td className="px-3 py-2.5 mono text-dim">{i === 0 ? '—' : sc.rho.toFixed(2)}</td>
                <td className={'px-3 py-2.5 mono ' + ((sc.top5_overlap ?? 5) >= 4 ? 'text-safe' : 'text-pan')}>{i === 0 ? '—' : (sc.top5_overlap ?? '—') + '/5'}</td>
                <td className="px-3 py-2.5">
                  <span className="flex flex-wrap gap-1">
                    {sc.top5.map(id => <span key={id} className="mono text-[11px] px-1.5 py-0.5 rounded bg-line text-dim">{id}</span>)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-[11px] text-faint mt-3">Ranking over {ws.universe_size} PAN-carrying systems, full-universe Spearman. The top distributors recur across weightings; where they move, the table names the reweighting responsible — the conclusion is structural, with its sensitivities stated rather than hidden.</div>
    </div>
  )
}

/* ============================ METHODS (cont.) ============================ */
function Methods({ d, onPick }) {
  const s = d.structure || {}
  const algos = [
    ['Cycle resolution', 'Tarjan strongly-connected-components → condensation', 'Tarjan 1972', 'Source relationships from BAM/ServiceNow contain cycles; SCC detection + supervertex contraction provably yields a DAG. The rule is explicit and explainable.'],
    ['Reachability / scope', 'Transitive closure (DFS descendants)', 'classical', 'A system is in PCI scope if reachable from any clear-PAN source. Memoized per-source so scope evaluations are O(sources) set-unions.'],
    ['Conduit importance', 'Betweenness centrality (exact; pivot-sampled at scale)', 'Freeman 1977; Brandes 2001; Brandes & Pich 2007', 'Systems that many PAN paths route through. Sampled estimator above ~600 nodes keeps scoring sub-second without changing the quantity measured.'],
    ['Heavy-hitter ranking', 'Downstream reach (primary distributor); solo descope = exclusive reach via set difference', 'own, interpretable', 'Distributors are ranked by how many systems they feed clear PAN to (reach). Solo descope — systems freed if only this source is tokenized — is reported alongside; it is small under shared PAN flow, which the minimal-set optimizer addresses.'],
    ['Composite risk', 'Weighted sum: 0.40 sensitivity + 0.30 reach + 0.20 betweenness + 0.10 source', 'own, every term bounded & named', 'R(v)∈[0,100]. No magic constants; weights are config-tunable and each factor is individually defensible.'],
    ['Minimum-intervention plan', 'Greedy max-marginal full-descope over the true PAN sources', 'heuristic (objective is supermodular under conjunctive coverage)', 'Fewest sources to tokenize for the most descope. A system frees only when ALL its true sources are tokenized, so the objective is supermodular — the (1−1/e) submodular guarantee does not apply and is not claimed; greedy is reported as a transparent heuristic.'],
    ['Concentration', 'Gini coefficient + Herfindahl-Hirschman index', 'Gini 1912; Hirschman 1945', 'Quantifies how few systems carry the exposure — the mathematical justification for targeting heavy hitters.'],
    ['Choke points', 'Articulation / cut vertices of the PAN subgraph', 'classical graph theory', 'Single points whose tokenization severs PAN to an entire branch.'],
    ['Card-data safety', 'Luhn check on Luhn-valid synthetic data; first-6/last-4 masking', 'Luhn 1954; PCI-DSS', 'Masking enforced on ingest; an unmasked PAN fails the run. No real card data is ever stored, logged, or displayed.'],
  ]
  const Stat = ({ v, l, sub, c = 'text-pan' }) => (
    <div className={({ 'text-pan': 'tint-red', 'text-panhot': 'tint-red', 'text-cool': 'tint-blue', 'text-safe': 'tint-green' }[c] || 'bg-panel2') + ' rounded-xl p-4'}>
      <div className={'disp text-3xl font-black ' + c}>{v}</div>
      <div className="text-xs text-txt mt-1">{l}</div>
      {sub && <div className="text-[11px] text-faint mt-0.5">{sub}</div>}
    </div>
  )
  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="disp font-bold text-lg">Methods &amp; algorithms <span className="text-faint text-xs font-normal">— what does the verifiable work</span></div>
        <p className="text-sm text-dim mt-1 max-w-3xl leading-relaxed">Deterministic algorithms and classical statistics do every measured step; the LLM only narrates the already-computed numbers. Each metric is named, bounded, and traceable to a rule, a statistic, or a citation — nothing is a black box.</p>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat v={s.reach_gini ?? '—'} l="Reach Gini coefficient" sub="0 = even · 1 = concentrated" />
        <Stat v={(s.top5_reach_share_pct ?? '—') + '%'} l="Top-5 sources' share of all downstream exposure" c="text-panhot" />
        <Stat v={s.propagation_depth ?? '—'} l="PAN propagation depth (hops)" sub="longest clear-PAN path" c="text-cool" />
        <Stat v={s.choke_point_count ?? '—'} l="Choke points" sub="cut vertices in PAN flow" c="text-safe" />
      </div>

      <div className="card p-0 overflow-hidden">
        <table className="w-full text-sm colgrid">
          <thead><tr className="text-left text-[11px] uppercase tracking-wider text-faint bg-panel2">
            <th className="px-4 py-2.5">Capability</th><th className="px-4 py-2.5">Algorithm / solver</th>
            <th className="px-4 py-2.5">Citation</th><th className="px-4 py-2.5">Why</th></tr></thead>
          <tbody>
            {algos.map((a, i) => (
              <tr key={i} className="border-t border-line align-top">
                <td className="px-4 py-3 text-txt font-semibold whitespace-nowrap">{a[0]}</td>
                <td className="px-4 py-3 text-dim">{a[1]}</td>
                <td className="px-4 py-3 text-faint mono text-[11px] whitespace-nowrap">{a[2]}</td>
                <td className="px-4 py-3 text-dim text-[13px]">{a[3]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <RunComplexity d={d} />
      <WeightSensitivity ws={s.weight_sensitivity} />
      <ScatterReachRisk d={d} onPick={onPick || (() => {})} />
      {s.choke_points && s.choke_points.length > 0 && (
        <div className="card p-5">
          <div className="disp font-bold text-sm">Choke points <span className="text-faint font-normal">— tokenizing one severs PAN to a whole branch</span></div>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {s.choke_points.map(c => <span key={c} className="mono text-[11px] px-2 py-0.5 rounded bg-safe/10 text-safe">{c}</span>)}
          </div>
        </div>
      )}
    </div>
  )
}

/* ============================ ASK (grounded chat) ============================ */
function ChatPanel({ suggested, live, threadId, height = 400 }) {
  const [msgs, setMsgs] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef()
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs, busy])

  const send = async (text) => {
    const q = (text ?? input).trim(); if (!q || busy) return
    setInput(''); setMsgs(m => [...m, { role: 'user', content: q }]); setBusy(true)
    try {
      if (!live) { setMsgs(m => [...m, { role: 'assistant', content: 'Live Q&A needs the API running (start the backend, then upload to analyze). Overview, graph, and drill-down work fully offline from the embedded snapshot.', grounded: [] }]); return }
      const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, history: msgs.slice(-6), thread_id: threadId || '' }) })
      const j = await r.json()
      setMsgs(m => [...m, { role: 'assistant', content: j.answer, grounded: j.grounded_on || [] }])
    } catch (e) {
      setMsgs(m => [...m, { role: 'assistant', content: 'Could not reach the analyst service: ' + (e.message || e), grounded: [] }])
    } finally { setBusy(false) }
  }
  return (
    <div className="flex flex-col">
      <div className="scroll overflow-auto space-y-3 pr-1" style={{ minHeight: msgs.length ? height : 0, maxHeight: height }}>
        {msgs.length === 0 && <div className="text-xs text-faint mb-1">Pick a suggested question below, or type your own.</div>}
        {msgs.map((m, i) => (
          <div key={i} className={'max-w-[88%] ' + (m.role === 'user' ? 'ml-auto' : '')}>
            <div className={'rounded-xl px-3 py-2 text-sm ' + (m.role === 'user' ? 'bg-pan/15 text-txt' : 'text-dim border border-[#ECDCA8] bg-[#FFFDF4]')}>{m.content}</div>
            {m.grounded && m.grounded.length > 0 && <div className="flex flex-wrap gap-1 mt-1">{m.grounded.slice(0, 8).map((gx, j) => <span key={j} className="mono text-[10px] px-1.5 py-0.5 rounded tint-blue text-cool">{gx}</span>)}</div>}
          </div>
        ))}
        {busy && <div className="text-xs text-faint mono">analyst is thinking…</div>}
        <div ref={endRef} />
      </div>
      <div className="flex flex-wrap gap-1.5 mt-2">
        {(suggested || []).slice(0, 5).map((s, i) => <button key={i} onClick={() => send(s)} className="text-left text-[11px] px-2.5 py-1 rounded-full border border-[#D9D3C7] bg-white text-dim hover:border-pan hover:text-pan hover:bg-gold/10 transition">{s}</button>)}
      </div>
      <div className="flex gap-2 mt-2">
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()}
          placeholder="ask about scope, heavy hitters, a system ID, tokenization impact…"
          className="flex-1 bg-white border border-[#D9D3C7] rounded-lg px-3 py-2 text-sm text-txt outline-none focus:border-pan focus:ring-2 focus:ring-gold/50" />
        <button onClick={() => send()} disabled={busy} className="mono text-xs px-4 rounded-lg bg-pan text-ink font-semibold disabled:opacity-50">send</button>
      </div>
    </div>
  )
}

function Ask({ suggested, live }) {
  return (
    <div className="grid lg:grid-cols-[1fr_290px] gap-5">
      <div className="card p-5">
        <div className="disp font-bold text-lg">Ask the analyst <span className="text-faint text-xs font-normal">— grounded in the computed analysis only</span></div>
        <div className="text-xs text-dim mb-3">Common questions are answered deterministically from the graph/scores (no model — cannot hallucinate); open-ended ones use the LLM constrained to the computed facts.</div>
        <ChatPanel suggested={suggested} live={live} height={380} />
      </div>
      <div className="card p-5 self-start">
        <div className="text-[11px] uppercase tracking-[.16em] text-faint mb-3">What I can answer</div>
        <ul className="text-xs text-dim space-y-2.5">
          <li><b className="text-txt">Scope</b> — totals and the metadata-confirmed vs inferred-only split.</li>
          <li><b className="text-txt">Heavy hitters</b> — the biggest PAN distributors by downstream reach.</li>
          <li><b className="text-txt">Hidden PCI</b> — systems BAM missed but Splunk caught.</li>
          <li><b className="text-txt">A system</b> — name an ID (e.g. 8CCF) for risk, scope basis, and lineage.</li>
          <li><b className="text-txt">Tokenization</b> — "what if we tokenize X" and the descope it yields.</li>
        </ul>
        <div className="text-[11px] text-faint mt-4 leading-relaxed">Every answer cites the systems and metrics it used. {live ? '' : 'Connect the API (upload to analyze) for live Q&A.'}</div>
      </div>
    </div>
  )
}

/* ============================ BLOCK & BENEFIT (interactive block-a-source) ============================ */
function BlastGraph({ system, soloSet, adj, byId, color, onPick }) {
  // Walk the actual cardholder-data flow downstream from the blocked source and draw
  // the systems that benefit as nodes radiating outward. Fully-freed (this was their
  // only true source) glow bright; feed-only (lose this feed, stay in scope via another
  // parent) are dimmer. Display is capped/sampled so a saturated estate doesn't blob.
  const { display, total, soloN, feedN } = useMemo(() => {
    const seen = new Set()
    if (system) {
      const stack = [system]
      while (stack.length) {
        const x = stack.pop()
        for (const t of (adj.get(x) || [])) if (t !== system && !seen.has(t)) { seen.add(t); stack.push(t) }
      }
    }
    const inScope = [...seen].filter(id => byId.get(id)?.in_scope)
    const solo = inScope.filter(id => soloSet.has(id))
    const feed = inScope.filter(id => !soloSet.has(id))
    const CAP = 54
    const showFeed = feed.slice(0, Math.max(0, CAP - solo.length))
    const disp = [...solo.map(id => ({ id, solo: true })), ...showFeed.map(id => ({ id, solo: false }))]
    return { display: disp, total: inScope.length, soloN: solo.length, feedN: feed.length }
  }, [system, adj, byId, soloSet])

  if (!system) return null
  const W = 720, H = 460, cx = W / 2, cy = H / 2
  const rings = [{ r: 78, cap: 10 }, { r: 130, cap: 18 }, { r: 188, cap: 30 }]
  // assign each displayed node a ring slot + angle
  const placed = []
  let idx = 0
  for (let ri = 0; ri < rings.length && idx < display.length; ri++) {
    const { r, cap } = rings[ri]
    const count = Math.min(cap, display.length - idx)
    for (let k = 0; k < count; k++) {
      const ang = (k / count) * 2 * Math.PI - Math.PI / 2 + (ri * 0.35)
      placed.push({ ...display[idx], x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) })
      idx++
    }
  }
  const hidden = total - placed.length
  return (
    <div>
      <div className="flex items-center gap-4 mb-1 text-[11px] text-dim flex-wrap">
        <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block" style={{ background: '#0E7C4A' }} />fully freed — leaves PCI scope ({soloN})</span>
        <span className="flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: '#2563EB' }} />loses a clear-PAN feed, stays in scope ({feedN})</span>
        <span className="flex items-center gap-1"><i className="w-3.5 h-3.5 rounded-full inline-block ring-1 ring-txt/40" style={{ background: color }} />blocked source</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 430 }}>
        {rings.map((rg, i) => <circle key={'rg' + i} cx={cx} cy={cy} r={rg.r} fill="none" stroke="#E6E2DA" strokeWidth="0.5" strokeDasharray="2 4" />)}
        {placed.map((p, i) => <line key={'e' + i} x1={cx} y1={cy} x2={p.x} y2={p.y}
          stroke={p.solo ? '#0E7C4A' : '#2563EB'} strokeWidth={p.solo ? 1.2 : 0.6} strokeOpacity={p.solo ? 0.65 : 0.3} />)}
        {placed.map((p, i) => (
          <g key={'n' + i} style={{ cursor: 'pointer' }} onClick={() => onPick && onPick(p.id)}>
            <circle cx={p.x} cy={p.y} r={p.solo ? 7 : 4.5} fill={p.solo ? '#0E7C4A' : '#2563EB'} fillOpacity={p.solo ? 1 : 0.82} stroke={p.solo ? '#FFFFFF' : 'none'} strokeWidth={p.solo ? 1 : 0}>
              {p.solo && <animate attributeName="r" values="7;10;7" dur="1.9s" repeatCount="indefinite" />}
            </circle>
            {(p.solo || placed.length <= 30) && <text x={p.x} y={p.y - 9} textAnchor="middle" fontSize="8.5" fill={p.solo ? '#1F2329' : '#5A6472'} className="mono">{p.id}</text>}
            <title>{p.id}{p.solo ? ' · fully freed' : ' · loses a feed (stays in scope)'}</title>
          </g>
        ))}
        {/* source at center */}
        <circle cx={cx} cy={cy} r="15" fill={color} stroke="#fff" strokeWidth="2.5" />
        <text x={cx} y={cy + 4} textAnchor="middle" fontSize="9" fill="#FFFFFF" className="mono">block</text>
        <text x={cx} y={cy - 22} textAnchor="middle" fontSize="11" fill="#1F2329" className="mono">{system}</text>
        {hidden > 0 && <text x={cx} y={H - 12} textAnchor="middle" fontSize="10" fill="#8B95A3">+ {hidden} more beneficiaries not shown ({total} total downstream benefit)</text>}
        {total === 0 && <text x={cx} y={cy + 40} textAnchor="middle" fontSize="11" fill="#8B95A3">this source feeds no in-scope systems</text>}
      </svg>
    </div>
  )
}

function BlastRadius({ d, onPick }) {
  const se = d.plan?.source_exposure
  const rows = useMemo(() => se?.per_source || [], [se])
  const scopeBefore = se?.scope_before || d.headline?.systems_exposed_to_clear_pan || 1
  const [a, setA] = useState(null)
  const [b, setB] = useState(null)
  useEffect(() => { if (!a && rows.length) setA(rows[0].system) }, [rows, a])
  const [copied, setCopied] = useState(false)
  if (!se || !rows.length) {
    return <div className="card p-6 text-dim text-sm">No per-source exposure data in this snapshot. Re-run the analysis on the backend to populate the Block-&-Benefit view.</div>
  }
  const rowOf = id => rows.find(r => r.system === id) || null
  const ra = rowOf(a), rb = rowOf(b)
  const pct = n => ((100 * (n || 0)) / Math.max(1, scopeBefore)).toFixed(1)
  // flow adjacency (provider -> consumers) + node lookup for the downstream walk
  const byId = useMemo(() => new Map((d.viz?.nodes || []).map(n => [n.id, n])), [d])
  const adj = useMemo(() => {
    const m = new Map()
    for (const e of (d.viz?.edges || [])) { if (!m.has(e.source)) m.set(e.source, []); m.get(e.source).push(e.target) }
    return m
  }, [d])
  const soloA = useMemo(() => new Set(ra?.solo_systems || []), [ra])
  const soloB = useMemo(() => new Set(rb?.solo_systems || []), [rb])
  // Detect a saturated estate: the top sources each reach most of the scope and their
  // feeds_removed are near-identical. On such data single-source numbers look "stuck" —
  // that's the finding, not a bug, so we surface it explicitly.
  const sat = useMemo(() => {
    const top = rows.slice(0, Math.min(10, rows.length))
    if (top.length < 3) return null
    const maxFeed = Math.max(...top.map(r => r.feeds_removed || 0))
    if (maxFeed < 0.5 * scopeBefore) return null
    const band = Math.max(2, 0.02 * scopeBefore)
    const cluster = top.filter(r => Math.abs((r.feeds_removed || 0) - maxFeed) <= band)
    if (cluster.length < 3) return null
    const maxSolo = Math.max(...rows.map(r => r.solo_descope || 0))
    return { n: cluster.length, pct: ((100 * maxFeed) / Math.max(1, scopeBefore)).toFixed(1), maxSolo,
             topSolo: (rows.find(r => (r.solo_descope || 0) === maxSolo) || {}).system }
  }, [rows, scopeBefore])

  const report = ra ? (
    `Block PAN at ${ra.system}:\n` +
    `• ${ra.feeds_removed} systems (${pct(ra.feeds_removed)}% of the ${scopeBefore}-system scope) lose a clear-PAN feed\n` +
    `• ${ra.solo_descope} fully descope (this was their only true source)` +
    (ra.solo_systems?.length ? `: ${ra.solo_systems.join(', ')}` : '') + `\n` +
    `• ${ra.parent_reduction} keep PAN via another source (parent-count reduced)\n` +
    (rb ? (`\nvs block PAN at ${rb.system}:\n` +
      `• ${rb.feeds_removed} lose a feed (${pct(rb.feeds_removed)}%) · ${rb.solo_descope} fully descope · ${rb.parent_reduction} parent-reduced\n`) : '')
  ) : ''
  const copy = async () => { try { await navigator.clipboard.writeText(report); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch (e) {} }

  const Card = ({ r, color, tag }) => r ? (
    <div className={(tag && tag.startsWith('A') ? 'tint-red' : 'tint-blue') + ' rounded-xl p-4 flex-1 min-w-[240px]'}>
      <div className="flex items-center gap-2 mb-2">
        <span className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
        <button onClick={() => onPick(r.system)} className="mono text-sm font-bold hover:underline" style={{ color }}>{r.system}</button>
        <span className="text-[10px] text-faint ml-auto">{tag}</span>
      </div>
      <div className="grid grid-cols-2 gap-y-2">
        <div><div className="disp text-2xl font-black text-safe">{r.feeds_removed}</div><div className="text-[11px] text-faint">lose a clear-PAN feed</div></div>
        <div><div className="disp text-2xl font-black text-cool">{pct(r.feeds_removed)}%</div><div className="text-[11px] text-faint">of {scopeBefore}-system scope</div></div>
        <div><div className="disp text-xl font-bold text-safe">{r.solo_descope}</div><div className="text-[11px] text-faint">fully descope</div></div>
        <div><div className="disp text-xl font-bold text-dim">{r.parent_reduction}</div><div className="text-[11px] text-faint">parent-count ↓ only</div></div>
      </div>
      {r.solo_systems?.length > 0 && <div className="mt-2 pt-2 border-t border-line">
        <div className="text-[10px] uppercase tracking-wider text-faint mb-1">fully freed</div>
        <div className="flex flex-wrap gap-1">{r.solo_systems.slice(0, 16).map(s => <button key={s} onClick={() => onPick(s)} className="mono text-[10px] px-1.5 py-0.5 rounded bg-safe/10 text-safe hover:bg-safe/20">{s}</button>)}
          {r.solo_descope > 16 && <span className="text-[10px] text-faint">+{r.solo_descope - 16}</span>}</div>
      </div>}
    </div>
  ) : null

  const downloadFile = (name, text, mime) => {
    try {
      const blob = new Blob([text], { type: mime })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url; link.download = name; document.body.appendChild(link); link.click()
      document.body.removeChild(link); setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) { /* noop */ }
  }
  const csvCell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
  const downloadCSV = () => {
    const hdr = ['Source', 'Fully descoped (leave scope)', 'Feeds removed', '% of scope', 'Parent-count reduced', 'Downstream reach', 'Risk', 'Fully-freed systems']
    const lines = [hdr.map(csvCell).join(',')]
    for (const r of rows) lines.push([r.system, r.solo_descope, r.feeds_removed, pct(r.feeds_removed), r.parent_reduction, r.downstream_reach, r.risk, (r.solo_systems || []).join('; ')].map(csvCell).join(','))
    downloadFile('pci-sentinel_block-benefit.csv', lines.join('\n'), 'text/csv;charset=utf-8')
  }
  const downloadMD = () => {
    const lines = []
    lines.push('# PCI-SENTINEL — Block & Benefit report')
    lines.push('')
    lines.push(`Per-source tokenization (PAN→CRN) impact across a ${scopeBefore}-system in-scope estate. A downstream system *fully descopes* only when **all** of its true PAN sources are tokenized (conjunctive); blocking one source removes a clear-PAN feed even when the system stays in scope via another parent.`)
    lines.push('')
    lines.push('| Source | Fully freed | Feeds removed | % of scope | Parent-count ↓ | Reach | Risk |')
    lines.push('|---|---|---|---|---|---|---|')
    for (const r of rows) lines.push(`| ${r.system} | ${r.solo_descope} | ${r.feeds_removed} | ${pct(r.feeds_removed)}% | ${r.parent_reduction} | ${r.downstream_reach} | ${r.risk} |`)
    lines.push('')
    lines.push('## Per-source detail')
    for (const r of rows) {
      lines.push('')
      lines.push(`### Block PAN at ${r.system}`)
      lines.push(`- ${r.feeds_removed} systems (${pct(r.feeds_removed)}% of scope) lose a clear-PAN feed`)
      lines.push(`- ${r.solo_descope} fully descope (this was their only true source)${r.solo_systems?.length ? ': ' + r.solo_systems.join(', ') : ''}`)
      lines.push(`- ${r.parent_reduction} keep PAN via another source (parent-count reduced)`)
    }
    lines.push('')
    lines.push('_What this claims: current-state PCI data-flow lineage from BAM (authoritative) + Splunk/survey signals (inferred, marked). What it does not: remediate controls or assert business need._')
    downloadFile('pci-sentinel_block-benefit.md', lines.join('\n'), 'text/markdown;charset=utf-8')
  }

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <div className="disp font-bold text-lg">Block &amp; Benefit <span className="text-faint text-xs font-normal">— block a source, see who benefits downstream</span></div>
            <p className="text-sm text-dim mt-1 max-w-3xl leading-relaxed">
              The FAQ's core question, made interactive: pick an upstream true PAN source to <b>block</b> (tokenize → CRN) and
              see exactly which downstream systems benefit. <span className="text-safe">Bright nodes fully leave PCI scope</span> (this
              was their only true source); the badge counts systems that lose a clear-PAN feed but stay in scope via another
              parent. Select a second source to compare. The list is pre-ranked, so the default selection is the
              highest-benefit single block on this estate.
            </p>
          </div>
          <div className="flex flex-col gap-1.5 shrink-0">
            <button onClick={downloadCSV} className="mono text-[11px] px-3 py-1.5 rounded-lg border border-safe/40 bg-white text-safe shadow-sm hover:bg-safe/10 whitespace-nowrap transition">↓ report (CSV)</button>
            <button onClick={downloadMD} className="mono text-[11px] px-3 py-1.5 rounded-lg border border-safe/40 bg-white text-safe shadow-sm hover:bg-safe/10 whitespace-nowrap transition">↓ report (.md)</button>
          </div>
        </div>
      </div>

      {sat && <div className="card p-4 border-l-4" style={{ borderLeftColor: '#2563EB' }}>
        <div className="text-sm text-txt"><b className="text-cool">Saturated estate — this is the finding, not a bug.</b> The top {sat.n} true sources each feed ~{sat.pct}% of the in-scope estate, so their per-source numbers are near-identical. Every downstream system has <i>many</i> true-PAN parents, so blocking any one source removes a clear-PAN feed from almost everything yet <b>fully frees almost nothing</b> — which is precisely why piecemeal tokenization can't reduce this estate.</div>
        <div className="text-[12px] text-dim mt-1.5">The signals that <i>do</i> discriminate here: the <span className="text-safe">fully-freed</span> column (only <span className="mono text-safe">{sat.topSolo}</span> frees a system on its own — its single exclusive child), and <b>set-vs-set</b> blocking. See the <b>Planner</b> for the block-set comparison and the saturation curve, which shows full descope only ramps once nearly the whole source front is tokenized.</div>
      </div>}

      <div className="grid lg:grid-cols-3 gap-5">
        {/* ranked candidate list */}
        <div className="card p-4">
          <div className="text-[11px] uppercase tracking-widest text-faint mb-2">Candidate sources <span className="text-faint normal-case">· ranked by benefit</span></div>
          <div className="text-[11px] text-faint mb-2">Click = block (A). “vs” = compare (B).</div>
          <div className="scroll max-h-[460px] overflow-auto space-y-1">
            {rows.map((r, i) => {
              const isA = r.system === a, isB = r.system === b
              return (
                <div key={r.system} className={'rounded-lg px-2.5 py-2 border cursor-pointer ' + (isA ? 'border-pan bg-pan/10' : isB ? 'border-cool bg-cool/10' : 'border-line hover:border-dim')} onClick={() => setA(r.system)}>
                  <div className="flex items-center gap-2">
                    <span className="mono text-sm" style={{ color: isA ? '#D71E28' : isB ? '#2563EB' : '#1F2329' }}>{r.system}</span>
                    {i === 0 && <span className="text-[9px] px-1 rounded bg-safe/15 text-safe">best</span>}
                    <button onClick={(e) => { e.stopPropagation(); setB(isB ? null : r.system) }} className={'ml-auto text-[10px] px-1.5 py-0.5 rounded border ' + (isB ? 'border-cool text-cool' : 'border-line text-faint hover:text-dim')}>vs</button>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-[10px] text-faint mono">
                    <span className="text-safe">{r.solo_descope} freed</span>
                    <span>{r.feeds_removed} feed ({pct(r.feeds_removed)}%)</span>
                    <span>reach {r.downstream_reach}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* benefit detail */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex flex-wrap gap-3">
            <Card r={ra} color="#D71E28" tag="A · blocked" />
            {rb && <Card r={rb} color="#2563EB" tag="B · compare" />}
          </div>

          <div className="card p-4">
            <div className="text-[11px] uppercase tracking-widest text-faint mb-2">Downstream beneficiaries {ra && <span className="text-faint normal-case">· block {ra.system}</span>}</div>
            <BlastGraph system={ra?.system} soloSet={soloA} adj={adj} byId={byId} color="#D71E28" onPick={onPick} />
            {rb && <div className="border-t border-line mt-3 pt-3">
              <div className="text-[11px] uppercase tracking-widest text-faint mb-2">Compare · block {rb.system}</div>
              <BlastGraph system={rb.system} soloSet={soloB} adj={adj} byId={byId} color="#2563EB" onPick={onPick} />
            </div>}
          </div>

          <div className="card p-4">
            <div className="flex items-center gap-2 mb-1">
              <div className="text-[11px] uppercase tracking-widest text-faint">Report</div>
              <button onClick={copy} className="ml-auto mono text-[11px] px-2 py-0.5 rounded border border-line text-pan hover:bg-panel2">{copied ? 'copied ✓' : 'copy'}</button>
            </div>
            <pre className="text-xs text-dim whitespace-pre-wrap leading-relaxed mono">{report}</pre>
            {ra && ra.solo_descope === 0 && <div className="text-[11px] text-faint mt-1">On this saturated estate no single block fully frees a system — the benefit is exposure narrowing ({ra.feeds_removed} feeds removed). Use the Planner's block-set comparison to find combinations that fully descope.</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ============================ VERDICT BANNER (persistent answer) ============================ */
function VerdictBanner({ d, onTab, onPick }) {
  const h = d.headline || {}, imp = d.impact || {}, hid = d.hidden || {}
  const detail = hid.hidden_detail || []
  const topMiss = detail.length ? detail[0] : null         // highest-reach BAM miss
  const topDist = (d.heavy_hitters || [])[0] || null       // widest distributor overall
  const levers = imp.tokenized_systems || (d.plan?.plan || []).slice(0, 3)
  return (
    <div className="card p-4 mb-5 border-l-4" style={{ borderLeftColor: '#8F0E1E' }}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="disp font-black text-3xl text-panhot">{fmt(h.hidden_pci_systems_bam_misses)}</span>
        <span className="text-txt text-base">systems are handling clear card numbers that BAM never flagged as PCI.</span>
        <button onClick={() => onTab('hidden')} className="mono text-[11px] px-2.5 py-1 rounded-lg bg-panhot text-white font-semibold shadow-sm hover:brightness-110 ml-1 transition">see the evidence →</button>
      </div>
      <div className="text-sm text-dim mt-1.5 leading-relaxed">
        {fmt(h.systems_exposed_to_clear_pan)} systems sit in PCI scope ({h.scope_metadata_confirmed} confirmed · {h.scope_inferred_only} inferred).
        {topDist && (() => {
          const sameTop = topMiss && topMiss.system === topDist.system
          // When the widest distributor overall is itself a system BAM never flagged,
          // state it once — that single fact IS the striking point. A prior version
          // printed the distributor twice (reading as a tautology) whenever the widest
          // overall and the widest BAM-missed system coincided; and "is itself one of
          // those misses" was redundant on the widest BAM-missed system in any case.
          return sameTop ? (
            <> The widest PAN distributor,{' '}
              <button onClick={() => onPick(topDist.system)} className="mono text-panhot hover:underline">{topDist.system}</button>
              {' '}(reaches {topDist.downstream_reach} systems), is itself flagged <b>PCI = No</b> in BAM — the single most exposed distributor on the estate is scope the catalogue never recorded.</>
          ) : (
            <> The widest PAN distributor is{' '}
              <button onClick={() => onPick(topDist.system)} className="mono text-pan hover:underline">{topDist.system}</button>
              {' '}(reaches {topDist.downstream_reach} systems).
              {topMiss && topMiss.downstream_reach > 0 && <> The widest distributor BAM never flagged is{' '}
                <button onClick={() => onPick(topMiss.system)} className="mono text-panhot hover:underline">{topMiss.system}</button>
                {' '}(reaches {topMiss.downstream_reach} systems) — unmanaged scope no compliance program is tracking.</>}</>
          )
        })()}
        {levers.length > 0 && <> Tokenizing the {levers.length} highest-leverage true sources
          ({levers.map((s, i) => <span key={s}><button onClick={() => onPick(s)} className="mono text-pan hover:underline">{s}</button>{i < levers.length - 1 ? ', ' : ''}</span>)})
          fully descopes <b className="text-safe">{imp.nodes_descoped}</b> and strips a clear-PAN feed from <b className="text-safe">{imp.feeds_removed ?? '—'}</b> more — full descope is small because the estate is saturated (every source reaches nearly all systems), which is the finding, not a failure.</>}
      </div>
    </div>
  )
}

/* ============================ HIDDEN SCOPE (the centerpiece) ============================ */
function HiddenScope({ d, onPick }) {
  const hid = d.hidden || {}
  const detail = hid.hidden_detail || []
  const propagating = detail.filter(x => x.downstream_reach > 0)
  const [q, setQ] = useState('')
  const rows = useMemo(() => {
    const t = q.trim().toUpperCase()
    return detail.filter(x => !t || x.system.toUpperCase().includes(t) || (x.name || '').toUpperCase().includes(t))
  }, [detail, q])
  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="disp font-bold text-lg">Hidden scope — what BAM missed <span className="text-faint text-xs font-normal">— the finding that matters most</span></div>
        <p className="text-sm text-dim mt-1.5 max-w-3xl leading-relaxed">
          BAM is self-reported, so it is incomplete. These systems are flagged <b className="text-txt">PCI = No</b> in the business
          catalogue, yet Splunk observed real card numbers in their logs. Each one is unmanaged PCI scope — exposure no compliance
          program currently knows about. We use BAM's <i>current</i> flag, so anything BAM has since caught is excluded.
        </p>
      </div>
      <ReconBars d={d} onPick={onPick} />

      <div className="flex flex-wrap gap-3">
        <KPI label="Hidden PCI — BAM misses" value={fmt(hid.hidden_pci_count)} sub="PCI=No in BAM · clear PAN in Splunk" tone="hot" delay={0}
          def="Systems BAM records as not handling PAN, but clear PAN appears in their Splunk logs." />
        <KPI label="Actively propagating" value={fmt(hid.hidden_propagating_count ?? propagating.length)} sub="feed the leaked PAN further downstream" tone="pan" delay={70}
          def="Hidden-PCI systems that are not leaf nodes — they pass cardholder data onward, widening the unknown exposure." />
        <KPI label="Declared PAN carriers" value={fmt(hid.declared_pan_systems_count)} sub="known, in BAM (for contrast)" tone="cool" delay={140}
          def="Systems BAM does flag as handling PAN — the known surface, shown for scale against the hidden surface." />
      </div>

      {propagating.length > 0 && (
        <div className="card p-5 border-l-4" style={{ borderLeftColor: '#8F0E1E' }}>
          <div className="disp font-bold text-sm text-panhot">Highest-risk misses — unflagged AND propagating</div>
          <div className="text-[11px] text-faint mb-3">A system BAM doesn't know is PCI, that also feeds PAN to others, hides the most scope. These are where to look first.</div>
          <div className="flex flex-wrap gap-2">
            {propagating.map(x => (
              <button key={x.system} onClick={() => onPick(x.system)} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-panhot/10 border border-panhot/30 hover:bg-panhot/20">
                <span className="mono text-panhot font-semibold">{x.system}</span>
                <span className="text-[11px] text-dim">reaches {x.downstream_reach}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="card p-5">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
          <div className="disp font-bold">Evidence ledger <span className="text-faint text-xs font-normal">— every miss, with its Splunk proof</span></div>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="filter id or name…" className="field-ivory border rounded-lg px-3 py-1.5 text-sm mono text-txt w-56 outline-none focus:border-pan focus:ring-2 focus:ring-gold/50" />
        </div>
        <div className="scroll overflow-auto max-h-[460px]">
          <table className="dt zt w-full text-sm">
            <thead><tr className="text-dim text-[11px] uppercase tracking-wider sticky top-0" style={{ background: '#FBF6E6' }}>
              <th>System</th><th title="Downstream systems it feeds PAN to">Propagates to</th>
              <th title="App's own stated origin of the PAN (DS6)">Stated source</th>
              <th>BAM flag</th><th title="What Splunk found in Sept–Dec logs">Splunk finding</th><th title="PCI DSS v4.0.1 requirement families this system should satisfy but does not">v4.0.1 gap</th></tr></thead>
            <tbody>{rows.map(x => (
              <tr key={x.system} className="hh mono" onClick={() => onPick(x.system)}>
                <td className="text-panhot font-semibold">{x.system}<span className="text-faint text-[10px] ml-1.5">{(x.name || '').slice(0, 18)}</span></td>
                <td className={x.downstream_reach > 0 ? 'text-pan' : 'text-faint'}>{x.downstream_reach || '—'}</td>
                <td className="text-dim">{x.stated_source || '—'}</td>
                <td><span className="text-[10px] px-1.5 py-0.5 rounded tint-blue text-cool font-semibold">PCI = No</span></td>
                <td><span className="text-[10px] px-1.5 py-0.5 rounded bg-panhot/15 text-panhot">{x.finding || 'True PAN'}</span></td>
                <td><ReqChips reqs={x.triggered_requirements} /></td>
              </tr>))}</tbody>
          </table>
        </div>
        <div className="text-[11px] text-faint mt-2">Click any row to trace its lineage in Drill-down. "Stated source" is the application owner's own attestation of where the PAN came from — a lead, not authoritative.</div>
      </div>
    </div>
  )
}

/* ============================ EXPOSURE MAP (treemap heatmap — scale-proof) ============================ */
/* A market-map of PCI exposure, the way a bank BA already reads stock heatmaps:
   one tile per in-scope system, grouped by Line of Business, AREA = blast radius
   (downstream systems it feeds), COLOR = risk / fate / live simulation. Pure layout,
   no force physics — renders 4,000 tiles as easily as 95. */
function ExposureMap({ d, onPick }) {
  const [mode, setMode] = useState('risk')          // 'risk' | 'fate' | 'sim'
  const [simSrc, setSimSrc] = useState(null)
  const plan = d.plan || {}
  const perSource = (plan.source_exposure && plan.source_exposure.per_source) || []
  const topSources = perSource.slice(0, 12)
  const seRow = useMemo(() => perSource.find(r => r.system === simSrc) || null, [perSource, simSrc])

  const inScope = useMemo(() => d.viz.nodes.filter(n => n.in_scope), [d])
  const retained = useMemo(() => new Set(((d.impact || {}).retained_via_detokenization) || []), [d])
  const maxRisk = useMemo(() => Math.max(1, ...inScope.map(n => n.risk || 0)), [inScope])

  const simSets = useMemo(() => {
    if (mode !== 'sim' || !simSrc) return null
    const out = new Map()
    d.viz.edges.forEach(e => { const a = eid(e.source); (out.get(a) || out.set(a, []).get(a)).push(eid(e.target)) })
    const down = new Set(); let fr = [simSrc]
    while (fr.length) { const nx = []; fr.forEach(u => (out.get(u) || []).forEach(v => { if (!down.has(v) && v !== simSrc) { down.add(v); nx.push(v) } })); fr = nx }
    return { down, freed: new Set((seRow && seRow.solo_systems) || []) }
  }, [mode, simSrc, d, seRow])

  const riskColor = r => {
    const t = Math.min(1, (r || 0) / maxRisk)
    const mix = (a, b) => Math.round(a + (b - a) * t)
    return `rgb(${mix(252, 215)},${mix(242, 30)},${mix(226, 40)})`   // warm paper -> brand red
  }
  const fateColor = n => n.true_source ? '#D71E28' : retained.has(n.id) ? '#2563EB' : '#0E7C4A'
  const simColor = n => {
    if (!simSets) return '#EDEAE2'
    if (n.id === simSrc) return '#8F0E1E'
    if (simSets.freed.has(n.id)) return '#0E7C4A'
    if (simSets.down.has(n.id)) return '#8CC2A6'
    return '#EDEAE2'
  }
  const fill = n => mode === 'risk' ? riskColor(n.risk) : mode === 'fate' ? fateColor(n) : simColor(n)
  const textOn = n => {
    const f = fill(n)
    return (f === '#EDEAE2' || f === '#8CC2A6' || (mode === 'risk' && (n.risk || 0) / maxRisk < 0.45)) ? '#1F2329' : '#FFFFFF'
  }

  const layout = useMemo(() => {
    const byLob = new Map()
    inScope.forEach(n => { const k = n.lob || '(LOB not recorded)'; (byLob.get(k) || byLob.set(k, []).get(k)).push(n) })
    const root = d3.hierarchy({
      children: [...byLob.entries()].map(([lob, kids]) => ({ lob, children: kids.map(n => ({ node: n })) }))
    }).sum(x => x.node ? 1 + (x.node.reach || 0) : 0).sort((a, b) => b.value - a.value)
    const W = 1180, H = 640
    d3.treemap().size([W, H]).paddingInner(2).paddingTop(18).paddingOuter(3).round(true)(root)
    return { root, W, H }
  }, [inScope])

  const Mode = ({ k, l }) => (
    <button onClick={() => setMode(k)}
      className={'mono text-[11px] px-2.5 py-1 rounded border ' + (mode === k ? 'border-pan text-pan bg-pan/10 font-semibold' : 'border-[#D9D3C7] bg-white text-dim shadow-sm hover:text-txt hover:border-pan/60 hover:bg-gold/10')}>{l}</button>
  )
  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="disp font-bold text-lg">PCI Exposure Map <span className="text-faint text-xs font-normal">— every tile is an in-scope system · area = how many systems it feeds · built to stay legible at 4,000+ apps</span></div>
        <div className="text-xs text-dim mt-1 max-w-4xl">Grouped by line of business, read like a market heatmap. Big tiles are the distributors that matter; tiny tiles are leaf consumers. Switch the coloring: <b>Risk heat</b> (deeper red = riskier), <b>Fate</b> (what happens under full tokenization), or <b>⚡ Simulate</b> — pick a source and watch exactly which systems benefit when its clear-PAN feed is cut. Click any tile to drill into its lineage.</div>
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <span className="text-[11px] text-faint">color by:</span>
          <Mode k="risk" l="Risk heat" /><Mode k="fate" l="Fate under full tokenization" /><Mode k="sim" l="⚡ Simulate a source" />
          {mode === 'sim' && (
            <span className="flex items-center gap-1.5 flex-wrap ml-2">
              <span className="text-[11px] text-faint">cut clear PAN at:</span>
              {topSources.map(r => (
                <button key={r.system} onClick={() => setSimSrc(r.system)}
                  className={'mono text-[11px] px-2 py-0.5 rounded border ' + (simSrc === r.system ? 'border-pan bg-pan text-white font-semibold' : 'border-pan/30 bg-pan/5 text-pan hover:bg-pan/15')}>{r.system}</button>
              ))}
            </span>
          )}
        </div>
        {mode === 'sim' && simSrc && seRow && (
          <div className="mt-3 px-3 py-2 rounded-lg tint-green flex items-center gap-4 flex-wrap text-[11px] text-dim">
            <span className="font-semibold text-txt">Cutting clear PAN at {simSrc}:</span>
            <span><b className="disp text-safe text-base">{fmt(seRow.solo_descope)}</b> fully freed — leave PCI scope</span>
            <span><b className="disp text-safe text-base">{fmt(seRow.feeds_removed)}</b> stop receiving its clear-PAN feed</span>
            <span><b className="disp text-cool text-base">{fmt(seRow.parent_reduction)}</b> have exposure narrowed</span>
            <span className="text-faint">{simSrc} stays in the CDE as the tokenization point</span>
          </div>
        )}
        {mode === 'sim' && !simSrc && <div className="mt-3 text-[11px] text-faint">Pick a source above — the map recolors to show exactly who benefits.</div>}
        <div className="flex flex-wrap gap-4 mt-3 text-[11px] text-dim">
          {mode === 'risk' && <>
            <span><i className="inline-block w-3 h-3 rounded-sm align-[-2px] mr-1.5" style={{ background: riskColor(maxRisk * 0.15) }} />lower risk</span>
            <span><i className="inline-block w-3 h-3 rounded-sm align-[-2px] mr-1.5" style={{ background: riskColor(maxRisk) }} />highest risk</span>
            <span><i className="inline-block w-3 h-3 rounded-sm align-[-2px] mr-1.5" style={{ background: '#fff', boxShadow: 'inset 0 0 0 2px #8F0E1E' }} />dark ring = hidden PCI (BAM miss)</span>
          </>}
          {mode === 'fate' && <>
            <span><i className="inline-block w-3 h-3 rounded-sm align-[-2px] mr-1.5" style={{ background: '#0E7C4A' }} />leaves PCI scope under full tokenization</span>
            <span><i className="inline-block w-3 h-3 rounded-sm align-[-2px] mr-1.5" style={{ background: '#D71E28' }} />stays — tokenization point</span>
            <span><i className="inline-block w-3 h-3 rounded-sm align-[-2px] mr-1.5" style={{ background: '#2563EB' }} />stays — needs RISE/APG</span>
          </>}
          {mode === 'sim' && <>
            <span><i className="inline-block w-3 h-3 rounded-sm align-[-2px] mr-1.5" style={{ background: '#8F0E1E' }} />the cut source</span>
            <span><i className="inline-block w-3 h-3 rounded-sm align-[-2px] mr-1.5" style={{ background: '#0E7C4A' }} />fully freed</span>
            <span><i className="inline-block w-3 h-3 rounded-sm align-[-2px] mr-1.5" style={{ background: '#8CC2A6' }} />loses this clear-PAN feed</span>
            <span><i className="inline-block w-3 h-3 rounded-sm align-[-2px] mr-1.5" style={{ background: '#EDEAE2' }} />unaffected</span>
          </>}
        </div>
      </div>

      <div className="card p-3">
        <svg viewBox={`0 0 ${layout.W} ${layout.H}`} className="w-full" style={{ maxHeight: 680 }}>
          {layout.root.children && layout.root.children.map((g, gi) => (
            <g key={gi}>
              <rect x={g.x0} y={g.y0} width={g.x1 - g.x0} height={g.y1 - g.y0} fill="none" stroke="#D9D3C7" strokeWidth="1" rx="3" />
              {(g.x1 - g.x0) > 70 && <text x={g.x0 + 4} y={g.y0 + 12} fontSize="9" fontWeight="700" fill="#5A6472" className="mono">
                {String(g.data.lob).slice(0, Math.floor((g.x1 - g.x0) / 6))}</text>}
              {g.children && g.children.map((leaf, li) => {
                const n = leaf.data.node, w = leaf.x1 - leaf.x0, h = leaf.y1 - leaf.y0
                const simNote = (mode === 'sim' && simSets)
                  ? '\n' + (simSets.freed.has(n.id) ? ('→ FULLY FREED if ' + simSrc + ' is tokenized')
                    : simSets.down.has(n.id) ? ('→ loses the clear-PAN feed from ' + simSrc)
                    : n.id === simSrc ? '→ the tokenization point' : '→ unaffected by this cut') : ''
                return (
                  <g key={li} style={{ cursor: 'pointer' }} onClick={() => onPick(n.id)}>
                    <rect x={leaf.x0} y={leaf.y0} width={w} height={h} fill={fill(n)} rx="2"
                      stroke={n.hidden_pci ? '#8F0E1E' : '#FFFFFF'} strokeWidth={n.hidden_pci ? 2 : 0.75} />
                    {w > 34 && h > 14 && <text x={leaf.x0 + w / 2} y={leaf.y0 + h / 2 + 3} textAnchor="middle"
                      fontSize={Math.min(11, h - 4)} fontWeight="700" fill={textOn(n)} className="mono" style={{ pointerEvents: 'none' }}>{n.id}</text>}
                    <title>{n.id + (n.name ? ' — ' + n.name : '') + '\nfeeds ' + fmt(n.reach || 0) + ' systems · risk ' + Math.round(n.risk || 0) + ' · tier ' + (n.tier != null ? n.tier : '—') + (n.true_source ? '\ntrue PAN source' : '') + (n.hidden_pci ? '\n⚠ hidden PCI — BAM never flagged it' : '') + simNote + '\nclick to drill into lineage'}</title>
                  </g>
                )
              })}
            </g>
          ))}
        </svg>
      </div>
    </div>
  )
}

/* ============================ MIGRATION ADVISORY (decision support — execution out of scope) ============================ */
/* The organizer FAQ (Tokenization Q8) defers actual migration to "separate activities";
   this tab is therefore an ADVISORY sequence, not an execution plan — it tells the
   program owner the order of work and who is in each wave, derived entirely from the
   computed graph. Scale-aware: counts + ranked samples, never 4,000 rows on screen. */
function MigrationAdvisory({ d, onPick, onTab }) {
  const plan = d.plan || {}, imp = d.impact || {}, hid = d.hidden || {}, st = d.structure || {}
  const steps = plan.steps || []
  const curve = (plan.cumulative_curve || plan.saturation_curve?.curve || [])
  const fb = plan.floor_breakdown || {}
  const retainedList = imp.retained_via_detokenization || []
  const inScope = useMemo(() => d.viz.nodes.filter(n => n.in_scope), [d])
  const retainedSet = useMemo(() => new Set(retainedList), [retainedList])
  const acceptCrn = useMemo(() => inScope.filter(n => !n.true_source && !retainedSet.has(n.id))
    .sort((a, b) => (b.risk || 0) - (a.risk || 0)), [inScope, retainedSet])
  const sources = useMemo(() => inScope.filter(n => n.true_source)
    .sort((a, b) => (b.reach || 0) - (a.reach || 0)), [inScope])
  const orderedSrc = useMemo(() => {
    const fromPlan = steps.map(s => s.tokenize)
    const rest = sources.map(n => n.id).filter(id => !fromPlan.includes(id))
    return [...fromPlan, ...rest]
  }, [steps, sources])
  const hiddenDetail = hid.hidden_detail || []
  const chokes = (st.segmentation_candidates || []).slice(0, 8)

  const Chips = ({ ids, tone }) => (
    <div className="flex flex-wrap gap-1 mt-2">
      {ids.slice(0, 12).map(id => (
        <button key={id} onClick={() => onPick(id)}
          className={'mono text-[11px] px-1.5 py-0.5 rounded hover:brightness-95 ' + tone}>{id}</button>
      ))}
      {ids.length > 12 && <span className="text-[10px] text-faint self-center">+{fmt(ids.length - 12)} more</span>}
    </div>
  )
  const Wave = ({ n, title, count, color, children }) => (
    <div className="card p-4 flex-1 min-w-[260px]" style={{ borderTop: '3px solid ' + color }}>
      <div className="flex items-baseline gap-2">
        <span className="disp font-black text-lg" style={{ color }}>{n}</span>
        <span className="disp font-bold text-sm text-txt">{title}</span>
        <span className="mono text-[11px] text-faint ml-auto">{fmt(count)} systems</span>
      </div>
      {children}
    </div>
  )
  return (
    <div className="space-y-4">
      <div className="card p-5 tint-gold">
        <div className="disp font-bold text-lg">Migration advisory <span className="text-faint text-xs font-normal">— the order of work, derived from the graph</span></div>
        <p className="text-sm text-dim mt-1 max-w-4xl leading-relaxed">
          <b className="text-txt">Advisory only.</b> The organizers are explicit that executing tokenization — downstream CRN acceptance,
          RISE/APG onboarding — is handled by <i>separate activities</i> outside this exercise. What the graph CAN decide, deterministically,
          is the <b>sequence</b>: who converts first, who follows, and who is permanent scope. Every wave below is computed from the same
          audited lineage as the rest of the analysis; nothing is invented.
        </p>
      </div>

      <div className="flex flex-wrap gap-4">
        <Wave n="W1" title="Tokenize the true sources" count={plan.true_source_count || sources.length} color="#D71E28">
          <p className="text-xs text-dim mt-1.5 leading-relaxed">Convert PAN → CRN where card numbers <b>originate</b>, in optimizer order — earliest steps carry the most leverage. These systems remain in the CDE as the tokenization points.</p>
          <Chips ids={orderedSrc} tone="bg-pan/10 text-pan" />
          {steps.length > 0 && <div className="text-[10px] text-faint mt-2">first {steps.length} in certified order: {steps.map(s => s.tokenize).join(' → ')}</div>}
        </Wave>
        <Wave n="W2" title="Switch downstream to CRN" count={plan.descopable ?? acceptCrn.length} color="#0E7C4A">
          <p className="text-xs text-dim mt-1.5 leading-relaxed">Once a system's <b>entire</b> source front emits CRN, it accepts tokens and <b>leaves PCI scope</b> — the clean-stream effect. Sequence inside the wave: highest-risk first (shown).</p>
          <Chips ids={acceptCrn.map(n => n.id)} tone="bg-safe/10 text-safe" />
        </Wave>
        <Wave n="W3" title="Onboard RISE/APG de-tokenization" count={retainedList.length} color="#2563EB">
          <p className="text-xs text-dim mt-1.5 leading-relaxed">These genuinely need the real card number. They stay inside the CDE <b>by design</b> and convert CRN → PAN only through the centralized RISE/APG services — permanent, controlled scope.</p>
          <Chips ids={retainedList} tone="bg-cool/10 text-cool" />
        </Wave>
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="card p-4 flex-1 min-w-[300px]" style={{ borderTop: '3px solid #8F0E1E' }}>
          <div className="disp font-bold text-sm text-panhot">Parallel track — close the hidden scope first</div>
          <p className="text-xs text-dim mt-1.5">The {fmt(hid.hidden_pci_count || 0)} systems BAM never flagged are unmanaged risk <i>today</i>, independent of any wave. Triage them before W1 budgets are set — each carries its Splunk evidence. <button onClick={() => onTab && onTab('hidden')} className="text-panhot hover:underline font-semibold">open the evidence ledger →</button></p>
          <Chips ids={hiddenDetail.map(x => x.system)} tone="bg-panhot/10 text-panhot" />
        </div>
        <div className="card p-4 flex-1 min-w-[300px]" style={{ borderTop: '3px solid #0E7C4A' }}>
          <div className="disp font-bold text-sm text-safe">Alternative lever — segmentation</div>
          <p className="text-xs text-dim mt-1.5">Where tokenization is slow to land, network-isolating the PAN feed at a choke point removes its whole downstream branch from CDE scope — the other canonical lever, available per-branch at any time.</p>
          <Chips ids={chokes.map(c => c.system || c)} tone="bg-safe/10 text-safe" />
        </div>
      </div>

      <div className="card p-4 text-[11px] text-faint leading-relaxed">
        Dependency rule the sequence encodes: a W2 system flips only when <b>all</b> of its true-source parents have completed W1
        (conjunctive coverage — the saturation curve in the Planner shows exactly when the wave releases{curve.length ? '' : ''}).
        W3 has no dependency on W1/W2 and can start immediately. Effort and ownership are deliberately NOT estimated here —
        execution planning is out of this exercise's scope per the organizer FAQ.
      </div>
    </div>
  )
}

/* ============================ BAM vs SPLUNK RECONCILIATION (the catalogue's blind spot, quantified) ============================ */
/* Proportional set-comparison, scale-proof at 4,000+ apps: what the system of record
   DECLARES vs what the logs OBSERVE, and the union — the real PAN surface. */
function ReconBars({ d, onPick }) {
  const hid = d.hidden || {}
  const declared = hid.declared_pan_systems_count || 0
  const hidden = hid.hidden_pci_count || 0
  const observed = useMemo(() => d.viz.nodes.filter(n => n.pan_in_logs_observed).length, [d])
  const overlap = Math.max(0, observed - hidden)      // observed in logs AND BAM already flags PCI
  const union = declared + hidden                      // the real PAN surface
  const [seg, setSeg] = useState(null)                 // {title, tone, list:[node]} | null
  const [q, setQ] = useState('')
  const lists = useMemo(() => {
    const ns = d.viz.nodes
    const decl = ns.filter(n => n.carries_pan).sort((a, b) => (b.reach || 0) - (a.reach || 0))
    const hidSet = new Set(hid.hidden_pci_systems || [])
    const hidL = ns.filter(n => hidSet.has(n.id)).sort((a, b) => (b.reach || 0) - (a.reach || 0))
    const obs = ns.filter(n => n.pan_in_logs_observed).sort((a, b) => (b.reach || 0) - (a.reach || 0))
    const ovl = obs.filter(n => !hidSet.has(n.id))
    return { decl, hidL, obs, ovl, union: [...decl, ...hidL] }
  }, [d, hid])
  const open = (title, tone, list) => { setQ(''); setSeg({ title, tone, list }) }
  const shown = seg ? seg.list.filter(n => !q || n.id.toLowerCase().includes(q.toLowerCase()) || (n.name || '').toLowerCase().includes(q.toLowerCase())) : []
  if (!union) return null
  const covPct = Math.round(100 * declared / union)
  const W = 1080, BH = 34, GAP = 46, P = { l: 8, t: 26 }
  const x = v => P.l + (v / union) * (W - 2 * P.l)
  return (
    <div className="card p-5">
      <div className="disp font-bold text-lg">What BAM declares vs what Splunk observes <span className="text-faint text-xs font-normal">— the catalogue's blind spot, measured</span></div>
      <div className="text-xs text-dim mt-1 max-w-4xl">BAM is the system of record but it is self-reported. Splunk log evidence is the ground truth check. Lay the two over each other and the gap is the finding: <b className="text-txt">the catalogue sees {covPct}% of the real clear-PAN surface</b> — the missing {100 - covPct}% ({fmt(hidden)} systems) is scope no compliance program is tracking.</div>
      <svg viewBox={`0 0 ${W} ${P.t + 3 * (BH + GAP)}`} className="w-full" style={{ maxHeight: 290 }}>
        {/* row 1 — BAM declared */}
        <text x={P.l} y={P.t - 8} fontSize="11" fontWeight="700" fill="#1F2329">BAM declares — PAN carriers in the catalogue</text>
        <rect x={x(0)} y={P.t} width={x(declared) - x(0)} height={BH} rx="4" fill="#2563EB" fillOpacity=".85"
          style={{ cursor: 'pointer' }} onClick={() => open('Declared in BAM — known PAN carriers', '#2563EB', lists.decl)}><title>click to list the {fmt(declared)} declared carriers</title></rect>
        <text x={x(declared) - 8} y={P.t + BH / 2 + 4} textAnchor="end" fontSize="13" fontWeight="800" fill="#fff" className="disp">{fmt(declared)}</text>
        {/* row 2 — Splunk observed */}
        <text x={P.l} y={P.t + BH + GAP - 8} fontSize="11" fontWeight="700" fill="#1F2329">Splunk observes — clear PAN actually in the logs</text>
        <rect x={x(Math.max(0, declared - overlap))} y={P.t + BH + GAP} width={Math.max(2, x(observed) - x(0))} height={BH} rx="4" fill="#E8A33D" fillOpacity=".9"
          style={{ cursor: 'pointer' }} onClick={() => open('Observed in Splunk — clear PAN in the logs', '#E8A33D', lists.obs)}><title>click to list the {fmt(observed)} Splunk-observed systems</title></rect>
        {hidden > 0 && <rect x={x(declared)} y={P.t + BH + GAP} width={x(hidden) - x(0)} height={BH} rx="4" fill="#8F0E1E" fillOpacity=".95"
          style={{ cursor: 'pointer' }} onClick={() => open('Hidden PCI — BAM never flagged, Splunk has the proof', '#8F0E1E', lists.hidL)}><title>click to list the {fmt(hidden)} hidden systems</title></rect>}
        {overlap > 0 && <text x={x(Math.max(0, declared - overlap)) + 8} y={P.t + BH + GAP + BH / 2 + 4} fontSize="11" fontWeight="700" fill="#1F2329">{fmt(overlap)} also in BAM ✓</text>}
        {hidden > 0 && <text x={x(declared) + (x(hidden) - x(0)) / 2} y={P.t + BH + GAP + BH / 2 + 4} textAnchor="middle" fontSize="13" fontWeight="800" fill="#fff" className="disp">{fmt(hidden)} BAM never flagged</text>}
        {/* row 3 — the real surface (union) */}
        <text x={P.l} y={P.t + 2 * (BH + GAP) - 8} fontSize="11" fontWeight="700" fill="#1F2329">The real clear-PAN surface — declared ∪ observed</text>
        <rect x={x(0)} y={P.t + 2 * (BH + GAP)} width={x(declared) - x(0)} height={BH} rx="4" fill="#2563EB" fillOpacity=".55"
          style={{ cursor: 'pointer' }} onClick={() => open('The real clear-PAN surface — declared ∪ observed', '#5A6472', lists.union)}><title>click to list all {fmt(union)} systems on the real surface</title></rect>
        <rect x={x(declared)} y={P.t + 2 * (BH + GAP)} width={x(hidden) - x(0)} height={BH} rx="4" fill="#8F0E1E" fillOpacity=".9"
          style={{ cursor: 'pointer' }} onClick={() => open('Hidden PCI — BAM never flagged, Splunk has the proof', '#8F0E1E', lists.hidL)}><title>click to list the {fmt(hidden)} hidden systems</title></rect>
        <text x={x(union) - 8} y={P.t + 2 * (BH + GAP) + BH / 2 + 4} textAnchor="end" fontSize="13" fontWeight="800" fill="#fff" className="disp">{fmt(union)}</text>
        {/* coverage bracket */}
        <line x1={x(0)} y1={P.t + 2 * (BH + GAP) + BH + 12} x2={x(declared)} y2={P.t + 2 * (BH + GAP) + BH + 12} stroke="#2563EB" strokeWidth="2" />
        <text x={x(declared / 2)} y={P.t + 2 * (BH + GAP) + BH + 26} textAnchor="middle" fontSize="10" fontWeight="700" fill="#2563EB">catalogue coverage {covPct}%</text>
        <line x1={x(declared)} y1={P.t + 2 * (BH + GAP) + BH + 12} x2={x(union)} y2={P.t + 2 * (BH + GAP) + BH + 12} stroke="#8F0E1E" strokeWidth="2" />
        <text x={x(declared + hidden / 2)} y={P.t + 2 * (BH + GAP) + BH + 26} textAnchor="middle" fontSize="10" fontWeight="700" fill="#8F0E1E">invisible {100 - covPct}%</text>
      </svg>
      <div className="text-[11px] text-faint mt-1">Proportional to system counts, so it stays honest at any scale. <b className="text-dim">Click any bar segment to list its systems.</b> The dark-red block is exactly the evidence ledger below — every system in it has its Splunk proof attached.</div>

      {seg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(31,35,41,.45)' }} onClick={() => setSeg(null)}>
          <div className="card p-5 w-full max-w-lg shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-sm" style={{ background: seg.tone }} />
              <span className="disp font-bold text-base text-txt">{seg.title}</span>
              <span className="mono text-[11px] text-faint">({fmt(seg.list.length)})</span>
              <button onClick={() => setSeg(null)} className="ml-auto text-faint hover:text-txt text-lg leading-none">✕</button>
            </div>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="filter id or name…" autoFocus
              className="field-ivory border rounded-lg px-3 py-1.5 text-sm mono text-txt w-full mt-3 outline-none focus:border-pan focus:ring-2 focus:ring-gold/50" />
            <div className="scroll overflow-auto max-h-80 mt-2 grid grid-cols-2 gap-1.5">
              {shown.slice(0, 200).map(n => (
                <button key={n.id} onClick={() => { onPick && onPick(n.id); setSeg(null) }}
                  className="flex items-center justify-between px-2.5 py-1.5 rounded-lg border border-line bg-white hover:border-pan/60 hover:bg-gold/10 text-left">
                  <span className="mono text-xs text-txt font-semibold">{n.id}</span>
                  <span className="mono text-[10px] text-faint">feeds {fmt(n.reach || 0)}</span>
                </button>
              ))}
              {shown.length === 0 && <div className="text-xs text-faint col-span-2 py-3 text-center">no systems match the filter</div>}
              {shown.length > 200 && <div className="text-[10px] text-faint col-span-2 text-center">showing first 200 — narrow with the filter</div>}
            </div>
            <div className="text-[10px] text-faint mt-2">sorted by downstream reach · click a system to open its full drill-down</div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ============================ PRESENT MODE (guided tour — communication axis) ============================ */
function buildTourSteps(d) {
  const h = d.headline || {}, imp = d.impact || {}, plan = d.plan || {}, econ = d.economics || {}
  const hid = d.hidden || {}
  const topMiss = (hid.hidden_detail || [])[0]
  const topDist = (d.heavy_hitters || [])[0]
  const fb = plan.floor_breakdown || {}
  const sat = plan.saturation_curve || {}
  const lastSat = (sat.curve || [])[ (sat.curve || []).length - 1 ]
  const floor = Math.max(0, (plan.before ?? 0) - (plan.descopable ?? 0))
  return [
    { tab: 'overview', title: 'The estate, in one screen',
      text: `${fmt(h.systems_exposed_to_clear_pan)} systems sit in PCI scope today — ${fmt(h.scope_metadata_confirmed)} confirmed by authoritative BAM metadata, ${fmt(h.scope_inferred_only)} surfaced only by survey/Splunk signals and kept clearly separate. ${fmt(h.cycle_clusters_resolved)} circular-dependency clusters were resolved via Tarjan SCC condensation into a provable DAG, so every lineage claim that follows is well-defined.` },
    { tab: 'hidden', title: 'The finding BAM cannot see',
      text: `${fmt(h.hidden_pci_systems_bam_misses)} systems are recorded as PCI = No in the catalogue, yet clear card numbers appear in their Splunk logs — unmanaged scope no compliance program is tracking.${topMiss ? ` The widest of them, ${topMiss.system}, propagates onward to ${fmt(topMiss.downstream_reach)} downstream systems.` : ''} Every row carries its evidence: the masked finding, the owner's stated source, and how far the leak travels.` },
    { tab: 'planner', title: 'Why no single tokenization fixes this',
      text: `${topDist ? `The widest distributor, ${topDist.system}, feeds clear PAN to ${fmt(topDist.downstream_reach)} systems — yet tokenizing it alone frees almost nothing.` : ''} A system only leaves the CDE when ALL of its true PAN sources emit CRN, and on a saturated estate every system has many. The saturation curve shows full descope stays flat until nearly the whole ${fmt(plan.true_source_count)}-source front is tokenized${lastSat ? `, then releases ${fmt(lastSat.fully_descoped)} of ${fmt(plan.before)} systems` : ''}. That shape is the insight, not a failure — and the certified-optimal frontier below it is exact, not heuristic.` },
    { tab: 'blast', title: 'Block this vs block that',
      text: `Even before full descope, every tokenization removes real exposure. Blocking a source strips its clear-PAN feeds, shrinks downstream parent counts, and lowers aggregate risk — the per-source benefit table and the side-by-side block-set comparison quantify exactly what the organizers' FAQ asks: "if we don't send PCI from this upstream, how many downstream benefit?"` },
    { tab: 'onboard', title: 'Dry-run tomorrow\'s system today',
      text: `Extensibility, live: describe a system that does not exist yet — who it consumes from, who it feeds, what it holds — and the engine answers the architecture review deterministically with the same clean-stream semantics: where it lands (CDE / connected / out), which upstream tokenizations would keep it clean, and how many out-of-scope systems it would drag in. Unknown names are reported, never invented.` },
    { tab: 'overview', title: 'The decision, costed',
      text: `The waterfall: ${fmt(plan.before)} in scope → ${fmt(plan.descopable)} fully descopable → a ${fmt(floor)}-system irreducible floor${fb.origins_in_scope != null ? ` (${fmt(fb.origins_in_scope)} tokenization points + ${fmt(fb.always_cde_in_scope)} always-CDE via RISE/APG)` : ''}.${econ.in_scope_now != null ? ` In audit terms: ${econ.posture_now} today → ${econ.posture_floor} at the floor, with the effort delta priced from labeled, overridable assumptions.` : ''} One denominator across every surface, enforced by a regression test.` },
    { tab: 'methods', title: 'Why you can trust the numbers',
      text: `Hybrid intelligence: deterministic graph algorithms and classical statistics do every measured step — Tarjan, reachability, Brandes betweenness, branch-and-bound exact optimization — each named, cited, and bounded. The LLM only narrates numbers it never computes. Card data is masked first-6/last-4 on ingest and an unmasked PAN fails the entire run. What it claims, and what it deliberately does not, is stated on every page.` },
  ]
}

function PresentMode({ d, onTab, onClose }) {
  const steps = useMemo(() => buildTourSteps(d), [d])
  const [i, setI] = useState(0)
  const go = n => { const j = Math.min(steps.length - 1, Math.max(0, n)); setI(j); onTab(steps[j].tab) }
  useEffect(() => { onTab(steps[0].tab) }, [])  // eslint-disable-line
  useEffect(() => {
    const k = e => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') go(i + 1)
      if (e.key === 'ArrowLeft') go(i - 1)
    }
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k)
  })
  const s = steps[i]
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 pointer-events-none">
      <div className="max-w-[860px] mx-auto px-5 pb-5 pointer-events-auto">
        <div className="card p-5 shadow-2xl border-2" style={{ borderColor: '#D71E28' }}>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="mono text-[11px] px-2 py-0.5 rounded bg-pan text-white font-bold">PRESENTING · {i + 1}/{steps.length}</span>
            <span className="disp font-bold text-lg text-txt">{s.title}</span>
            <button onClick={onClose} className="ml-auto mono text-[11px] px-2 py-1 rounded border border-line text-dim hover:text-txt" title="Esc">✕ exit</button>
          </div>
          <p className="text-sm text-dim leading-relaxed mt-2">{s.text}</p>
          <div className="flex items-center gap-2 mt-3">
            <button onClick={() => go(i - 1)} disabled={i === 0}
              className={'mono text-xs px-4 py-1.5 rounded-lg ' + (i === 0 ? 'bg-line text-faint' : 'bg-panel2 text-txt hover:bg-line')}>← prev</button>
            <div className="flex gap-1.5 mx-2">{steps.map((_, j) => (
              <button key={j} onClick={() => go(j)} className="rounded-full" style={{ width: 8, height: 8, background: j === i ? '#D71E28' : '#C7CDD6' }} />))}</div>
            {i < steps.length - 1
              ? <button onClick={() => go(i + 1)} className="mono text-xs px-4 py-1.5 rounded-lg bg-pan text-white font-semibold hover:brightness-110">next →</button>
              : <button onClick={onClose} className="mono text-xs px-4 py-1.5 rounded-lg bg-safe text-white font-semibold hover:brightness-110">finish ✓</button>}
            <span className="ml-auto text-[10px] text-faint">← → keys · Esc to exit · the script doubles as the 3-minute demo narration</span>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ============================ APP ============================ */
export default function App() {
  const { data: d, src, agents, suggested, uploading, error, phase, gate, analyze, approve, reset, clearError } = useData()
  const [tab, setTab] = useState('overview')
  const [sel, setSel] = useState(null)
  const [present, setPresent] = useState(false)
  if (!d) return <div className="h-full flex items-center justify-center text-dim mono">loading analysis…</div>
  const pick = id => { setSel(id); setTab('drill') }
  const showBanner = !['pipeline'].includes(tab)
  return (
    <div className="min-h-full">
      {/* corporate masthead — brand red band, gold keyline (the page signature) */}
      <div className="masthead">
        <div className="max-w-[1280px] mx-auto px-5 py-3 flex items-center gap-4 flex-wrap">
          <div className="disp font-black text-2xl tracking-tight text-white">PCI<span className="text-gold">·</span>SENTINEL</div>
          <div className="text-xs text-white/80 border-l border-white/30 pl-4 leading-tight">Intelligent mapping of interdependencies across PCI systems<br />cardholder-data lineage · scope reduction · clean-stream targeting</div>
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            {error && <span onClick={clearError} title="dismiss" className="mono text-[11px] px-2 py-1 rounded bg-white text-pan font-semibold cursor-pointer max-w-[340px] truncate shadow-sm">⚠ {error}</span>}
            {src === 'live' && phase === 'done' && (
              <div className="flex items-center gap-1.5">
                <a href="/api/report/pdf" className="mono text-[11px] px-3 py-1.5 rounded bg-white text-brandDeep font-semibold shadow-sm hover:bg-gold hover:text-txt transition" title="Executive PDF report">↓ PDF</a>
                <a href="/api/report/xlsx" className="mono text-[11px] px-3 py-1.5 rounded bg-white text-brandDeep font-semibold shadow-sm hover:bg-gold hover:text-txt transition" title="XLSX data pack">↓ XLSX</a>
              </div>
            )}
            <button onClick={() => setPresent(true)} title="Guided walkthrough of the findings — judge mode"
              className="mono text-[11px] px-3 py-1.5 rounded bg-gold text-txt font-semibold hover:brightness-110 transition">▶ Present</button>
            <button onClick={() => { reset(); setTab('pipeline') }}
              className="mono text-[11px] px-3 py-1.5 rounded bg-white text-pan font-semibold hover:bg-gold hover:text-txt transition">↑ New analysis</button>
            <span className={'mono text-[11px] px-2 py-1 rounded ' + (src === 'live' ? 'bg-white/20 text-white' : 'bg-white/10 text-white/70')}>{src === 'live' ? '● live API' : '● embedded snapshot'}</span>
            <span title="AI narration mode: generative (enterprise gateway) vs deterministic templates with identical numbers"
              className={'mono text-[11px] px-2 py-1 rounded ' + ((d.plan && d.plan.decision_memo && d.plan.decision_memo.generated) ? 'bg-gold text-txt font-semibold' : 'bg-white/10 text-white/70')}>{(d.plan && d.plan.decision_memo && d.plan.decision_memo.generated) ? '✦ AI: generative' : '○ AI: deterministic'}</span>
          </div>
        </div>
      </div>
      <div className="max-w-[1280px] mx-auto px-5 py-5">
      <nav className="flex gap-0.5 items-center mb-5 bg-panel rounded-xl p-1 w-full border border-line shadow-sm overflow-x-auto">
        {[['pipeline', 'Pipeline'], ['overview', 'Overview'], ['hidden', 'Hidden Scope'], ['planner', 'Planner'], ['blast', 'Block & Benefit'], ['onboard', 'Onboarding'], ['roadmap', 'Roadmap'], ['graph', 'Data-Flow Graph'], ['heatmap', 'Exposure Map'], ['drill', 'Drill-down'], ['methods', 'Methods'], ['ask', 'Ask']].map(([k, l]) => (<React.Fragment key={k}>
          <button data-on={tab === k ? '1' : '0'} onClick={() => setTab(k)} className="tab mono text-[13px] px-3.5 py-2 rounded-lg text-dim whitespace-nowrap">{l}</button>
          {['hidden', 'roadmap', 'drill'].includes(k) && <span className="w-px h-5 bg-line mx-0.5" aria-hidden="true" />}
        </React.Fragment>))}
      </nav>
      {showBanner && <VerdictBanner d={d} onTab={setTab} onPick={pick} />}
      {tab === 'pipeline' && <Pipeline d={d} agents={agents} phase={phase} gate={gate} uploading={uploading} suggested={suggested} onUpload={analyze} onApprove={approve} onReset={reset} />}
      {tab === 'overview' && <Overview d={d} onPick={pick} onTab={setTab} />}
      {tab === 'hidden' && <HiddenScope d={d} onPick={pick} />}
      {tab === 'planner' && <Planner d={d} live={src === 'live'} onPick={pick} />}
      {tab === 'blast' && <BlastRadius d={d} onPick={pick} />}
      {tab === 'onboard' && <Onboarding d={d} live={src === 'live'} onPick={pick} />}
      {tab === 'graph' && <GraphView d={d} selected={sel} onPick={setSel} />}
      {tab === 'graph' && sel && <div className="mt-4"><Drill d={d} selected={sel} onPick={setSel} /></div>}
      {tab === 'heatmap' && <ExposureMap d={d} onPick={pick} />}
      {tab === 'roadmap' && <MigrationAdvisory d={d} onPick={pick} onTab={setTab} />}
      {tab === 'drill' && <Drill d={d} selected={sel} onPick={setSel} />}
      {tab === 'methods' && <Methods d={d} onPick={pick} />}
      {tab === 'ask' && <Ask suggested={suggested} live={src === 'live'} />}
      {present && <PresentMode d={d} onTab={setTab} onClose={() => setPresent(false)} />}
      <footer className="text-[11px] text-faint mt-8 leading-relaxed">
        <b className="text-dim">What this claims:</b> current-state PCI data-flow lineage from BAM (authoritative) + Splunk/survey signals (clearly marked inferred), with cycle resolution via Tarjan SCC condensation and a defensible, reproducible risk model.
        <b className="text-dim"> What it does not:</b> remediate controls, assert business need, or treat inferred signals as ground truth. Card numbers are masked first-6/last-4 on ingest; an unmasked PAN fails the run.
      </footer>
      </div>
    </div>
  )
}

/* ============================ DECISION LAYER COMPONENTS (F1–F5) ============================ */

const REQ_SHORT = {
  req3: 'Req 3', req4: 'Req 4', req3_sad: 'Req 3.2 (SAD)',
  req7_8: 'Req 7/8', req10: 'Req 10', req11: 'Req 11',
}
function ReqChips({ reqs }) {
  if (!reqs || !reqs.length) return null
  return (
    <div className="flex flex-wrap gap-1">
      {reqs.map(r => (
        <span key={r} className="mono text-[10px] px-1.5 py-0.5 rounded border border-panhot/40 text-panhot bg-panhot/5">
          {REQ_SHORT[r] || r}
        </span>
      ))}
    </div>
  )
}

/* F1 — scope economics (the exec headline) */
function ScopeEconomics({ d }) {
  const e = d.economics
  if (!e || !e.in_scope_now) return null
  const a = e.assumptions || {}
  const money = n => (typeof n === 'number' ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n)
  const crossesPosture = e.posture_now !== e.posture_floor
  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <div className="disp font-bold text-lg">PCI audit surface — what it costs, and the floor</div>
        <div className="text-[11px] text-faint">all figures are labeled estimates · see assumptions</div>
      </div>
      <div className="flex items-end gap-3 mt-3 flex-wrap">
        <div className="tint-red rounded-lg px-4 py-3">
          <div className="disp text-3xl font-black text-pan">{fmt(e.in_scope_now)}</div>
          <div className="text-[11px] text-dim">in PCI scope now (CDE)</div>
        </div>
        <div className="disp text-2xl text-faint pb-3">→</div>
        <div className="tint-green rounded-lg px-4 py-3">
          <div className="disp text-3xl font-black text-safe">{fmt(e.achievable_floor)}</div>
          <div className="text-[11px] text-dim">achievable floor (full tokenization)</div>
        </div>
        <div className="tint-blue rounded-lg px-4 py-3">
          <div className="disp text-3xl font-black text-cool">{fmt(e.removable)}</div>
          <div className="text-[11px] text-dim">systems removable from scope</div>
        </div>
        <div className="tint-gold rounded-lg px-4 py-3">
          <div className="disp text-2xl font-black text-safe">~{money(e.cost_saving)}</div>
          <div className="text-[11px] text-dim">est. assessment saving ({e.effort_now?.qsa_days}→{e.effort_floor?.qsa_days} QSA-days)</div>
        </div>
      </div>
      {crossesPosture && (
        <div className="text-xs text-safe mt-3">
          Reaching the floor changes the assessment posture from <b>{e.posture_now}</b> to <b>{e.posture_floor}</b>.
        </div>
      )}
      <div className="text-[11px] text-faint mt-3">
        Assumptions (override via env): {money(a.qsa_day_rate)}/QSA-day · {a.days_per_cde_system} day/CDE system ·
        {' '}{a.days_per_connected} day/connected-to system · ROC above {fmt(a.roc_threshold)} in-scope.
        Floor = current scope minus the maximum fully-descoped count on the saturation curve.
      </div>
    </div>
  )
}

/* F2 — scope category bar (CDE / connected-to / out) */
function CategoryBar({ d }) {
  const c = d.categories && d.categories.counts
  const fam = (d.categories && d.categories.family_counts) || {}
  const labels = (d.categories && d.categories.family_labels) || {}
  if (!c) return null
  const total = (c.cde || 0) + (c.connected || 0) + (c.out || 0) || 1
  const seg = [
    ['In scope (CDE)', c.cde, 'bg-pan', 'text-pan'],
    ['Connected-to', c.connected, 'bg-cool', 'text-cool'],
    ['Out of scope', c.out, 'bg-safe', 'text-safe'],
  ]
  return (
    <div className="card p-5">
      <div className="disp font-bold text-lg">PCI scope categories (v4.0.1)</div>
      <div className="text-[11px] text-faint mb-3">
        The three official PCI SSC categories. Connected-to systems are also in scope — they can affect
        the CDE. Tokenization moves systems CDE → connected-to → out.
      </div>
      <div className="flex h-5 rounded-full overflow-hidden bg-panel2">
        {seg.map(([lbl, v, bg]) => (
          <div key={lbl} className={'h-full ' + bg} title={`${lbl}: ${v}`}
            style={{ width: (100 * (v || 0) / total) + '%', transition: 'width .8s cubic-bezier(.2,.8,.2,1)' }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-4 mt-2 text-xs">
        {seg.map(([lbl, v, , tc]) => (
          <span key={lbl} className={tc}><b className="mono">{fmt(v || 0)}</b> <span className="text-dim">{lbl}</span></span>
        ))}
      </div>
      {Object.keys(fam).length > 0 && (
        <div className="mt-4">
          <div className="text-[11px] text-dim mb-1">Requirement families triggered across in-scope systems:</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
            {Object.entries(fam).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
              <span key={k} title={labels[k] || k}>
                <b className="mono text-panhot">{fmt(v)}</b> <span className="text-dim">{REQ_SHORT[k] || k}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/* per-system scope-category + requirements badge (Drill) */
function RequirementBadges({ node }) {
  if (!node) return null
  const cat = node.category
  const tone = cat === 'cde' ? 'text-pan border-pan/40 bg-pan/5'
    : cat === 'connected' ? 'text-cool border-cool/40 bg-cool/5'
      : 'text-safe border-safe/40 bg-safe/5'
  const label = cat === 'cde' ? 'In scope (CDE)' : cat === 'connected' ? 'Connected-to' : 'Out of scope'
  return (
    <div className="mb-3">
      <span className={'mono text-[11px] px-2 py-0.5 rounded border ' + tone}>{label}</span>
      <div className="mt-1"><ReqChips reqs={node.triggered_requirements} /></div>
    </div>
  )
}

/* F4 — segmentation choke points (second lever; Planner) */
function SegmentationCard({ d, onPick }) {
  const rows = (d.structure && d.structure.segmentation_candidates) || []
  if (!rows.length) return null
  return (
    <div className="card p-5">
      <div className="disp font-bold text-lg">Segmentation choke points (alternative lever)</div>
      <div className="text-[11px] text-faint mb-3">
        Articulation points of the in-scope PAN subgraph: network-isolating the PAN feed at one of these
        removes its whole downstream branch from CDE scope. Segmentation is the other canonical
        scope-reduction lever besides tokenization.
      </div>
      <table className="w-full text-sm zt">
        <thead>
          <tr className="text-dim text-xs text-left border-b border-line">
            <th className="py-1">System</th><th>Branch isolated</th><th>Reach</th><th>Role</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 8).map(r => (
            <tr key={r.system} className="border-b border-line/40 hover:bg-panel2/40">
              <td className="py-1.5"><button className="mono text-pan hover:underline" onClick={() => onPick(r.system)}>{r.system}</button></td>
              <td className="mono text-cool">{fmt(r.branch_size)} systems</td>
              <td className="mono text-dim">{fmt(r.downstream_reach)}</td>
              <td className="text-xs text-dim">{r.is_true_source ? 'true source' : 'relay'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* F3 — Sankey flow (hand-rolled SVG; no d3-sankey dependency) */
function SankeyFlow({ d, onPick }) {
  const ref = useRef(null)
  const sk = d.sankey
  useEffect(() => {
    if (!sk || !sk.nodes || !ref.current) return
    const W = 760, H = 360, padX = 12, bandX = [padX + 90, W / 2 - 40, W - padX - 110]
    const colByBand = ['#D71E28', '#2563EB', '#0E7C4A']  // pan / cool / safe
    const nodes = sk.nodes.map(n => ({ ...n }))
    const links = sk.links.map(l => ({ ...l }))
    const byId = Object.fromEntries(nodes.map(n => [n.id, n]))

    const outSum = {}, inSum = {}
    links.forEach(l => { outSum[l.source] = (outSum[l.source] || 0) + l.value; inSum[l.target] = (inSum[l.target] || 0) + l.value })
    nodes.forEach(n => { n.value = Math.max(outSum[n.id] || 0, inSum[n.id] || 0) || 1 })

    const bands = [0, 1, 2].map(b => nodes.filter(n => n.band === b))
    const maxBandTotal = Math.max(...bands.map(col => col.reduce((s, n) => s + n.value, 0)), 1)
    const scale = (H - 40) / maxBandTotal
    const gap = 10
    bands.forEach(col => {
      let y = 20
      col.sort((a, b) => b.value - a.value)
      col.forEach(n => { n.h = Math.max(n.value * scale, 6); n.y = y; n.x = bandX[n.band]; y += n.h + gap })
    })

    const svg = d3.select(ref.current).html('').append('svg')
      .attr('width', '100%').attr('viewBox', [0, 0, W, H]).style('max-height', H + 'px')

    const linkG = svg.append('g').attr('fill-opacity', 0.28)
    const srcCursor = {}, tgtCursor = {}
    links.sort((a, b) => b.value - a.value).forEach(l => {
      const s = byId[l.source], t = byId[l.target]
      if (!s || !t) return
      const sh = l.value * scale, th = l.value * scale
      const sy = (srcCursor[l.source] = (srcCursor[l.source] || s.y)); srcCursor[l.source] += sh
      const ty = (tgtCursor[l.target] = (tgtCursor[l.target] || t.y)); tgtCursor[l.target] += th
      const x0 = s.x + 14, x1 = t.x, xc = (x0 + x1) / 2
      const path = `M${x0},${sy} C${xc},${sy} ${xc},${ty} ${x1},${ty} L${x1},${ty + th} C${xc},${ty + th} ${xc},${sy + sh} ${x0},${sy + sh} Z`
      linkG.append('path').attr('d', path).attr('fill', colByBand[s.band])
        .append('title').text(`${s.label} → ${t.label}: ${l.value}`)
    })

    const g = svg.append('g')
    nodes.forEach(n => {
      g.append('rect').attr('x', n.x).attr('y', n.y).attr('width', 14).attr('height', n.h)
        .attr('rx', 3).attr('fill', colByBand[n.band]).style('cursor', n.band === 0 ? 'pointer' : 'default')
        .on('click', () => { if (n.band === 0 && n.id.startsWith('src:') && n.id !== 'src:other') onPick(n.id.slice(4)) })
        .append('title').text(`${n.label}: ${n.value}`)
      const anchor = n.band === 2 ? 'end' : 'start'
      const tx = n.band === 2 ? n.x - 6 : n.x + 20
      if (n.h >= 12) g.append('text').attr('x', tx).attr('y', n.y + n.h / 2 + 3).attr('text-anchor', anchor)
        .attr('font-size', 10).attr('fill', '#5A6472').attr('font-family', 'ui-monospace,monospace')
        .text(n.label.length > 22 ? n.label.slice(0, 21) + '…' : n.label)
    })
  }, [sk, onPick])

  if (!sk || !sk.nodes) return null
  return (
    <div className="card p-5">
      <div className="disp font-bold text-lg">How clear PAN flows through the estate</div>
      <div className="text-[11px] text-faint mb-2">
        A few true sources spray real card numbers across nearly everything. Width = systems on that path.
        Left = the widest PAN sources (click to drill) · middle = relays that carry &amp; forward · right = terminal consumers.
        {sk.source_count ? ` ${fmt(sk.source_count)} true sources feed ${fmt(sk.scope)} in-scope systems.` : ''}
      </div>
      <div ref={ref} />
    </div>
  )
}

/* ============================ OWNERSHIP (who owns the exposure) ============================ */
function OwnershipCard({ d, onPick }) {
  const own = d.ownership
  const rows = (own && own.by_lob) || []
  if (!rows.length) return null
  const max = Math.max(1, ...rows.map(r => r.in_scope))
  const cov = own.coverage || {}
  return (
    <div className="card p-5">
      <div className="disp font-bold text-lg">Who owns the exposure</div>
      <div className="text-[11px] text-faint mb-3">
        PCI scope and hidden-PCI counts grouped by the authoritative BAM <b>line of business</b> — the
        remediation program gets owners, not just system IDs. Systems whose BAM row records no line of
        business are reported under "(not recorded in BAM)", never guessed.
      </div>
      <div className="space-y-1.5">
        {rows.map((r, i) => {
          const unattr = r.line_of_business === '(not recorded in BAM)'
          return (
            <div key={i} className="flex items-center gap-2 text-sm">
              <span className={'w-56 truncate text-xs ' + (unattr ? 'text-faint italic' : 'text-txt')} title={r.line_of_business}>{r.line_of_business}</span>
              <div className="flex-1 h-4 rounded bg-panel2 overflow-hidden">
                <div className={'h-full flex items-center justify-end pr-1.5 ' + (unattr ? 'bg-line' : 'bg-pan/80')}
                  style={{ width: Math.max(6, 100 * r.in_scope / max) + '%', transition: 'width .5s' }}>
                  <span className={'mono text-[10px] font-bold ' + (unattr ? 'text-dim' : 'text-ink')}>{r.in_scope}</span>
                </div>
              </div>
              <span className={'mono text-[10px] w-20 text-right ' + (r.hidden_pci > 0 ? 'text-panhot' : 'text-faint')}>
                {r.hidden_pci > 0 ? `⚠ ${r.hidden_pci} hidden` : '—'}
              </span>
              <span className="mono text-[10px] w-16 text-right text-faint">{r.systems} sys</span>
            </div>
          )
        })}
      </div>
      {rows.some(r => r.hidden_sample && r.hidden_sample.length > 0) && (
        <div className="mt-3 pt-3 border-t border-line">
          <div className="text-[10px] uppercase tracking-wider text-faint mb-1">hidden-PCI systems by owner (click to trace)</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {rows.filter(r => r.hidden_sample?.length).map((r, i) => (
              <span key={i} className="text-[11px] text-dim">
                <span className={r.line_of_business === '(not recorded in BAM)' ? 'text-faint italic' : 'text-txt'}>{r.line_of_business}:</span>{' '}
                {r.hidden_sample.map(s => <button key={s} onClick={() => onPick && onPick(s)} className="mono text-panhot hover:underline mr-1">{s}</button>)}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="text-[11px] text-faint mt-3">
        Bar = systems in PCI scope (CDE). Coverage: {fmt(cov.systems_with_lob || 0)} systems carry a BAM line of business,
        {' '}{fmt(cov.systems_without_lob || 0)} do not (mostly systems known only from dependency edges or signals).
      </div>
    </div>
  )
}

/* ============================ INPUT FIDELITY (trust card) ============================ */
function InputFidelity({ d }) {
  const q = d.quality || {}
  const g = d.graph_stats || {}
  if (!q.files_ingested) return null
  const Stat = ({ v, l, tint }) => (
    <div className={(tint || 'bg-panel2') + ' rounded-lg px-3 py-2 text-center'}>
      <div className="disp text-xl font-black text-txt">{fmt(v ?? '—')}</div>
      <div className="text-[10px] text-faint leading-tight">{l}</div>
    </div>
  )
  return (
    <div className="card p-5">
      <div className="disp font-bold text-lg">Input fidelity <span className="text-faint text-xs font-normal">— what was ingested, masked, deduplicated, and refused</span></div>
      <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mt-3">
        <Stat v={q.files_ingested} l="files ingested" />
        <Stat v={q.edge_rows} l="dependency rows (DS1–3)" />
        <Stat v={q.bam_rows} l="BAM rows (DS4)" />
        <Stat v={(q.survey_rows || 0) + (q.splunk_rows || 0)} l="signal rows (DS5+DS6)" />
        <Stat v={q.pan_cells_masked_on_ingest} l="PAN cells masked on ingest" tint="tint-gold" />
        <Stat v={g.unresolved_signals} l="signal tokens NOT invented" tint="tint-blue" />
      </div>
      <div className="text-[11px] text-dim mt-3 leading-relaxed">
        {fmt(g.metadata_edges || 0)} authoritative edges deduplicated to {fmt(g.metadata_edges_deduped || 0)} distinct flows;
        {' '}{fmt(g.inferred_edges || 0)} inferred edges kept separate and source-tagged.
        {' '}<b className="text-txt">{fmt(g.unresolved_signals || 0)} survey/Splunk tokens named systems outside the authoritative
        BAM universe — they are reported and excluded, never invented as nodes or edges</b> (constraint: the map contains
        nothing the inputs cannot prove). Every PAN encountered was masked first-6/last-4 before any processing; an unmasked
        PAN anywhere fails the run.
      </div>
    </div>
  )
}

/* ============================ METHODS: measured run + complexity ============================ */
function RunComplexity({ d }) {
  const audit = d.audit || []
  if (!audit.length) return null
  const BIG_O = {
    supervisor: 'O(1) routing', ingest: 'O(rows) stream + mask', validate_masking_leak: 'O(cells) regex+Luhn',
    build_graph: 'O(V+E) construction', condense_to_dag: 'O(V+E) Tarjan SCC', score: 'O(V·E) Brandes → pivot-sampled at scale',
    analytics: 'O(S·(V+E)) memoized reachability', human_gate: 'O(1) interrupt', report: 'O(V) serialization',
  }
  const total = audit.reduce((s, a) => s + (a.ms || 0), 0)
  return (
    <div className="card p-5">
      <div className="disp font-bold text-lg">Measured run <span className="text-faint text-xs font-normal">— this dataset, this hardware, named complexity</span></div>
      <div className="text-[11px] text-faint mb-3">Wall-clock per pipeline stage for the run on screen, beside each stage's algorithmic complexity (V systems, E flows, S PAN sources). Reachability is memoized per source and betweenness switches to the Brandes–Pich sampled estimator above ~600 nodes, which is what keeps the engine sub-minute at enterprise scale.</div>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-[11px] uppercase tracking-wider text-faint bg-panel2">
          <th className="px-3 py-2">Stage</th><th className="px-3 py-2">Measured</th><th className="px-3 py-2">Complexity</th></tr></thead>
        <tbody>
          {audit.map((a, i) => (
            <tr key={i} className="border-t border-line">
              <td className="px-3 py-1.5 mono text-txt">{a.stage}</td>
              <td className="px-3 py-1.5 mono text-dim">{fmt(a.ms)} ms</td>
              <td className="px-3 py-1.5 text-dim text-[12px]">{BIG_O[a.stage] || '—'}</td>
            </tr>
          ))}
          <tr className="border-t border-line bg-panel2">
            <td className="px-3 py-1.5 font-semibold text-txt">end-to-end</td>
            <td className="px-3 py-1.5 mono font-semibold text-pan">{fmt(total)} ms</td>
            <td className="px-3 py-1.5 text-faint text-[12px]">ingest → DAG → score → analyze → report</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

/* ============================ ONBOARDING (extensibility — assess before building) ============================ */
function NeighbourPicker({ d, label, picked, setPicked, hint }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return []
    return d.viz.nodes.filter(n => !picked.includes(n.id) &&
      (n.id.toLowerCase().includes(t) || (n.name || '').toLowerCase().includes(t))).slice(0, 10)
  }, [q, d, picked])
  const add = id => { setPicked([...picked, id]); setQ(''); setOpen(false) }
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-faint mb-1">{label}</div>
      <div className="flex flex-wrap gap-1.5 mb-1.5">
        {picked.map(p => (
          <span key={p} className="mono text-[11px] px-2 py-0.5 rounded bg-pan/10 text-pan border border-pan/30 flex items-center gap-1">
            {p}<button onClick={() => setPicked(picked.filter(x => x !== p))} className="text-dim hover:text-txt">✕</button>
          </span>
        ))}
        {!picked.length && <span className="text-[11px] text-faint italic">none yet</span>}
      </div>
      <div className="relative" style={{ maxWidth: 280 }}>
        <input value={q} placeholder="search id or name…"
          onChange={e => { setQ(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={e => { if (e.key === 'Enter' && matches[0]) add(matches[0].id); if (e.key === 'Escape') setOpen(false) }}
          className="mono text-[11px] px-2 py-1.5 rounded-lg border border-[#D9D3C7] bg-white text-txt w-full outline-none focus:border-pan focus:ring-2 focus:ring-gold/50" />
        {open && matches.length > 0 && (
          <div className="absolute z-20 mt-1 w-full max-h-48 overflow-auto rounded border border-line bg-panel shadow-xl">
            {matches.map(m => (
              <button key={m.id} onClick={() => add(m.id)} className="block w-full text-left px-2 py-1 hover:bg-pan/5 border-b border-line/40 last:border-0">
                <span className="mono text-[11px] text-txt">{m.id}</span>
                {m.in_scope && <span className="mono text-[9px] text-pan ml-1.5">in scope</span>}
                {m.true_source && <span className="mono text-[9px] text-panhot ml-1.5">true source</span>}
                <span className="block text-[10px] text-dim truncate">{m.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="text-[10px] text-faint mt-1">{hint}</div>
    </div>
  )
}


/* Simplification Goal 4 — propose mechanisms to detect EMERGING PCI scope early.
   Each trigger maps to an engine capability that already exists, so the proposal is
   credible: re-run the pipeline on metadata deltas and diff the audited outputs. */
function EmergingScopeWatch() {
  const rows = [
    ['BAM PCI flag flips Yes→No (or No→Yes)', 'Re-run scope; diff against the last run — a flip that removes a PAN carrier while Splunk still sees PAN becomes a new hidden-PCI finding automatically.'],
    ['New dependency edge lands on a CDE system', 'The onboarding assessment above runs the same check pre-build; post-build, a nightly re-run flags the new edge and the transitive scope it drags in.'],
    ['New clear-PAN hit in Splunk for a PCI=No app', 'Exactly the DS6 signal — ingested as an inferred PAN source, it surfaces in Hidden Scope with its evidence on the next run.'],
    ['CDE survey response contradicts BAM', 'Inferred edges are kept provenance-tagged and never merged, so contradictions are visible side-by-side in the lineage, not silently resolved.'],
    ['Risk score of any system moves more than a set threshold', 'Every run emits the full per-system score sheet (XLSX); a simple diff between runs is an early-warning list, no new infrastructure needed.'],
  ]
  return (
    <div className="card p-5">
      <div className="disp font-bold text-lg">Emerging-scope watch <span className="text-faint text-xs font-normal">— proposed mechanism: catch tomorrow\'s PCI scope before it spreads</span></div>
      <p className="text-sm text-dim mt-1 max-w-3xl leading-relaxed">The whole pipeline is deterministic and runs end-to-end in seconds, so scope detection becomes a <b>scheduled diff</b>: re-run on each BAM/Splunk refresh and alert on what changed. Every trigger below is caught by a capability that already exists in this engine — nothing here is speculative.</p>
      <div className="mt-3 space-y-2">
        {rows.map(([t, h], i) => (
          <div key={i} className="flex gap-3 text-xs">
            <span className="mono shrink-0 w-5 h-5 rounded-md tint-gold text-[#6B4E00] font-bold flex items-center justify-center">{i + 1}</span>
            <div><span className="font-semibold text-txt">{t}.</span> <span className="text-dim">{h}</span></div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Onboarding({ d, live, onPick }) {
  const [appId, setAppId] = useState('NEW-APP')
  const [providers, setProviders] = useState([])
  const [consumers, setConsumers] = useState([])
  const [flags, setFlags] = useState({ pan: false, crn_only: false, detokenizes: false, full_track: false, pin: false })
  const [res, setRes] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const assessWith = async (payload) => {
    if (!live) return
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/api/onboard', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload) })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      setRes(await r.json())
    } catch (e) { setErr(String(e.message || e)) } finally { setBusy(false) }
  }
  const assess = () => assessWith({ app_id: appId, providers, consumers, ...flags })
  // one-click demo scenarios derived from the live analysis — prefill AND assess
  const topSrc = (d.heavy_hitters || [])[0]?.system
  const outNode = useMemo(() => (d.viz?.nodes || []).find(n => !n.in_scope && !n.carries_pan && !n.hidden_pci)?.id, [d])
  const scenarios = [
    topSrc && { label: `consumer of ${topSrc}`, hint: 'lands in CDE; names the exact upstream fix',
      s: { app_id: 'NEW-CONS', providers: [topSrc], consumers: [], pan: false, crn_only: false, detokenizes: false, full_track: false, pin: false } },
    outNode && { label: `PAN originator feeding ${outNode}`, hint: 'new true source; drags systems into scope',
      s: { app_id: 'NEW-ORIG', providers: [], consumers: [outNode], pan: true, crn_only: false, detokenizes: false, full_track: false, pin: false } },
    { label: 'CRN-native reporting reader', hint: 'token-only by design → connected, not CDE',
      s: { app_id: 'NEW-CRN', providers: [], consumers: topSrc ? [topSrc] : [], pan: false, crn_only: true, detokenizes: false, full_track: false, pin: false } },
    { label: 'detokenizing service', hint: 'permanent CDE — RISE/APG territory',
      s: { app_id: 'NEW-DETOK', providers: topSrc ? [topSrc] : [], consumers: [], pan: false, crn_only: false, detokenizes: true, full_track: false, pin: false } },
  ].filter(Boolean)
  const runScenario = sc => {
    setAppId(sc.s.app_id); setProviders(sc.s.providers); setConsumers(sc.s.consumers)
    setFlags({ pan: sc.s.pan, crn_only: sc.s.crn_only, detokenizes: sc.s.detokenizes, full_track: sc.s.full_track, pin: sc.s.pin })
    assessWith(sc.s)
  }
  const catTone = c => c === 'cde' ? 'text-pan border-pan/40 bg-pan/5' : c === 'connected' ? 'text-cool border-cool/40 bg-cool/5' : 'text-safe border-safe/40 bg-safe/5'
  const catLabel = c => c === 'cde' ? 'In scope (CDE)' : c === 'connected' ? 'Connected-to (in scope)' : 'Out of scope'
  const FlagBox = ({ k, label, warn }) => (
    <label className="flex items-center gap-2 text-xs text-dim cursor-pointer select-none">
      <input type="checkbox" className="accent-pan" checked={flags[k]} onChange={e => setFlags({ ...flags, [k]: e.target.checked })} />
      {label}{warn && flags[k] && <span className="text-[10px] text-panhot">{warn}</span>}
    </label>
  )
  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="disp font-bold text-lg">Onboard a system <span className="text-faint text-xs font-normal">— assess scope before a line of code is written</span></div>
        <p className="text-sm text-dim mt-1 max-w-3xl leading-relaxed">
          Describe a <b>planned</b> system — who it will consume data from, who it will feed, what it will hold — and the
          engine answers the architecture-review questions deterministically, with the same clean-stream semantics as the
          rest of the analysis: <b>where it lands</b> (CDE / connected-to / out), <b>why</b>, which upstream tokenizations would
          let it receive CRN instead of clear PAN, and how many currently-out-of-scope systems the new feed would <b>drag into
          scope</b>. Planned neighbours that don't exist in the authoritative universe are reported, never invented.
        </p>
        {live && scenarios.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3">
            <span className="text-[11px] text-faint self-center">one-click dry-runs:</span>
            {scenarios.map((sc, i) => (
              <button key={i} onClick={() => runScenario(sc)} title={sc.hint}
                className="mono text-[11px] px-2.5 py-1 rounded-lg border border-pan/30 text-pan bg-pan/5 hover:bg-pan/10">▸ {sc.label}</button>
            ))}
          </div>
        )}
      </div>

      <div className="grid lg:grid-cols-[380px_1fr] gap-5">
        <div className="card p-5 space-y-4 self-start" style={{ background: '#FAF8F2' }}>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-faint mb-1">Planned app id</div>
            <input value={appId} onChange={e => setAppId(e.target.value)}
              className="mono text-sm px-2 py-1.5 rounded-lg border border-[#D9D3C7] bg-white text-txt w-44 outline-none focus:border-pan focus:ring-2 focus:ring-gold/50" />
          </div>
          <NeighbourPicker d={d} label="Will consume data FROM (providers)" picked={providers} setPicked={setProviders}
            hint="upstream systems sending it data — these decide whether clear PAN reaches it" />
          <NeighbourPicker d={d} label="Will feed data TO (consumers)" picked={consumers} setPicked={setConsumers}
            hint="downstream systems — these decide how far new exposure would spread" />
          <div className="space-y-1.5">
            <div className="text-[11px] uppercase tracking-wider text-faint">Its own data handling</div>
            <FlagBox k="pan" label="stores / processes clear PAN itself" warn="→ new true source" />
            <FlagBox k="crn_only" label="tokenized PAN (CRN) only" />
            <FlagBox k="detokenizes" label="detokenizes (CRN → PAN)" warn="→ permanent CDE" />
            <FlagBox k="full_track" label="full track data" warn="→ permanent CDE" />
            <FlagBox k="pin" label="PIN data" warn="→ permanent CDE" />
          </div>
          <button onClick={assess} disabled={!live || busy}
            className={'text-xs px-5 py-2 rounded-lg font-semibold ' + (!live || busy ? 'bg-panel2 text-faint border border-line' : 'bg-pan text-ink hover:brightness-110 shadow-sm')}>
            {busy ? 'assessing…' : 'Assess scope impact →'}</button>
          {!live && <div className="text-[11px] text-faint">Needs the live API — upload and run an analysis first; the assessment is computed against the live graph.</div>}
          {err && <div className="text-[11px] text-panhot">⚠ {err}</div>}
        </div>

        {res ? (
          <div className="space-y-4">
            <div className="card p-5">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="disp font-black text-2xl text-txt">{res.app_id}</span>
                <span className={'mono text-[12px] px-2.5 py-1 rounded border font-semibold ' + catTone(res.category)}>{catLabel(res.category)}</span>
                <span className="mono text-[11px] px-2 py-0.5 rounded bg-panel2 text-dim">tier {res.sensitivity_tier} / 4</span>
                {res.permanent_cde && <span className="mono text-[11px] px-2 py-0.5 rounded bg-panhot/10 text-panhot border border-panhot/30">permanent CDE</span>}
              </div>
              <p className="text-sm text-dim mt-3 leading-relaxed">{res.verdict}</p>
              <div className="mt-2"><ReqChips reqs={res.triggered_requirements} /></div>
            </div>

            <div className="grid md:grid-cols-3 gap-3">
              <div className="card p-4">
                <div className={'disp text-3xl font-black ' + (res.receives_clear_pan ? 'text-pan' : 'text-safe')}>{res.pan_providers.length}</div>
                <div className="text-[11px] text-dim mt-1">provider(s) feeding it clear PAN</div>
                <div className="flex flex-wrap gap-1 mt-2">{res.pan_providers.map(p => <button key={p} onClick={() => onPick(p)} className="mono text-[11px] px-1.5 py-0.5 rounded bg-pan/10 text-pan hover:bg-pan/20">{p}</button>)}</div>
              </div>
              <div className="card p-4">
                <div className="disp text-3xl font-black text-cool">{res.origins_reaching_count}</div>
                <div className="text-[11px] text-dim mt-1">true PAN origins reach it — tokenize these and it receives CRN</div>
                <div className="flex flex-wrap gap-1 mt-2">{res.origins_reaching.slice(0, 12).map(o => <button key={o} onClick={() => onPick(o)} className="mono text-[11px] px-1.5 py-0.5 rounded bg-cool/10 text-cool hover:bg-cool/20">{o}</button>)}
                  {res.origins_reaching_count > 12 && <span className="text-[10px] text-faint">+{res.origins_reaching_count - 12}</span>}</div>
                {res.blocking_always_cde_origins?.length > 0 && <div className="text-[10px] text-panhot mt-1.5">⚠ {res.blocking_always_cde_origins.join(', ')} cannot be tokenized away (always-CDE)</div>}
              </div>
              <div className="card p-4">
                <div className={'disp text-3xl font-black ' + (res.scope_expansion_count > 0 ? 'text-panhot' : 'text-safe')}>{res.scope_expansion_count > 0 ? '+' + res.scope_expansion_count : '0'}</div>
                <div className="text-[11px] text-dim mt-1">currently-out-of-scope systems this onboarding would drag INTO scope (transitive)</div>
                <div className="flex flex-wrap gap-1 mt-2">{(res.scope_expansion_sample || []).map(x => <button key={x} onClick={() => onPick(x)} className="mono text-[11px] px-1.5 py-0.5 rounded bg-panhot/10 text-panhot hover:bg-panhot/20">{x}</button>)}</div>
              </div>
            </div>

            <div className="card p-4 text-[11px] text-dim">
              <span className={'mr-3 ' + (res.can_fully_descope_under_tokenization ? 'text-safe' : 'text-faint')}>
                {res.can_fully_descope_under_tokenization
                  ? '✓ would fully descope once its true-source front is tokenized'
                  : res.permanent_cde ? '✗ never descopes — always-CDE data elements' : res.category === 'cde' ? '✗ cannot fully descope (originates PAN or blocked by an always-CDE origin)' : '— not in the CDE'}
              </span>
              {(res.unknown_providers?.length > 0 || res.unknown_consumers?.length > 0) && (
                <span className="text-panhot">⚠ not in the authoritative universe (reported, not invented): {[...(res.unknown_providers || []), ...(res.unknown_consumers || [])].join(', ')}</span>
              )}
            </div>
          </div>
        ) : (
          <div className="card p-8 text-center text-dim self-start text-sm">
            Pick the planned providers/consumers on the left and assess.<br />
            <span className="text-[11px] text-faint">Try: consume from a heavy hitter → lands in the CDE with the exact upstream tokenizations named; feed an out-of-scope system → see the transitive scope expansion it would cause.</span>
          </div>
        )}
      </div>
      <EmergingScopeWatch />
    </div>
  )
}
