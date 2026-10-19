<?php

namespace Ditactic\Dictation\Tests\Feature;

use Ditactic\Dictation\Facades\Dictation;
use Ditactic\Dictation\Tests\TestCase;

class RoutesWithoutAudioTest extends TestCase
{
    protected function defineRoutes($router): void
    {
        $router->middleware('auth')->prefix('api/dictation')->name('dictation.')->group(function () {
            Dictation::routes(['except' => ['audio']]);
        });
    }

    public function test_audio_url_is_null_when_the_audio_route_is_not_mounted(): void
    {
        Dictation::fake('x');

        $this->actingAs($this->user())->postJson('/api/dictation', $this->uploadPayload())
            ->assertCreated()
            ->assertJsonPath('data.audio_url', null);

        $this->assertNull(Dictation::routeName('audio'));
        $this->assertSame('dictation.show', Dictation::routeName('show'));
    }
}
