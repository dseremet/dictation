import { useCallback } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { formatDuration } from './level'
import { useDictationRecorder } from './useDictationRecorder'
import type { DictationError, RecordingResult } from './types'

export interface DictationButtonProps {
  onResult: (result: { uri: string; mime: string; durationMs: number; size: number; interrupted?: boolean }) => void
  onError?: (error: DictationError) => void
  style?: StyleProp<ViewStyle>
  colors?: { idle?: string; recording?: string; text?: string }
  labels?: { start?: string; stop?: string }
  maxDurationMs?: number
  disabled?: boolean
  /** Hide the level bar. */
  showLevel?: boolean
  testID?: string
}

const DEFAULT_COLORS = { idle: '#1f6feb', recording: '#d1242f', text: '#ffffff' }
const DEFAULT_LABELS = { start: 'Diktiraj', stop: 'Završi' }

/**
 * Minimal mic toggle for native screens: idle → recording (duration + level
 * bar) → `onResult({ uri, mime, durationMs })`. Upload it with `uploadRecording`.
 */
export function DictationButton(props: DictationButtonProps) {
  const { onResult, onError, style, maxDurationMs, disabled, showLevel = true, testID } = props
  const colors = { ...DEFAULT_COLORS, ...props.colors }
  const labels = { ...DEFAULT_LABELS, ...props.labels }

  const recorder = useDictationRecorder({
    maxDurationMs,
    onAutoStop: (result) => onResult(result),
    onInterrupted: (result, error) => {
      if (result) onResult(result)
      else onError?.(error)
    },
  })

  const onPress = useCallback(async () => {
    try {
      if (recorder.state === 'idle') {
        await recorder.start()
      } else if (recorder.state === 'recording' || recorder.state === 'paused') {
        const result: RecordingResult = await recorder.stop()
        onResult(result)
      }
    } catch (e) {
      const err = e as DictationError
      onError?.({ code: err.code ?? 'unknown', message: err.message ?? String(e) })
    }
  }, [recorder, onResult, onError])

  const active = recorder.state === 'recording' || recorder.state === 'paused'
  const busy = recorder.state === 'stopping'
  const background = active ? colors.recording : colors.idle

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled || busy, busy }}
      accessibilityLabel={active ? labels.stop : labels.start}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: background, opacity: pressed || disabled ? 0.8 : 1 }, style]}
    >
      <View style={styles.row}>
        {busy ? <ActivityIndicator color={colors.text} /> : <View style={[styles.dot, active ? styles.dotStop : styles.dotMic, { borderColor: colors.text, backgroundColor: active ? colors.text : 'transparent' }]} />}
        <Text style={[styles.label, { color: colors.text }]}>{active ? labels.stop : labels.start}</Text>
        {active ? <Text style={[styles.duration, { color: colors.text }]}>{formatDuration(recorder.durationMs)}</Text> : null}
      </View>
      {active && showLevel ? (
        <View style={styles.levelTrack}>
          <View style={[styles.levelFill, { width: `${Math.round(Math.min(1, Math.max(0, recorder.level)) * 100)}%`, backgroundColor: colors.text }]} />
        </View>
      ) : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: {
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    minWidth: 160,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  dot: {
    width: 14,
    height: 14,
    borderWidth: 2,
  },
  dotMic: {
    borderRadius: 7,
  },
  dotStop: {
    borderRadius: 3,
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
  },
  duration: {
    marginLeft: 'auto',
    fontVariant: ['tabular-nums'],
    fontSize: 15,
  },
  levelTrack: {
    marginTop: 8,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.3)',
    overflow: 'hidden',
  },
  levelFill: {
    height: 4,
    borderRadius: 2,
  },
})
