<?php

namespace Ditactic\Dictation\Contracts;

use Ditactic\Dictation\Models\Recording;

interface TranscriptPostProcessor
{
    /**
     * Return the cleaned-up transcript. Implementations must never throw for
     * ordinary failures: return the input text unchanged instead.
     */
    public function process(string $text, Recording $recording): string;
}
