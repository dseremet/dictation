<?php

namespace Ditactic\Dictation\DTO;

final class TranscriptionRequest
{
    /**
     * @param  string  $path  Absolute path of a local audio file.
     * @param  string  $mime  Mime type the file was stored with.
     * @param  string  $language  ISO 639-1 code or `auto`.
     * @param  string|null  $prompt  Whisper prompt (style/vocabulary hint).
     * @param  array<int, array{canonical: string, variants: array<int, string>, weight: int|float}>  $glossary  Engine glossary entries.
     * @param  string|null  $model  Overrides the driver's configured model.
     * @param  array<string, mixed>  $options  Driver-specific extras.
     */
    public function __construct(
        public readonly string $path,
        public readonly string $mime,
        public readonly string $language = 'auto',
        public readonly ?string $prompt = null,
        public readonly array $glossary = [],
        public readonly ?string $model = null,
        public readonly array $options = [],
    ) {
    }

    public function filename(): string
    {
        return basename($this->path);
    }
}
