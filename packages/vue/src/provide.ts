import { inject, provide, type InjectionKey } from 'vue'
import { useDictation, type UseDictationReturn } from './useDictation'
import type { UseDictationOptions } from './types'

export const DICTATION_KEY: InjectionKey<UseDictationReturn> = Symbol('dictation')

/** Create one dictation instance in a parent and share it with `<DictationButton>` children. */
export function provideDictation(options: UseDictationOptions): UseDictationReturn {
  const dictation = useDictation(options)
  provide(DICTATION_KEY, dictation)
  return dictation
}

export function injectDictation(): UseDictationReturn | undefined {
  return inject(DICTATION_KEY, undefined)
}
