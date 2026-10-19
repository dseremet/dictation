<?php

namespace Ditactic\Dictation\Tests\Feature;

use Ditactic\Dictation\DictationService;
use Ditactic\Dictation\DTO\TranscriptionRequest;
use Ditactic\Dictation\Events\RecordingCreated;
use Ditactic\Dictation\Events\TranscriptionCompleted;
use Ditactic\Dictation\Events\TranscriptionFailed;
use Ditactic\Dictation\Exceptions\TranscriptionException;
use Ditactic\Dictation\Facades\Dictation;
use Ditactic\Dictation\Jobs\TranscribeRecording;
use Ditactic\Dictation\Models\Recording;
use Ditactic\Dictation\Tests\TestCase;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;

class UploadFlowTest extends TestCase
{
    public function test_upload_is_stored_transcribed_and_returned_with_the_fake_driver(): void
    {
        Event::fake([RecordingCreated::class, TranscriptionCompleted::class, TranscriptionFailed::class]);
        $fake = Dictation::fake('Pacijent se žali na bol u desnom hipohondriju.');

        $user = $this->user();
        $note = $this->note($user);

        $response = $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload([
            'recordable_type' => 'note',
            'recordable_id' => (string) $note->id,
        ]));

        $response->assertCreated()
            ->assertJsonPath('data.status', 'done')
            ->assertJsonPath('data.language', 'bs')
            ->assertJsonPath('data.detected_language', 'bs')
            ->assertJsonPath('data.duration_ms', 4200)
            ->assertJsonPath('data.transcript', 'Pacijent se žali na bol u desnom hipohondriju.')
            ->assertJsonPath('data.transcript_raw', 'Pacijent se žali na bol u desnom hipohondriju.')
            ->assertJsonPath('data.transcript_corrected', null)
            ->assertJsonPath('data.final_text', 'Pacijent se žali na bol u desnom hipohondriju.')
            ->assertJsonPath('data.context.field_label', 'Anamneza')
            ->assertJsonPath('data.warnings', [])
            ->assertJsonPath('data.error', null)
            ->assertJsonStructure(['data' => ['uuid', 'status', 'language', 'detected_language', 'duration_ms', 'transcript', 'transcript_raw', 'transcript_corrected', 'final_text', 'context', 'warnings', 'created_at', 'audio_url', 'error']]);

        $uuid = $response->json('data.uuid');
        $this->assertStringEndsWith("/api/dictation/{$uuid}/audio", $response->json('data.audio_url'));

        $recording = Recording::where('uuid', $uuid)->firstOrFail();
        $this->assertSame('note', $recording->recordable_type);
        $this->assertSame($note->id, (int) $recording->recordable_id);
        $this->assertSame('user', $recording->owner_type);
        $this->assertSame($user->id, (int) $recording->owner_id);
        $this->assertSame($user->id, (int) $recording->user_id);
        $this->assertSame('audio/webm', $recording->mime);
        $this->assertSame("{$user->id}/{$uuid}.webm", $recording->path);
        $this->assertSame('fake', $recording->engine_model);
        $this->assertSame(1, $recording->attempts);
        $this->assertNotNull($recording->processed_at);
        $this->assertCount(1, $recording->segments);
        Storage::disk('local')->assertExists($recording->path);

        // Relation on the host model
        $this->assertTrue($note->recordings()->first()->is($recording));
        $this->assertTrue($note->latestRecording->is($recording));

        $fake->assertTranscribedCount(1);
        $fake->assertTranscribed(function (TranscriptionRequest $request) use ($recording) {
            return $request->language === 'bs'
                && $request->mime === 'audio/webm'
                && str_ends_with($request->path, $recording->path)
                && str_contains((string) $request->prompt, 'Anamneza.')
                && ! str_contains((string) $request->prompt, 'Amoksicilin')
                && in_array('Amoksicilin', array_column($request->glossary ?? [], 'canonical'), true)
                && $request->glossary[1]['canonical'] === 'Hipohondrij'
                && $request->glossary[1]['variants'] === ['hipo hondrij']
                && $request->glossary[1]['weight'] === 2;
        });

        Event::assertDispatched(RecordingCreated::class);
        Event::assertDispatched(TranscriptionCompleted::class, fn ($e) => $e->recording->is($recording));
        Event::assertNotDispatched(TranscriptionFailed::class);
    }

    public function test_upload_without_recordable_is_allowed(): void
    {
        Dictation::fake('Tekst.');
        $user = $this->user();

        $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload())
            ->assertCreated()
            ->assertJsonPath('data.recordable_type', null)
            ->assertJsonPath('data.status', 'done');
    }

    public function test_upload_queues_the_job_on_the_dictation_queue_and_stays_pending(): void
    {
        Queue::fake();
        $user = $this->user();

        $response = $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload(['audio' => $this->audioFile('a.m4a', 32, 'audio/mp4')]));

        $response->assertCreated()->assertJsonPath('data.status', 'pending')->assertJsonPath('data.transcript', null);

        $recording = Recording::firstOrFail();
        $this->assertStringEndsWith('.m4a', $recording->path);

        Queue::assertPushed(TranscribeRecording::class, function (TranscribeRecording $job) use ($recording) {
            return (string) $job->recordingId === (string) $recording->id
                && $job->queue === 'dictation'
                && $job->tries === 2
                && $job->timeout === 900
                && $job->backoff === [30, 120]
                && $job->afterCommit === true
                && $job->uniqueId() === (string) $recording->id;
        });
    }

    public function test_extension_follows_detected_mime_not_client_name(): void
    {
        Dictation::fake('x');
        $user = $this->user();

        $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload([
            'audio' => $this->audioFile('../../evil.txt', 8, 'video/webm'),
        ]))->assertCreated();

        $recording = Recording::firstOrFail();
        $this->assertSame("{$user->id}/{$recording->uuid}.webm", $recording->path);
        $this->assertSame('video/webm', $recording->mime);
    }

    public function test_language_defaults_to_config_when_omitted(): void
    {
        config(['dictation.language_default' => 'hr']);
        $fake = Dictation::fake('x');
        $user = $this->user();

        $payload = $this->uploadPayload();
        unset($payload['language']);

        $this->actingAs($user)->postJson('/api/dictation', $payload)->assertCreated()->assertJsonPath('data.language', 'hr');
        $this->assertSame('hr', $fake->lastRequest()->language);
    }

    public function test_permanent_engine_failure_marks_recording_failed_without_leaking_internals(): void
    {
        Event::fake([TranscriptionFailed::class, TranscriptionCompleted::class]);
        Dictation::fake()->failWith('Transcription engine returned HTTP 415: unsupported media at http://dictation-engine:8000/v1', retryable: false);
        $user = $this->user();

        $response = $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload());

        $response->assertCreated()
            ->assertJsonPath('data.status', 'failed')
            ->assertJsonPath('data.transcript', null);

        $this->assertStringContainsString('HTTP 415', $response->json('data.error'));
        $this->assertStringNotContainsString('http://', $response->json('data.error'));

        Event::assertDispatched(TranscriptionFailed::class, fn ($e) => $e->willRetry === false);
        Event::assertNotDispatched(TranscriptionCompleted::class);
    }

    public function test_retryable_failure_keeps_recording_pending_and_rethrows_for_the_worker(): void
    {
        Event::fake([TranscriptionFailed::class]);
        $fake = Dictation::fake();
        $fake->respondWith([TranscriptionException::retryable('engine busy', 503), 'Drugi pokušaj uspio.']);
        $user = $this->user();

        $recording = $this->makeRecording($user);
        $job = new TranscribeRecording($recording->id);

        try {
            $job->handle(app(DictationService::class));
            $this->fail('Expected the retryable exception to be rethrown.');
        } catch (TranscriptionException $e) {
            $this->assertTrue($e->isRetryable());
        }

        $recording->refresh();
        $this->assertSame('pending', $recording->status);
        $this->assertSame('engine busy', $recording->error);
        $this->assertSame(1, $recording->attempts);
        Event::assertDispatched(TranscriptionFailed::class, fn ($e) => $e->willRetry === true);

        // Second attempt succeeds
        $job->handle(app(DictationService::class));
        $recording->refresh();
        $this->assertSame('done', $recording->status);
        $this->assertSame('Drugi pokušaj uspio.', $recording->transcript);
        $this->assertNull($recording->error);
        $this->assertSame(2, $recording->attempts);
    }

    public function test_job_failed_hook_marks_recording_failed(): void
    {
        $user = $this->user();
        $recording = $this->makeRecording($user, ['status' => 'processing']);

        (new TranscribeRecording($recording->id))->failed(new \RuntimeException('worker timeout'));

        $recording->refresh();
        $this->assertSame('failed', $recording->status);
        $this->assertSame('RuntimeException: worker timeout', $recording->error);
    }

    public function test_job_skips_recordings_that_are_already_done(): void
    {
        $fake = Dictation::fake('new text');
        $user = $this->user();
        $recording = $this->makeRecording($user, ['status' => 'done', 'transcript' => 'old text']);

        (new TranscribeRecording($recording->id))->handle(app(DictationService::class));

        $this->assertSame('old text', $recording->fresh()->transcript);
        $fake->assertNothingTranscribed();
    }

    public function test_job_handles_missing_audio_file_as_permanent_failure(): void
    {
        Dictation::fake('x');
        $user = $this->user();
        $recording = $this->makeRecording($user, ['path' => 'missing/file.webm']);

        (new TranscribeRecording($recording->id))->handle(app(DictationService::class));

        $recording->refresh();
        $this->assertSame('failed', $recording->status);
        $this->assertStringContainsString('missing from storage', $recording->error);
    }

    public function test_show_update_retry_and_destroy(): void
    {
        Dictation::fake('Originalni tekst.');
        $user = $this->user();

        $uuid = $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload())->json('data.uuid');

        $this->actingAs($user)->getJson("/api/dictation/{$uuid}")
            ->assertOk()->assertJsonPath('data.uuid', $uuid)->assertJsonPath('data.status', 'done');

        $this->actingAs($user)->patchJson("/api/dictation/{$uuid}", ['transcript_corrected' => '  Ispravljeni tekst.  '])
            ->assertOk()
            ->assertJsonPath('data.transcript_corrected', 'Ispravljeni tekst.')
            ->assertJsonPath('data.final_text', 'Ispravljeni tekst.')
            ->assertJsonPath('data.transcript', 'Originalni tekst.');

        $this->actingAs($user)->patchJson("/api/dictation/{$uuid}", ['transcript_corrected' => null])
            ->assertOk()->assertJsonPath('data.final_text', 'Originalni tekst.');

        $this->actingAs($user)->patchJson("/api/dictation/{$uuid}", [])
            ->assertUnprocessable()->assertJsonValidationErrors('transcript_corrected');

        // retry on a done recording is a no-op
        $this->actingAs($user)->postJson("/api/dictation/{$uuid}/retry")->assertOk()->assertJsonPath('data.status', 'done');

        // retry on a failed one re-runs the job
        Recording::where('uuid', $uuid)->update(['status' => 'failed', 'error' => 'boom']);
        Dictation::fake('Nakon ponovnog pokušaja.');
        $this->actingAs($user)->postJson("/api/dictation/{$uuid}/retry")
            ->assertStatus(202)->assertJsonPath('data.status', 'done')->assertJsonPath('data.transcript', 'Nakon ponovnog pokušaja.')->assertJsonPath('data.error', null);

        $recording = Recording::where('uuid', $uuid)->firstOrFail();
        $path = $recording->path;
        Storage::disk('local')->assertExists($path);

        $this->actingAs($user)->deleteJson("/api/dictation/{$uuid}")->assertNoContent();

        Storage::disk('local')->assertMissing($path);
        $this->assertSoftDeleted($recording);
        $this->actingAs($user)->getJson("/api/dictation/{$uuid}")->assertNotFound();
    }

    public function test_retry_on_a_recording_still_processing_is_rejected(): void
    {
        $user = $this->user();
        $recording = $this->makeRecording($user, ['status' => 'processing']);

        $this->actingAs($user)->postJson("/api/dictation/{$recording->uuid}/retry")->assertStatus(409);
    }

    public function test_index_lists_recordings_for_a_recordable_and_for_the_owner(): void
    {
        $user = $this->user();
        $other = $this->user();
        $note = $this->note($user);
        $otherNote = $this->note($other);

        $a = $this->makeRecording($user, ['recordable_type' => 'note', 'recordable_id' => $note->id]);
        $b = $this->makeRecording($user, ['recordable_type' => 'note', 'recordable_id' => $note->id, 'status' => 'failed']);
        $c = $this->makeRecording($user);
        $this->makeRecording($other, ['recordable_type' => 'note', 'recordable_id' => $otherNote->id]);

        $this->actingAs($user)->getJson('/api/dictation?recordable_type=note&recordable_id='.$note->id)
            ->assertOk()->assertJsonCount(2, 'data')
            ->assertJsonPath('data.0.uuid', $b->uuid)
            ->assertJsonPath('data.1.uuid', $a->uuid);

        $this->actingAs($user)->getJson('/api/dictation?recordable_type=note&recordable_id='.$note->id.'&status=failed')
            ->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.uuid', $b->uuid);

        $this->actingAs($user)->getJson('/api/dictation')
            ->assertOk()->assertJsonCount(3, 'data')->assertJsonPath('data.0.uuid', $c->uuid);

        $this->actingAs($user)->getJson('/api/dictation?recordable_type=note&recordable_id='.$otherNote->id)
            ->assertOk()->assertJsonCount(0, 'data');

        $this->actingAs($user)->getJson('/api/dictation?recordable_type=bogus&recordable_id=1')
            ->assertUnprocessable()->assertJsonValidationErrors('recordable_type');
    }

    protected function makeRecording($user, array $attributes = []): Recording
    {
        $uuid = (string) \Illuminate\Support\Str::uuid();
        $path = "{$user->id}/{$uuid}.webm";
        Storage::disk('local')->put($path, str_repeat('a', 128));

        return Recording::create(array_merge([
            'uuid' => $uuid,
            'owner_type' => 'user',
            'owner_id' => $user->id,
            'user_id' => $user->id,
            'language_hint' => 'bs',
            'status' => 'pending',
            'disk' => 'local',
            'path' => $path,
            'mime' => 'audio/webm',
            'size_bytes' => 128,
        ], $attributes));
    }
}
