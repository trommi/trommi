// Same switch as the board: light unless the human picked dark. #dark and #light override, for screenshots.
// (A file of its own: the app's CSP allows no inline script.)
{
  const hash = location.hash.slice(1).split(',')
  let theme = null
  try { theme = localStorage.getItem('agent-board-theme') } catch {}
  if (hash.includes('dark')) theme = 'dark'
  if (hash.includes('light')) theme = 'light'
  if (theme === 'dark') document.documentElement.dataset.theme = 'dark'
}
