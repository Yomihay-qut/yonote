import { Capacitor, SystemBars, SystemBarsStyle } from '@capacitor/core'
import { flushEdits } from './buffered-save'
import { hideKeyboard, hideVisibleKeyboard } from './input-motion'

type BackLayer = 'page' | 'editor' | 'gesture' | 'dialog' | 'menu'
type BackHandler = { layer: BackLayer; handle: () => boolean; owner?: HTMLElement }

const layers: BackLayer[] = ['menu', 'dialog', 'gesture', 'editor', 'page']
const backHandlers = new Set<BackHandler>()

export function registerBackHandler(layer: BackLayer, handle: () => boolean, owner?: HTMLElement) {
  const entry = { layer, handle, owner }
  backHandlers.add(entry)
  return () => { backHandlers.delete(entry) }
}

export function handleBack() {
  const handlers = [...backHandlers].reverse()
  const dialog = handlers.find((handler) =>
    handler.layer === 'dialog' && handler.owner instanceof HTMLDialogElement && handler.owner.open,
  )?.owner
  for (const layer of layers) {
    for (const entry of handlers) {
      if (entry.layer !== layer || (entry.owner && !entry.owner.isConnected)) continue
      if (dialog && (!entry.owner || !dialog.contains(entry.owner))) continue
      if (entry.handle()) return true
    }
  }
  return false
}

export function setSystemBarTheme(light: boolean) {
  if (Capacitor.isNativePlatform()) {
    void SystemBars.setStyle({ style: light ? SystemBarsStyle.Light : SystemBarsStyle.Dark }).catch(() => {})
  }
}

// Let the same close hierarchy handle Android's system back gesture.
export function installNativeNavigation() {
  const escape = (key: KeyboardEvent) => {
    if (key.key !== 'Escape' || key.isComposing || key.defaultPrevented) return
    if (handleBack()) key.preventDefault()
  }
  document.addEventListener('keydown', escape)
  if (Capacitor.getPlatform() !== 'android') return () => document.removeEventListener('keydown', escape)
  let disposed = false
  let navigating = false
  const handles: { remove: () => Promise<void> }[] = []
  void import('@capacitor/app')
    .then(async ({ App }) => {
      const back = await App.addListener('backButton', async ({ canGoBack }) => {
        if (disposed || navigating) return
        navigating = true
        try {
          if (await hideVisibleKeyboard() || disposed || handleBack()) return
          const input = document.activeElement
          // Some floating IMEs leave the WebView focused without reporting visible insets.
          if (input instanceof HTMLElement &&
            (input.isContentEditable || input.matches('input:read-write, textarea:read-write'))) {
            input.blur()
            await hideKeyboard()
            return
          }
          await flushEdits()
          if (disposed) return
          if (canGoBack) window.history.back()
          else await App.minimizeApp()
        } catch {
          // Stay in the app if edits could not be saved or the native call failed.
        } finally {
          navigating = false
        }
      })
      const state = await App.addListener('appStateChange', ({ isActive }) => {
        if (!isActive) void flushEdits().catch(() => {})
      })
      if (disposed) {
        await back.remove()
        await state.remove()
      } else handles.push(back, state)
    })
    .catch(() => {})
  return () => {
    document.removeEventListener('keydown', escape)
    disposed = true
    for (const handle of handles) void handle.remove()
  }
}
