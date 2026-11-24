import { debounce, type DebouncedFunc } from 'lodash-es'

// Coalesce input without reading the ProseMirror document on every keystroke.
// A maximum delay bounds continuous typing; navigation and visibility changes flush immediately.
const writers = new Set<BufferedSave>()
export class BufferedSave {
  private readonly scheduleFlush: DebouncedFunc<() => void>
  private pending = false
  private writing = 0
  private flight: Promise<void> = Promise.resolve()
  constructor(
    private write: () => Promise<void>,
    private onError: (error: unknown) => void,
    delay = 220,
    maxDelay = 800,
  ) {
    this.scheduleFlush = debounce(() => { void this.flush().catch(() => {}) }, delay, { maxWait: maxDelay })
    writers.add(this)
  }
  schedule() {
    this.pending = true
    this.scheduleFlush()
  }
  get hasPending() {
    return this.pending || this.writing > 0
  }
  flush() {
    this.scheduleFlush.cancel()
    if (this.pending) {
      this.pending = false
      // Start synchronously so an unmount cannot destroy the editor before its snapshot is read.
      // IndexedDB serializes the writes; flight tracks completion for navigation.
      this.writing++
      const next = this.write().finally(() => {
        this.writing--
      })
      this.flight = Promise.all([this.flight.catch(() => {}), next])
        .then(() => {})
        .catch((error) => {
          this.pending = true
          this.onError(error)
          throw error
        })
    }
    return this.flight
  }
  dispose() {
    const result = this.flush().catch(() => {})
    writers.delete(this)
    return result
  }
}
export async function flushEdits() {
  await Promise.all([...writers].map((writer) => writer.flush()))
}
