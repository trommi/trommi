// Browser stand-in for the hub's server/thumbs.mjs: the app has no thumbnail service (pictures are decrypted in the
// page), so every picture keeps its own address. views/picture.mjs needs only these two names.
export const WIDTHS = [160, 320, 640, 1280]
export const sizeOfUrl = () => null
