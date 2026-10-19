import type { DictationError, DictationMessages, RecorderError } from './types'

/** Bosnian defaults. Override any key through the `messages` prop/option. */
export const defaultMessages: DictationMessages = {
  start: 'Diktiraj',
  stop: 'Završi',
  requesting: 'Pristup mikrofonu…',
  recording: 'Snimanje…',
  paused: 'Pauzirano',
  uploading: 'Slanje…',
  transcribing: 'Prepisujem…',
  done: 'Prepisano',
  failed: 'Prepis nije uspio',
  retry: 'Pokušaj ponovo',
  insert: 'Ubaci u polje',
  correct: 'Ispravi',
  save: 'Sačuvaj',
  cancel: 'Odustani',
  delete: 'Obriši',
  confirmDelete: 'Obrisati snimak?',
  permissionDenied: 'Pristup mikrofonu je odbijen.',
  unsupported: 'Snimanje nije podržano na ovom uređaju.',
  busy: 'Mikrofon je zauzet.',
  interrupted: 'Snimanje je prekinuto.',
  tooLong: 'Snimak je predug.',
  empty: 'Snimak je prazan.',
  uploadFailed: 'Slanje snimka nije uspjelo.',
  timeout: 'Obrada traje predugo. Pokušajte ponovo kasnije.',
  pending: 'Čeka obradu',
  processing: 'Obrada…',
  noRecordings: 'Nema snimaka.',
  recordingLabel: 'Snimak',
}

export function resolveMessages(...overrides: Array<Partial<DictationMessages> | undefined>): DictationMessages {
  return Object.assign({}, defaultMessages, ...overrides.map((o) => o ?? {}))
}

/** Human text for an error, localized by code with the raw message as fallback. */
export function errorText(error: RecorderError | DictationError | null | undefined, messages: DictationMessages = defaultMessages): string {
  if (!error) return ''
  switch (error.code) {
    case 'permission_denied':
      return messages.permissionDenied
    case 'unsupported':
      return messages.unsupported
    case 'busy':
      return messages.busy
    case 'interrupted':
      return messages.interrupted
    case 'too_long':
      return messages.tooLong
    case 'empty':
      return messages.empty
    case 'upload_failed':
      return messages.uploadFailed
    case 'timeout':
      return messages.timeout
    case 'transcription_failed':
    case 'poll_failed':
    case 'retry_failed':
      return error.message || messages.failed
    default:
      return error.message || messages.failed
  }
}

/** mm:ss for a duration in ms. */
export function formatDuration(ms: number | null | undefined): string {
  const total = Math.max(0, Math.floor((ms ?? 0) / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
