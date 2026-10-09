// The site's one script: the theme button in the head of every page (one button: System, Light, Dark, and round again).
// Loaded in <head> without defer, so <html data-theme="system|light|dark"> stands before the first paint (site.css
// takes its colours from that attribute). A picked theme is kept in this browser's localStorage under one key;
// "system" keeps nothing. Without this script the page follows the system and the button is not shown.
(function () {
  var KEY = 'trommi-site-theme'
  var root = document.documentElement
  var NEXT = { system: 'light', light: 'dark', dark: 'system' }
  var NAMES = { system: 'System', light: 'Light', dark: 'Dark' }
  var SCHEME = /\(prefers-color-scheme:\s*(light|dark)\)/

  function stored() {
    try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system' } catch (e) { return 'system' }
  }
  function keep(mode) {
    try { if (mode === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, mode) } catch (e) { /* private window: the choice lasts for this page */ }
  }

  // What is chosen by a media query on the system's scheme (<source> of a <picture>, <meta name="theme-color">)
  // follows the picked theme: the scheme clause becomes always true or the whole query never true. Only the
  // picture that is shown is fetched.
  function follow(el, mode) {
    var media = el.getAttribute('data-media')
    if (media == null) {
      media = el.getAttribute('media') || ''
      if (!SCHEME.test(media)) return
      el.setAttribute('data-media', media)
    }
    var next = mode === 'system' ? media : SCHEME.exec(media)[1] === mode ? media.replace(SCHEME, '(min-width: 0px)') : 'not all'
    if (el.getAttribute('media') !== next) el.setAttribute('media', next)
  }
  function apply(mode) {
    root.setAttribute('data-theme', mode)
    var all = document.querySelectorAll('[media]')
    for (var i = 0; i < all.length; i++) follow(all[i], mode)
    // the button says what is set and what a press does (its mark comes from data-theme, in site.css)
    var btn = document.querySelector('.theme-btn')
    if (btn) {
      btn.setAttribute('data-tip', 'Theme: ' + NAMES[mode])
      btn.setAttribute('aria-label', 'Theme: ' + NAMES[mode] + '. Switch to ' + NAMES[NEXT[mode]])
    }
  }

  var mode = stored()
  apply(mode)

  // While the page is still being read: a <source> is set right as it arrives, before its <img> picks a file.
  var watch = null
  if (mode !== 'system' && window.MutationObserver) {
    watch = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) for (var j = 0; j < records[i].addedNodes.length; j++) {
        var node = records[i].addedNodes[j]
        if (node.nodeType === 1 && node.hasAttribute('media')) follow(node, mode)
      }
    })
    watch.observe(root, { childList: true, subtree: true })
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (watch) watch.disconnect()
    apply(mode)
    document.addEventListener('click', function (e) {
      if (!e.target || !e.target.closest || !e.target.closest('.theme-btn')) return
      mode = NEXT[mode]
      keep(mode)
      apply(mode)
    })
  })
  // another tab of the site changed it
  window.addEventListener('storage', function (e) { if (e.key === KEY || e.key === null) { mode = stored(); apply(mode) } })
})()
