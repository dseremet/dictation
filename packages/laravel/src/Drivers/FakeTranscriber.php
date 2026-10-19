<?php

namespace Ditactic\Dictation\Drivers;

use Closure;
use Ditactic\Dictation\Contracts\Transcriber;
use Ditactic\Dictation\DTO\TranscriptionRequest;
use Ditactic\Dictation\DTO\TranscriptionResult;
use Ditactic\Dictation\Exceptions\TranscriptionException;
use PHPUnit\Framework\Assert as PHPUnit;
use Throwable;

/**
 * Returns a configurable transcript without calling any engine.
 * Used by `Dictation::fake()` in host test suites and as a local dev driver.
 */
class FakeTranscriber implements Transcriber
{
    /** @var array<int, TranscriptionRequest> */
    public array $requests = [];

    /** @var array<int, string|TranscriptionResult|Throwable|Closure> */
    protected array $queue = [];

    protected string|TranscriptionResult|Throwable|Closure $default;

    protected ?string $language;

    public function __construct(array $config = [])
    {
        $this->default = (string) ($config['text'] ?? '');
        $this->language = $config['language'] ?? null;
    }

    /**
     * Set what the next transcriptions return. Accepts a string, a
     * TranscriptionResult, a Throwable to be thrown, a Closure receiving the
     * request, or a list of those consumed in order (last one repeats).
     */
    public function respondWith(string|TranscriptionResult|Throwable|Closure|array $response): static
    {
        if (is_array($response)) {
            $this->queue = array_values($response);
            if ($this->queue !== []) {
                $this->default = end($this->queue);
            }

            return $this;
        }

        $this->queue = [];
        $this->default = $response;

        return $this;
    }

    public function failWith(string $message, bool $retryable = false): static
    {
        return $this->respondWith(new TranscriptionException($message, $retryable));
    }

    public function transcribe(TranscriptionRequest $request): TranscriptionResult
    {
        $this->requests[] = $request;

        $response = $this->queue !== [] ? array_shift($this->queue) : $this->default;

        if ($response instanceof Closure) {
            $response = $response($request);
        }

        if ($response instanceof Throwable) {
            throw $response;
        }

        if ($response instanceof TranscriptionResult) {
            return $response;
        }

        $text = (string) $response;

        return new TranscriptionResult(
            text: $text,
            language: $request->language !== 'auto' ? $request->language : $this->language,
            durationMs: null,
            segments: $text === '' ? [] : [['id' => 0, 'start' => 0.0, 'end' => 1.0, 'text' => $text]],
            model: 'fake',
            rawText: $text,
            warnings: [],
            processingMs: 0,
            raw: ['text' => $text, 'x_ditactic' => ['model' => 'fake', 'raw_text' => $text]],
        );
    }

    // ---------------------------------------------------------------- assertions for host tests

    public function assertTranscribed(?Closure $callback = null): void
    {
        $matching = $callback ? array_filter($this->requests, $callback) : $this->requests;

        PHPUnit::assertNotEmpty($matching, 'No transcription request matched the expectation.');
    }

    public function assertNothingTranscribed(): void
    {
        PHPUnit::assertCount(0, $this->requests, 'A transcription request was sent unexpectedly.');
    }

    public function assertTranscribedCount(int $count): void
    {
        PHPUnit::assertCount($count, $this->requests);
    }

    public function lastRequest(): ?TranscriptionRequest
    {
        return $this->requests === [] ? null : end($this->requests);
    }
}
