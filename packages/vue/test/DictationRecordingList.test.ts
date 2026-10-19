import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import DictationRecordingList from '../src/components/DictationRecordingList.vue'
import { createFakeHttp, endpoints, flush, makeRecording } from './helpers/fakes'

describe('DictationRecordingList', () => {
  it('renders the player, status pill and text; emits insert', async () => {
    const { http } = createFakeHttp({})
    const recordings = [makeRecording(), makeRecording({ uuid: 'r-2', status: 'processing', transcript: null, final_text: null, audio_url: null })]
    const wrapper = mount(DictationRecordingList, { props: { recordings, http, endpoints } })

    const items = wrapper.findAll('.dct-item')
    expect(items).toHaveLength(2)
    const audio = items[0].find('audio')
    expect(audio.attributes('controls')).toBeDefined()
    expect(audio.attributes('preload')).toBe('none')
    expect(audio.attributes('src')).toBe('/karton/diktat/r-1/audio')
    expect(items[1].find('audio').attributes('src')).toBe('/dict/r-2/audio')
    expect(items[0].find('.dct-pill').text()).toBe('Prepisano')
    expect(items[1].find('.dct-pill').text()).toBe('Obrada…')
    expect(items[0].find('.dct-item__text').text()).toBe('Pacijent se žali na bol.')
    expect(items[1].find('.dct-btn--insert').exists()).toBe(false)

    await items[0].find('.dct-btn--insert').trigger('click')
    expect(wrapper.emitted('insert')).toHaveLength(1)
    expect(wrapper.emitted('insert')![0][0]).toEqual({ recording: recordings[0], text: 'Pacijent se žali na bol.' })
  })

  it('PATCHes a correction and emits updated', async () => {
    const { http } = createFakeHttp({
      patch: (body: Record<string, unknown>) => ({ data: makeRecording({ transcript_corrected: body.transcript_corrected as string, final_text: body.transcript_corrected as string }) }),
    })
    const wrapper = mount(DictationRecordingList, { props: { recordings: [makeRecording()], http, endpoints } })

    await wrapper.find('.dct-btn--correct').trigger('click')
    const textarea = wrapper.find('textarea')
    expect(textarea.exists()).toBe(true)
    expect((textarea.element as HTMLTextAreaElement).value).toBe('Pacijent se žali na bol.')
    await textarea.setValue('Pacijent se žali na bol u epigastriju.')
    const buttons = wrapper.findAll('.dct-item__actions button')
    expect(buttons[0].text()).toBe('Sačuvaj')
    await buttons[0].trigger('click')
    await flush(4)

    expect(http.patch).toHaveBeenCalledWith('/dict/r-1', { transcript_corrected: 'Pacijent se žali na bol u epigastriju.' })
    const updated = wrapper.emitted('updated')![0][0] as { transcript_corrected: string }
    expect(updated.transcript_corrected).toBe('Pacijent se žali na bol u epigastriju.')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.find('.dct-item__text').text()).toBe('Pacijent se žali na bol u epigastriju.')
  })

  it('deletes after confirm and emits deleted', async () => {
    const { http } = createFakeHttp({})
    const confirm = vi.fn().mockResolvedValue(true)
    const wrapper = mount(DictationRecordingList, { props: { recordings: [makeRecording()], http, endpoints, confirm } })
    await wrapper.find('.dct-btn--delete').trigger('click')
    await flush(4)
    expect(confirm).toHaveBeenCalledWith('Obrisati snimak?')
    expect(http.delete).toHaveBeenCalledWith('/dict/r-1')
    expect(wrapper.emitted('deleted')).toHaveLength(1)
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.dct-item')).toHaveLength(0)
    expect(wrapper.find('.dct-list__empty').text()).toBe('Nema snimaka.')
  })

  it('does not delete when confirm is declined', async () => {
    const { http } = createFakeHttp({})
    const wrapper = mount(DictationRecordingList, { props: { recordings: [makeRecording()], http, endpoints, confirm: () => false } })
    await wrapper.find('.dct-btn--delete').trigger('click')
    await flush(2)
    expect(http.delete).not.toHaveBeenCalled()
  })

  it('offers retry for failed recordings and hides edit controls when canEdit is false', async () => {
    const { http } = createFakeHttp({ post: makeRecording({ status: 'pending', error: null }) })
    const failed = makeRecording({ status: 'failed', error: 'Engine down', transcript: null, final_text: null })
    const wrapper = mount(DictationRecordingList, { props: { recordings: [failed], http, endpoints } })
    expect(wrapper.find('.dct-item__error').text()).toBe('Engine down')
    await wrapper.find('.dct-btn--retry').trigger('click')
    await flush(4)
    expect(http.post).toHaveBeenCalledWith('/dict/r-1/retry', null, expect.anything())
    expect(wrapper.emitted('retried')).toHaveLength(1)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.dct-pill').text()).toBe('Čeka obradu')

    const readOnly = mount(DictationRecordingList, { props: { recordings: [makeRecording()], http, endpoints, canEdit: false } })
    expect(readOnly.find('.dct-btn--insert').exists()).toBe(true)
    expect(readOnly.find('.dct-btn--correct').exists()).toBe(false)
    expect(readOnly.find('.dct-btn--delete').exists()).toBe(false)
  })

  it('accepts message overrides', () => {
    const { http } = createFakeHttp({})
    const wrapper = mount(DictationRecordingList, {
      props: { recordings: [makeRecording()], http, endpoints, messages: { insert: 'Insert' } },
    })
    expect(wrapper.find('.dct-btn--insert').text()).toBe('Insert')
  })
})
