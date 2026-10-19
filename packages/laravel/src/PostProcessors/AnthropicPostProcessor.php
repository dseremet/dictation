<?php

namespace Ditactic\Dictation\PostProcessors;

use Ditactic\Dictation\Contracts\TranscriptPostProcessor;
use Ditactic\Dictation\Models\Recording;
use Illuminate\Http\Client\Factory as HttpFactory;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Cleans the transcript with the Anthropic Messages API (raw HTTP, no SDK).
 * Any failure returns the original text: post-processing must never block a
 * transcript.
 */
class AnthropicPostProcessor implements TranscriptPostProcessor
{
    public const API_VERSION = '2023-06-01';

    public function __construct(
        protected HttpFactory $http,
        protected array $config = [],
    ) {
    }

    public function process(string $text, Recording $recording): string
    {
        if (trim($text) === '') {
            return $text;
        }

        $apiKey = (string) ($this->config['api_key'] ?? '');
        if ($apiKey === '') {
            Log::warning('dictation: Anthropic post-processor skipped, no API key configured.');

            return $text;
        }

        try {
            $response = $this->http
                ->withHeaders([
                    'x-api-key' => $apiKey,
                    'anthropic-version' => self::API_VERSION,
                ])
                ->acceptJson()
                ->timeout((int) ($this->config['timeout'] ?? 60))
                ->post(rtrim((string) ($this->config['base_url'] ?? 'https://api.anthropic.com'), '/').'/v1/messages', $this->payload($text, $recording));
        } catch (Throwable $e) {
            Log::warning('dictation: Anthropic post-processor request failed, keeping raw transcript.', ['error' => $e->getMessage()]);

            return $text;
        }

        if ($response->failed()) {
            Log::warning('dictation: Anthropic post-processor returned HTTP '.$response->status().', keeping raw transcript.', [
                'body' => mb_substr($response->body(), 0, 300),
            ]);

            return $text;
        }

        $body = $response->json();

        if (($body['stop_reason'] ?? null) === 'refusal') {
            Log::notice('dictation: Anthropic post-processor refused, keeping raw transcript.');

            return $text;
        }

        $cleaned = '';
        foreach ((array) ($body['content'] ?? []) as $block) {
            if (is_array($block) && ($block['type'] ?? null) === 'text') {
                $cleaned .= (string) ($block['text'] ?? '');
            }
        }

        $cleaned = trim($cleaned);

        if ($cleaned === '' || ! $this->looksSane($text, $cleaned)) {
            return $text;
        }

        return $cleaned;
    }

    protected function payload(string $text, Recording $recording): array
    {
        $payload = [
            'model' => (string) ($this->config['model'] ?? 'claude-haiku-5-5'),
            'max_tokens' => (int) ($this->config['max_tokens'] ?? 4096),
            'system' => $this->systemPrompt($recording),
            'messages' => [
                ['role' => 'user', 'content' => $text],
            ],
        ];

        $effort = $this->config['effort'] ?? null;
        if (is_string($effort) && $effort !== '') {
            $payload['output_config'] = ['effort' => $effort];
        }

        return $payload;
    }

    public function systemPrompt(Recording $recording): string
    {
        $prompt = $this->basePrompt();

        $language = $recording->detected_language ?? $recording->language_hint;
        if (is_string($language) && $language !== '' && $language !== 'auto') {
            $prompt .= "\n\nThe dictation language code is `{$language}`.";
        }

        $label = $recording->context['field_label'] ?? null;
        if (is_string($label) && trim($label) !== '') {
            $prompt .= "\n\nThe text belongs to the record field \"".trim($label).'".';
        }

        return $prompt;
    }

    protected function basePrompt(): string
    {
        $candidates = array_filter([
            $this->config['prompt'] ?? null,
            function_exists('resource_path') ? resource_path('vendor/dictation/prompts/bhs-medical-cleanup.md') : null,
            dirname(__DIR__, 2).'/resources/prompts/bhs-medical-cleanup.md',
        ]);

        foreach ($candidates as $path) {
            if (is_string($path) && is_file($path)) {
                return trim((string) file_get_contents($path));
            }
        }

        return 'Clean up this medical dictation transcript. Fix recognition errors, punctuation and spacing only. Never add or remove facts. Reply with the text only.';
    }

    /** Guard against the model replacing the transcript with something else entirely. */
    protected function looksSane(string $original, string $cleaned): bool
    {
        $originalLength = mb_strlen(trim($original));
        $cleanedLength = mb_strlen($cleaned);

        if ($cleanedLength > $originalLength * 2 + 200) {
            return false;
        }

        if ($originalLength > 40 && $cleanedLength < $originalLength * 0.3) {
            return false;
        }

        return true;
    }
}
