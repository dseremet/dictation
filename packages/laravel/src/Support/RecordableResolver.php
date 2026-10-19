<?php

namespace Ditactic\Dictation\Support;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\Relation;

/**
 * Turns a `recordable_type` from the request into a model class.
 * Morph-map aliases always win; bare class names are accepted only when
 * listed in config('dictation.recordables').
 */
final class RecordableResolver
{
    /** @return class-string<Model>|null */
    public static function classFor(?string $type): ?string
    {
        if ($type === null || $type === '') {
            return null;
        }

        $mapped = Relation::getMorphedModel($type);
        if ($mapped !== null) {
            return $mapped;
        }

        $allowed = (array) config('dictation.recordables', []);
        $normalized = ltrim($type, '\\');

        foreach ($allowed as $class) {
            if (ltrim((string) $class, '\\') === $normalized && is_subclass_of($class, Model::class)) {
                return $class;
            }
        }

        return null;
    }

    public static function find(?string $type, int|string|null $id): ?Model
    {
        $class = self::classFor($type);

        if ($class === null || $id === null || $id === '') {
            return null;
        }

        return $class::query()->find($id);
    }
}
