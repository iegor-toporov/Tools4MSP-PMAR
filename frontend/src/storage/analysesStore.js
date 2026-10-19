/**
 * Salvataggio del pannello delle analisi in IndexedDB, in questo browser.
 *
 * IndexedDB e non localStorage: le analisi portano i loro dati (raster, reti) e
 * superano facilmente i ~5 MB di localStorage. Ogni accesso è protetto: in una
 * finestra privata, con i dati del sito bloccati o a quota piena, l'app continua
 * a funzionare in memoria, come prima di questa persistenza.
 *
 * Cosa si salva e come lo si rilegge: persistedState.js.
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

/** Lo stato salvato, o null se non c'è o IndexedDB non è disponibile. */
export async function loadState() {
  try {
    return (await run('readonly', store => store.get(KEY))) ?? null
  } catch (err) {
    console.warn('[analysesStore] lettura non riuscita:', err)
    return null
  }
}

/** Salva lo stato; false se non è stato possibile (quota, IndexedDB assente…). */
export async function saveState(value) {
  try {
    await run('readwrite', store => store.put(value, KEY))
    return true
  } catch (err) {
    console.warn('[analysesStore] salvataggio non riuscito:', err)
    return false
  }
}
