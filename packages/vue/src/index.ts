export { useRecorder, normalizeRecorderError } from './recorder/useRecorder'
export type { UseRecorderReturn } from './recorder/useRecorder'
export { MediaRecorderSource, DEFAULT_MIME_TYPES, pickMimeType, mapMediaError, isMediaRecorderSupported } from './recorder/mediaRecorderSource'
export { NativeBridgeSource, hasNativeBridge, getBridgeMarker } from './recorder/nativeBridgeSource'

export { useDictation, extensionForMime, finalTextOf, isTerminalStatus } from './useDictation'
export type { UseDictationReturn } from './useDictation'
export { provideDictation, injectDictation, DICTATION_KEY } from './provide'

export { axiosAdapter, fetchAdapter, HttpError, unwrapRecording, describeError } from './http'
export type { FetchAdapterOptions } from './http'

export { defaultMessages, resolveMessages, errorText, formatDuration } from './messages'

export { default as DictationButton } from './components/DictationButton.vue'
export { default as DictationRecordingList } from './components/DictationRecordingList.vue'
export { default as DictationLevelMeter } from './components/DictationLevelMeter.vue'

export type {
  RecorderState,
  RecorderError,
  RecorderErrorCode,
  RecorderResult,
  RecordingSource,
  SourceCallbacks,
  SourceFactory,
  SourceStartOptions,
  SourceStatus,
  MediaRecorderSourceOptions,
  NativeBridgeSourceOptions,
  UseRecorderOptions,
  HttpAdapter,
  HttpResponse,
  HttpRequestOptions,
  Recording,
  RecordingStatus,
  RecordableRef,
  DictationEndpoints,
  DictationPhase,
  DictationError,
  DictationErrorCode,
  DictationMessages,
  UseDictationOptions,
} from './types'
