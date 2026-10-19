<?php

namespace Ditactic\Dictation\Contracts;

use Ditactic\Dictation\Models\Recording;

interface GlossaryProvider
{
    /**
     * Terms that help the engine recognise this recording (e.g. the clinic's
     * own procedure names). Each item is a string or an array
     * ['canonical' => 'Botoks', 'variants' => ['botox'], 'weight' => 2].
     *
     * @return array<int, string|array{canonical: string, variants?: array<int, string>, weight?: int|float}>
     */
    public function terms(Recording $recording): array;
}
