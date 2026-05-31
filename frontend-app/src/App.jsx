import React, { useState, useEffect, useRef, useMemo } from 'react'
import * as d3 from 'd3'
import SNAPSHOT from './snapshot.json'

const isHttp = typeof location !== 'undefined' && location.protocol.startsWith('http')
const fmt = n => (typeof n === 'number' ? n.toLocaleString() : n)

const AGENTS_FALLBACK = SNAPSHOT.agents || []
const SUGGESTED_FALLBACK = SNAPSHOT.suggested_questions || []

/* ---- shared graph filter (pan = cardholder-data lineage, heavy = top distributors, all = full) ---- */
function filterGraph(viz, mode, heavyList) {
  const { nodes, edges } = viz
  const byId = new Map(nodes.map(n => [n.id, n]))
  const carries = n => n && (n.carries_pan || n.true_source || n.hidden_pci)
  if (mode === 'heavy') {
    const adj = new Map()
    edges.forEach(e => { if (!adj.has(e.source)) adj.set(e.source, []); adj.get(e.source).push(e.target) })
    const keep = new Set(heavyList); const stack = [...heavyList]
    while (stack.length) { const x = stack.pop(); (adj.get(x) || []).forEach(t => { if (!keep.has(t)) { keep.add(t); stack.push(t) } }) }
    return { N: nodes.filter(n => keep.has(n.id)), L: edges.filter(e => keep.has(e.source) && keep.has(e.target)) }
  }
  if (mode === 'pan') {
    const panEdges = edges.filter(e => carries(byId.get(e.source)))
    const keep = new Set(); panEdges.forEach(e => { keep.add(e.source); keep.add(e.target) })
    // only nodes incident to a PAN edge — isolated carriers add noise and scatter the layout
    return { N: nodes.filter(n => keep.has(n.id)), L: panEdges }
  }
  const idset = new Set(nodes.map(n => n.id))
  return { N: nodes, L: edges.filter(e => idset.has(e.source) && idset.has(e.target)) }
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
  const heavyList = useMemo(() => d.heavy_hitters.map(h => h.system), [d])
  const heavySet = useMemo(() => new Set(heavyList), [heavyList])
  const exclBySys = useMemo(() => Object.fromEntries(d.heavy_hitters.map(h => [h.system, h.exclusive_reach])), [d])
  const counts = useMemo(() => { const { N, L } = filterGraph(d.viz, mode, heavyList); return { n: N.length, l: L.length } }, [d, mode, heavyList])
  const comp = useMemo(() => {
    const ns = d.viz.nodes
    return { total: ns.length, pan: ns.filter(n => n.carries_pan || n.true_source).length,
             hidden: ns.filter(n => n.hidden_pci).length, scope: ns.filter(n => n.in_scope).length }
  }, [d])

  useEffect(() => {
    const base = filterGraph(d.viz, mode, heavyList)
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
    const rad = n => (heavySet.has(n.id) ? 6 : 3) + Math.sqrt(n.reach || 0) * 1.7
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
      .attr('stroke', n => n.hidden_pci ? '#ff5c5c' : (heavySet.has(n.id) ? '#fff' : (n.scope_prov === 'inferred' ? '#f5a623' : '#0a0e14')))
      .attr('stroke-width', n => heavySet.has(n.id) ? 2 : (n.hidden_pci ? 2 : (n.scope_prov === 'inferred' ? 1.5 : 1)))
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
    const label = g.append('g').selectAll('text').data(N.filter(n => heavySet.has(n.id) || (n.reach || 0) >= 14 || n.hidden_pci)).join('text')
      .text(n => n.id)
      .attr('font-size', n => heavySet.has(n.id) ? 10 : 9).attr('fill', n => heavySet.has(n.id) ? '#e6edf6' : '#8aa0bd')
      .attr('class', 'mono').attr('dx', 8).attr('dy', 3)
    sim.on('tick', () => {
      link.attr('x1', e => e.source.x).attr('y1', e => e.source.y).attr('x2', e => e.target.x).attr('y2', e => e.target.y)
      node.attr('cx', n => n.x).attr('cy', n => n.y); label.attr('x', n => n.x).attr('y', n => n.y)
    })
    return () => sim.stop()
  }, [d, mode, showInferred, heavyList, heavySet, exclBySys, onPick])
  useEffect(() => {
    if (!selected) return
    d3.select(ref.current).selectAll('circle')
      .attr('stroke', n => n.id === selected ? '#2dd4bf' : (n.hidden_pci ? '#ff5c5c' : (heavySet.has(n.id) ? '#fff' : (n.scope_prov === 'inferred' ? '#f5a623' : '#0a0e14'))))
      .attr('stroke-width', n => n.id === selected ? 3.5 : (heavySet.has(n.id) ? 2 : (n.hidden_pci ? 2 : 1)))
  }, [selected, heavySet])

  const modes = [['pan', 'PAN flow only'], ['heavy', 'Heavy-hitter subgraph'], ['all', 'All systems']]
  const modeHelp = { pan: 'Only the cardholder-data lineage: edges originating from a PAN-carrying system.',
    heavy: 'The top PAN distributors (by downstream reach) and everything downstream of them — the decision-relevant subgraph.',
    all: 'Every system and dependency. Hover a node to isolate its neighbourhood.' }
  return (
    <div className="card p-3">
      <div className="flex items-center gap-2 px-2 pt-1 pb-2 flex-wrap">
        <span className="text-[11px] text-faint mr-1">view:</span>
        {modes.map(([k, l]) => <button key={k} onClick={() => setMode(k)}
          className={'mono text-[11px] px-2.5 py-1 rounded border ' + (mode === k ? 'border-pan text-pan bg-pan/10' : 'border-line text-dim hover:text-txt')}>{l}</button>)}
        <label className="flex items-center gap-1 text-[11px] text-dim ml-2 cursor-pointer"><input type="checkbox" checked={showInferred} onChange={e => setShowInferred(e.target.checked)} />show inferred edges</label>
        <span className="ml-auto mono text-[11px] text-faint">{counts.n} nodes · {counts.l} edges</span>
      </div>
      <div className="px-2 text-[11px] text-dim mb-1">{modeHelp[mode]}</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-2 py-1 text-[11px] text-dim items-center">
        <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block ring-1 ring-white" style={{ background: '#f5a623' }} />true PAN source (★ heavy hitter)</span>
        <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block" style={{ background: '#f7c873' }} />carries PAN</span>
        <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block" style={{ background: '#ff5c5c' }} />hidden PCI (BAM miss)</span>
        <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block" style={{ background: '#5b8def' }} />in scope</span>
        <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block" style={{ background: 'transparent', border: '1.5px dashed #f5a623' }} />inferred-only scope</span>
        <span className="flex items-center gap-1"><svg width="26" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="#2c3e57" strokeWidth="2" markerEnd="" /></svg>metadata →</span>
        <span className="flex items-center gap-1"><svg width="26" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke="#f5a623" strokeWidth="2" strokeDasharray="4 3" /></svg>inferred →</span>
        <span className="ml-auto text-faint">arrow = PAN flow (provider→consumer) · hover = isolate · scroll = zoom</span>
      </div>
      <div ref={ref} style={{ width: '100%' }} />
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
    </div>
  )
}

/* ============================ CHARTS (pure SVG, no deps) ============================ */
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
  const color = n => n.hidden_pci ? 'var(--panhot)' : n.true_source ? 'var(--pan)' : n.carries_pan ? '#e3a83a' : 'var(--cool)'
  return (
    <div className="card p-5">
      <div className="disp font-bold">Prioritization quadrant <span className="text-faint text-xs font-normal">— conduit centrality × risk</span></div>
      <div className="text-xs text-dim mb-2">Reach is saturated here (every source reaches ~the whole estate), so we plot <b>betweenness</b> — how many PAN paths route through a system — against risk. Upper-right = high-conduit <i>and</i> high-risk: the systems whose tokenization would sever the most PAN flow. <span className="text-pan">◯ ringed</span> = top distributor · <span className="text-safe">▢</span> = choke point (cut vertex).</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 320 }}>
        {[0, 0.25, 0.5, 0.75, 1].map((f, i) => (
          <g key={i}>
            <line x1={P.l} x2={W - P.r} y1={y(f * maxY)} y2={y(f * maxY)} stroke="var(--line)" strokeWidth="0.5" />
            <text x={P.l - 6} y={y(f * maxY) + 3} textAnchor="end" fontSize="9" fill="var(--faint)">{Math.round(f * maxY)}</text>
          </g>
        ))}
        <text x={P.l - 30} y={P.t + 6} fontSize="9" fill="var(--dim)" transform={`rotate(-90 ${P.l - 30} ${H / 2})`}>risk score</text>
        <text x={(W) / 2} y={H - 6} textAnchor="middle" fontSize="9" fill="var(--dim)">betweenness (conduit centrality) →</text>
        {nodes.map((n, i) => {
          const isChoke = chokes.has(n.id)
          const r = hh.has(n.id) ? 7 : 3.6
          if (isChoke) return <rect key={i} x={x(bx(n)) - r} y={y(n.risk || 0) - r} width={2 * r} height={2 * r}
            fill={color(n)} fillOpacity={0.85} stroke="var(--safe)" strokeWidth="1.4" rx="1"
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
  const tone = rho >= 0.9 ? 'text-safe' : rho >= 0.75 ? 'text-pan' : 'text-panhot'
  return (
    <div className="card p-5">
      <div className="disp font-bold text-lg">Risk-weight sensitivity <span className="text-faint text-xs font-normal">— does the ranking depend on the weights?</span></div>
      <p className="text-sm text-dim mt-1 mb-4 max-w-3xl leading-relaxed">
        The composite risk weights sensitivity/reach/betweenness/source at 0.40/0.30/0.20/0.10. To show the heavy-hitter
        ranking isn't an artifact of those constants, each PAN-carrying system's risk is recomputed from its stored
        graph-derived factors under alternative weightings and re-ranked. A rank correlation near 1.0 means the ordering —
        and the conclusions — fall out of the data-flow structure, not the chosen numbers.
      </p>
      <div className="flex flex-wrap gap-3 mb-4">
        <div className="bg-panel2 rounded-xl p-4 flex-1 min-w-[180px]">
          <div className={'disp text-3xl font-black ' + tone}>{rho.toFixed(2)}</div>
          <div className="text-xs text-txt mt-1">Mean rank correlation (Spearman ρ)</div>
          <div className="text-[11px] text-faint mt-0.5">base vs each reweighting · 1.0 = identical order</div>
        </div>
        <div className="bg-panel2 rounded-xl p-4 flex-1 min-w-[180px]">
          <div className="disp text-3xl font-black text-safe">{ov}/5</div>
          <div className="text-xs text-txt mt-1">Top-5 membership held</div>
          <div className="text-[11px] text-faint mt-0.5">worst case across all reweightings</div>
        </div>
        <div className="bg-panel2 rounded-xl p-4 flex-1 min-w-[180px]">
          <div className="disp text-3xl font-black text-cool">{ws.min_rank_correlation.toFixed(2)}</div>
          <div className="text-xs text-txt mt-1">Worst-case ρ</div>
          <div className="text-[11px] text-faint mt-0.5">most adversarial single reweighting</div>
        </div>
      </div>
      <div className="scroll overflow-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-[11px] uppercase tracking-wider text-faint bg-panel2">
            <th className="px-3 py-2">Weighting (s/r/b/src)</th><th className="px-3 py-2">ρ</th><th className="px-3 py-2">Top-5 distributors by risk</th></tr></thead>
          <tbody>
            {ws.scenarios.map((sc, i) => (
              <tr key={i} className={'border-t border-line ' + (i === 0 ? 'bg-pan/5' : '')}>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <span className={'font-semibold ' + (i === 0 ? 'text-pan' : 'text-txt')}>{sc.name}</span>
                  <span className="mono text-[11px] text-faint ml-2">{sc.weights.sensitivity}/{sc.weights.reach}/{sc.weights.betweenness}/{sc.weights.source}</span>
                </td>
                <td className="px-3 py-2.5 mono text-dim">{i === 0 ? '—' : sc.rho.toFixed(2)}</td>
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
      <div className="text-[11px] text-faint mt-3">Ranking over {ws.universe_size} PAN-carrying systems. Same distributors recur in the top 5 across every weighting — the result is structural, not tuned.</div>
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
        {topDist && <> The widest PAN distributor is{' '}
          <button onClick={() => onPick(topDist.system)} className="mono text-pan hover:underline">{topDist.system}</button>
          {' '}(reaches {topDist.downstream_reach} systems).</>}
        {topMiss && topMiss.downstream_reach > 0 && <> Strikingly, the widest <b>BAM-missed</b> distributor,{' '}
          <button onClick={() => onPick(topMiss.system)} className="mono text-panhot hover:underline">{topMiss.system}</button>
          {' '}(reaches {topMiss.downstream_reach} systems), is itself one of those misses.</>}
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
              <th>BAM flag</th><th title="What Splunk found in Sept–Dec logs">Splunk finding</th></tr></thead>
            <tbody>{rows.map(x => (
              <tr key={x.system} className="hh mono" onClick={() => onPick(x.system)}>
                <td className="text-panhot font-semibold">{x.system}<span className="text-faint text-[10px] ml-1.5">{(x.name || '').slice(0, 18)}</span></td>
                <td className={x.downstream_reach > 0 ? 'text-pan' : 'text-faint'}>{x.downstream_reach || '—'}</td>
                <td className="text-dim">{x.stated_source || '—'}</td>
                <td><span className="text-[10px] px-1.5 py-0.5 rounded bg-line text-dim">PCI = No</span></td>
                <td><span className="text-[10px] px-1.5 py-0.5 rounded bg-panhot/15 text-panhot">{x.finding || 'True PAN'}</span></td>
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
  const tabs = [['pipeline', 'Pipeline'], ['overview', 'Overview'], ['hidden', 'Hidden Scope'], ['planner', 'Planner'], ['graph', 'Data-Flow Graph'], ['drill', 'Drill-down'], ['methods', 'Methods'], ['ask', 'Ask']]
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
        </div>
      </header>
      <nav className="flex gap-1 mb-5 bg-panel rounded-xl p-1 w-fit border border-line">
        {tabs.map(([k, l]) => <button key={k} data-on={tab === k ? '1' : '0'} onClick={() => setTab(k)} className="tab mono text-sm px-4 py-2 rounded-lg text-dim">{l}</button>)}
      </nav>
      {showBanner && <VerdictBanner d={d} onTab={setTab} onPick={pick} />}
      {tab === 'pipeline' && <Pipeline d={d} agents={agents} phase={phase} gate={gate} uploading={uploading} suggested={suggested} onUpload={analyze} onApprove={approve} onReset={reset} />}
      {tab === 'overview' && <Overview d={d} onPick={pick} />}
      {tab === 'hidden' && <HiddenScope d={d} onPick={pick} />}
      {tab === 'planner' && <Planner d={d} live={src === 'live'} onPick={pick} />}
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
