import { lazy, Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './style.css'
import './polish.css'
import './fluid.css'
import { Capacitor } from '@capacitor/core'

// Synchronously apply persisted theme/accent/motion before first React paint to prevent startup flash.
;(() => {
  try {
    const read = <T,>(k: string, fallback: T): T => {
      const raw = localStorage.getItem(k)
      return raw ? (JSON.parse(raw) ?? fallback) : fallback
    }
    const theme = read<string>('theme', 'system')
    const accent = read<string>('accent', '#e5bd42')
    const motion = read<boolean>('motion', true)
    const accents: Record<string, string> = {
      yellow: '#e9c13b',
      blue: '#81b6ff',
      green: '#82c7a5',
      purple: '#bd9cf3',
    }
    const resolved =
      theme === 'system'
        ? matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme
    document.documentElement.dataset.theme = resolved
    document.documentElement.style.setProperty(
      '--accent',
      accents[accent] || (accent.startsWith('#') ? accent : accents.yellow),
    )
    document.documentElement.dataset.motion = String(motion)
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', resolved === 'light' ? '#f9faf8' : '#0b0d0e')
  } catch {}
})()

// Native APKs & Tauri desktop load bundled assets directly. Only browser/PWA needs a service worker.
if (
  !Capacitor.isNativePlatform() &&
  !('__TAURI_INTERNALS__' in window) &&
  !import.meta.env.DEV &&
  'serviceWorker' in navigator
) {
  const register = () => {
    void navigator.serviceWorker
      .register('/sw.js')
      .catch((error) => console.warn('Offline cache', error))
  }
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}
const PublicNote = lazy(() => import('./PublicNote'))
const share = location.pathname.match(/^\/s\/([\w-]+)$/)
ReactDOM.createRoot(document.getElementById('root')!).render(
  share ? (
    <Suspense fallback={null}>
      <PublicNote token={share[1]} />
    </Suspense>
  ) : (
    <App />
  ),
)
