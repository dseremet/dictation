<?php

namespace Ditactic\Dictation\Tests\Unit;

use Ditactic\Dictation\Contracts\GlossaryProvider;
use Ditactic\Dictation\Models\Recording;
use Ditactic\Dictation\Support\PromptBuilder;
use Ditactic\Dictation\Tests\TestCase;

class PromptBuilderTest extends TestCase
{
    public function test_merges_config_terms_provider_terms_and_field_label(): void
    {
        config(['dictation.prompt_terms' => ['Amoksicilin', 'amoksicilin', ['canonical' => 'EKG', 'weight' => 3]]]);

        $this->app->instance(GlossaryProvider::class, new class implements GlossaryProvider
        {
            public function terms(Recording $recording): array
            {
                return ['Botoks', ['canonical' => 'Amoksicilin', 'variants' => ['amoxicillin']], '', 42, null];
            }
        });

        $recording = new Recording(['context' => ['field_label' => 'Terapija:']]);
        $built = app(PromptBuilder::class)->build($recording);

        // Terms stay out of the free-text prompt by default (they go as hotwords).
        $this->assertSame('Terapija.', $built['prompt']);

        config(['dictation.prompt_include_terms' => true]);
        $this->assertSame('Terapija. Amoksicilin, EKG, Botoks, 42.', app(PromptBuilder::class)->build($recording)['prompt']);
        $this->assertSame([
            ['canonical' => 'Amoksicilin', 'variants' => ['amoxicillin'], 'weight' => 1],
            ['canonical' => 'EKG', 'variants' => [], 'weight' => 3],
            ['canonical' => 'Botoks', 'variants' => [], 'weight' => 1],
            ['canonical' => '42', 'variants' => [], 'weight' => 1],
        ], $built['glossary']);
    }

    public function test_empty_when_nothing_configured(): void
    {
        config(['dictation.prompt_terms' => []]);

        $built = app(PromptBuilder::class)->build(new Recording);

        $this->assertNull($built['prompt']);
        $this->assertSame([], $built['glossary']);
    }

    public function test_respects_limits(): void
    {
        config(['dictation.prompt_terms' => array_map(fn ($i) => "Termin{$i}", range(1, 100)), 'dictation.prompt_max_terms' => 10, 'dictation.prompt_max_chars' => 60, 'dictation.prompt_include_terms' => true]);

        $built = app(PromptBuilder::class)->build(new Recording);

        $this->assertCount(10, $built['glossary']);
        $this->assertLessThanOrEqual(60, mb_strlen($built['prompt']));
        $this->assertStringStartsWith('Termin1, Termin2', $built['prompt']);
    }
}
