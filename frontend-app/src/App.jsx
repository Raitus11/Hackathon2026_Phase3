import React, { useState, useEffect, useRef, useMemo } from 'react'
import * as d3 from 'd3'
import SNAPSHOT from './snapshot.json'

const isHttp = typeof location !== 'undefined' && location.protocol.startsWith('http')
const fmt = n => (typeof n === 'number' ? n.toLocaleString() : n)

function useData() {
  const [data, setData] = useState(null)
  const [src, setSrc] = useState('snapshot')
  useEffect(() => {
    let live = false
    ;(async () => {
      try {
        if (isHttp) {
          const h = await fetch('/health').then(r => r.json()).catch(() => null)
          if (h && h.has_run) {
            const [g, head, imp, hh] = await Promise.all([
              fetch('/api/graph').then(r => r.json()),
              fetch('/api/headline').then(r => r.json()),
              fetch('/api/impact').then(r => r.json()),
              fetch('/api/heavy-hitters?top_k=10').then(r => r.json()),
            ])
            setData({ ...SNAPSHOT, viz: g, headline: head.headline, hidden: head.hidden,
                      impact: imp, heavy_hitters: hh.heavy_hitters })
            setSrc('live'); live = true
          }
        }
      } catch (e) { /* fall through to snapshot */ }
      if (!live) setData(SNAPSHOT)
    })()
  }, [])
  return [data, src]
}

function KPI({ label, value, sub, tone, delay }) {
  const tones = { pan: 'text-pan', hot: 'text-panhot', safe: 'text-safe', cool: 'text-cool' }
  return (
    <div className="card kpi p-4 flex-1 min-w-[180px]" style={{ animationDelay: delay + 'ms' }}>
      <div className="text-[11px] uppercase tracking-[.14em] text-faint">{label}</div>
      <div className={'disp font-black text-4xl mt-1 ' + (tones[tone] || 'text-txt')}>{value}</div>
      <div className="text-xs text-dim mt-1">{sub}</div>
    </div>
  )
}

function Overview({ d, onPick }) {
  const h = d.headline, imp = d.impact
  const before = imp.scope_before, after = imp.scope_after, maxv = Math.max(before, 1)
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-3">
        <KPI label="Systems exposed to clear PAN" value={fmt(h.systems_exposed_to_clear_pan)} sub="current PCI / CDE scope" tone="pan" delay={0} />
        <KPI label="Hidden PCI — BAM misses" value={fmt(h.hidden_pci_systems_bam_misses)} sub="PCI=No in BAM, PAN seen in Splunk" tone="hot" delay={70} />
        <KPI label="Cycle clusters resolved" value={fmt(h.cycle_clusters_resolved)} sub="Tarjan SCC → condensation → DAG" tone="cool" delay={140} />
        <KPI label="Top intervention" value={h.top_intervention || '—'} sub="highest clean-stream leverage" tone="safe" delay={210} />
      </div>
      <div className="grid lg:grid-cols-2 gap-5">
        <div className="card p-5">
          <div className="disp font-bold text-lg">Clean-stream impact</div>
          <div className="text-xs text-dim mb-4">Tokenize PAN at top-{imp.tokenized_systems.length} true-source(s): {imp.tokenized_systems.map(s => <span key={s} className="mono text-pan">{s} </span>)}</div>
          {[['In-scope now', before, 'bg-pan'], ['In-scope after', after, 'bg-safe']].map(([lbl, v, c], i) => (
            <div key={i} className="mb-3">
              <div className="flex justify-between text-xs mb-1"><span className="text-dim">{lbl}</span><span className="mono">{v} systems</span></div>
              <div className="h-3 rounded-full bg-panel2 overflow-hidden"><div className={'h-full ' + c} style={{ width: (100 * v / maxv) + '%', transition: 'width .8s cubic-bezier(.2,.8,.2,1)' }} /></div>
            </div>
          ))}
          <div className="grid grid-cols-3 gap-2 mt-4 text-center">
            <div className="bg-panel2 rounded-lg p-3"><div className="disp text-2xl font-black text-safe">{imp.nodes_descoped}</div><div className="text-[11px] text-dim">systems descoped</div></div>
            <div className="bg-panel2 rounded-lg p-3"><div className="disp text-2xl font-black text-safe">{imp.node_surface_reduction_pct}%</div><div className="text-[11px] text-dim">surface reduction</div></div>
            <div className="bg-panel2 rounded-lg p-3"><div className="disp text-2xl font-black text-cool">{imp.retained_via_detokenization_count}</div><div className="text-[11px] text-dim">stay (RISE/APG)</div></div>
          </div>
          <div className="text-[11px] text-faint mt-3">A system descopes only when it receives CRN from <b>all</b> upstreams. Systems that must de-tokenize via centralized RISE/APG services remain in CDE.</div>
        </div>
        <div className="card p-5">
          <div className="disp font-bold text-lg">Heavy hitters — primary PAN distributors</div>
          <div className="text-xs text-dim mb-2">Ranked by exclusive downstream reach. Click to inspect.</div>
          <div className="scroll overflow-auto max-h-[260px]">
            <table className="dt w-full text-sm">
              <thead><tr className="text-faint text-[11px] uppercase tracking-wider sticky top-0 bg-panel"><th>System</th><th>Excl. reach</th><th>Reach</th><th>Out-deg</th><th>Risk</th></tr></thead>
              <tbody>{d.heavy_hitters.map(r => (
                <tr key={r.system} className="hh mono" onClick={() => onPick(r.system)}>
                  <td className="text-pan font-semibold">{r.system}</td>
                  <td>{r.exclusive_reach}</td><td>{r.downstream_reach}</td><td>{r.out_degree}</td>
                  <td><span className="px-2 py-0.5 rounded" style={{ background: 'rgba(245,166,35,' + (r.risk / 120) + ')' }}>{r.risk}</span></td>
                </tr>))}</tbody>
            </table>
          </div>
        </div>
      </div>
      <div className="card p-5">
        <div className="disp font-bold text-lg mb-1">Grounded explanation</div>
        <p className="text-sm text-dim leading-relaxed">{d.explanation}</p>
        <div className="flex flex-wrap gap-2 mt-4">{d.audit.map((a, i) => <span key={i} className="mono text-[11px] px-2 py-1 rounded bg-panel2 text-faint">{a.stage} · {a.ms}ms</span>)}</div>
      </div>
    </div>
  )
}

function GraphView({ d, selected, onPick }) {
  const ref = useRef()
  useEffect(() => {
    const { nodes, edges } = d.viz
    const W = ref.current.clientWidth, H = 620
    const svg = d3.select(ref.current).html('').append('svg').attr('width', W).attr('height', H).attr('viewBox', [0, 0, W, H])
    const g = svg.append('g')
    svg.call(d3.zoom().scaleExtent([.2, 4]).on('zoom', e => g.attr('transform', e.transform)))
    const N = nodes.map(n => ({ ...n })), idset = new Set(N.map(n => n.id))
    const L = edges.filter(e => idset.has(e.source) && idset.has(e.target)).map(e => ({ ...e }))
    const color = n => n.pan_in_logs_observed ? '#ff5c5c' : n.true_source ? '#f5a623' : n.carries_pan ? '#f7c873' : n.in_scope ? '#5b8def' : '#3a4a63'
    const rad = n => 4 + Math.sqrt(n.reach || 0) * 1.6
    const sim = d3.forceSimulation(N)
      .force('link', d3.forceLink(L).id(d => d.id).distance(46).strength(.25))
      .force('charge', d3.forceManyBody().strength(-90))
      .force('center', d3.forceCenter(W / 2, H / 2))
      .force('collide', d3.forceCollide().radius(n => rad(n) + 3))
    const link = g.append('g').selectAll('line').data(L).join('line')
      .attr('class', 'lk').attr('stroke', e => e.provenance === 'inferred' ? '#f5a623' : '#26354a')
      .attr('stroke-opacity', e => e.provenance === 'inferred' ? .8 : .45)
      .attr('stroke-width', e => e.provenance === 'inferred' ? 1.4 : 1)
      .attr('stroke-dasharray', e => e.provenance === 'inferred' ? '4 3' : null)
    const node = g.append('g').selectAll('circle').data(N).join('circle')
      .attr('class', 'node').attr('r', rad).attr('fill', color)
      .attr('stroke', n => n.pan_in_logs_observed ? '#ff5c5c' : '#0a0e14').attr('stroke-width', n => n.pan_in_logs_observed ? 2 : 1)
      .on('click', (e, n) => onPick(n.id))
      .call(d3.drag()
        .on('start', (e, n) => { if (!e.active) sim.alphaTarget(.3).restart(); n.fx = n.x; n.fy = n.y })
        .on('drag', (e, n) => { n.fx = e.x; n.fy = e.y })
        .on('end', (e, n) => { if (!e.active) sim.alphaTarget(0); n.fx = null; n.fy = null }))
    node.append('title').text(n => `${n.id} ${n.name || ''}\nreach ${n.reach} · risk ${n.risk} · tier ${n.tier}`)
    const label = g.append('g').selectAll('text').data(N.filter(n => (n.reach || 0) >= 12 || n.true_source)).join('text')
      .text(n => n.id).attr('font-size', 9).attr('fill', '#8aa0bd').attr('class', 'mono').attr('dx', 8).attr('dy', 3)
    sim.on('tick', () => {
      link.attr('x1', e => e.source.x).attr('y1', e => e.source.y).attr('x2', e => e.target.x).attr('y2', e => e.target.y)
      node.attr('cx', n => n.x).attr('cy', n => n.y)
      label.attr('x', n => n.x).attr('y', n => n.y)
    })
    return () => sim.stop()
  }, [d])
  useEffect(() => {
    if (!selected) return
    d3.select(ref.current).selectAll('circle')
      .attr('stroke', n => n.id === selected ? '#2dd4bf' : (n.pan_in_logs_observed ? '#ff5c5c' : '#0a0e14'))
      .attr('stroke-width', n => n.id === selected ? 3 : (n.pan_in_logs_observed ? 2 : 1))
  }, [selected])
  return (
    <div className="card p-3">
      <div className="flex flex-wrap gap-4 px-2 py-1 text-[11px] text-dim items-center">
        <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block" style={{ background: '#f5a623' }} />true PAN source</span>
        <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block" style={{ background: '#f7c873' }} />carries PAN</span>
        <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block ring-2 ring-panhot" style={{ background: '#ff5c5c' }} />hidden PCI (Splunk)</span>
        <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-full inline-block" style={{ background: '#5b8def' }} />in scope</span>
        <span className="flex items-center gap-1"><svg width="26" height="6"><line x1="0" y1="3" x2="26" y2="3" stroke="#26354a" strokeWidth="2" /></svg>metadata</span>
        <span className="flex items-center gap-1"><svg width="26" height="6"><line x1="0" y1="3" x2="26" y2="3" stroke="#f5a623" strokeWidth="2" strokeDasharray="4 3" /></svg>inferred</span>
        <span className="ml-auto text-faint">scroll = zoom · drag · click = inspect · edge = PAN flow (provider→consumer)</span>
      </div>
      <div ref={ref} style={{ width: '100%' }} />
    </div>
  )
}

function Drill({ d, selected, onPick }) {
  const node = useMemo(() => d.viz.nodes.find(n => n.id === selected), [d, selected])
  if (!node) return <div className="card p-8 text-center text-dim">Select a system in the graph or heavy-hitter table to inspect its lineage, scores, and PAN exposure.</div>
  const ins = d.viz.edges.filter(e => e.target === selected), outs = d.viz.edges.filter(e => e.source === selected)
  const hh = d.heavy_hitters.find(h => h.system === selected)
  const Row = ({ k, v, t }) => <div className="flex justify-between py-1.5 border-b border-line text-sm"><span className="text-dim">{k}</span><span className={'mono ' + (t || '')}>{v}</span></div>
  return (
    <div className="grid lg:grid-cols-3 gap-5">
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
        <Row k="Hidden PCI (Splunk)" v={node.pan_in_logs_observed ? 'YES — BAM misses' : 'no'} t={node.pan_in_logs_observed ? 'text-panhot' : ''} />
        <Row k="Cycle cluster" v={node.super_node || '—'} />
        {hh && <div className="mt-3 text-[11px] text-faint">Heavy hitter: tokenizing this descopes <b className="text-safe">{hh.exclusive_reach}</b> exclusively-dependent systems.</div>}
      </div>
      <div className="card p-5">
        <div className="disp font-bold mb-2">Upstream providers <span className="text-faint text-xs">({ins.length}) — send PAN to {node.id}</span></div>
        <div className="scroll max-h-[300px] overflow-auto space-y-1">
          {ins.length ? ins.map((e, i) => (
            <button key={i} onClick={() => onPick(e.source)} className="w-full flex justify-between text-left text-sm px-2 py-1 rounded hover:bg-panel2">
              <span className="mono text-cool">{e.source}</span>
              <span className={'text-[10px] px-1.5 rounded ' + (e.provenance === 'inferred' ? 'bg-pan/20 text-pan' : 'bg-line text-dim')}>{e.provenance}{e.signal ? ' · ' + e.signal : ''}</span>
            </button>)) : <div className="text-dim text-sm">none — candidate true source</div>}
        </div>
      </div>
      <div className="card p-5">
        <div className="disp font-bold mb-2">Downstream consumers <span className="text-faint text-xs">({outs.length}) — receive PAN from {node.id}</span></div>
        <div className="scroll max-h-[300px] overflow-auto space-y-1">
          {outs.length ? outs.map((e, i) => (
            <button key={i} onClick={() => onPick(e.target)} className="w-full flex justify-between text-left text-sm px-2 py-1 rounded hover:bg-panel2">
              <span className="mono text-txt">{e.target}</span>
              <span className={'text-[10px] px-1.5 rounded ' + (e.provenance === 'inferred' ? 'bg-pan/20 text-pan' : 'bg-line text-dim')}>{e.provenance}</span>
            </button>)) : <div className="text-dim text-sm">none — leaf / terminal consumer</div>}
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const [d, src] = useData()
  const [tab, setTab] = useState('overview')
  const [sel, setSel] = useState(null)
  if (!d) return <div className="h-full flex items-center justify-center text-dim mono">loading analysis…</div>
  const pick = id => { setSel(id); if (tab === 'overview') setTab('graph') }
  const tabs = [['overview', 'Overview'], ['graph', 'Data-Flow Graph'], ['drill', 'Drill-down']]
  return (
    <div className="max-w-[1280px] mx-auto px-5 py-5">
      <header className="flex items-center gap-4 mb-5">
        <div className="disp font-black text-2xl tracking-tight">PCI<span className="text-pan">·</span>SENTINEL</div>
        <div className="text-xs text-faint border-l border-line pl-4 leading-tight">Intelligent mapping of interdependencies across PCI systems<br />cardholder-data lineage · scope reduction · clean-stream targeting</div>
        <div className="ml-auto flex items-center gap-3">
          <span className={'mono text-[11px] px-2 py-1 rounded ' + (src === 'live' ? 'bg-safe/20 text-safe' : 'bg-line text-dim')}>{src === 'live' ? '● live API' : '● embedded snapshot'}</span>
        </div>
      </header>
      <nav className="flex gap-1 mb-5 bg-panel rounded-xl p-1 w-fit border border-line">
        {tabs.map(([k, l]) => <button key={k} data-on={tab === k ? '1' : '0'} onClick={() => setTab(k)} className="tab mono text-sm px-4 py-2 rounded-lg text-dim">{l}</button>)}
      </nav>
      {tab === 'overview' && <Overview d={d} onPick={pick} />}
      {tab === 'graph' && <GraphView d={d} selected={sel} onPick={setSel} />}
      {tab === 'drill' && <Drill d={d} selected={sel} onPick={setSel} />}
      {tab === 'graph' && sel && <div className="mt-4"><Drill d={d} selected={sel} onPick={setSel} /></div>}
      <footer className="text-[11px] text-faint mt-8 leading-relaxed">
        <b className="text-dim">What this claims:</b> current-state PCI data-flow lineage from BAM (authoritative) + Splunk/survey signals (clearly marked inferred), with cycle resolution via Tarjan SCC condensation and a defensible, reproducible risk model.
        <b className="text-dim"> What it does not:</b> remediate controls, assert business need, or treat inferred signals as ground truth. Card numbers are masked first-6/last-4 on ingest; an unmasked PAN fails the run.
      </footer>
    </div>
  )
}
