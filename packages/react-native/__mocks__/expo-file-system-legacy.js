/* Fake expo-file-system/legacy for jest: an in-memory map of uri -> base64. */
const __files = new Map()

const readAsStringAsync = jest.fn(async (uri) => {
  if (!__files.has(uri)) throw new Error(`ENOENT: ${uri}`)
  return __files.get(uri)
})
const deleteAsync = jest.fn(async (uri, options) => {
  if (!__files.has(uri) && !(options && options.idempotent)) throw new Error(`ENOENT: ${uri}`)
  __files.delete(uri)
})
const getInfoAsync = jest.fn(async (uri) => {
  if (!__files.has(uri)) return { exists: false, isDirectory: false, uri }
  const base64 = __files.get(uri)
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return { exists: true, isDirectory: false, uri, size: Math.floor((base64.length * 3) / 4) - padding, modificationTime: 0 }
})

module.exports = { __files, readAsStringAsync, deleteAsync, getInfoAsync, EncodingType: { UTF8: 'utf8', Base64: 'base64' } }
