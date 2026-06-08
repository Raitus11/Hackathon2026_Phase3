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
  const [gen, setGen] = useState(false)   // backend generative? (sdk) — from /health
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
    const h = await fetch('/health').then(r => r.json()).catch(() => null)
    setGen(!!(h && h.generative))
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
  return (
    <div className="card kpi p-4 flex-1 min-w-[190px] relative group" style={{ animationDelay: delay + 'ms' }}>
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
            <span key={t} className="text-[11px] mono px-2.5 py-1 rounded-full border border-line text-dim">{t}</span>)}
        </div>
      </div>

      {/* compact flow strip */}
      <div className="card px-5 py-4">
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
        <div className="card px-5 py-4">
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
      <div className="card p-5">
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
                    className={'text-xs px-5 py-2 rounded-lg font-semibold ' + (uploading ? 'bg-line text-faint' : 'bg-pan text-ink hover:brightness-110')}>
                    {uploading ? 'running…' : 'Run analysis →'}
                  </button>
                  <label className="flex items-center gap-2 text-xs text-dim cursor-pointer select-none">
                    <input type="checkbox" checked={requireApproval} onChange={e => setRequireApproval(e.target.checked)} />
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
function Overview({ d, onPick }) {
  const h = d.headline, imp = d.impact, dag = d.dag_stats || {}
  const before = imp.scope_before, after = imp.scope_after, maxv = Math.max(before, 1)
  return (
    <div className="space-y-5">
      <ScopeEconomics d={d} />
      <SankeyFlow d={d} onPick={onPick} />
      <CategoryBar d={d} />
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
            <div className="bg-panel2 rounded-lg p-3"><div className="disp text-2xl font-black text-safe">{imp.nodes_descoped}</div><div className="text-[11px] text-dim">systems descoped</div></div>
            <div className="bg-panel2 rounded-lg p-3"><div className="disp text-2xl font-black text-pan">{imp.sources_downgraded_count ?? (imp.sources_downgraded || []).length}</div><div className="text-[11px] text-dim">sources → token</div></div>
            <div className="bg-panel2 rounded-lg p-3"><div className="disp text-2xl font-black text-safe">{imp.node_surface_reduction_pct}%</div><div className="text-[11px] text-dim">surface ↓</div></div>
            <div className="bg-panel2 rounded-lg p-3"><div className="disp text-2xl font-black text-cool">{imp.retained_via_detokenization_count}</div><div className="text-[11px] text-dim">stay (RISE/APG)</div></div>
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
                  <td><span className="px-2 py-0.5 rounded" style={{ background: 'rgba(245,166,35,' + (r.risk / 120) + ')' }}>{r.risk}</span></td>
                </tr>))}</tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <ScatterReachRisk d={d} onPick={onPick} />
        <BarExclusiveReach d={d} onPick={onPick} />
      </div>

      <div className="card p-5">
        <div className="disp font-bold text-lg mb-1">Grounded explanation <span className="text-faint text-xs font-normal">— LLM narrates only computed numbers</span></div>
        <p className="text-sm text-dim leading-relaxed">{d.explanation}</p>
        <div className="flex flex-wrap gap-2 mt-4">{d.audit.map((a, i) => <span key={i} className="mono text-[11px] px-2 py-1 rounded bg-panel2 text-faint">{a.stage} · {a.ms}ms</span>)}</div>
      </div>
    </div>
  )
}

/* ============================ GRAPH ============================ */
function GraphView({ d, selected, onPick }) {
  const ref = useRef()
  const [mode, setMode] = useState('heavy')
  const [showInferred, setShowInferred] = useState(true)
  const [focusId, setFocusId] = useState(null)        // pinned app, or null = whole-estate view
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
      .append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', '#3f5169')
    const g = svg.append('g')
    svg.call(d3.zoom().scaleExtent([.2, 4]).on('zoom', e => g.attr('transform', e.transform)))
    let L = base.L.map(e => ({ ...e }))
    if (!showInferred) L = L.filter(e => e.provenance !== 'inferred')
    const idset = new Set(base.N.map(n => n.id))
    const Lv = L.filter(e => idset.has(e.source) && idset.has(e.target))
    const N = base.N.map(n => ({ ...n }))
    const deg = {}; Lv.forEach(e => { deg[e.source] = (deg[e.source] || 0) + 1; deg[e.target] = (deg[e.target] || 0) + 1 })
    const color = n => n.hidden_pci ? '#ff5c5c' : n.true_source ? '#f5a623' : n.carries_pan ? '#f7c873' : n.in_scope ? '#5b8def' : '#3a4a63'
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
      .attr('stroke', e => e.provenance === 'inferred' ? '#f5a623' : '#2c3e57')
      .attr('stroke-opacity', e => e.provenance === 'inferred' ? .85 : .5)
      .attr('stroke-width', e => Math.min(3, 1 + (e.count || 1) * .25))
      .attr('stroke-dasharray', e => e.provenance === 'inferred' ? '4 3' : null)
    const node = g.append('g').selectAll('circle').data(N).join('circle')
      .attr('class', 'node').attr('r', rad).attr('fill', color)
      .attr('stroke', n => isRoot(n) ? '#2dd4bf' : n.hidden_pci ? '#ff5c5c' : (heavySet.has(n.id) ? '#fff' : (n.scope_prov === 'inferred' ? '#f5a623' : '#0a0e14')))
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
      .attr('fill', n => isRoot(n) ? '#2dd4bf' : heavySet.has(n.id) ? '#e6edf6' : '#8aa0bd')
      .attr('class', 'mono').attr('dx', n => isRoot(n) ? 13 : 8).attr('dy', 3)
    sim.on('tick', () => {
      link.attr('x1', e => e.source.x).attr('y1', e => e.source.y).attr('x2', e => e.target.x).attr('y2', e => e.target.y)
      node.attr('cx', n => n.x).attr('cy', n => n.y); label.attr('x', n => n.x).attr('y', n => n.y)
    })
    return () => sim.stop()
  }, [d, mode, showInferred, heavyList, heavySet, exclBySys, onPick, focusId, hops, dir])
  useEffect(() => {
    if (!selected) return
    d3.select(ref.current).selectAll('circle')
      .attr('stroke', n => n.id === selected ? '#2dd4bf' : (n.hidden_pci ? '#ff5c5c' : (heavySet.has(n.id) ? '#fff' : (n.scope_prov === 'inferred' ? '#f5a623' : '#0a0e14'))))
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
          className={'mono text-[11px] px-2.5 py-1 rounded border ' + (!focusId && mode === k ? 'border-pan text-pan bg-pan/10' : 'border-line text-dim hover:text-txt')}>{l}</button>)}
        <label className="flex items-center gap-1 text-[11px] text-dim ml-2 cursor-pointer"><input type="checkbox" checked={showInferred} onChange={e => setShowInferred(e.target.checked)} />show inferred edges</label>
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
            className="mono text-[11px] px-2 py-1 rounded border border-line bg-panel2 text-txt w-full outline-none focus:border-cool" />
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
                className={'mono text-[11px] px-2 py-1 rounded border ' + (dir === k ? 'border-cool text-cool bg-cool/10' : 'border-line text-dim hover:text-txt')}>{l}</button>)}
            <span className="text-[11px] text-faint ml-1">hops:</span>
            {[[1, '1'], [2, '2'], [Infinity, 'all']].map(([k, l]) =>
              <button key={l} onClick={() => setHops(k)}
                className={'mono text-[11px] px-2 py-1 rounded border ' + (hops === k ? 'border-cool text-cool bg-cool/10' : 'border-line text-dim hover:text-txt')}>{l}</button>)}
          </>
        )}
        {!focusId && <span className="text-[11px] text-faint">pick an app to isolate its PAN neighbourhood — or keep the full view above</span>}
      </div>

      <div className="px-2 text-[11px] text-dim mb-1">{focusId ? focusHelp : modeHelp[mode]}</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-2 py-1 text-[11px] text-dim items-center">
        <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block ring-1 ring-white" style={{ background: '#f5a623' }} />true PAN source (★ heavy hitter)</span>
        <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block" style={{ background: '#f7c873' }} />carries PAN</span>
        <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block" style={{ background: '#ff5c5c' }} />hidden PCI (BAM miss)</span>
        <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block" style={{ background: '#5b8def' }} />in scope</span>
        <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block" style={{ background: 'transparent', border: '1.5px dashed #f5a623' }} />inferred-only scope</span>
        {focusId && <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block" style={{ background: 'transparent', border: '2px solid #2dd4bf' }} />focused app</span>}
        <span className="flex items-center gap-1"><svg width="26" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="#2c3e57" strokeWidth="2" markerEnd="" /></svg>metadata →</span>
        <span className="flex items-center gap-1"><svg width="26" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="#f5a623" strokeWidth="2" strokeDasharray="4 3" /></svg>inferred →</span>
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
      {left.map((e, i) => <line key={'li' + i} x1="58" y1={yFor(i, left.length)} x2={cx} y2={cy} stroke={e.provenance === 'inferred' ? '#f5a623' : '#2c3e57'} strokeWidth="1.2" strokeDasharray={e.provenance === 'inferred' ? '4 3' : null} />)}
      {right.map((e, i) => <line key={'ro' + i} x1={cx} y1={cy} x2={W - 58} y2={yFor(i, right.length)} stroke={e.provenance === 'inferred' ? '#f5a623' : '#2c3e57'} strokeWidth="1.2" strokeDasharray={e.provenance === 'inferred' ? '4 3' : null} />)}
      {left.map((e, i) => <g key={'lt' + i} className="cursor-pointer" onClick={() => onPick(e.source)}><circle cx="50" cy={yFor(i, left.length)} r="5" fill="#5b8def" /><text x="44" y={yFor(i, left.length) + 3} textAnchor="end" fontSize="8" fill="#8aa0bd" className="mono">{e.source}</text></g>)}
      {right.map((e, i) => <g key={'rt' + i} className="cursor-pointer" onClick={() => onPick(e.target)}><circle cx={W - 50} cy={yFor(i, right.length)} r="5" fill="#5b8def" /><text x={W - 44} y={yFor(i, right.length) + 3} fontSize="8" fill="#8aa0bd" className="mono">{e.target}</text></g>)}
      <circle cx={cx} cy={cy} r="9" fill={node.hidden_pci ? '#ff5c5c' : node.true_source ? '#f5a623' : '#f7c873'} stroke="#2dd4bf" strokeWidth="2" />
      <text x={cx} y={cy - 14} textAnchor="middle" fontSize="9" fill="#e6edf6" className="mono">{node.id}</text>
      <text x="50" y="14" textAnchor="middle" fontSize="8" fill="#56657d">providers</text>
      <text x={W - 50} y="14" textAnchor="middle" fontSize="8" fill="#56657d">consumers</text>
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
          className="w-full bg-panel2 border border-line rounded-lg px-3 py-2 text-sm mono text-txt mb-2" />
        <div className="scroll overflow-auto max-h-[520px] space-y-0.5">
          {list.map(n => (
            <button key={n.id} onClick={() => onPick(n.id)}
              className={'w-full flex items-center justify-between text-left px-2 py-1.5 rounded text-sm ' + (n.id === selected ? 'bg-pan/15' : 'hover:bg-panel2')}>
              <span className="flex items-center gap-1.5">
                <i className="w-2 h-2 rounded-full inline-block" style={{ background: n.hidden_pci ? '#ff5c5c' : n.true_source ? '#f5a623' : n.carries_pan ? '#f7c873' : n.in_scope ? '#5b8def' : '#3a4a63' }} />
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
            </div>
            <div className="card p-5">
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
            <div className="card p-5">
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
              <div className="disp font-bold mb-2">Upstream providers <span className="text-faint text-xs">({ins.length}) — send PAN to {node.id}</span></div>
              <div className="scroll max-h-[240px] overflow-auto space-y-1">
                {ins.length ? ins.map((e, i) => (
                  <button key={i} onClick={() => onPick(e.source)} className="w-full flex justify-between text-left text-sm px-2 py-1 rounded hover:bg-panel2">
                    <span className="mono text-cool">{e.source}</span>
                    <span className={'text-[10px] px-1.5 rounded ' + (e.provenance === 'inferred' ? 'bg-pan/20 text-pan' : 'bg-line text-dim')}>{e.provenance}{e.signal ? ' · ' + e.signal : ''}{e.count > 1 ? ' ×' + e.count : ''}</span>
                  </button>)) : <div className="text-dim text-sm">none — candidate true source</div>}
              </div>
            </div>
            <div className="card p-5">
              <div className="disp font-bold mb-2">Downstream consumers <span className="text-faint text-xs">({outs.length}) — receive PAN from {node.id}</span></div>
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
    <div className="card p-5 border border-pan/30">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="disp font-bold text-lg flex items-center gap-2">
          AI Decision Memo
          <span className={'mono text-[10px] px-2 py-0.5 rounded ' + (memo.generated ? 'bg-pan/20 text-pan' : 'bg-line text-dim')}>{memo.generated ? '✦ AI-generated' : '○ deterministic narration'}</span>
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
          {chips.map(c => <span key={c} className="mono text-[10px] px-2 py-0.5 rounded bg-panel2 text-faint border border-line">grounded on: {c}</span>)}
        </div>
      )}
    </div>
  )
}

function Planner({ d, live, generative, onPick }) {
  const candidates = useMemo(() => {
    const ids = d.heavy_hitters.map(h => h.system)
    const seen = new Set(ids)
    ;(d.plan?.plan || []).forEach(s => { if (!seen.has(s)) { ids.push(s); seen.add(s) } })  // ensure levers are toggleable
    return ids
  }, [d])
  const exclBy = useMemo(() => Object.fromEntries(d.heavy_hitters.map(h => [h.system, h.exclusive_reach])), [d])
  const [plan, setPlan] = useState(d.plan || null)
  const [target, setTarget] = useState(Math.round((d.plan?.target_fraction || 0.8) * 100))
  const [selected, setSelected] = useState(() => (d.plan?.plan || []).slice(0, 3))
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
                className={'mono text-[11px] px-2 py-1 rounded border ' + (selected.includes(s) ? 'border-pan text-pan bg-pan/10' : 'border-line text-dim hover:text-txt') + (!live ? ' opacity-60' : '')}>
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
            <line x1={P.l} x2={W - P.r} y1={y(f * maxY)} y2={y(f * maxY)} stroke="#1e2a3d" strokeWidth="0.5" />
            <text x={P.l - 6} y={y(f * maxY) + 3} textAnchor="end" fontSize="9" fill="#56657d">{Math.round(f * maxY)}</text>
          </g>
        ))}
        {[0, 25, 50, 75, 100].map((p, i) => (
          <text key={i} x={x(p)} y={H - P.b + 14} textAnchor="middle" fontSize="9" fill="#56657d">{p}%</text>
        ))}
        <text x={P.l - 34} y={P.t + 4} fontSize="9" fill="#8aa0bd" transform={`rotate(-90 ${P.l - 34} ${H / 2})`}>systems fully descoped</text>
        <text x={(W) / 2} y={H - 6} textAnchor="middle" fontSize="9" fill="#8aa0bd">% of true PAN sources tokenized →</text>
        <polyline points={pts} fill="none" stroke="#2dd4bf" strokeWidth="2" />
        {sc.curve.map((p, i) => <circle key={i} cx={x(p.pct_sources)} cy={y(p.fully_descoped)} r="3" fill="#2dd4bf"><title>{p.pct_sources}% sources ({p.k}) → {p.fully_descoped} fully descoped</title></circle>)}
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
          <div key={i} className="bg-panel2 rounded-xl p-4 border border-line">
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

function ScatterReachRisk({ d, onPick }) {
  const nodes = (d.viz?.nodes || []).filter(n => n.carries_pan || n.hidden_pci || (n.reach || 0) > 0)
  const W = 560, H = 300, P = { l: 44, r: 16, t: 14, b: 36 }
  // On a saturated estate, downstream reach is ~identical for every source (the dots
  // collapse to one vertical line), so reach can't discriminate. Conduit centrality
  // (betweenness) is the axis that separates the systems many PAN paths route THROUGH
  // from ordinary carriers — the real prioritization signal here.
  const bx = n => n.betweenness || 0
  const maxX = Math.max(1e-9, ...nodes.map(bx))
  const maxY = Math.max(1, ...nodes.map(n => n.risk || 0))
  const chokes = new Set(((d.structure || {}).choke_points) || [])
  const hh = new Set(d.heavy_hitters.slice(0, 8).map(h => h.system))
  const x = v => P.l + (v / maxX) * (W - P.l - P.r)
  const y = v => H - P.b - (v / maxY) * (H - P.t - P.b)
  const color = n => n.hidden_pci ? '#ff5c5c' : n.true_source ? '#f5a623' : n.carries_pan ? '#e3a83a' : '#5b8def'
  return (
    <div className="card p-5">
      <div className="disp font-bold">Prioritization quadrant <span className="text-faint text-xs font-normal">— conduit centrality × risk</span></div>
      <div className="text-xs text-dim mb-2">Reach is saturated here (every source reaches ~the whole estate), so we plot <b>betweenness</b> — how many PAN paths route through a system — against risk. Upper-right = high-conduit <i>and</i> high-risk: the systems whose tokenization would sever the most PAN flow. <span className="text-pan">◯ ringed</span> = top distributor · <span className="text-safe">▢</span> = choke point (cut vertex).</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 320 }}>
        {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
          <g key={i}>
            <line x1={P.l} x2={W - P.r} y1={y(f * maxY)} y2={y(f * maxY)} stroke="#1e2a3d" strokeWidth="0.5" />
            <text x={P.l - 6} y={y(f * maxY) + 3} textAnchor="end" fontSize="9" fill="#56657d">{Math.round(f * maxY)}</text>
          </g>
        ))}
        <text x={P.l - 30} y={P.t + 6} fontSize="9" fill="#8aa0bd" transform={`rotate(-90 ${P.l - 30} ${H / 2})`}>risk score</text>
        <text x={(W) / 2} y={H - 6} textAnchor="middle" fontSize="9" fill="#8aa0bd">betweenness (conduit centrality) →</text>
        {nodes.map((n, i) => {
          const isChoke = chokes.has(n.id)
          const r = hh.has(n.id) ? 7 : 3.6
          if (isChoke) return <rect key={i} x={x(bx(n)) - r} y={y(n.risk || 0) - r} width={2 * r} height={2 * r}
            fill={color(n)} fillOpacity={0.85} stroke="#2dd4bf" strokeWidth="1.4" rx="1"
            style={{ cursor: 'pointer' }} onClick={() => onPick(n.id)}>
            <title>{n.id} · choke point · betweenness {(+bx(n)).toFixed(3)} · risk {n.risk}</title></rect>
          return <circle key={i} cx={x(bx(n))} cy={y(n.risk || 0)} r={r}
            fill={color(n)} fillOpacity={hh.has(n.id) ? 0.95 : 0.55}
            stroke={hh.has(n.id) ? '#fff' : 'none'} strokeWidth={hh.has(n.id) ? 1 : 0}
            style={{ cursor: 'pointer' }} onClick={() => onPick(n.id)}>
            <title>{n.id} · betweenness {(+bx(n)).toFixed(3)} · risk {n.risk}</title>
          </circle>
        })}
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
function Methods({ d }) {
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
    <div className="bg-panel2 rounded-xl p-4">
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
        <table className="w-full text-sm">
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
      <WeightSensitivity ws={s.weight_sensitivity} />
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
            <div className={'rounded-xl px-3 py-2 text-sm ' + (m.role === 'user' ? 'bg-pan/15 text-txt' : 'bg-panel2 text-dim')}>{m.content}</div>
            {m.grounded && m.grounded.length > 0 && <div className="flex flex-wrap gap-1 mt-1">{m.grounded.slice(0, 8).map((gx, j) => <span key={j} className="mono text-[10px] px-1.5 py-0.5 rounded bg-line text-faint">{gx}</span>)}</div>}
          </div>
        ))}
        {busy && <div className="text-xs text-faint mono">analyst is thinking…</div>}
        <div ref={endRef} />
      </div>
      <div className="flex flex-wrap gap-1.5 mt-2">
        {(suggested || []).slice(0, 5).map((s, i) => <button key={i} onClick={() => send(s)} className="text-left text-[11px] px-2.5 py-1 rounded-full border border-line text-dim hover:border-pan hover:text-pan">{s}</button>)}
      </div>
      <div className="flex gap-2 mt-2">
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()}
          placeholder="ask about scope, heavy hitters, a system ID, tokenization impact…"
          className="flex-1 bg-panel2 border border-line rounded-lg px-3 py-2 text-sm text-txt" />
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
        <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block" style={{ background: '#2dd4bf' }} />fully freed — leaves PCI scope ({soloN})</span>
        <span className="flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: '#5b8def' }} />loses a clear-PAN feed, stays in scope ({feedN})</span>
        <span className="flex items-center gap-1"><i className="w-3.5 h-3.5 rounded-full inline-block ring-1 ring-white" style={{ background: color }} />blocked source</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 430 }}>
        {rings.map((rg, i) => <circle key={'rg' + i} cx={cx} cy={cy} r={rg.r} fill="none" stroke="#1e2a3d" strokeWidth="0.5" strokeDasharray="2 4" />)}
        {placed.map((p, i) => <line key={'e' + i} x1={cx} y1={cy} x2={p.x} y2={p.y}
          stroke={p.solo ? '#2dd4bf' : '#5b8def'} strokeWidth={p.solo ? 1.2 : 0.6} strokeOpacity={p.solo ? 0.65 : 0.3} />)}
        {placed.map((p, i) => (
          <g key={'n' + i} style={{ cursor: 'pointer' }} onClick={() => onPick && onPick(p.id)}>
            <circle cx={p.x} cy={p.y} r={p.solo ? 7 : 4.5} fill={p.solo ? '#2dd4bf' : '#5b8def'} fillOpacity={p.solo ? 1 : 0.82} stroke={p.solo ? '#0a0e14' : 'none'} strokeWidth={p.solo ? 1 : 0}>
              {p.solo && <animate attributeName="r" values="7;10;7" dur="1.9s" repeatCount="indefinite" />}
            </circle>
            {(p.solo || placed.length <= 30) && <text x={p.x} y={p.y - 9} textAnchor="middle" fontSize="8.5" fill={p.solo ? '#e6edf6' : '#8aa0bd'} className="mono">{p.id}</text>}
            <title>{p.id}{p.solo ? ' · fully freed' : ' · loses a feed (stays in scope)'}</title>
          </g>
        ))}
        {/* source at center */}
        <circle cx={cx} cy={cy} r="15" fill={color} stroke="#fff" strokeWidth="2.5" />
        <text x={cx} y={cy + 4} textAnchor="middle" fontSize="9" fill="#0a0e14" className="mono">block</text>
        <text x={cx} y={cy - 22} textAnchor="middle" fontSize="11" fill="#e6edf6" className="mono">{system}</text>
        {hidden > 0 && <text x={cx} y={H - 12} textAnchor="middle" fontSize="10" fill="#56657d">+ {hidden} more beneficiaries not shown ({total} total downstream benefit)</text>}
        {total === 0 && <text x={cx} y={cy + 40} textAnchor="middle" fontSize="11" fill="#56657d">this source feeds no in-scope systems</text>}
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
    <div className="bg-panel2 rounded-xl p-4 border border-line flex-1 min-w-[240px]">
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
            <button onClick={downloadCSV} className="mono text-[11px] px-3 py-1.5 rounded border border-line text-safe hover:bg-panel2 whitespace-nowrap">↓ report (CSV)</button>
            <button onClick={downloadMD} className="mono text-[11px] px-3 py-1.5 rounded border border-line text-safe hover:bg-panel2 whitespace-nowrap">↓ report (.md)</button>
          </div>
        </div>
      </div>

      {sat && <div className="card p-4 border-l-4" style={{ borderLeftColor: '#5b8def' }}>
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
                    <span className="mono text-sm" style={{ color: isA ? '#f5a623' : isB ? '#5b8def' : '#e6edf6' }}>{r.system}</span>
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
            <Card r={ra} color="#f5a623" tag="A · blocked" />
            {rb && <Card r={rb} color="#5b8def" tag="B · compare" />}
          </div>

          <div className="card p-4">
            <div className="text-[11px] uppercase tracking-widest text-faint mb-2">Downstream beneficiaries {ra && <span className="text-faint normal-case">· block {ra.system}</span>}</div>
            <BlastGraph system={ra?.system} soloSet={soloA} adj={adj} byId={byId} color="#f5a623" onPick={onPick} />
            {rb && <div className="border-t border-line mt-3 pt-3">
              <div className="text-[11px] uppercase tracking-widest text-faint mb-2">Compare · block {rb.system}</div>
              <BlastGraph system={rb.system} soloSet={soloB} adj={adj} byId={byId} color="#5b8def" onPick={onPick} />
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
    <div className="card p-4 mb-5 border-l-4" style={{ borderLeftColor: '#ff5c5c' }}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="disp font-black text-3xl text-panhot">{fmt(h.hidden_pci_systems_bam_misses)}</span>
        <span className="text-txt text-base">systems are handling clear card numbers that BAM never flagged as PCI.</span>
        <button onClick={() => onTab('hidden')} className="mono text-[11px] px-2 py-0.5 rounded border border-panhot/40 text-panhot hover:bg-panhot/10 ml-1">see the evidence →</button>
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

      <div className="flex flex-wrap gap-3">
        <KPI label="Hidden PCI — BAM misses" value={fmt(hid.hidden_pci_count)} sub="PCI=No in BAM · clear PAN in Splunk" tone="hot" delay={0}
          def="Systems BAM records as not handling PAN, but clear PAN appears in their Splunk logs." />
        <KPI label="Actively propagating" value={fmt(hid.hidden_propagating_count ?? propagating.length)} sub="feed the leaked PAN further downstream" tone="pan" delay={70}
          def="Hidden-PCI systems that are not leaf nodes — they pass cardholder data onward, widening the unknown exposure." />
        <KPI label="Declared PAN carriers" value={fmt(hid.declared_pan_systems_count)} sub="known, in BAM (for contrast)" tone="cool" delay={140}
          def="Systems BAM does flag as handling PAN — the known surface, shown for scale against the hidden surface." />
      </div>

      {propagating.length > 0 && (
        <div className="card p-5 border-l-4" style={{ borderLeftColor: '#ff5c5c' }}>
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
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="filter id or name…" className="bg-panel2 border border-line rounded-lg px-3 py-1.5 text-sm mono text-txt w-56" />
        </div>
        <div className="scroll overflow-auto max-h-[460px]">
          <table className="dt w-full text-sm">
            <thead><tr className="text-faint text-[11px] uppercase tracking-wider sticky top-0 bg-panel">
              <th>System</th><th title="Downstream systems it feeds PAN to">Propagates to</th>
              <th title="App's own stated origin of the PAN (DS6)">Stated source</th>
              <th>BAM flag</th><th title="What Splunk found in Sept–Dec logs">Splunk finding</th><th title="PCI DSS v4.0.1 requirement families this system should satisfy but does not">v4.0.1 gap</th></tr></thead>
            <tbody>{rows.map(x => (
              <tr key={x.system} className="hh mono" onClick={() => onPick(x.system)}>
                <td className="text-panhot font-semibold">{x.system}<span className="text-faint text-[10px] ml-1.5">{(x.name || '').slice(0, 18)}</span></td>
                <td className={x.downstream_reach > 0 ? 'text-pan' : 'text-faint'}>{x.downstream_reach || '—'}</td>
                <td className="text-dim">{x.stated_source || '—'}</td>
                <td><span className="text-[10px] px-1.5 py-0.5 rounded bg-line text-dim">PCI = No</span></td>
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

/* ============================ APP ============================ */
export default function App() {
  const { data: d, src, agents, suggested, uploading, error, phase, gate, analyze, approve, reset, clearError } = useData()
  const [tab, setTab] = useState('overview')
  const [sel, setSel] = useState(null)
  if (!d) return <div className="h-full flex items-center justify-center text-dim mono">loading analysis…</div>
  const pick = id => { setSel(id); setTab('drill') }
  const tabs = [['pipeline', 'Pipeline'], ['overview', 'Overview'], ['hidden', 'Hidden Scope'], ['planner', 'Planner'], ['blast', 'Block & Benefit'], ['graph', 'Data-Flow Graph'], ['drill', 'Drill-down'], ['methods', 'Methods'], ['ask', 'Ask']]
  const showBanner = !['pipeline'].includes(tab)
  return (
    <div className="max-w-[1280px] mx-auto px-5 py-5">
      <header className="flex items-center gap-4 mb-5">
        <div className="disp font-black text-2xl tracking-tight">PCI<span className="text-pan">·</span>SENTINEL</div>
        <div className="text-xs text-faint border-l border-line pl-4 leading-tight">Intelligent mapping of interdependencies across PCI systems<br />cardholder-data lineage · scope reduction · clean-stream targeting</div>
        <div className="ml-auto flex items-center gap-3">
          {error && <span onClick={clearError} title="dismiss" className="mono text-[11px] px-2 py-1 rounded bg-panhot/20 text-panhot cursor-pointer max-w-[340px] truncate">⚠ {error}</span>}
          {src === 'live' && phase === 'done' && (
            <div className="flex items-center gap-1.5">
              <a href="/api/report/pdf" className="mono text-[11px] px-3 py-1.5 rounded border border-line text-safe hover:bg-panel2" title="Executive PDF report">↓ PDF</a>
              <a href="/api/report/xlsx" className="mono text-[11px] px-3 py-1.5 rounded border border-line text-safe hover:bg-panel2" title="XLSX data pack">↓ XLSX</a>
            </div>
          )}
          <button onClick={() => { reset(); setTab('pipeline') }}
            className="mono text-[11px] px-3 py-1.5 rounded border border-line text-pan hover:bg-panel2">↑ New analysis</button>
          <span className={'mono text-[11px] px-2 py-1 rounded ' + (src === 'live' ? 'bg-safe/20 text-safe' : 'bg-line text-dim')}>{src === 'live' ? '● live API' : '● embedded snapshot'}</span>
          <span title="AI narration mode: generative (enterprise gateway) vs deterministic templates with identical numbers"
            className={'mono text-[11px] px-2 py-1 rounded ' + (gen ? 'bg-pan/20 text-pan' : 'bg-line text-dim')}>{gen ? '✦ AI: generative' : '○ AI: deterministic'}</span>
        </div>
      </header>
      <nav className="flex gap-1 mb-5 bg-panel rounded-xl p-1 w-fit border border-line">
        {tabs.map(([k, l]) => <button key={k} data-on={tab === k ? '1' : '0'} onClick={() => setTab(k)} className="tab mono text-sm px-4 py-2 rounded-lg text-dim">{l}</button>)}
      </nav>
      {showBanner && <VerdictBanner d={d} onTab={setTab} onPick={pick} />}
      {tab === 'pipeline' && <Pipeline d={d} agents={agents} phase={phase} gate={gate} uploading={uploading} suggested={suggested} onUpload={analyze} onApprove={approve} onReset={reset} />}
      {tab === 'overview' && <Overview d={d} onPick={pick} />}
      {tab === 'hidden' && <HiddenScope d={d} onPick={pick} />}
      {tab === 'planner' && <Planner d={d} live={src === 'live'} generative={gen} onPick={pick} />}
      {tab === 'blast' && <BlastRadius d={d} onPick={pick} />}
      {tab === 'graph' && <GraphView d={d} selected={sel} onPick={setSel} />}
      {tab === 'graph' && sel && <div className="mt-4"><Drill d={d} selected={sel} onPick={setSel} /></div>}
      {tab === 'drill' && <Drill d={d} selected={sel} onPick={setSel} />}
      {tab === 'methods' && <Methods d={d} />}
      {tab === 'ask' && <Ask suggested={suggested} live={src === 'live'} />}
      <footer className="text-[11px] text-faint mt-8 leading-relaxed">
        <b className="text-dim">What this claims:</b> current-state PCI data-flow lineage from BAM (authoritative) + Splunk/survey signals (clearly marked inferred), with cycle resolution via Tarjan SCC condensation and a defensible, reproducible risk model.
        <b className="text-dim"> What it does not:</b> remediate controls, assert business need, or treat inferred signals as ground truth. Card numbers are masked first-6/last-4 on ingest; an unmasked PAN fails the run.
      </footer>
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
        <div className="bg-panel2 rounded-lg px-4 py-3">
          <div className="disp text-3xl font-black text-pan">{fmt(e.in_scope_now)}</div>
          <div className="text-[11px] text-dim">in PCI scope now (CDE)</div>
        </div>
        <div className="disp text-2xl text-faint pb-3">→</div>
        <div className="bg-panel2 rounded-lg px-4 py-3">
          <div className="disp text-3xl font-black text-safe">{fmt(e.achievable_floor)}</div>
          <div className="text-[11px] text-dim">achievable floor (full tokenization)</div>
        </div>
        <div className="bg-panel2 rounded-lg px-4 py-3">
          <div className="disp text-3xl font-black text-cool">{fmt(e.removable)}</div>
          <div className="text-[11px] text-dim">systems removable from scope</div>
        </div>
        <div className="bg-panel2 rounded-lg px-4 py-3">
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
      <table className="w-full text-sm">
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
    const colByBand = ['#d98b1f', '#3f6fd1', '#0f9b8e']  // pan / cool / safe
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
        .attr('font-size', 10).attr('fill', '#9fb0c6').attr('font-family', 'ui-monospace,monospace')
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
