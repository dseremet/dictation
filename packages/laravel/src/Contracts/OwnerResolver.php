<?php

namespace Ditactic\Dictation\Contracts;

use Illuminate\Http\Request;

interface OwnerResolver
{
    /**
     * Resolve the owner (tenant) of recordings created in this request.
     *
     * @return array{0: class-string, 1: int|string} [owner model class, owner id]
     */
    public function resolve(Request $request, mixed $user): array;
}
