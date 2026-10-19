// reads the exported canopy/shade/heat grid from webdata/grid, chunk by chunk, cached
// no ui code in here on purpose, this gets reused for tap popups and route scoring later

let metaPromise = null
const chunkCache = new Map()
const CHUNK_CACHE_MAX = 200 // each chunk's ~146kb decompressed, a long session walking the whole metro shouldn't just keep growing

function loadMeta() {
  if (!metaPromise) metaPromise = fetch('webdata/grid/meta.json').then(res => {
    if (!res.ok) throw new Error('grid meta bad status')
    return res.json()
  })
  return metaPromise
}

async function maybeDecompress(buf) {
  const bytes = new Uint8Array(buf)
  // some hosts gunzip .gz files in flight, so only inflate it ourselves if it's actually still gzipped
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
    const decompressed = await new Response(stream).arrayBuffer()
    return new Uint8Array(decompressed)
  }
  return bytes
}

function loadChunk(col, row) {
  const key = `${col}_${row}`
  if (chunkCache.has(key)) {
    const cached = chunkCache.get(key)
    chunkCache.delete(key)
    chunkCache.set(key, cached) // bump to most recently used, map keeps insertion order
    return cached
  }

  const promise = (async () => {
    const res = await fetch(`webdata/grid/${col}_${row}.bin.gz`)
    if (!res.ok) return null
    return maybeDecompress(await res.arrayBuffer())
  })()
  chunkCache.set(key, promise)
  if (chunkCache.size > CHUNK_CACHE_MAX) chunkCache.delete(chunkCache.keys().next().value)
  return promise
}

function decodeCell(bytes, localRow, localCol, meta) {
  const offset = (localRow * meta.chunk_size_cells + localCol) * meta.bytes_per_cell
  const canopyByte = bytes[offset]
  const anomByte = bytes[offset + meta.bytes_per_cell - 1]

  const shade = {}
  meta.hours.forEach((hour, i) => {
    const b = bytes[offset + 1 + i]
    shade[hour] = b === 255 ? null : b
  })

  return {
    canopy: canopyByte === 255 ? null : canopyByte,
    anomaly: anomByte === 255 ? null : anomByte - 30,
    shade: shade
  }
}

async function getGridCell(lat, lng) {
  const meta = await loadMeta()
  const col = Math.floor((lng - meta.origin.lng) / meta.cell_size_deg)
  const row = Math.floor((meta.origin.lat - lat) / meta.cell_size_deg)
  if (col < 0 || col >= meta.grid_width || row < 0 || row >= meta.grid_height) return null

  const chunkCol = Math.floor(col / meta.chunk_size_cells)
  const chunkRow = Math.floor(row / meta.chunk_size_cells)
  const localCol = col % meta.chunk_size_cells
  const localRow = row % meta.chunk_size_cells

  const bytes = await loadChunk(chunkCol, chunkRow)
  if (!bytes) return null
  return decodeCell(bytes, localRow, localCol, meta)
}

// same idea as getGridCell but for hundreds/thousands of points at once (route scoring),
// so we group by chunk first instead of letting loadChunk's own cache dedupe one at a time
async function getGridCells(points) {
  const meta = await loadMeta()
  const chunksNeeded = new Map()

  const located = points.map(p => {
    const col = Math.floor((p.lng - meta.origin.lng) / meta.cell_size_deg)
    const row = Math.floor((meta.origin.lat - p.lat) / meta.cell_size_deg)
    if (col < 0 || col >= meta.grid_width || row < 0 || row >= meta.grid_height) return null

    const chunkCol = Math.floor(col / meta.chunk_size_cells)
    const chunkRow = Math.floor(row / meta.chunk_size_cells)
    const key = `${chunkCol}_${chunkRow}`
    chunksNeeded.set(key, [chunkCol, chunkRow])
    return { key, localRow: row % meta.chunk_size_cells, localCol: col % meta.chunk_size_cells }
  })

  const keys = Array.from(chunksNeeded.keys())
  const loadedChunks = await Promise.all(keys.map(key => loadChunk(...chunksNeeded.get(key))))
  const bytesByKey = new Map(keys.map((key, i) => [key, loadedChunks[i]]))

  return located.map(loc => {
    if (!loc) return null
    const bytes = bytesByKey.get(loc.key)
    if (!bytes) return null
    return decodeCell(bytes, loc.localRow, loc.localCol, meta)
  })
}
