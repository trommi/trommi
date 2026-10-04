// Before first paint (a classic script, so it runs before the page is drawn; external, for the CSP): the theme this
// browser chose and whether the sidebar is folded to the rail. Same keys as today's board.
(function () {
  try { if (localStorage.getItem('agent-board-theme') === 'dark') document.documentElement.dataset.theme = 'dark' } catch (e) {}
  try { if (localStorage.getItem('trommi-rail') === 'folded') document.documentElement.dataset.rail = 'folded' } catch (e) {}
})()
