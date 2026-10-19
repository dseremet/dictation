/* Type-only view of the test helpers exposed by the fakes in ../__mocks__. */
import type { AppStateStatus } from 'react-native'

declare module 'react-native' {
  interface AppStateStatic {
    __emit(next: AppStateStatus): void
    __listenerCount(): number
  }
}

declare module 'expo-audio' {
  interface FakeAudioRecorder {
    uri: string | null
    isRecording: boolean
    durationMillis: number
    metering: number
    prepareToRecordAsync: jest.Mock
    record: jest.Mock
    pause: jest.Mock
    stop: jest.Mock
    getStatus: jest.Mock
    __emitStatus(status: { isFinished?: boolean; hasError?: boolean; error?: string | null; url?: string | null }): void
  }
  export const __audio: {
    recorder: FakeAudioRecorder | null
    permission: { granted: boolean; status: string; canAskAgain: boolean }
    reset(): void
  }
}

declare module 'expo-file-system/legacy' {
  export const __files: Map<string, string>
}
