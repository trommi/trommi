// A layout an agent sent, large (the board's large.html): opened in a new tab by "Open large" (js/richhtml.js), which
// hands the block over under the key in the address. Shown in the same sandboxed frame as in the conversation.
import { largeBlock } from '/js/richhtml.js'
const stage = document.getElementById('stage')
const frame = largeBlock(location.hash.slice(1))
if (frame) stage.append(frame)
else { const p = document.createElement('p'); p.textContent = 'This layout is no longer here. Open it again from the conversation or the card it stands in.'; stage.append(p) }
