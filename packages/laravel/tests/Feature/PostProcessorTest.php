<?php

namespace Ditactic\Dictation\Tests\Feature;

use Ditactic\Dictation\Contracts\TranscriptPostProcessor;
use Ditactic\Dictation\Facades\Dictation;
use Ditactic\Dictation\Models\Recording;
use Ditactic\Dictation\PostProcessors\AnthropicPostProcessor;
use Ditactic\Dictation\PostProcessors\NullPostProcessor;
use Ditactic\Dictation\Tests\TestCase;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;

class PostProcessorTest extends TestCase
{
    public function test_post_processing_is_off_by_default(): void
    {
        $this->assertInstanceOf(NullPostProcessor::class, app(TranscriptPostProcessor::class));
    }

    public function test_anthropic_processor_cleans_transcript_and_keeps_raw(): void
    {
        config([
            'dictation.postprocess.enabled' => true,
            'dictation.postprocess.driver' => 'anthropic',
            'dictation.postprocess.anthropic.api_key' => 'sk-ant-test',
        ]);
        $this->assertInstanceOf(AnthropicPostProcessor::class, app(TranscriptPostProcessor::class));

        Http::fake([
            'api.anthropic.com/v1/messages' => Http::response([
                'id' => 'msg_1', 'type' => 'message', 'role' => 'assistant', 'model' => 'claude-haiku-5-5',
                'content' => [['type' => 'text', 'text' => 'Pacijent se žali na bol u desnom hipohondriju. RR 120/80.']],
                'stop_reason' => 'end_turn',
            ]),
        ]);

        Dictation::fake('pacijent se žali na bol u desnom hipo hondriju RR sto dvadeset sa osamdeset');
        $user = $this->user();

        $response = $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload());

        $response->assertCreated()
            ->assertJsonPath('data.transcript', 'Pacijent se žali na bol u desnom hipohondriju. RR 120/80.')
            ->assertJsonPath('data.transcript_raw', 'pacijent se žali na bol u desnom hipo hondriju RR sto dvadeset sa osamdeset')
            ->assertJsonPath('data.final_text', 'Pacijent se žali na bol u desnom hipohondriju. RR 120/80.');

        Http::assertSent(function (Request $request) {
            $body = $request->data();

            return $request->url() === 'https://api.anthropic.com/v1/messages'
                && $request->hasHeader('x-api-key', 'sk-ant-test')
                && $request->hasHeader('anthropic-version', '2023-06-01')
                && $body['model'] === 'claude-haiku-5-5'
                && $body['max_tokens'] === 4096
                && $body['output_config'] === ['effort' => 'low']
                && str_contains($body['system'], 'Never add, remove or change medical facts')
                && str_contains($body['system'], 'language code is `bs`')
                && str_contains($body['system'], 'record field "Anamneza"')
                && $body['messages'] === [['role' => 'user', 'content' => 'pacijent se žali na bol u desnom hipo hondriju RR sto dvadeset sa osamdeset']];
        });
    }

    public function test_anthropic_failure_falls_back_to_raw_transcript(): void
    {
        config(['dictation.postprocess.enabled' => true, 'dictation.postprocess.anthropic.api_key' => 'sk-ant-test']);
        Http::fake(['api.anthropic.com/*' => Http::response(['error' => ['type' => 'overloaded_error']], 529)]);

        Dictation::fake('sirovi tekst');
        $this->actingAs($this->user())->postJson('/api/dictation', $this->uploadPayload())
            ->assertCreated()->assertJsonPath('data.status', 'done')->assertJsonPath('data.transcript', 'sirovi tekst');
    }

    public function test_anthropic_refusal_or_empty_answer_falls_back_to_raw_transcript(): void
    {
        $recording = new Recording(['language_hint' => 'bs']);
        $processor = new AnthropicPostProcessor(app(\Illuminate\Http\Client\Factory::class), ['api_key' => 'k']);

        Http::fakeSequence('api.anthropic.com/*')
            ->push(['content' => [], 'stop_reason' => 'refusal'])
            ->push(['content' => [['type' => 'text', 'text' => '   ']], 'stop_reason' => 'end_turn'])
            // Suspiciously long answer (model wrote an essay) is discarded
            ->push(['content' => [['type' => 'text', 'text' => str_repeat('bla ', 200)]], 'stop_reason' => 'end_turn'])
            ->push(['content' => [['type' => 'text', 'text' => 'Tekst.']], 'stop_reason' => 'end_turn']);

        $this->assertSame('tekst', $processor->process('tekst', $recording));
        $this->assertSame('tekst', $processor->process('tekst', $recording));
        $this->assertSame('tekst', $processor->process('tekst', $recording));
        $this->assertSame('Tekst.', $processor->process('tekst', $recording));
        Http::assertSentCount(4);
    }

    public function test_missing_api_key_skips_processing_without_http(): void
    {
        Http::fake();
        $processor = new AnthropicPostProcessor(app(\Illuminate\Http\Client\Factory::class), ['api_key' => null]);

        $this->assertSame('tekst', $processor->process('tekst', new Recording));
        Http::assertNothingSent();
    }

    public function test_custom_post_processor_class_can_be_configured(): void
    {
        config(['dictation.postprocess.enabled' => true, 'dictation.postprocess.driver' => UpperCaseProcessor::class]);

        Dictation::fake('mali tekst');
        $this->actingAs($this->user())->postJson('/api/dictation', $this->uploadPayload())
            ->assertCreated()->assertJsonPath('data.transcript', 'MALI TEKST')->assertJsonPath('data.transcript_raw', 'mali tekst');
    }
}

class UpperCaseProcessor implements TranscriptPostProcessor
{
    public function process(string $text, Recording $recording): string
    {
        return mb_strtoupper($text);
    }
}
