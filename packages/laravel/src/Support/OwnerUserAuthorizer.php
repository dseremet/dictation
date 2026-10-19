<?php

namespace Ditactic\Dictation\Support;

use Ditactic\Dictation\Contracts\RecordingAuthorizer;
use Ditactic\Dictation\Models\Recording;
use Illuminate\Database\Eloquent\Model;

/**
 * Default authorizer: a user may create recordings and manage the ones whose
 * owner is the user itself (or that the user uploaded). Suitable for
 * single-tenant apps; multi-tenant apps bind their own implementation.
 */
class OwnerUserAuthorizer implements RecordingAuthorizer
{
    public function canCreate(mixed $user, array $input): bool
    {
        return $user instanceof Model;
    }

    public function canView(mixed $user, Recording $recording): bool
    {
        return $this->owns($user, $recording);
    }

    public function canUpdate(mixed $user, Recording $recording): bool
    {
        return $this->owns($user, $recording);
    }

    public function canDelete(mixed $user, Recording $recording): bool
    {
        return $this->owns($user, $recording);
    }

    protected function owns(mixed $user, Recording $recording): bool
    {
        if (! $user instanceof Model) {
            return false;
        }

        $isOwner = $recording->owner_type === $user->getMorphClass()
            && (string) $recording->owner_id === (string) $user->getKey();

        $isUploader = $recording->user_id !== null
            && (string) $recording->user_id === (string) $user->getKey();

        return $isOwner || $isUploader;
    }
}
