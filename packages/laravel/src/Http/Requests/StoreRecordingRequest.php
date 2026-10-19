<?php

namespace Ditactic\Dictation\Http\Requests;

use Ditactic\Dictation\Support\AudioMime;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StoreRecordingRequest extends FormRequest
{
    /** Authorization happens in the controller, after validation, with the resolved recordable. */
    public function authorize(): bool
    {
        return true;
    }

    protected function prepareForValidation(): void
    {
        $id = $this->input('recordable_id');
        if (is_int($id) || is_float($id)) {
            $this->merge(['recordable_id' => (string) $id]);
        }
    }

    public function rules(): array
    {
        $mimes = array_values(array_unique(array_filter(array_map(
            [AudioMime::class, 'normalize'],
            (array) config('dictation.limits.allowed_mimes', array_keys(AudioMime::EXTENSIONS)),
        ))));

        $languages = array_merge((array) config('dictation.languages', ['bs', 'hr', 'sr']), ['auto']);
        $maxDuration = (int) config('dictation.limits.max_duration_ms', 600000);
        $maxContextKeys = (int) config('dictation.limits.max_context_keys', 20);
        $maxContextValue = (int) config('dictation.limits.max_context_value_length', 500);

        return [
            'audio' => [
                'required',
                'file',
                'mimetypes:'.implode(',', $mimes),
                'max:'.(int) config('dictation.limits.max_size_kb', 51200),
            ],
            'language' => ['sometimes', 'nullable', 'string', Rule::in($languages)],
            'duration_ms' => ['sometimes', 'nullable', 'integer', 'min:0', 'max:'.max($maxDuration, 1)],
            'context' => ['sometimes', 'nullable', 'array', 'max:'.$maxContextKeys],
            'context.*' => [
                'nullable',
                function (string $attribute, mixed $value, \Closure $fail) use ($maxContextValue) {
                    if (is_array($value) || is_object($value)) {
                        $fail('The :attribute field must be a string or a number.');

                        return;
                    }
                    if (is_string($value) && mb_strlen($value) > $maxContextValue) {
                        $fail("The :attribute field may not be longer than {$maxContextValue} characters.");
                    }
                },
            ],
            'recordable_type' => ['sometimes', 'nullable', 'string', 'max:191', 'required_with:recordable_id'],
            // Ids arrive as strings from multipart forms and as integers from
            // JSON clients; both are fine.
            'recordable_id' => ['sometimes', 'nullable', 'string', 'max:64', 'required_with:recordable_type'],
        ];
    }

    public function attributes(): array
    {
        return [
            'audio' => 'audio file',
            'context.*' => 'context value',
        ];
    }
}
