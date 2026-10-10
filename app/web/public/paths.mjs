// The app's addresses from before they had words: /s/<id>… (a chat with a session) and /a/<id> (a shared artifact).
// Links of then were handed on and the iOS app may hold them, so they still work: they move to /chat/<id>… and
// /artifact/<id> (worker.js answers with a 301, the page's router replaces the address in place).
//   /s/<id>, /s/<id>/files, /s/<id>/card/<n> …   →  /chat/<id>, /chat/<id>/files, /chat/<id>/card/<n> …
//   /s/<id>/a/<object>                          →  /chat/<id>/artifact/<object>
//   /a/<share id>                               →  /artifact/<share id>   (the share's secret stays after the #)

/** The new address of an old one, or null when `pathname` is not of the old form. */
export function movedPath(pathname) {
  if (pathname.startsWith('/s/')) return `/chat/${pathname.slice(3).replace(/^([^/]+)\/a\//, '$1/artifact/')}`
  if (pathname.startsWith('/a/')) return `/artifact/${pathname.slice(3)}`
  return null
}
