import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import DictationButton from '../src/components/DictationButton.vue'
import { provideDictation } from '../src/provide'
import { createFakeHttp, createFakeSource, endpoints, flush, makeRecording } from './helpers/fakes'

describe('DictationButton', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('walks through idle → recording → transcribing → done and emits transcript', async () => {
    const source = createFakeSource()
    const pending = makeRecording({ status: 'pending', final_text: null })
    const { http } = createFakeHttp({ post: pending, gets: [makeRecording({ final_text: 'Tekst nalaza.' })] })
    const wrapper = mount(DictationButton, {
      props: { options: { http, endpoints, recorder: { source: source.factory } } },
    })
    const button = wrapper.find('button')
    expect(button.text()).toBe('Diktiraj')
    expect(wrapper.attributes('data-phase')).toBe('idle')

    await button.trigger('click')
    await flush(4)
    await wrapper.vm.$nextTick()
    expect(wrapper.attributes('data-phase')).toBe('recording')
    expect(button.text()).toContain('Završi')
    expect(button.text()).toContain('00:00')
    expect(wrapper.find('.dct-pulse').exists()).toBe(true)
    expect(wrapper.find('.dct-meter').exists()).toBe(true)

    vi.advanceTimersByTime(65_000)
    await wrapper.vm.$nextTick()
    expect(button.text()).toContain('01:05')

    await button.trigger('click')
    await flush(20)
    await wrapper.vm.$nextTick()
    expect(wrapper.attributes('data-phase')).toBe('transcribing')
    expect(button.text()).toBe('Prepisujem…')
    expect(button.attributes('disabled')).toBeDefined()
    expect(wrapper.find('.dct-spinner').exists()).toBe(true)

    await vi.advanceTimersByTimeAsync(1500)
    await flush(4)
    await wrapper.vm.$nextTick()
    expect(wrapper.attributes('data-phase')).toBe('done')
    expect(button.text()).toBe('Diktiraj')

    expect(wrapper.emitted('recording')).toHaveLength(1)
    expect(wrapper.emitted('transcript')).toHaveLength(1)
    expect(wrapper.emitted('transcript')![0][0]).toMatchObject({ text: 'Tekst nalaza.', recording: { uuid: 'r-1', status: 'done' } })
    const phases = wrapper.emitted('phase')!.map((e) => e[0])
    expect(phases).toEqual(['recording', 'uploading', 'transcribing', 'done'])
  })

  it('shows the failure, emits error and offers retry', async () => {
    const source = createFakeSource()
    source.failStartWith({ code: 'permission_denied', message: 'denied' })
    const { http } = createFakeHttp({})
    const wrapper = mount(DictationButton, { props: { options: { http, endpoints, recorder: { source: source.factory } } } })
    await wrapper.find('button').trigger('click')
    await flush(4)
    await wrapper.vm.$nextTick()
    expect(wrapper.attributes('data-phase')).toBe('failed')
    expect(wrapper.find('button').text()).toBe('Pokušaj ponovo')
    expect(wrapper.find('.dct-hint').text()).toBe('Pristup mikrofonu je odbijen.')
    expect(wrapper.emitted('error')![0][0]).toMatchObject({ code: 'permission_denied' })
  })

  it('uses a provided instance and custom messages', async () => {
    const source = createFakeSource()
    const { http } = createFakeHttp({})
    const Parent = defineComponent({
      setup() {
        provideDictation({ http, endpoints, recorder: { source: source.factory }, messages: { start: 'Snimi' } })
        return () => h(DictationButton, { size: 'sm' })
      },
    })
    const wrapper = mount(Parent)
    expect(wrapper.find('button').text()).toBe('Snimi')
    expect(wrapper.find('.dct-size-sm').exists()).toBe(true)
  })

  it('throws without options or provider', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(() => mount(DictationButton)).toThrow(/provideDictation/)
    spy.mockRestore()
  })
})
