<?php

namespace Ditactic\Dictation\Concerns;

use Ditactic\Dictation\Models\Recording;
use Illuminate\Database\Eloquent\Relations\MorphMany;
use Illuminate\Database\Eloquent\Relations\MorphOne;

/**
 * Add to any model that recordings can be attached to (`recordable`).
 */
trait HasRecordings
{
    public function recordings(): MorphMany
    {
        return $this->morphMany($this->dictationRecordingModel(), 'recordable')->latest('id');
    }

    public function latestRecording(): MorphOne
    {
        return $this->morphOne($this->dictationRecordingModel(), 'recordable')->latestOfMany();
    }

    /** @return class-string<Recording> */
    protected function dictationRecordingModel(): string
    {
        return config('dictation.model', Recording::class);
    }
}
