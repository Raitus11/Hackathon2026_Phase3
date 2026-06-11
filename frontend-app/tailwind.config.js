export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: { extend: {
    // Red/white corporate light theme. Token NAMES are unchanged so every existing
    // className keeps working; only the values moved. Semantics on a white surface:
    //   pan     = brand red — primary accent AND "true PAN source" (red == live card data)
    //   panhot  = deep blood red — hidden-PCI severity (darker == heavier on white)
    //   carrier = gold-amber — carries PAN it received (softer than originating it)
    //   gold    = brand gold — masthead keyline + generative-AI highlight
    //   ink     = text color on brand-filled controls (white on red)
    colors: { ink:'#ffffff', panel:'#ffffff', panel2:'#F6F4EF', line:'#E6E2DA',
      pan:'#D71E28', panhot:'#8F0E1E', safe:'#0E7C4A', cool:'#2563EB',
      txt:'#1F2329', dim:'#5A6472', faint:'#8B95A3',
      gold:'#FFCD41', brandDeep:'#A21621', carrier:'#E8A33D' },
    fontFamily: { disp:['Archivo','sans-serif'], body:['"IBM Plex Sans"','sans-serif'], mono:['"IBM Plex Mono"','monospace'] }
  } }, plugins: []
}
