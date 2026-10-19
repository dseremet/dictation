<?php

namespace Ditactic\Dictation\Tests\Feature;

use Ditactic\Dictation\Facades\Dictation;
use Ditactic\Dictation\Models\Recording;
use Ditactic\Dictation\Tests\TestCase;
use Illuminate\Support\Facades\Storage;

class AudioStreamTest extends TestCase
{
    public function test_audio_streams_privately_with_range_support(): void
    {
        Dictation::fake('x');
        $user = $this->user();
        $uuid = $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload([
            'audio' => $this->audioFile('rec.ogg', 2, 'audio/ogg'),
        ]))->json('data.uuid');

        $recording = Recording::where('uuid', $uuid)->firstOrFail();
        Storage::disk('local')->put($recording->path, 'abcdefghijklmnopqrstuvwxyz');

        $response = $this->actingAs($user)->get("/api/dictation/{$uuid}/audio");
        $response->assertOk();
        $response->assertHeader('Content-Type', 'audio/ogg');
        $response->assertHeader('Accept-Ranges', 'bytes');
        $this->assertStringContainsString('no-store', $response->headers->get('Cache-Control'));
        $this->assertStringContainsString('private', $response->headers->get('Cache-Control'));
        $this->assertStringContainsString('inline', $response->headers->get('Content-Disposition'));
        $this->assertSame('abcdefghijklmnopqrstuvwxyz', $response->getFile()->getContent());

        $partial = $this->actingAs($user)->get("/api/dictation/{$uuid}/audio", ['Range' => 'bytes=0-9']);
        $partial->assertStatus(206);
        $partial->assertHeader('Content-Range', 'bytes 0-9/26');
        $partial->assertHeader('Content-Length', '10');
    }

    public function test_missing_file_is_404(): void
    {
        $user = $this->user();
        $recording = Recording::create([
            'owner_type' => 'user', 'owner_id' => $user->id, 'user_id' => $user->id,
            'disk' => 'local', 'path' => "{$user->id}/gone.webm", 'mime' => 'audio/webm',
        ]);

        $this->actingAs($user)->get("/api/dictation/{$recording->uuid}/audio")->assertNotFound();
    }
}
