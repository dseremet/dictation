<?php

namespace Ditactic\Dictation\Contracts;

use Ditactic\Dictation\Models\Recording;

/**
 * Host applications bind this contract to decide who may do what.
 *
 * `$user` is the authenticated user (may be null for guest routes) and
 * `$input` on create is the validated upload payload plus `recordable`
 * (the resolved model instance or null) and `owner` ([type, id]).
 */
interface RecordingAuthorizer
{
    public function canCreate(mixed $user, array $input): bool;

    public function canView(mixed $user, Recording $recording): bool;

    public function canUpdate(mixed $user, Recording $recording): bool;

    public function canDelete(mixed $user, Recording $recording): bool;
}
