import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import './index.css'
import App from './App.tsx'
import { ConnectClaude } from './ConnectClaude.tsx'

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

if (!publishableKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY — run `clerk env pull`.')
}

/* Claude's connector sends her to /?connect=… to approve it (Oct 19, 2026). */
const connectRequest = new URLSearchParams(window.location.search).get('connect')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClerkProvider
      publishableKey={publishableKey}
      appearance={{ variables: { colorPrimary: '#c03760' } }}
    >
      {connectRequest ? <ConnectClaude request={connectRequest} /> : <App />}
    </ClerkProvider>
  </StrictMode>,
)
