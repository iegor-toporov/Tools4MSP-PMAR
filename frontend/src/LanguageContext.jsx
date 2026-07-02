import { createContext, useContext, useState } from 'react'
import { translations } from './i18n'

const LanguageContext = createContext()

export function LanguageProvider({ children }) {
  const [lang, setLang] = useState('en')
  const toggle = () => setLang(l => l === 'it' ? 'en' : 'it')
  return (
    <LanguageContext.Provider value={{ lang, t: translations[lang], toggle }}>
      {children}
    </LanguageContext.Provider>
  )
}

export const useLang = () => useContext(LanguageContext)
