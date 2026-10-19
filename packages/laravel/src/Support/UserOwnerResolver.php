<?php

namespace Ditactic\Dictation\Support;

use Ditactic\Dictation\Contracts\OwnerResolver;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\Request;

/**
 * Default owner resolver: the authenticated user owns the recordings.
 * Multi-tenant apps replace this with e.g. [Partner::class, $user->partner_id].
 */
class UserOwnerResolver implements OwnerResolver
{
    public function resolve(Request $request, mixed $user): array
    {
        if (! $user instanceof Model) {
            throw new AuthenticationException('Dictation needs an authenticated user to resolve the recording owner.');
        }

        return [$user->getMorphClass(), $user->getKey()];
    }
}
