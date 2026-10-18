/** Scarica un testo come file. Blob e non `data:` URI: i file possono essere grandi. */
export function saveText(text, filename, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  Object.assign(document.createElement('a'), { href: url, download: filename }).click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
