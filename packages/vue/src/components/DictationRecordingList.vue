<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { describeError, unwrapRecording } from '../http'
import { formatDuration, resolveMessages } from '../messages'
import type { DictationEndpoints, DictationMessages, HttpAdapter, Recording } from '../types'
import { finalTextOf } from '../useDictation'

const props = withDefaults(
  defineProps<{
    recordings: Recording[]
    http: HttpAdapter
    endpoints: DictationEndpoints
    /** Show correct / delete / retry controls. */
    canEdit?: boolean
    messages?: Partial<DictationMessages>
    /** Replace `window.confirm` for deletion. */
    confirm?: (message: string) => boolean | Promise<boolean>
  }>(),
  { canEdit: true, messages: undefined, confirm: undefined },
)

const emit = defineEmits<{
  insert: [payload: { recording: Recording; text: string }]
  updated: [recording: Recording]
  deleted: [recording: Recording]
  retried: [recording: Recording]
  error: [payload: { recording: Recording; action: 'update' | 'delete' | 'retry'; error: unknown }]
}>()

const msgs = computed(() => resolveMessages(props.messages))

/** Server responses layered over the parent's array so the UI updates even if the parent does not. */
const overrides = reactive(new Map<string, Recording>())
const removed = reactive(new Set<string>())
const busy = reactive(new Set<string>())
const editing = ref<string | null>(null)
const draft = ref('')

const items = computed(() =>
  props.recordings.filter((r) => !removed.has(r.uuid)).map((r) => ({ ...r, ...(overrides.get(r.uuid) ?? {}) })),
)

function textOf(recording: Recording): string {
  return finalTextOf(recording)
}

function statusLabel(recording: Recording): string {
  switch (recording.status) {
    case 'pending':
      return msgs.value.pending
    case 'processing':
      return msgs.value.processing
    case 'failed':
      return msgs.value.failed
    default:
      return msgs.value.done
  }
}

function audioSrc(recording: Recording): string {
  return recording.audio_url || props.endpoints.audio(recording.uuid)
}

function createdLabel(recording: Recording): string {
  if (!recording.created_at) return ''
  const date = new Date(recording.created_at)
  return Number.isNaN(date.getTime()) ? recording.created_at : date.toLocaleString()
}

function insert(recording: Recording): void {
  emit('insert', { recording, text: textOf(recording) })
}

function startEdit(recording: Recording): void {
  editing.value = recording.uuid
  draft.value = textOf(recording)
}

function cancelEdit(): void {
  editing.value = null
  draft.value = ''
}

async function saveEdit(recording: Recording): Promise<void> {
  if (busy.has(recording.uuid)) return
  busy.add(recording.uuid)
  try {
    const response = await props.http.patch(props.endpoints.update(recording.uuid), { transcript_corrected: draft.value })
    const updated = unwrapRecording<Recording>(response.data) ?? {
      ...recording,
      transcript_corrected: draft.value,
      final_text: draft.value,
    }
    overrides.set(recording.uuid, updated)
    cancelEdit()
    emit('updated', updated)
  } catch (error) {
    emit('error', { recording, action: 'update', error })
  } finally {
    busy.delete(recording.uuid)
  }
}

async function remove(recording: Recording): Promise<void> {
  if (busy.has(recording.uuid)) return
  const ask = props.confirm ?? ((message: string) => (typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(message) : true))
  if (!(await ask(msgs.value.confirmDelete))) return
  busy.add(recording.uuid)
  try {
    await props.http.delete(props.endpoints.destroy(recording.uuid))
    removed.add(recording.uuid)
    if (editing.value === recording.uuid) cancelEdit()
    emit('deleted', recording)
  } catch (error) {
    emit('error', { recording, action: 'delete', error })
  } finally {
    busy.delete(recording.uuid)
  }
}

async function retry(recording: Recording): Promise<void> {
  if (busy.has(recording.uuid) || !props.endpoints.retry) return
  busy.add(recording.uuid)
  try {
    const response = await props.http.post(props.endpoints.retry(recording.uuid), null, { headers: { Accept: 'application/json' } })
    const updated = unwrapRecording<Recording>(response.data) ?? { ...recording, status: 'pending' as const, error: null }
    overrides.set(recording.uuid, updated)
    emit('retried', updated)
  } catch (error) {
    emit('error', { recording, action: 'retry', error })
  } finally {
    busy.delete(recording.uuid)
  }
}

defineExpose({ describeError })
</script>

<template>
  <div class="dct-list">
    <p v-if="items.length === 0" class="dct-list__empty">
      <slot name="empty">{{ msgs.noRecordings }}</slot>
    </p>

    <article
      v-for="recording in items"
      :key="recording.uuid"
      class="dct-item"
      :class="[`dct-item--${recording.status}`, { 'dct-item--busy': busy.has(recording.uuid) }]"
      :data-uuid="recording.uuid"
    >
      <header class="dct-item__head">
        <span class="dct-pill" :class="`dct-pill--${recording.status}`">
          <span v-if="recording.status === 'processing'" class="dct-pill__spinner" aria-hidden="true" />
          {{ statusLabel(recording) }}
        </span>
        <span v-if="recording.duration_ms" class="dct-item__meta">{{ formatDuration(recording.duration_ms) }}</span>
        <span v-if="recording.detected_language" class="dct-item__meta">{{ recording.detected_language }}</span>
        <span v-if="recording.created_at" class="dct-item__meta dct-item__date">{{ createdLabel(recording) }}</span>
        <slot name="meta" :recording="recording" />
      </header>

      <audio class="dct-item__audio" controls preload="none" :src="audioSrc(recording)" :aria-label="msgs.recordingLabel" />

      <p v-if="recording.status === 'failed' && recording.error" class="dct-item__error">{{ recording.error }}</p>

      <div v-if="editing === recording.uuid" class="dct-item__edit">
        <textarea v-model="draft" class="dct-textarea" rows="4" :disabled="busy.has(recording.uuid)" />
        <div class="dct-item__actions">
          <button type="button" class="dct-btn dct-btn--primary" :disabled="busy.has(recording.uuid)" @click="saveEdit(recording)">
            {{ msgs.save }}
          </button>
          <button type="button" class="dct-btn" :disabled="busy.has(recording.uuid)" @click="cancelEdit">{{ msgs.cancel }}</button>
        </div>
      </div>

      <template v-else>
        <p v-if="textOf(recording)" class="dct-item__text">{{ textOf(recording) }}</p>
        <div class="dct-item__actions">
          <button
            v-if="recording.status === 'done' && textOf(recording)"
            type="button"
            class="dct-btn dct-btn--primary dct-btn--insert"
            @click="insert(recording)"
          >
            {{ msgs.insert }}
          </button>
          <button
            v-if="canEdit && recording.status === 'done'"
            type="button"
            class="dct-btn dct-btn--correct"
            @click="startEdit(recording)"
          >
            {{ msgs.correct }}
          </button>
          <button
            v-if="canEdit && recording.status === 'failed' && endpoints.retry"
            type="button"
            class="dct-btn dct-btn--retry"
            :disabled="busy.has(recording.uuid)"
            @click="retry(recording)"
          >
            {{ msgs.retry }}
          </button>
          <button
            v-if="canEdit"
            type="button"
            class="dct-btn dct-btn--danger dct-btn--delete"
            :disabled="busy.has(recording.uuid)"
            @click="remove(recording)"
          >
            {{ msgs.delete }}
          </button>
          <slot name="actions" :recording="recording" :text="textOf(recording)" />
        </div>
      </template>
    </article>
  </div>
</template>

<style scoped>
.dct-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  font-family: var(--dct-font, inherit);
  font-size: var(--dct-list-size, 0.875rem);
  color: inherit;
}
.dct-list__empty {
  margin: 0;
  color: var(--dct-muted, #6b7280);
}
.dct-item {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--dct-border, rgba(127, 127, 127, 0.3));
  border-radius: var(--dct-radius, 8px);
  background: var(--dct-item-bg, transparent);
}
.dct-item--busy {
  opacity: 0.7;
}
.dct-item__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.dct-item__meta {
  color: var(--dct-muted, #6b7280);
  font-size: 0.85em;
}
.dct-item__date {
  margin-left: auto;
}
.dct-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
  padding: 0.1em 0.6em;
  border-radius: 999px;
  font-size: 0.8em;
  font-weight: 600;
  color: var(--dct-pill-color, var(--dct-accent, #2563eb));
  background: var(--dct-pill-bg, color-mix(in srgb, var(--dct-accent, #2563eb) 12%, transparent));
}
.dct-pill--pending,
.dct-pill--processing {
  --dct-pill-color: var(--dct-warning, #b45309);
  --dct-pill-bg: color-mix(in srgb, var(--dct-warning, #b45309) 12%, transparent);
}
.dct-pill--failed {
  --dct-pill-color: var(--dct-danger, #dc2626);
  --dct-pill-bg: color-mix(in srgb, var(--dct-danger, #dc2626) 12%, transparent);
}
.dct-pill--done {
  --dct-pill-color: var(--dct-success, #15803d);
  --dct-pill-bg: color-mix(in srgb, var(--dct-success, #15803d) 12%, transparent);
}
.dct-pill__spinner {
  width: 0.75em;
  height: 0.75em;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-right-color: transparent;
  animation: dct-spin 0.8s linear infinite;
}
.dct-item__audio {
  width: 100%;
  max-width: 100%;
  height: 2.25rem;
}
.dct-item__text {
  margin: 0;
  white-space: pre-wrap;
  line-height: 1.45;
}
.dct-item__error {
  margin: 0;
  color: var(--dct-danger, #dc2626);
  font-size: 0.85em;
}
.dct-item__edit {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.dct-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 0.5rem;
  font: inherit;
  line-height: 1.45;
  border: 1px solid var(--dct-border, rgba(127, 127, 127, 0.3));
  border-radius: var(--dct-radius, 8px);
  background: var(--dct-input-bg, transparent);
  color: inherit;
  resize: vertical;
}
.dct-textarea:focus-visible {
  outline: 2px solid var(--dct-accent, #2563eb);
  outline-offset: 1px;
}
.dct-item__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.dct-btn {
  padding: 0.3em 0.7em;
  font: inherit;
  font-size: 0.9em;
  line-height: 1.2;
  color: var(--dct-btn-color, inherit);
  background: transparent;
  border: 1px solid var(--dct-border, rgba(127, 127, 127, 0.4));
  border-radius: var(--dct-radius, 8px);
  cursor: pointer;
}
.dct-btn:hover:not(:disabled) {
  background: color-mix(in srgb, currentColor 8%, transparent);
}
.dct-btn:focus-visible {
  outline: 2px solid var(--dct-accent, #2563eb);
  outline-offset: 2px;
}
.dct-btn:disabled {
  cursor: default;
  opacity: 0.6;
}
.dct-btn--primary {
  color: #fff;
  background: var(--dct-accent, #2563eb);
  border-color: var(--dct-accent, #2563eb);
}
.dct-btn--primary:hover:not(:disabled) {
  background: var(--dct-accent, #2563eb);
  filter: brightness(0.93);
}
.dct-btn--danger {
  color: var(--dct-danger, #dc2626);
  border-color: color-mix(in srgb, var(--dct-danger, #dc2626) 50%, transparent);
}
@keyframes dct-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
