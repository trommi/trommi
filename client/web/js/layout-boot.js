// Which shell the page wears, decided before the first paint (a plain script in the head).
// The sidebar is the default. "Stack + Table" (css/stack.css, css/table.css, js/stack.js, js/table.js)
// is on when <html data-layout="stack">: asked for once by ?layout=stack in the address, then
// remembered in this browser; ?layout=sidebar turns it off again. The flag is read and taken out of
// the address, so no link the page writes afterwards carries it.
(function () {
  var KEY = 'trommi-layout'
  var want = null
  try {
    var params = new URLSearchParams(location.search)
    want = params.get('layout')
    if (want != null) {
      params.delete('layout')
      var query = params.toString()
      history.replaceState(history.state, '', location.pathname + (query ? '?' + query : '') + location.hash)
    }
  } catch (e) {}
  try {
    if (want === 'stack' || want === 'sidebar') localStorage.setItem(KEY, want)
    else want = localStorage.getItem(KEY)
  } catch (e) {}
  if (want === 'stack') document.documentElement.dataset.layout = 'stack'
})()
