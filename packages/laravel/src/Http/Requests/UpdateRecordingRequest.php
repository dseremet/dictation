<?php

namespace Ditactic\Dictation\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class UpdateRecordingRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'transcript_corrected' => ['present', 'nullable', 'string', 'max:200000'],
        ];
    }
}
