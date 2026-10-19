<?php

namespace Ditactic\Dictation;

use Closure;
use Ditactic\Dictation\Contracts\Transcriber;
use Ditactic\Dictation\DTO\TranscriptionResult;
use Ditactic\Dictation\Drivers\FakeTranscriber;
use Ditactic\Dictation\Drivers\OpenAiCompatibleTranscriber;
use Ditactic\Dictation\Http\Controllers\RecordingController;
use Illuminate\Http\Client\Factory as HttpFactory;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Manager;
use Throwable;

/**
 * @method Transcriber driver(string|null $driver = null)
 * @method TranscriptionResult transcribe(\Ditactic\Dictation\DTO\TranscriptionRequest $request)
 */
class DictationManager extends Manager
{
    public const ROUTE_ACTIONS = ['index', 'store', 'show', 'update', 'destroy', 'audio', 'retry'];

    /** @var array<string, string> action => fully qualified route name, filled by routes() */
    protected array $routeNames = [];

    protected bool $routeNamesResolved = false;

    public function getDefaultDriver(): string
    {
        return (string) $this->config->get('dictation.driver', 'openai_compatible');
    }

    protected function createOpenaiCompatibleDriver(): Transcriber
    {
        return new OpenAiCompatibleTranscriber(
            $this->container->make(HttpFactory::class),
            (array) $this->config->get('dictation.drivers.openai_compatible', []),
        );
    }

    protected function createFakeDriver(): Transcriber
    {
        return new FakeTranscriber((array) $this->config->get('dictation.drivers.fake', []));
    }

    /**
     * Swap the transcriber for the fake and run jobs synchronously, for host
     * test suites. Returns the fake so you can assert on it.
     *
     * @param  string|TranscriptionResult|Throwable|Closure|array|null  $response  See FakeTranscriber::respondWith().
     */
    public function fake(string|TranscriptionResult|Throwable|Closure|array|null $response = null): FakeTranscriber
    {
        $this->config->set('dictation.driver', 'fake');
        $this->config->set('dictation.queue.connection', 'sync');
        $this->forgetDrivers();

        /** @var FakeTranscriber $fake */
        $fake = $this->driver('fake');

        if ($response !== null) {
            $fake->respondWith($response);
        }

        return $fake;
    }

    /**
     * Register the recording routes inside the caller's route group. Route
     * names are relative to the group's name prefix:
     * index, store, show, update, destroy, audio, retry.
     *
     * @param  array{only?: array<int, string>, except?: array<int, string>}  $options
     */
    public function routes(array $options = []): void
    {
        $actions = self::ROUTE_ACTIONS;

        if (! empty($options['only'])) {
            $actions = array_values(array_intersect($actions, (array) $options['only']));
        }
        if (! empty($options['except'])) {
            $actions = array_values(array_diff($actions, (array) $options['except']));
        }

        $controller = $this->config->get('dictation.controller', RecordingController::class);

        $definitions = [
            'index' => ['get', '/', 'index'],
            'store' => ['post', '/', 'store'],
            'show' => ['get', '{recording}', 'show'],
            'update' => ['patch', '{recording}', 'update'],
            'destroy' => ['delete', '{recording}', 'destroy'],
            'audio' => ['get', '{recording}/audio', 'audio'],
            'retry' => ['post', '{recording}/retry', 'retry'],
        ];

        foreach ($actions as $action) {
            [$method, $uri, $handler] = $definitions[$action];

            $route = Route::{$method}($uri, [$controller, $handler])->name($action);

            if (str_contains($uri, '{recording}')) {
                $route->where('recording', '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}');
            }

            $this->routeNames[$action] = (string) $route->getName();
        }

        // Names are assigned after the routes were added to the collection; when routes() runs
        // after the application has booted (tests, late-registered groups) nobody refreshes for us.
        Route::getRoutes()->refreshNameLookups();
        Route::getRoutes()->refreshActionLookups();
    }

    /** Fully qualified route name for an action, or null if it is not registered. */
    public function routeName(string $action): ?string
    {
        if (isset($this->routeNames[$action]) && Route::has($this->routeNames[$action])) {
            return $this->routeNames[$action];
        }

        // Routes may come from the route cache, in which case routes() never ran: look the action up.
        if (! $this->routeNamesResolved) {
            $this->routeNamesResolved = true;
            $controller = $this->config->get('dictation.controller', RecordingController::class);

            foreach (self::ROUTE_ACTIONS as $candidate) {
                $route = Route::getRoutes()->getByAction($controller.'@'.$candidate);
                if ($route && $route->getName()) {
                    $this->routeNames[$candidate] = $route->getName();
                }
            }
        }

        $name = $this->routeNames[$action] ?? null;

        return $name !== null && Route::has($name) ? $name : null;
    }

    /** Forget cached route names (tests re-register routes per test). */
    public function flushRouteNames(): void
    {
        $this->routeNames = [];
        $this->routeNamesResolved = false;
    }
}
