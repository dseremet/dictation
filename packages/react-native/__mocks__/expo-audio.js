/* Fake expo-audio recorder for jest. Tests drive it through `__audio`. */
const React = require('react')

const IOSOutputFormat = { MPEG4AAC: 'aac ' }
const AudioQuality = { MIN: 0, LOW: 32, MEDIUM: 64, HIGH: 96, MAX: 127 }
const RecordingPresets = { HIGH_QUALITY: {}, LOW_QUALITY: {} }

class FakeAudioRecorder {
  constructor(options) {
    this.options = options
    this.id = 1
    this.uri = null
    this.isRecording = false
    this.durationMillis = 0
    this.metering = -160
    this.listeners = new Set()
    this.prepareToRecordAsync = jest.fn(async () => {
      this.prepared = true
    })
    this.record = jest.fn(() => {
      this.isRecording = true
    })
    this.pause = jest.fn(() => {
      this.isRecording = false
    })
    this.stop = jest.fn(async () => {
      this.isRecording = false
      this.uri = this.uri || 'file:///tmp/recording-1.m4a'
    })
    this.getStatus = jest.fn(() => ({
      canRecord: true,
      isRecording: this.isRecording,
      durationMillis: this.durationMillis,
      mediaServicesDidReset: false,
      metering: this.metering,
      url: this.uri,
    }))
  }
  addListener(_event, handler) {
    this.listeners.add(handler)
    return { remove: () => this.listeners.delete(handler) }
  }
  __emitStatus(status) {
    for (const l of Array.from(this.listeners)) l({ id: this.id, isFinished: false, hasError: false, error: null, url: this.uri, ...status })
  }
}

const __audio = {
  recorder: null,
  permission: { granted: true, status: 'granted', canAskAgain: true },
  reset() {
    __audio.recorder = null
    __audio.permission = { granted: true, status: 'granted', canAskAgain: true }
  },
}

function useAudioRecorder(options, statusListener) {
  const ref = React.useRef(null)
  if (!ref.current) {
    ref.current = new FakeAudioRecorder(options)
    __audio.recorder = ref.current
  }
  const recorder = ref.current
  React.useEffect(() => {
    const sub = recorder.addListener('recordingStatusUpdate', (status) => statusListener?.(status))
    return () => sub.remove()
  }, [recorder.id])
  return recorder
}

const requestRecordingPermissionsAsync = jest.fn(async () => __audio.permission)
const getRecordingPermissionsAsync = jest.fn(async () => __audio.permission)
const setAudioModeAsync = jest.fn(async () => undefined)

module.exports = {
  __audio,
  FakeAudioRecorder,
  IOSOutputFormat,
  AudioQuality,
  RecordingPresets,
  useAudioRecorder,
  requestRecordingPermissionsAsync,
  getRecordingPermissionsAsync,
  setAudioModeAsync,
}
