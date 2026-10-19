<?php

namespace Ditactic\Dictation\Tests\Feature;

use Ditactic\Dictation\Facades\Dictation;
use Ditactic\Dictation\Jobs\TranscribeRecording;
use Ditactic\Dictation\Models\Recording;
use Ditactic\Dictation\Tests\TestCase;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

class CommandsTest extends TestCase
{
    public function test_health_with_fake_driver(): void
    {
        $this->artisan('dictation:health')->expectsOutputToContain('Driver: fake')->assertSuccessful();
    }

    public function test_health_pings_engine(): void
    {
        config(['dictation.drivers.openai_compatible.url' => 'http://engine.test:8000', 'dictation.drivers.openai_compatible.token' => 'tok']);
        Http::fake([
            'engine.test:8000/health' => Http::response(['status' => 'ok', 'model' => 'turbo']),
            'engine.test:8000/v1/models' => Http::response(['object' => 'list', 'data' => [['id' => 'turbo', 'object' => 'model']]]),
        ]);

        $this->artisan('dictation:health', ['--driver' => 'openai_compatible'])
            ->expectsOutputToContain('GET /health -> HTTP 200')
            ->expectsOutputToContain('- turbo')
            ->expectsOutputToContain('Engine is reachable.')
            ->assertSuccessful();

        Http::assertSent(fn ($r) => $r->hasHeader('Authorization', 'Bearer tok'));
    }

    public function test_health_fails_when_engine_is_down(): void
    {
        config(['dictation.drivers.openai_compatible.url' => 'http://engine.test:8000']);
        Http::fake(['engine.test:8000/*' => Http::response('loading', 503)]);

        $this->artisan('dictation:health', ['--driver' => 'openai_compatible'])->assertFailed();
    }

    public function test_transcribe_command_runs_synchronously(): void
    {
        Dictation::fake('Komandni tekst.');
        $recording = $this->pendingRecording();

        $this->artisan('dictation:transcribe', ['uuid' => $recording->uuid])
            ->expectsOutputToContain('Komandni tekst.')
            ->assertSuccessful();

        $this->assertSame('done', $recording->fresh()->status);
    }

    public function test_transcribe_command_marks_failed_on_error(): void
    {
        Dictation::fake()->failWith('nope');
        $recording = $this->pendingRecording();

        $this->artisan('dictation:transcribe', ['uuid' => $recording->uuid])->assertFailed();

        $this->assertSame('failed', $recording->fresh()->status);
        $this->assertSame('nope', $recording->fresh()->error);
    }

    public function test_transcribe_command_unknown_uuid(): void
    {
        $this->artisan('dictation:transcribe', ['uuid' => (string) Str::uuid()])->assertFailed();
    }

    public function test_requeue_failed_and_stuck(): void
    {
        Queue::fake();

        $failed = $this->pendingRecording(['status' => 'failed', 'error' => 'boom']);
        $done = $this->pendingRecording(['status' => 'done']);
        $fresh = $this->pendingRecording(['status' => 'processing']);
        $stuck = $this->pendingRecording(['status' => 'processing']);
        Recording::where('id', $stuck->id)->update(['updated_at' => now()->subHours(2)]);

        $this->artisan('dictation:requeue', ['--failed' => true, '--dry-run' => true])->expectsOutputToContain('Would re-queue 1')->assertSuccessful();
        Queue::assertNothingPushed();

        $this->artisan('dictation:requeue')->expectsOutputToContain('Re-queued 1')->assertSuccessful();
        Queue::assertPushed(TranscribeRecording::class, fn ($job) => (string) $job->recordingId === (string) $failed->id);
        $this->assertSame('pending', $failed->fresh()->status);
        $this->assertNull($failed->fresh()->error);

        $this->artisan('dictation:requeue', ['--stuck' => 60])->expectsOutputToContain('Re-queued 1')->assertSuccessful();
        Queue::assertPushed(TranscribeRecording::class, fn ($job) => (string) $job->recordingId === (string) $stuck->id);
        Queue::assertNotPushed(TranscribeRecording::class, fn ($job) => in_array((string) $job->recordingId, [(string) $done->id, (string) $fresh->id], true));
    }

    protected function pendingRecording(array $attributes = []): Recording
    {
        $user = $this->user();
        $uuid = (string) Str::uuid();
        Storage::disk('local')->put("{$user->id}/{$uuid}.webm", 'audio');

        return Recording::create(array_merge([
            'uuid' => $uuid, 'owner_type' => 'user', 'owner_id' => $user->id, 'user_id' => $user->id,
            'language_hint' => 'bs', 'disk' => 'local', 'path' => "{$user->id}/{$uuid}.webm", 'mime' => 'audio/webm', 'size_bytes' => 5,
        ], $attributes));
    }
}
