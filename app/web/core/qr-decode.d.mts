/** The first QR code of a frame as text (data: RGBA bytes); throws when none is found. */
export function decodeQR(img: { width: number; height: number; data: Uint8Array | Uint8ClampedArray }, opts?: Record<string, unknown>): string
