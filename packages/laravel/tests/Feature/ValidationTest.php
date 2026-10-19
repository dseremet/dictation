<?php

namespace Ditactic\Dictation\Tests\Feature;

use Ditactic\Dictation\Facades\Dictation;
use Ditactic\Dictation\Models\Recording;
use Ditactic\Dictation\Tests\TestCase;
use Illuminate\Http\UploadedFile;

class ValidationTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        Dictation::fake('x');
    }

    public function test_audio_is_required(): void
    {
        $this->actingAs($this->user())->postJson('/api/dictation', ['language' => 'bs'])
            ->assertUnprocessable()->assertJsonValidationErrors('audio');
    }

    public function test_non_audio_mime_is_rejected(): void
    {
        $this->actingAs($this->user())->postJson('/api/dictation', $this->uploadPayload([
            'audio' => UploadedFile::fake()->create('notes.txt', 10, 'text/plain'),
        ]))->assertUnprocessable()->assertJsonValidationErrors('audio');

        $this->actingAs($this->user())->postJson('/api/dictation', $this->uploadPayload([
            'audio' => UploadedFile::fake()->create('shell.php', 10, 'application/x-php'),
        ]))->assertUnprocessable()->assertJsonValidationErrors('audio');

        $this->assertSame(0, Recording::count());
    }

    public function test_every_configured_mime_is_accepted(): void
    {
        $user = $this->user();

        foreach (['audio/webm' => 'webm', 'video/webm' => 'webm', 'audio/ogg' => 'ogg', 'audio/mp4' => 'm4a', 'audio/x-m4a' => 'm4a', 'audio/aac' => 'aac', 'audio/mpeg' => 'mp3', 'audio/wav' => 'wav', 'audio/x-wav' => 'wav'] as $mime => $ext) {
            $response = $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload([
                'audio' => UploadedFile::fake()->create('blob', 4, $mime),
            ]));
            $response->assertCreated();
            $this->assertStringEndsWith(".{$ext}", Recording::where('uuid', $response->json('data.uuid'))->value('path'), $mime);
        }
    }

    public function test_file_larger_than_limit_is_rejected(): void
    {
        config(['dictation.limits.max_size_kb' => 100]);

        $this->actingAs($this->user())->postJson('/api/dictation', $this->uploadPayload([
            'audio' => $this->audioFile('big.webm', 101),
        ]))->assertUnprocessable()->assertJsonValidationErrors('audio');

        $this->actingAs($this->user())->postJson('/api/dictation', $this->uploadPayload([
            'audio' => $this->audioFile('ok.webm', 100),
        ]))->assertCreated();
    }

    public function test_language_must_be_configured_or_auto(): void
    {
        $user = $this->user();

        $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload(['language' => 'de']))
            ->assertUnprocessable()->assertJsonValidationErrors('language');

        $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload(['language' => 'auto']))->assertCreated();
        $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload(['language' => 'hr']))->assertCreated();
    }

    public function test_duration_must_be_a_non_negative_integer_within_the_limit(): void
    {
        $user = $this->user();

        $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload(['duration_ms' => 'abc']))
            ->assertUnprocessable()->assertJsonValidationErrors('duration_ms');
        $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload(['duration_ms' => -1]))
            ->assertUnprocessable()->assertJsonValidationErrors('duration_ms');
        $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload(['duration_ms' => 600001]))
            ->assertUnprocessable()->assertJsonValidationErrors('duration_ms');
    }

    public function test_context_must_be_shallow_and_bounded(): void
    {
        $user = $this->user();

        $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload(['context' => ['nested' => ['a' => 1]]]))
            ->assertUnprocessable()->assertJsonValidationErrors('context.nested');

        $tooMany = [];
        for ($i = 0; $i < 21; $i++) {
            $tooMany["k{$i}"] = 'v';
        }
        $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload(['context' => $tooMany]))
            ->assertUnprocessable()->assertJsonValidationErrors('context');

        $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload(['context' => ['long' => str_repeat('x', 501)]]))
            ->assertUnprocessable()->assertJsonValidationErrors('context.long');

        $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload(['context' => ['question_key' => 'dg', 'order' => 3]]))
            ->assertCreated()->assertJsonPath('data.context.order', 3);
    }

    public function test_recordable_must_resolve_through_the_morph_map_or_allow_list(): void
    {
        $user = $this->user();
        $note = $this->note($user);

        $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload(['recordable_type' => 'note']))
            ->assertUnprocessable()->assertJsonValidationErrors('recordable_id');

        $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload(['recordable_type' => 'invoice', 'recordable_id' => '1']))
            ->assertUnprocessable()->assertJsonValidationErrors('recordable_type');

        // Bare class names are not accepted unless allow-listed
        $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload(['recordable_type' => \Ditactic\Dictation\Tests\Fixtures\User::class, 'recordable_id' => (string) $user->id]))
            ->assertUnprocessable()->assertJsonValidationErrors('recordable_type');

        $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload(['recordable_type' => 'note', 'recordable_id' => '999']))
            ->assertUnprocessable()->assertJsonValidationErrors('recordable_id');

        $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload(['recordable_type' => 'note', 'recordable_id' => (string) $note->id]))
            ->assertCreated()->assertJsonPath('data.recordable_type', 'note');
    }
}
