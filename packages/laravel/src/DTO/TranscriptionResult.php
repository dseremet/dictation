<?php

namespace Ditactic\Dictation\DTO;

final class TranscriptionResult
{
    /**
     * @param  string  $text  Final text from the engine (normalised when the engine normalises).
     * @param  string|null  $language  Detected or confirmed language code.
     * @param  int|null  $durationMs  Audio duration reported by the engine.
     * @param  array<int, array{id?: int, start: float, end: float, text: string}>  $segments
     * @param  string|null  $model  Model that produced the text.
     * @param  string|null  $rawText  Text before the engine's normaliser (x_ditactic.raw_text), if any.
     * @param  array<int, string>  $warnings  Engine warnings (x_ditactic.warnings).
     * @param  int|null  $processingMs  Engine processing time.
     * @param  array<string, mixed>  $raw  Full decoded response body.
     */
    public function __construct(
        public readonly string $text,
        public readonly ?string $language = null,
        public readonly ?int $durationMs = null,
        public readonly array $segments = [],
        public readonly ?string $model = null,
        public readonly ?string $rawText = null,
        public readonly array $warnings = [],
        public readonly ?int $processingMs = null,
        public readonly array $raw = [],
    ) {
    }

    /** Engine extras worth keeping next to the transcript. */
    public function meta(): array
    {
        $x = is_array($this->raw['x_ditactic'] ?? null) ? $this->raw['x_ditactic'] : [];

        return array_filter([
            'raw_text' => $this->rawText,
            'language_probability' => $x['language_probability'] ?? null,
            'duration_after_vad' => $x['duration_after_vad'] ?? null,
            'compute_type' => $x['compute_type'] ?? null,
            'device' => $x['device'] ?? null,
            'glossary_version' => $x['glossary_version'] ?? null,
            'normalized' => $x['normalized'] ?? null,
        ], fn ($v) => $v !== null);
    }
}
