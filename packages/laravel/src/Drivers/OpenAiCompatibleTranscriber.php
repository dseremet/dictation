<?php

namespace Ditactic\Dictation\Drivers;

use Ditactic\Dictation\Contracts\Transcriber;
use Ditactic\Dictation\DTO\TranscriptionRequest;
use Ditactic\Dictation\DTO\TranscriptionResult;
use Ditactic\Dictation\Exceptions\TranscriptionException;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Factory as HttpFactory;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;

/**
 * POST /v1/audio/transcriptions, OpenAI style. Works against the self-hosted
 * engine (which adds the `glossary` field and the `x_ditactic` response block)
 * and against OpenAI or any compatible API (extra fields are ignored there).
 */
class OpenAiCompatibleTranscriber implements Transcriber
{
    public function __construct(
        protected HttpFactory $http,
        protected array $config = [],
    ) {
    }

    public function transcribe(TranscriptionRequest $request): TranscriptionResult
    {
        if (! is_file($request->path) || ! is_readable($request->path)) {
            throw TranscriptionException::permanent('Audio file is missing or unreadable: '.basename($request->path));
        }

        $verbose = (bool) ($this->config['verbose'] ?? true);
        $model = $request->model ?? ($this->config['model'] ?? 'whisper-1');

        $fields = array_merge((array) ($this->config['extra'] ?? []), [
            'model' => $model,
            'response_format' => $verbose ? 'verbose_json' : 'json',
        ]);

        if ($request->language !== '' && $request->language !== 'auto') {
            $fields['language'] = $request->language;
        }

        if ($request->prompt !== null && $request->prompt !== '') {
            $fields['prompt'] = $request->prompt;
        }

        if ($request->glossary !== []) {
            $fields['glossary'] = json_encode($request->glossary, JSON_UNESCAPED_UNICODE);
        }

        if (($this->config['temperature'] ?? null) !== null) {
            $fields['temperature'] = (string) $this->config['temperature'];
        }

        foreach ($request->options as $key => $value) {
            if (is_scalar($value)) {
                $fields[$key] = is_bool($value) ? ($value ? 'true' : 'false') : (string) $value;
            }
        }

        $stream = fopen($request->path, 'r');
        if ($stream === false) {
            throw TranscriptionException::permanent('Could not open audio file for upload.');
        }

        try {
            $response = $this->pendingRequest()
                ->attach('file', $stream, $this->uploadName($request), ['Content-Type' => $request->mime])
                ->post($this->endpoint(), $fields);
        } catch (ConnectionException $e) {
            throw TranscriptionException::retryable('Transcription engine unreachable: '.$e->getMessage(), null, $e);
        } finally {
            if (is_resource($stream)) {
                fclose($stream);
            }
        }

        return $this->parse($response, $model);
    }

    /** GET /health on the engine (not part of the OpenAI API; may 404 elsewhere). */
    public function health(): array
    {
        $response = $this->pendingRequest()->timeout(10)->get(rtrim($this->baseUrl(), '/').'/health');

        return ['status' => $response->status(), 'body' => $response->json() ?? $response->body()];
    }

    /** GET /v1/models. */
    public function models(): array
    {
        $response = $this->pendingRequest()->timeout(10)->get(rtrim($this->baseUrl(), '/').'/v1/models');

        return ['status' => $response->status(), 'body' => $response->json() ?? $response->body()];
    }

    public function endpoint(): string
    {
        return rtrim($this->baseUrl(), '/').'/v1/audio/transcriptions';
    }

    protected function baseUrl(): string
    {
        return (string) ($this->config['url'] ?? 'http://dictation-engine:8000');
    }

    protected function pendingRequest(): PendingRequest
    {
        $request = $this->http
            ->acceptJson()
            ->timeout((int) ($this->config['timeout'] ?? 600))
            ->connectTimeout((int) ($this->config['connect_timeout'] ?? 10));

        if (! empty($this->config['token'])) {
            $request = $request->withToken((string) $this->config['token']);
        }

        return $request;
    }

    protected function uploadName(TranscriptionRequest $request): string
    {
        $name = $request->filename();

        return pathinfo($name, PATHINFO_EXTENSION) === '' ? $name.'.bin' : $name;
    }

    protected function parse(Response $response, string $requestedModel): TranscriptionResult
    {
        if ($response->failed()) {
            $status = $response->status();
            $message = $this->errorMessage($response);
            $retryable = in_array($status, [408, 425, 429, 500, 502, 503, 504], true);

            throw new TranscriptionException("Transcription engine returned HTTP {$status}: {$message}", $retryable, $status);
        }

        $body = $response->json();

        if (! is_array($body)) {
            // `text` response format or a non-JSON body: use it as-is.
            $text = trim($response->body());

            return new TranscriptionResult(text: $text, model: $requestedModel, raw: ['text' => $text]);
        }

        $extra = is_array($body['x_ditactic'] ?? null) ? $body['x_ditactic'] : [];
        $text = trim((string) ($body['text'] ?? ''));

        $segments = [];
        foreach ((array) ($body['segments'] ?? []) as $i => $segment) {
            if (! is_array($segment)) {
                continue;
            }
            $segments[] = [
                'id' => (int) ($segment['id'] ?? $i),
                'start' => (float) ($segment['start'] ?? 0),
                'end' => (float) ($segment['end'] ?? 0),
                'text' => trim((string) ($segment['text'] ?? '')),
            ];
        }

        $duration = $body['duration'] ?? null;

        return new TranscriptionResult(
            text: $text,
            language: isset($body['language']) ? (string) $body['language'] : null,
            durationMs: is_numeric($duration) ? (int) round($duration * 1000) : null,
            segments: $segments,
            model: (string) ($extra['model'] ?? $requestedModel),
            rawText: isset($extra['raw_text']) ? (string) $extra['raw_text'] : null,
            warnings: array_values(array_map('strval', (array) ($extra['warnings'] ?? []))),
            processingMs: isset($extra['processing_ms']) && is_numeric($extra['processing_ms']) ? (int) $extra['processing_ms'] : null,
            raw: $body,
        );
    }

    protected function errorMessage(Response $response): string
    {
        $json = $response->json();

        if (is_array($json)) {
            $message = $json['error']['message'] ?? $json['detail'] ?? $json['message'] ?? null;
            if (is_string($message) && $message !== '') {
                return mb_substr($message, 0, 500);
            }
        }

        $body = trim($response->body());

        return $body === '' ? 'empty response' : mb_substr($body, 0, 500);
    }
}
