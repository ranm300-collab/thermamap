// reads the exported canopy/shade/heat grid from webdata/grid, chunk by chunk, cached
// no ui code in here on purpose, this gets reused for tap popups and route scoring later

let metaPromise = null
const chunkCache = new Map()

function loadMeta() {
  if (!metaPromise) metaPromise = fetch('webdata/grid/meta.json').then(res => res.json())
  return metaPromise
}

function maybeDecompress(buf) {
  const bytes = new Uint8Array(buf)
  // some hosts gunzip .gz files in flight, so only inflate it ourselves if it's actually still gzipped
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
    return new Response(stream).arrayBuffer().then(decompressed => new Uint8Array(decompressed))
  }
  return bytes
}

function loadChunk(col, row) {
  const key = `${col}_${row}`
  if (chunkCache.has(key)) return chunkCache.get(key)

  const promise = fetch(`webdata/grid/${col}_${row}.bin.gz`)
    .then(res => res.ok ? res.arrayBuffer() : null)
    .then(buf => buf ? maybeDecompress(buf) : null)
  chunkCache.set(key, promise)
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

function getGridCell(lat, lng) {
  return loadMeta().then(meta => {
    const col = Math.floor((lng - meta.origin.lng) / meta.cell_size_deg)
    const row = Math.floor((meta.origin.lat - lat) / meta.cell_size_deg)
    if (col < 0 || col >= meta.grid_width || row < 0 || row >= meta.grid_height) return null

    const chunkCol = Math.floor(col / meta.chunk_size_cells)
    const chunkRow = Math.floor(row / meta.chunk_size_cells)
    const localCol = col % meta.chunk_size_cells
    const localRow = row % meta.chunk_size_cells

    return loadChunk(chunkCol, chunkRow).then(bytes => {
      if (!bytes) return null
      return decodeCell(bytes, localRow, localCol, meta)
    })
  })
}
