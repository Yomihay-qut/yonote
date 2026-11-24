import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installNativeNavigation, registerBackHandler } from './native'

const { hide, flush, minimize, addListener } = vi.hoisted(() => ({
  hide: vi.fn(),
  flush: vi.fn(),
  minimize: vi.fn(),
  addListener: vi.fn(),
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true },
  registerPlugin: () => ({ hide }),
}))
vi.mock('@capacitor/app', () => ({ App: { addListener, minimizeApp: minimize } }))
vi.mock('./buffered-save', () => ({ flushEdits: flush }))

class Editable {
  isContentEditable = true
  blur = vi.fn()
}

let back: (event: { canGoBack: boolean }) => Promise<void>
let dispose: () => void
const pageBack = vi.fn()
let removePage: () => void
let focus: { activeElement: Editable | null }

beforeEach(async () => {
  vi.resetAllMocks()
  hide.mockResolvedValue({ handled: false })
  focus = Object.assign(new EventTarget(), { activeElement: null })
  vi.stubGlobal('document', focus)
  vi.stubGlobal('HTMLElement', Editable)
  addListener.mockImplementation(async (event, handler) => {
    if (event === 'backButton') back = handler
    return { remove: async () => {} }
  })
  removePage = registerBackHandler('page', pageBack)
  dispose = installNativeNavigation()
  await vi.waitFor(() => expect(addListener).toHaveBeenCalledWith('backButton', expect.any(Function)))
})

afterEach(() => {
  dispose()
  removePage()
  vi.unstubAllGlobals()
})

describe('Android back', () => {
  it('consumes the gesture at the keyboard before asking the editor to close', async () => {
    hide.mockResolvedValue({ handled: true })
    pageBack.mockReturnValue(true)
    await back({ canGoBack: false })
    expect(hide).toHaveBeenCalledWith({ onlyIfVisible: true })
    expect(pageBack).not.toHaveBeenCalled()
    expect(minimize).not.toHaveBeenCalled()
    hide.mockResolvedValue({ handled: false })
    await back({ canGoBack: false })
    expect(pageBack).toHaveBeenCalledTimes(1)
    expect(minimize).not.toHaveBeenCalled()
  })

  it('preserves a focused editor at the root even when IME visibility is unavailable', async () => {
    const editor = new Editable()
    focus.activeElement = editor
    await back({ canGoBack: false })
    expect(editor.blur).toHaveBeenCalledTimes(1)
    expect(hide).toHaveBeenCalledTimes(2)
    expect(minimize).not.toHaveBeenCalled()
  })

  it('flushes edits before sending the idle root task to the background', async () => {
    await back({ canGoBack: false })
    expect(flush).toHaveBeenCalledBefore(minimize)
  })
})
