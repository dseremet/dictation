<?php

namespace Ditactic\Dictation\Support;

use Ditactic\Dictation\Contracts\GlossaryProvider;
use Ditactic\Dictation\Models\Recording;
use Illuminate\Contracts\Container\Container;

/**
 * Builds the Whisper `prompt` and the engine `glossary` for one recording from
 * config('dictation.prompt_terms'), the optional GlossaryProvider and the
 * upload context (`field_label`).
 */
class PromptBuilder
{
    public function __construct(protected Container $container)
    {
    }

    /**
     * @return array{prompt: string|null, glossary: array<int, array{canonical: string, variants: array<int, string>, weight: int|float}>}
     */
    public function build(Recording $recording): array
    {
        $entries = [];

        foreach ((array) config('dictation.prompt_terms', []) as $term) {
            $this->push($entries, $term);
        }

        if ($this->container->bound(GlossaryProvider::class)) {
            try {
                foreach ((array) $this->container->make(GlossaryProvider::class)->terms($recording) as $term) {
                    $this->push($entries, $term);
                }
            } catch (\Throwable $e) {
                // Vocabulary hints are best effort; a broken provider must not
                // fail the transcription.
                if (function_exists('logger')) {
                    logger()->warning('dictation: glossary provider failed', ['error' => $e->getMessage()]);
                }
            }
        }

        $maxTerms = max(1, (int) config('dictation.prompt_max_terms', 60));
        $glossary = array_values(array_slice($entries, 0, $maxTerms));

        return [
            'prompt' => $this->promptText($recording, $glossary),
            'glossary' => $glossary,
        ];
    }

    protected function push(array &$entries, mixed $term): void
    {
        $entry = $this->normalize($term);
        if ($entry === null) {
            return;
        }

        $key = mb_strtolower($entry['canonical']);
        if (isset($entries[$key])) {
            $entries[$key]['variants'] = array_values(array_unique(array_merge($entries[$key]['variants'], $entry['variants'])));
            $entries[$key]['weight'] = max($entries[$key]['weight'], $entry['weight']);

            return;
        }

        $entries[$key] = $entry;
    }

    protected function normalize(mixed $term): ?array
    {
        if (is_string($term) || is_int($term) || is_float($term)) {
            $term = ['canonical' => (string) $term];
        }

        if (! is_array($term)) {
            return null;
        }

        $canonical = trim((string) ($term['canonical'] ?? $term['term'] ?? ''));
        if ($canonical === '' || mb_strlen($canonical) > 80) {
            return null;
        }

        $variants = array_values(array_filter(array_map(
            fn ($v) => trim((string) $v),
            (array) ($term['variants'] ?? [])
        ), fn ($v) => $v !== '' && mb_strlen($v) <= 80));

        $weight = $term['weight'] ?? 1;

        return [
            'canonical' => $canonical,
            'variants' => $variants,
            'weight' => is_numeric($weight) ? $weight + 0 : 1,
        ];
    }

    protected function promptText(Recording $recording, array $glossary): ?string
    {
        $maxChars = max(50, (int) config('dictation.prompt_max_chars', 800));
        $parts = [];

        $label = $recording->context['field_label'] ?? null;
        if (is_string($label) && trim($label) !== '') {
            $parts[] = rtrim(trim($label), '.:').'.';
        }

        // The glossary travels as structured `glossary` hotwords; repeating it
        // as a comma list in the free-text prompt primes Whisper to emit stray
        // commas and colons ("Dijagnoza,:,"). Only backends without glossary
        // support (plain OpenAI) should get the terms in the prompt.
        if (! config('dictation.prompt_include_terms', false)) {
            $prompt = trim(implode(' ', $parts));

            return $prompt === '' ? null : $prompt;
        }

        $terms = [];
        $length = array_sum(array_map('mb_strlen', $parts));
        foreach ($glossary as $entry) {
            $next = $entry['canonical'];
            if ($length + mb_strlen($next) + 2 > $maxChars) {
                break;
            }
            $terms[] = $next;
            $length += mb_strlen($next) + 2;
        }

        if ($terms !== []) {
            $parts[] = implode(', ', $terms).'.';
        }

        $prompt = trim(implode(' ', $parts));

        return $prompt === '' ? null : $prompt;
    }
}
