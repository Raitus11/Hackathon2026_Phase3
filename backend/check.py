import os, glob
from pci_sentinel import ingest as I, graph_build as G, analytics as A, optimize
from pci_sentinel.scoring import compute_scores
fs = [(os.path.basename(p), open(p, encoding='utf-8-sig').read())
      for p in sorted(glob.glob('../sample_data/*.csv'))]
a = G.build_graph(I.ingest_files(fs)); s = compute_scores(a.G)
c = A.cumulative_descope_curve(a.G, a.pan_sources, s, max_k=10)
print('cumulative_descope_curve k6 =', [r['cumulative_descoped'] for r in c][5])
fr = optimize.descope_frontier(a.G, a.pan_sources, s, k_max=10)
print('descope_frontier greedy  k6 =', next(r['greedy_descoped'] for r in fr['frontier'] if r['k'] == 6))