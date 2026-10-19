import { AudioQuality, IOSOutputFormat, type RecordingOptions } from 'expo-audio'

/**
 * Recording preset tuned for speech that is sent to a server-side ASR engine:
 * mono AAC at 16 kHz / 32 kbps in an M4A container. Roughly 1.5 MB per
 * 5 minutes. Whisper resamples to 16 kHz anyway, so a higher rate only costs
 * upload time. Metering is on so the UI can show an input level.
 */
export const DICTATION_RECORDING_OPTIONS: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 32000,
  isMeteringEnabled: true,
  android: {
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
  },
  ios: {
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.MEDIUM,
  },
  web: {
    mimeType: 'audio/mp4',
    bitsPerSecond: 32000,
  },
}
