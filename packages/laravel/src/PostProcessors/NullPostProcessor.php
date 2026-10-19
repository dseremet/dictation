<?php

namespace Ditactic\Dictation\PostProcessors;

use Ditactic\Dictation\Contracts\TranscriptPostProcessor;
use Ditactic\Dictation\Models\Recording;

class NullPostProcessor implements TranscriptPostProcessor
{
    public function process(string $text, Recording $recording): string
    {
        return $text;
    }
}
