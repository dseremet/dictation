import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'
import { deleteAsync, readAsStringAsync } from 'expo-file-system/legacy'
import { DEFAULT_MAX_DURATION_MS, buildDeliveryScript, buildInjectedScript } from '@ditactic/dictation-protocol'
import { createBridgeController, type BridgeController, type BridgeEvent } from './bridgeController'
import { useDictationRecorder, type DictationRecorder } from './useDictationRecorder'
import { RECORDING_MIME, type BridgeRecorder, type RecorderState } from './types'

/** The part of a `react-native-webview` ref the bridge needs. */
export interface WebViewLike {
  injectJavaScript(script: string): void
}

/** Shape of the `onMessage` event (`WebViewMessageEvent`), kept structural so
 * `react-native-webview` is not a hard dependency. */
export interface WebViewMessageLike {
  nativeEvent: { data: string }
}

export interface UseDictationBridgeOptions {
  webViewRef: RefObject<WebViewLike | null>
  /** Hard limit advertised to the page. Default 10 minutes. */
  maxDurationMs?: number
  /** Called for every bridge message in both directions (debug logging). */
  onEvent?: (event: BridgeEvent) => void
  /** Receives WebView messages that are not dictation messages. */
  onMessage?: (event: WebViewMessageLike) => void
  /** Forwarded after `dictation:ready` was sent. */
  onLoadEnd?: (event: unknown) => void
  /** Interval of `dictation:status` messages. Default 500 ms. */
  statusIntervalMs?: number
  /** How often the native recorder is polled for duration/level. Default 250 ms. */
  pollIntervalMs?: number
}

export interface DictationBridge {
  /** Spread onto `<WebView>`: publishes the bridge marker before the page runs. */
  injectedJavaScriptBeforeContentLoaded: string
  /** Spread onto `<WebView>`; non-dictation messages go to `options.onMessage`. */
  onMessage: (event: WebViewMessageLike) => void
  /** Spread onto `<WebView>`; sends `dictation:ready` when the page loaded. */
  onLoadEnd: (event: unknown) => void
  isRecording: boolean
  state: RecorderState
  durationMs: number
  level: number
  recorder: DictationRecorder
  controller: BridgeController
}

/**
 * Native side of the dictation bridge: lets a `@ditactic/dictation-vue` page
 * inside a WebView record through the device microphone via expo-audio and
 * receive the file as base64 chunks.
 */
export function useDictationBridge(options: UseDictationBridgeOptions): DictationBridge {
  const { webViewRef, maxDurationMs = DEFAULT_MAX_DURATION_MS, statusIntervalMs = 500, pollIntervalMs } = options

  const optionsRef = useRef(options)
  optionsRef.current = options
  const controllerRef = useRef<BridgeController | null>(null)

  const recorder = useDictationRecorder({
    maxDurationMs,
    pollIntervalMs,
    onAutoStop: (result) => void controllerRef.current?.notifyStopped(result, 'too_long'),
    onInterrupted: (result, error) => {
      if (result) void controllerRef.current?.notifyStopped(result, 'interrupted')
      else controllerRef.current?.notifyError(error.code, error.message)
    },
  })
  const recorderRef = useRef(recorder)
  recorderRef.current = recorder

  const adapter = useMemo<BridgeRecorder>(
    () => ({
      start: (o) => recorderRef.current.start(o),
      pause: () => recorderRef.current.pause(),
      resume: () => recorderRef.current.resume(),
      stop: () => recorderRef.current.stop(),
      getStatus: () => recorderRef.current.getStatus(),
    }),
    [],
  )

  const controller = useMemo(
    () =>
      createBridgeController({
        recorder: adapter,
        maxDurationMs,
        statusIntervalMs,
        mime: RECORDING_MIME,
        deliver: (message) => {
          webViewRef.current?.injectJavaScript(buildDeliveryScript(message))
        },
        readBase64: (uri) => readAsStringAsync(uri, { encoding: 'base64' }),
        deleteFile: (uri) => deleteAsync(uri, { idempotent: true }),
        onEvent: (event) => optionsRef.current.onEvent?.(event),
      }),
    [adapter, maxDurationMs, statusIntervalMs, webViewRef],
  )
  controllerRef.current = controller

  useEffect(() => {
    return () => {
      void controller.dispose()
    }
  }, [controller])

  const injectedJavaScriptBeforeContentLoaded = useMemo(
    () => buildInjectedScript({ record: true, maxDurationMs, mime: RECORDING_MIME }),
    [maxDurationMs],
  )

  const onMessage = useCallback(
    (event: WebViewMessageLike) => {
      const handled = controller.handleMessage(event?.nativeEvent?.data)
      if (!handled) optionsRef.current.onMessage?.(event)
    },
    [controller],
  )

  const onLoadEnd = useCallback(
    (event: unknown) => {
      controller.onPageLoaded()
      optionsRef.current.onLoadEnd?.(event)
    },
    [controller],
  )

  return {
    injectedJavaScriptBeforeContentLoaded,
    onMessage,
    onLoadEnd,
    isRecording: recorder.state === 'recording' || recorder.state === 'paused',
    state: recorder.state,
    durationMs: recorder.durationMs,
    level: recorder.level,
    recorder,
    controller,
  }
}
