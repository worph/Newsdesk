import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App'
import './index.css'
// Imported for its side effect: the listener has to exist before Chrome fires
// `beforeinstallprompt`, which is well before any component mounts.
import './install'
import { registerServiceWorker } from './push'

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)

// Install and push only — see web/public/sw.js. Registered on load so it never
// delays the first render.
window.addEventListener('load', () => void registerServiceWorker())
