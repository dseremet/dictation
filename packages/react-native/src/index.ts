export { useDictationRecorder } from './useDictationRecorder'
export type { UseDictationRecorderOptions, DictationRecorder } from './useDictationRecorder'

export { useDictationBridge } from './useDictationBridge'
export type { UseDictationBridgeOptions, DictationBridge, WebViewLike, WebViewMessageLike } from './useDictationBridge'

export { createBridgeController } from './bridgeController'
export type { BridgeController, BridgeControllerOptions, BridgeEvent } from './bridgeController'

export { uploadRecording, flattenFields } from './uploadRecording'
export type { UploadRecordingOptions, UploadFields, UploadFieldValue } from './uploadRecording'

export { DictationButton } from './DictationButton'
export type { DictationButtonProps } from './DictationButton'

export { DICTATION_RECORDING_OPTIONS } from './recordingOptions'
export { dbToLevel, formatDuration, base64ByteLength } from './level'
export { RECORDING_MIME, DictationRecorderError, toDictationError } from './types'
export type { RecorderState, RecordingResult, DictationError, RecorderStatus, BridgeRecorder, HttpClient } from './types'

export {
  CHUNK_SIZE,
  DEFAULT_MAX_DURATION_MS,
  ErrorCodes,
  PROTOCOL_VERSION,
  buildDeliveryScript,
  buildInjectedScript,
  chunkBase64,
  parseMessage,
} from '@ditactic/dictation-protocol'
export type { ErrorCode, NativeToWebMessage, WebToNativeMessage, BridgeCapabilities } from '@ditactic/dictation-protocol'
