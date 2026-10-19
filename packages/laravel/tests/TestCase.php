<?php

namespace Ditactic\Dictation\Tests;

use Ditactic\Dictation\DictationServiceProvider;
use Ditactic\Dictation\Facades\Dictation;
use Ditactic\Dictation\Tests\Fixtures\Note;
use Ditactic\Dictation\Tests\Fixtures\NoteAuthorizer;
use Ditactic\Dictation\Tests\Fixtures\User;
use Illuminate\Database\Eloquent\Relations\Relation;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Routing\Router;
use Illuminate\Support\Facades\Storage;
use Orchestra\Testbench\TestCase as Orchestra;

abstract class TestCase extends Orchestra
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake('local');
        Relation::morphMap(['note' => Note::class, 'user' => User::class]);
        NoteAuthorizer::reset();
    }

    protected function tearDown(): void
    {
        Relation::morphMap([], false);

        parent::tearDown();
    }

    protected function getPackageProviders($app): array
    {
        return [DictationServiceProvider::class];
    }

    protected function getPackageAliases($app): array
    {
        return ['Dictation' => Dictation::class];
    }

    protected function defineEnvironment($app): void
    {
        // Tests run only on Testbench's in-memory SQLite connection.
        $app['config']->set('database.default', 'testing');
        $app['config']->set('database.connections.testing', [
            'driver' => 'sqlite',
            'database' => ':memory:',
            'prefix' => '',
            'foreign_key_constraints' => true,
        ]);

        $app['config']->set('app.key', 'base64:2fl+Ktvkfl+Fuz4Qp/A75G2RTiWVA/ZoKZvp6fiiM10=');
        $app['config']->set('auth.providers.users.model', User::class);
        $app['config']->set('queue.default', 'sync');
        $app['config']->set('queue.failed.driver', 'null');
        $app['config']->set('cache.default', 'array');
        $app['config']->set('filesystems.default', 'local');

        $app['config']->set('dictation.driver', 'fake');
        $app['config']->set('dictation.storage.disk', 'local');
        $app['config']->set('dictation.authorizer', NoteAuthorizer::class);
        $app['config']->set('dictation.prompt_terms', ['Amoksicilin', ['canonical' => 'Hipohondrij', 'variants' => ['hipo hondrij'], 'weight' => 2]]);
    }

    protected function defineDatabaseMigrations(): void
    {
        $this->loadMigrationsFrom(__DIR__.'/Fixtures/migrations');
    }

    protected function defineRoutes($router): void
    {
        /** @var Router $router */
        $router->middleware('auth')->prefix('api/dictation')->name('dictation.')->group(function () {
            Dictation::routes();
        });
    }

    // ---------------------------------------------------------------- helpers

    protected function user(array $attributes = []): User
    {
        static $i = 0;
        $i++;

        return User::create(array_merge([
            'name' => "Doctor {$i}",
            'email' => "doctor{$i}@example.test",
            'password' => 'secret',
        ], $attributes));
    }

    protected function note(User $user, array $attributes = []): Note
    {
        return Note::create(array_merge(['user_id' => $user->id, 'title' => 'Anamneza'], $attributes));
    }

    protected function audioFile(string $name = 'rec.webm', int $kb = 64, string $mime = 'audio/webm'): UploadedFile
    {
        return UploadedFile::fake()->create($name, $kb, $mime);
    }

    protected function uploadPayload(array $overrides = []): array
    {
        return array_merge([
            'audio' => $this->audioFile(),
            'language' => 'bs',
            'duration_ms' => 4200,
            'context' => ['question_key' => 'anamneza', 'field_label' => 'Anamneza'],
        ], $overrides);
    }
}
