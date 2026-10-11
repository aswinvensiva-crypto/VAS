/**
 * Draw VAS's icons — a glowing reactor ring — straight to PNG, so the app has
 * a window, tray and installer icon without an image editor or a dependency.
 *
 *   node scripts/make-icons.mjs
 *
 * Writes build/icon.png (256 px, which electron-builder turns into the .ico)
 * and electron/assets/tray.png (32 px; Windows scales it for the tray).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size)
      const o = y * (size * 4 + 1) + 1 + x * 4
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const clamp = (v) => Math.max(0, Math.min(1, v))

/** A dark disc, a bright cyan ring, a soft glow and a hot core. */
function reactor(x, y, size) {
  const c = size / 2
  const r = Math.hypot(x - c, y - c) / c // 0 at centre, 1 at the edge
  const disc = clamp((0.98 - r) * size * 0.5) // anti-aliased outer edge
  const ring = clamp(1 - Math.abs(r - 0.66) / 0.09)
  const glow = clamp(1 - Math.abs(r - 0.66) / 0.3) * 0.35
  const core = clamp(1 - r / 0.26)
  const light = clamp(ring + glow + core * 0.9)
  const R = Math.round(10 + light * (90 - 10) + core * 120)
  const G = Math.round(18 + light * (225 - 18) + core * 30)
  const B = Math.round(26 + light * (255 - 26))
  return [Math.min(255, R), Math.min(255, G), Math.min(255, B), Math.round(disc * 255)]
}

for (const [file, size] of [
  ['build/icon.png', 256],
  ['electron/assets/tray.png', 32],
]) {
  const path = join(ROOT, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, png(size, reactor))
  console.log(`wrote ${file} (${size}px)`)
}
