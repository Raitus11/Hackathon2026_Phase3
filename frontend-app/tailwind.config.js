export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: { extend: {
    colors: { ink:'#0a0e14', panel:'#0f1622', panel2:'#131c2b', line:'#1e2a3d',
      pan:'#f5a623', panhot:'#ff5c5c', safe:'#2dd4bf', cool:'#5b8def',
      txt:'#e6edf6', dim:'#8aa0bd', faint:'#56657d' },
    fontFamily: { disp:['Archivo','sans-serif'], body:['"IBM Plex Sans"','sans-serif'], mono:['"IBM Plex Mono"','monospace'] }
  } }, plugins: []
}
