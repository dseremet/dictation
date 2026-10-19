<?php

namespace Ditactic\Dictation\Tests\Fixtures;

use Ditactic\Dictation\Contracts\RecordingAuthorizer;
use Ditactic\Dictation\Models\Recording;

/**
 * Test authorizer: a user may attach recordings to their own notes and
 * manage recordings they own. `$denyAll` simulates a read-only account.
 */
class NoteAuthorizer implements RecordingAuthorizer
{
    public static bool $denyAll = false;

    /** @var array<int, array> inputs seen by canCreate */
    public static array $createInputs = [];

    public static function reset(): void
    {
        static::$denyAll = false;
        static::$createInputs = [];
    }

    public function canCreate(mixed $user, array $input): bool
    {
        static::$createInputs[] = $input;

        if (static::$denyAll || ! $user instanceof User) {
            return false;
        }

        $recordable = $input['recordable'] ?? null;

        return $recordable === null || ($recordable instanceof Note && (int) $recordable->user_id === (int) $user->id);
    }

    public function canView(mixed $user, Recording $recording): bool
    {
        return $this->owns($user, $recording);
    }

    public function canUpdate(mixed $user, Recording $recording): bool
    {
        return ! static::$denyAll && $this->owns($user, $recording);
    }

    public function canDelete(mixed $user, Recording $recording): bool
    {
        return ! static::$denyAll && $this->owns($user, $recording);
    }

    protected function owns(mixed $user, Recording $recording): bool
    {
        return $user instanceof User
            && $recording->owner_type === $user->getMorphClass()
            && (int) $recording->owner_id === (int) $user->id;
    }
}
