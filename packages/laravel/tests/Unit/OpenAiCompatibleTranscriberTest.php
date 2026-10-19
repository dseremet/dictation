<?php

namespace Ditactic\Dictation\Tests\Unit;

use Ditactic\Dictation\Drivers\OpenAiCompatibleTranscriber;
use Ditactic\Dictation\DTO\TranscriptionRequest;
use Ditactic\Dictation\Exceptions\TranscriptionException;
use Ditactic\Dictation\Facades\Dictation;
use Ditactic\Dictation\Tests\TestCase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;

class OpenAiCompatibleTranscriberTest extends TestCase
{
    protected string $file;

    protected function setUp(): void
    {
        parent::setUp();
        $this->file = tempnam(sys_get_temp_dir(), 'dct').'.webm';
        file_put_contents($this->file, 'fake-audio');
    }

    protected function tearDown(): void
    {
        @unlink($this->file);
        parent::tearDown();
    }

    /** Multipart field value as sent (Http::fake keeps the raw multipart parts). */
    protected function field(Request $request, string $name): ?string
    {
        foreach ($request->data() as $part) {
            if (($part['name'] ?? null) === $name && ! isset($part['filename'])) {
                return $part['contents'];
            }
        }

        return null;
    }

    protected function driver(array $config = []): OpenAiCompatibleTranscriber
    {
        return new OpenAiCompatibleTranscriber(app(\Illuminate\Http\Client\Factory::class), array_merge([
            'url' => 'http://engine.test:8000/',
            'token' => 'secret-token',
            'model' => 'turbo',
            'timeout' => 600,
        ], $config));
    }

    public function test_sends_openai_style_multipart_and_parses_verbose_json_with_engine_extras(): void
    {
        Http::fake([
            'engine.test:8000/v1/audio/transcriptions' => Http::response([
                'task' => 'transcribe',
                'language' => 'hr',
                'duration' => 4.21,
                'text' => 'Pritisak 120/80.',
                'segments' => [
                    ['id' => 0, 'start' => 0.0, 'end' => 2.5, 'text' => ' Pritisak 120/80. ', 'avg_logprob' => -0.2],
                ],
                'x_ditactic' => [
                    'model' => 'deepdml/faster-whisper-large-v3-turbo-ct2',
                    'raw_text' => 'pritisak sto dvadeset sa osamdeset tačka',
                    'warnings' => ['speech_rate_low'],
                    'processing_ms' => 1830,
                    'language_probability' => 0.97,
                    'compute_type' => 'int8',
                    'device' => 'cpu',
                ],
            ]),
        ]);

        $result = $this->driver()->transcribe(new TranscriptionRequest(
            path: $this->file,
            mime: 'audio/webm',
            language: 'hr',
            prompt: 'Anamneza. Amoksicilin.',
            glossary: [['canonical' => 'Amoksicilin', 'variants' => ['amoxicilin'], 'weight' => 2]],
        ));

        $this->assertSame('Pritisak 120/80.', $result->text);
        $this->assertSame('pritisak sto dvadeset sa osamdeset tačka', $result->rawText);
        $this->assertSame('hr', $result->language);
        $this->assertSame(4210, $result->durationMs);
        $this->assertSame([['id' => 0, 'start' => 0.0, 'end' => 2.5, 'text' => 'Pritisak 120/80.']], $result->segments);
        $this->assertSame('deepdml/faster-whisper-large-v3-turbo-ct2', $result->model);
        $this->assertSame(['speech_rate_low'], $result->warnings);
        $this->assertSame(1830, $result->processingMs);
        $this->assertSame(['raw_text' => 'pritisak sto dvadeset sa osamdeset tačka', 'language_probability' => 0.97, 'compute_type' => 'int8', 'device' => 'cpu'], $result->meta());

        Http::assertSent(function (Request $request) {
            return $request->url() === 'http://engine.test:8000/v1/audio/transcriptions'
                && $request->method() === 'POST'
                && $request->isMultipart()
                && $request->hasFile('file', null, basename($this->file))
                && $request->hasHeader('Authorization', 'Bearer secret-token')
                && $this->field($request, 'model') === 'turbo'
                && $this->field($request, 'language') === 'hr'
                && $this->field($request, 'prompt') === 'Anamneza. Amoksicilin.'
                && $this->field($request, 'response_format') === 'verbose_json'
                && json_decode($this->field($request, 'glossary'), true) === [['canonical' => 'Amoksicilin', 'variants' => ['amoxicilin'], 'weight' => 2]];
        });
    }

    public function test_auto_language_is_omitted_and_json_format_used_when_not_verbose(): void
    {
        Http::fake(['engine.test:8000/*' => Http::response(['text' => 'ok'])]);

        $result = $this->driver(['verbose' => false, 'token' => null, 'temperature' => 0.2])->transcribe(new TranscriptionRequest($this->file, 'audio/ogg', 'auto'));

        $this->assertSame('ok', $result->text);
        $this->assertSame('turbo', $result->model);
        $this->assertSame([], $result->segments);

        Http::assertSent(function (Request $request) {
            return $this->field($request, 'language') === null
                && $this->field($request, 'prompt') === null
                && $this->field($request, 'glossary') === null
                && $this->field($request, 'response_format') === 'json'
                && $this->field($request, 'temperature') === '0.2'
                && ! $request->hasHeader('Authorization');
        });
    }

    public function test_request_model_overrides_config(): void
    {
        Http::fake(['engine.test:8000/*' => Http::response(['text' => 'ok'])]);

        $this->driver()->transcribe(new TranscriptionRequest($this->file, 'audio/webm', 'bs', model: 'small'));

        Http::assertSent(fn (Request $r) => $this->field($r, 'model') === 'small');
    }

    public function test_5xx_busy_and_timeouts_are_retryable(): void
    {
        foreach ([503, 504, 429, 502, 500] as $status) {
            Http::fake(["engine{$status}.test/*" => Http::response(['error' => ['message' => 'busy']], $status)]);

            try {
                $this->driver(['url' => "http://engine{$status}.test"])->transcribe(new TranscriptionRequest($this->file, 'audio/webm', 'bs'));
                $this->fail("Expected exception for HTTP {$status}");
            } catch (TranscriptionException $e) {
                $this->assertTrue($e->isRetryable(), "HTTP {$status} should be retryable");
                $this->assertSame($status, $e->status);
                $this->assertStringContainsString("HTTP {$status}: busy", $e->getMessage());
            }
        }
    }

    public function test_4xx_is_permanent(): void
    {
        foreach ([400, 401, 413, 415, 422] as $status) {
            Http::fake(["engine{$status}.test/*" => Http::response(['detail' => 'bad audio'], $status)]);

            try {
                $this->driver(['url' => "http://engine{$status}.test"])->transcribe(new TranscriptionRequest($this->file, 'audio/webm', 'bs'));
                $this->fail("Expected exception for HTTP {$status}");
            } catch (TranscriptionException $e) {
                $this->assertFalse($e->isRetryable(), "HTTP {$status} should not be retryable");
                $this->assertStringContainsString('bad audio', $e->getMessage());
            }
        }
    }

    public function test_connection_errors_are_retryable(): void
    {
        Http::fake(fn () => throw new ConnectionException('cURL error 7: Failed to connect'));

        try {
            $this->driver()->transcribe(new TranscriptionRequest($this->file, 'audio/webm', 'bs'));
            $this->fail('Expected exception');
        } catch (TranscriptionException $e) {
            $this->assertTrue($e->isRetryable());
            $this->assertStringContainsString('unreachable', $e->getMessage());
        }
    }

    public function test_missing_file_is_permanent_without_http(): void
    {
        Http::fake();

        $this->expectException(TranscriptionException::class);

        try {
            $this->driver()->transcribe(new TranscriptionRequest('/nope/missing.webm', 'audio/webm', 'bs'));
        } finally {
            Http::assertNothingSent();
        }
    }

    public function test_manager_builds_driver_from_config_and_can_be_extended(): void
    {
        config(['dictation.driver' => 'openai_compatible']);
        Dictation::forgetDrivers();
        $this->assertInstanceOf(OpenAiCompatibleTranscriber::class, Dictation::driver());

        Dictation::extend('custom', fn () => new \Ditactic\Dictation\Drivers\FakeTranscriber(['text' => 'custom']));
        $this->assertSame('custom', Dictation::driver('custom')->transcribe(new TranscriptionRequest($this->file, 'audio/webm', 'bs'))->text);
    }
}
