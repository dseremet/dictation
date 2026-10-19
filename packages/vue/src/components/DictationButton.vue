<script setup lang="ts">
import { computed, watch } from 'vue'
import { errorText, formatDuration, resolveMessages } from '../messages'
import { injectDictation } from '../provide'
import type { DictationError, DictationMessages, DictationPhase, Recording, UseDictationOptions } from '../types'
import { useDictation } from '../useDictation'
import DictationLevelMeter from './DictationLevelMeter.vue'

const props = withDefaults(
  defineProps<{
    /** `useDictation` options. Omit when a parent called `provideDictation()`. */
    options?: UseDictationOptions
    size?: 'sm' | 'md' | 'lg'
    disabled?: boolean
    messages?: Partial<DictationMessages>
    /** Hide the text and show only the icon/timer. */
    showLabel?: boolean
  }>(),
  { options: undefined, size: 'md', disabled: false, messages: undefined, showLabel: true },
)

const emit = defineEmits<{
  transcript: [payload: { text: string; recording: Recording }]
  recording: [payload: { recording: Recording }]
  error: [error: DictationError]
  phase: [phase: DictationPhase]
}>()

const dictation = props.options ? useDictation(props.options) : injectDictation()
if (!dictation) {
  throw new Error('[dictation-vue] <DictationButton> needs an `options` prop or `provideDictation()` in a parent component.')
}

const { phase, recording, transcript, error, recorder, durationMs, level } = dictation
const msgs = computed(() => resolveMessages(dictation.options.messages, props.messages))

const isRecording = computed(() => phase.value === 'recording' && (recorder.state.value === 'recording' || recorder.state.value === 'paused'))
const isRequesting = computed(() => phase.value === 'recording' && !isRecording.value)
const isBusy = computed(() => phase.value === 'uploading' || phase.value === 'transcribing' || isRequesting.value)
const isFailed = computed(() => phase.value === 'failed')

const label = computed(() => {
  switch (phase.value) {
    case 'recording':
      return isRequesting.value ? msgs.value.requesting : recorder.state.value === 'paused' ? msgs.value.paused : msgs.value.stop
    case 'uploading':
      return msgs.value.uploading
    case 'transcribing':
      return msgs.value.transcribing
    case 'failed':
      return msgs.value.retry
    default:
      return msgs.value.start
  }
})

const title = computed(() => {
  if (isRecording.value) return msgs.value.recording
  if (isFailed.value) return errorText(error.value, msgs.value) || msgs.value.failed
  return label.value
})

const hint = computed(() => (isFailed.value ? errorText(error.value, msgs.value) || msgs.value.failed : ''))
const time = computed(() => formatDuration(durationMs.value))

function onClick(): void {
  if (props.disabled) return
  if (isRecording.value) {
    void dictation!.finish()
  } else if (isFailed.value) {
    void dictation!.retry()
  } else if (phase.value === 'idle' || phase.value === 'done') {
    void dictation!.start()
  }
}

let emittedUuid: string | null = null
watch(phase, (next) => {
  emit('phase', next)
  if (next === 'done' && recording.value) {
    emit('transcript', { text: transcript.value, recording: recording.value })
  }
  if (next === 'failed' && error.value) {
    emit('error', error.value)
  }
})
watch(recording, (next) => {
  if (next && next.uuid !== emittedUuid) {
    emittedUuid = next.uuid
    emit('recording', { recording: next })
  }
})

defineExpose({ dictation })
</script>

<template>
  <span class="dct-button-wrap" :class="[`dct-size-${size}`, `dct-phase-${phase}`]" :data-phase="phase">
    <button
      type="button"
      class="dct-button"
      :class="{
        'dct-button--recording': isRecording,
        'dct-button--busy': isBusy,
        'dct-button--failed': isFailed,
        'dct-button--icon-only': !showLabel,
      }"
      :disabled="disabled || (isBusy && !isRecording)"
      :aria-pressed="isRecording ? 'true' : 'false'"
      :aria-label="title"
      :aria-busy="isBusy ? 'true' : 'false'"
      :title="title"
      @click="onClick"
    >
      <span v-if="isRecording" class="dct-pulse" aria-hidden="true" />
      <span v-else-if="isBusy" class="dct-spinner" aria-hidden="true" />
      <span v-else-if="isFailed" class="dct-icon" aria-hidden="true">
        <slot name="failed-icon">
          <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 9v4" /><path d="M12 17h.01" />
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          </svg>
        </slot>
      </span>
      <span v-else class="dct-icon" aria-hidden="true">
        <slot name="icon">
          <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10a7 7 0 0 0 14 0" /><path d="M12 17v4" /><path d="M8 21h8" />
          </svg>
        </slot>
      </span>

      <span v-if="isRecording" class="dct-time" aria-live="off">{{ time }}</span>
      <DictationLevelMeter v-if="isRecording" :level="level" class="dct-button__meter" />
      <span v-if="showLabel" class="dct-label">{{ label }}</span>
    </button>
    <span v-if="hint" class="dct-hint" role="status">{{ hint }}</span>
  </span>
</template>

<style scoped>
.dct-button-wrap {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  font-family: var(--dct-font, inherit);
  --dct-button-pad: 0.4em 0.75em;
  --dct-button-size: 0.875rem;
}
.dct-size-sm {
  --dct-button-pad: 0.25em 0.55em;
  --dct-button-size: 0.75rem;
}
.dct-size-lg {
  --dct-button-pad: 0.55em 1em;
  --dct-button-size: 1rem;
}
.dct-button {
  display: inline-flex;
  align-items: center;
  gap: 0.45em;
  padding: var(--dct-button-pad);
  font: inherit;
  font-size: var(--dct-button-size);
  line-height: 1.2;
  color: var(--dct-button-color, var(--dct-accent, #2563eb));
  background: var(--dct-button-bg, transparent);
  border: 1px solid var(--dct-button-border, var(--dct-accent, #2563eb));
  border-radius: var(--dct-radius, 8px);
  cursor: pointer;
  transition:
    background-color 120ms ease,
    color 120ms ease,
    border-color 120ms ease;
}
.dct-button:hover:not(:disabled) {
  background: var(--dct-button-hover-bg, color-mix(in srgb, var(--dct-accent, #2563eb) 10%, transparent));
}
.dct-button:focus-visible {
  outline: 2px solid var(--dct-accent, #2563eb);
  outline-offset: 2px;
}
.dct-button:disabled {
  cursor: default;
  opacity: 0.7;
}
.dct-button--recording {
  color: var(--dct-recording-color, #fff);
  background: var(--dct-recording-bg, var(--dct-danger, #dc2626));
  border-color: var(--dct-recording-bg, var(--dct-danger, #dc2626));
}
.dct-button--recording:hover:not(:disabled) {
  background: var(--dct-recording-bg, var(--dct-danger, #dc2626));
  filter: brightness(0.95);
}
.dct-button--failed {
  color: var(--dct-danger, #dc2626);
  border-color: var(--dct-danger, #dc2626);
}
.dct-button--icon-only {
  padding: 0.45em;
}
.dct-icon {
  display: inline-flex;
  font-size: 1.15em;
}
.dct-pulse {
  width: 0.7em;
  height: 0.7em;
  border-radius: 50%;
  background: currentColor;
  animation: dct-pulse 1.2s ease-in-out infinite;
}
.dct-spinner {
  width: 0.9em;
  height: 0.9em;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-right-color: transparent;
  animation: dct-spin 0.8s linear infinite;
}
.dct-time {
  font-variant-numeric: tabular-nums;
  min-width: 3.2em;
}
.dct-button__meter {
  --dct-meter-on: currentColor;
  --dct-meter-off: color-mix(in srgb, currentColor 35%, transparent);
}
.dct-hint {
  font-size: 0.75rem;
  color: var(--dct-danger, #dc2626);
}
@keyframes dct-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.45;
    transform: scale(0.75);
  }
}
@keyframes dct-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .dct-pulse {
    animation: none;
  }
}
</style>
