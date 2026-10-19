<?php

namespace Ditactic\Dictation\Tests\Feature;

use Ditactic\Dictation\Facades\Dictation;
use Ditactic\Dictation\Models\Recording;
use Ditactic\Dictation\Tests\Fixtures\Note;
use Ditactic\Dictation\Tests\Fixtures\NoteAuthorizer;
use Ditactic\Dictation\Tests\TestCase;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

class AuthorizationTest extends TestCase
{
    public function test_guests_get_401(): void
    {
        $this->postJson('/api/dictation', $this->uploadPayload())->assertUnauthorized();
        $this->getJson('/api/dictation/'.Str::uuid())->assertUnauthorized();
        $this->getJson('/api/dictation')->assertUnauthorized();
    }

    public function test_authorizer_receives_the_resolved_recordable_and_can_deny_create(): void
    {
        Dictation::fake('x');
        $user = $this->user();
        $other = $this->user();
        $foreignNote = $this->note($other);

        $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload([
            'recordable_type' => 'note',
            'recordable_id' => (string) $foreignNote->id,
        ]))->assertForbidden();

        $input = NoteAuthorizer::$createInputs[0];
        $this->assertInstanceOf(Note::class, $input['recordable']);
        $this->assertTrue($input['recordable']->is($foreignNote));
        $this->assertSame('bs', $input['language']);
        $this->assertSame(['user', $user->id], [$input['owner'][0], (int) $input['owner'][1]]);

        $this->assertSame(0, Recording::count());
        $this->assertSame([], Storage::disk('local')->allFiles());
    }

    public function test_read_only_user_cannot_create(): void
    {
        NoteAuthorizer::$denyAll = true;
        $user = $this->user();

        $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload())->assertForbidden();
    }

    public function test_other_users_cannot_view_update_stream_or_delete(): void
    {
        Dictation::fake('x');
        $owner = $this->user();
        $intruder = $this->user();

        $uuid = $this->actingAs($owner)->postJson('/api/dictation', $this->uploadPayload())->assertCreated()->json('data.uuid');

        $this->actingAs($intruder)->getJson("/api/dictation/{$uuid}")->assertForbidden();
        $this->actingAs($intruder)->get("/api/dictation/{$uuid}/audio")->assertForbidden();
        $this->actingAs($intruder)->patchJson("/api/dictation/{$uuid}", ['transcript_corrected' => 'hack'])->assertForbidden();
        $this->actingAs($intruder)->postJson("/api/dictation/{$uuid}/retry")->assertForbidden();
        $this->actingAs($intruder)->deleteJson("/api/dictation/{$uuid}")->assertForbidden();

        $this->assertNull(Recording::where('uuid', $uuid)->first()->transcript_corrected);
    }

    public function test_read_only_user_can_view_but_not_change(): void
    {
        Dictation::fake('x');
        $user = $this->user();
        $uuid = $this->actingAs($user)->postJson('/api/dictation', $this->uploadPayload())->json('data.uuid');

        NoteAuthorizer::$denyAll = true;

        $this->actingAs($user)->getJson("/api/dictation/{$uuid}")->assertOk();
        $this->actingAs($user)->get("/api/dictation/{$uuid}/audio")->assertOk();
        $this->actingAs($user)->patchJson("/api/dictation/{$uuid}", ['transcript_corrected' => 'x'])->assertForbidden();
        $this->actingAs($user)->deleteJson("/api/dictation/{$uuid}")->assertForbidden();
    }

    public function test_unknown_uuid_is_404(): void
    {
        $user = $this->user();

        $this->actingAs($user)->getJson('/api/dictation/'.Str::uuid())->assertNotFound();
        $this->actingAs($user)->getJson('/api/dictation/not-a-uuid')->assertNotFound();
    }
}
