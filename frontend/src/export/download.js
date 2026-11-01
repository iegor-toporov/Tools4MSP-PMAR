/** Download a text as a file. A Blob and not a `data:` URI: the files can be large. */
export function saveText(text, filename, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  Object.assign(document.createElement('a'), { href: url, download: filename }).click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Download bytes (e.g. a GeoTIFF) as a file. */
export function saveBytes(bytes, filename, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type }))
  Object.assign(document.createElement('a'), { href: url, download: filename }).click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Base64 (as the GeoTIFFs arrive from the backend) → bytes. */
export function base64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
