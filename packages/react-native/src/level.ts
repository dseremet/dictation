/**
 * Map a metering value in dBFS to a 0..1 level for a UI meter.
 *
 * expo-audio reports metering as dBFS in the range -160 (silence) .. 0 (full
 * scale). A linear map over the whole range is useless for a meter, because
 * normal speech sits around -30..-10 dB and room noise around -50 dB, so the
 * default floor is -60 dB: everything at or below it is 0 and 0 dB is 1.
 */
export function dbToLevel(db: number | null | undefined, floorDb: number = -60): number {
  if (db == null || !Number.isFinite(db)) return 0
  const clamped = Math.max(Math.min(db, 0), floorDb)
  return (clamped - floorDb) / -floorDb
}

/** Format milliseconds as `m:ss` (or `h:mm:ss` beyond an hour). */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const mmss = `${minutes}:${String(seconds).padStart(2, '0')}`
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : mmss
}

/** Decoded byte length of a base64 string (without decoding it). */
export function base64ByteLength(base64: string): number {
  if (!base64) return 0
  let padding = 0
  if (base64.endsWith('==')) padding = 2
  else if (base64.endsWith('=')) padding = 1
  return Math.floor((base64.length * 3) / 4) - padding
}
