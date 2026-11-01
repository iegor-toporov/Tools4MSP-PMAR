/**
 * Saving of the analysis panel in IndexedDB, in this browser.
 *
 * IndexedDB and not localStorage: the analyses carry their data (rasters, networks)
 * and easily exceed the ~5 MB of localStorage. Every access is guarded: in a private
 * window, with site data blocked or the quota full, the app keeps working in memory
 * only.
 *
 * What is saved and how it is read back: persistedState.js.
 */

const DB_NAME = 'dto-pmar'
const STORE   = 'state'
const KEY     = 'analyses'

let dbPromise = null

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror   = () => reject(req.error)
      req.onblocked = () => reject(new Error('IndexedDB blocked'))
    }).catch(err => { dbPromise = null; throw err })
  }
  return dbPromise
}

function run(mode, op) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, mode)
    const req = op(tx.objectStore(STORE))
    tx.oncomplete = () => resolve(req.result)
    tx.onerror    = () => reject(tx.error)
    tx.onabort    = () => reject(tx.error)
  }))
}

/** The saved state, or null if there is none or IndexedDB is not available. */
export async function loadState() {
  try {
    return (await run('readonly', store => store.get(KEY))) ?? null
  } catch (err) {
    console.warn('[analysesStore] read failed:', err)
    return null
  }
}

/** Save the state; false if it was not possible (quota, no IndexedDB…). */
export async function saveState(value) {
  try {
    await run('readwrite', store => store.put(value, KEY))
    return true
  } catch (err) {
    console.warn('[analysesStore] save failed:', err)
    return false
  }
}
