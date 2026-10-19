<?php

namespace Ditactic\Dictation\Http\Resources;

use Ditactic\Dictation\Facades\Dictation;
use Ditactic\Dictation\Models\Recording;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * @mixin Recording
 */
class RecordingResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        /** @var Recording $recording */
        $recording = $this->resource;

        return [
            'uuid' => $recording->uuid,
            'status' => $recording->status,
            'language' => $recording->language_hint,
            'detected_language' => $recording->detected_language,
            'duration_ms' => $recording->duration_ms,
            'transcript' => $recording->transcript,
            'transcript_raw' => $recording->transcript_raw,
            'transcript_corrected' => $recording->transcript_corrected,
            'final_text' => $recording->final_text,
            'context' => $recording->context ?? (object) [],
            'warnings' => $recording->warnings ?? [],
            'recordable_type' => $recording->recordable_type,
            'recordable_id' => $recording->recordable_id,
            'created_at' => $recording->created_at?->toISOString(),
            'processed_at' => $recording->processed_at?->toISOString(),
            'audio_url' => $this->audioUrl($recording),
            'error' => $recording->error,
        ];
    }

    protected function audioUrl(Recording $recording): ?string
    {
        $name = Dictation::routeName('audio');

        return $name ? route($name, ['recording' => $recording->uuid]) : null;
    }
}
