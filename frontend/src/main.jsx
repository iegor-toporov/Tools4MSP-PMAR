import React from 'react'
import ReactDOM from 'react-dom/client'
import { MantineProvider, createTheme } from '@mantine/core'
import '@mantine/core/styles.css'
import App from './App'
import { LanguageProvider } from './LanguageContext'
import './index.css'

const theme = createTheme({
  primaryColor: 'blue',
  primaryShade: { light: 6, dark: 5 },
  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif',
  defaultRadius: 'md',
  colors: {
    blue: [
      '#e8f4ff',
      '#c8e6ff',
      '#99cfff',
      '#66b5ff',
      '#3d9eff',
      '#0a84ff',
      '#007aff',
      '#0062cc',
      '#004d9e',
      '#003575',
    ],
  },
})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="light">
      <LanguageProvider>
        <App />
      </LanguageProvider>
    </MantineProvider>
  </React.StrictMode>
)
