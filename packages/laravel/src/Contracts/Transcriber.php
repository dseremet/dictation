<?php

namespace Ditactic\Dictation\Contracts;

use Ditactic\Dictation\DTO\TranscriptionRequest;
use Ditactic\Dictation\DTO\TranscriptionResult;
use Ditactic\Dictation\Exceptions\TranscriptionException;

interface Transcriber
{
    /**
     * Transcribe one audio file.
     *
     * @throws TranscriptionException when the engine fails; `retryable` says whether a later attempt may succeed.
     */
    public function transcribe(TranscriptionRequest $request): TranscriptionResult;
}
