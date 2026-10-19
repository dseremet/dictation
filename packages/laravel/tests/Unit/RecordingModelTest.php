<?php

namespace Ditactic\Dictation\Tests\Unit;

use Ditactic\Dictation\Models\Recording;
use Ditactic\Dictation\Tests\TestCase;

class RecordingModelTest extends TestCase
{
    public function test_final_text_precedence_and_status_helpers(): void
    {
        $recording = new Recording(['transcript_raw' => 'raw']);
        $this->assertSame('raw', $recording->final_text);

        $recording->transcript = 'clean';
        $this->assertSame('clean', $recording->final_text);

        $recording->transcript_corrected = 'corrected';
        $this->assertSame('corrected', $recording->final_text);

        $this->assertTrue($recording->isPending());
        $recording->status = Recording::STATUS_DONE;
        $this->assertTrue($recording->isDone());
        $this->assertTrue($recording->isTerminal());
    }

    public function test_uuid_is_generated_and_used_as_route_key(): void
    {
        $user = $this->user();
        $recording = Recording::create(['owner_type' => 'user', 'owner_id' => $user->id, 'disk' => 'local', 'path' => 'x.webm']);

        $this->assertMatchesRegularExpression('/^[0-9a-f-]{36}$/', $recording->uuid);
        $this->assertSame('uuid', $recording->getRouteKeyName());
        $this->assertSame(config('dictation.table'), $recording->getTable());
        $this->assertTrue($recording->owner->is($user));
    }

    public function test_scopes(): void
    {
        $user = $this->user();
        $other = $this->user();
        $note = $this->note($user);

        $a = Recording::create(['owner_type' => 'user', 'owner_id' => $user->id, 'disk' => 'local', 'path' => 'a', 'status' => 'done', 'recordable_type' => 'note', 'recordable_id' => $note->id]);
        Recording::create(['owner_type' => 'user', 'owner_id' => $user->id, 'disk' => 'local', 'path' => 'b', 'status' => 'failed']);
        Recording::create(['owner_type' => 'user', 'owner_id' => $other->id, 'disk' => 'local', 'path' => 'c', 'status' => 'done']);

        $this->assertSame(2, Recording::forOwner($user)->count());
        $this->assertSame(2, Recording::forOwner('user', $user->id)->count());
        $this->assertSame(1, Recording::forOwner($user)->done()->count());
        $this->assertSame(1, Recording::forOwner($user)->failed()->count());
        $this->assertSame(1, Recording::forRecordable($note)->count());
        $this->assertTrue(Recording::forRecordable($note)->first()->recordable->is($note));
        $this->assertTrue($note->recordings->first()->is($a));
    }
}
