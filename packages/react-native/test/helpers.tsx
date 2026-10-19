import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { createElement, type ReactElement } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// React 19 logs a one-line deprecation for react-test-renderer; keep test output readable.
const originalConsoleError = console.error
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('react-test-renderer is deprecated')) return
  originalConsoleError(...args)
}

const mounted = new Set<ReactTestRenderer>()
/** Unmount everything a test left behind so leaked intervals cannot keep jest alive. */
export function cleanup(): void {
  for (const renderer of Array.from(mounted)) {
    try {
      act(() => renderer.unmount())
    } catch {
      // already unmounted
    }
  }
  mounted.clear()
}
afterEach(cleanup)

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Run an async action inside act() and capture its rejection. A promise that
 * rejects out of act() leaves React's act scope open in React 19, which breaks
 * every later render in the test file.
 */
export async function actCatch<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  let outcome: { value?: T; error?: unknown } = {}
  await act(async () => {
    try {
      outcome = { value: await fn() }
    } catch (error) {
      outcome = { error }
    }
  })
  return outcome
}

/** Wait for pending promises and timers inside React's act(). */
export const flush = (ms = 0) => act(() => sleep(ms))

export function renderHook<T>(useHook: () => T): { result: { current: T }; unmount: () => void; renderer: ReactTestRenderer } {
  const result = { current: undefined as unknown as T }
  function Probe() {
    result.current = useHook()
    return null
  }
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(createElement(Probe))
  })
  mounted.add(renderer)
  return {
    result,
    renderer,
    unmount: () => {
      mounted.delete(renderer)
      act(() => renderer.unmount())
    },
  }
}

export function render(element: ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(element)
  })
  mounted.add(renderer)
  return renderer
}

export { act }
