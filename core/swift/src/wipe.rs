//! Memory the library frees is wiped first.
//!
//! Keys cross the edge as plain bytes: an argument is copied in, a result is copied out, and the copies this
//! side makes on the way (the buffer a result travels in, a `Vec` an argument arrived in) are ordinary heap
//! memory that Rust would hand back as it is. This allocator overwrites every block with zeros before it frees
//! it, so that no copy of a key outlives its use on this side of the edge, whichever code made it. In a browser
//! that matters twice: the page can read the module's whole memory.
//!
//! What the host holds (a `Uint8Array`, a `Data`) is the host's to forget.

use std::alloc::{GlobalAlloc, Layout, System};
use zeroize::Zeroize;

/// The system's allocator, wiping what it takes back.
pub struct Wiping;

// SAFETY: every call is passed to the system allocator unchanged. `dealloc` first writes zeros over exactly the
// block being freed: `pointer` is valid for `layout.size()` bytes, as the caller of `dealloc` guarantees.
// `realloc` is the trait's own: allocate, copy, `dealloc` the old block, which wipes it. The system's `realloc`
// could move a block and leave the old bytes behind.
unsafe impl GlobalAlloc for Wiping {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        System.alloc(layout)
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        System.alloc_zeroed(layout)
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // Through `zeroize`, whose writes the compiler may not drop as "dead stores before a free".
        std::slice::from_raw_parts_mut(pointer, layout.size()).zeroize();
        System.dealloc(pointer, layout);
    }
}
