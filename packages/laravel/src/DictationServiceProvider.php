<?php

namespace Ditactic\Dictation;

use Ditactic\Dictation\Console\HealthCommand;
use Ditactic\Dictation\Console\RequeueCommand;
use Ditactic\Dictation\Console\TranscribeCommand;
use Ditactic\Dictation\Contracts\GlossaryProvider;
use Ditactic\Dictation\Contracts\OwnerResolver;
use Ditactic\Dictation\Contracts\RecordingAuthorizer;
use Ditactic\Dictation\Contracts\Transcriber;
use Ditactic\Dictation\Contracts\TranscriptPostProcessor;
use Ditactic\Dictation\PostProcessors\AnthropicPostProcessor;
use Ditactic\Dictation\PostProcessors\NullPostProcessor;
use Ditactic\Dictation\Support\OwnerUserAuthorizer;
use Ditactic\Dictation\Support\PromptBuilder;
use Ditactic\Dictation\Support\UserOwnerResolver;
use Illuminate\Contracts\Container\Container;
use Illuminate\Http\Client\Factory as HttpFactory;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;
use InvalidArgumentException;

class DictationServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__.'/../config/dictation.php', 'dictation');

        $this->app->singleton(DictationManager::class, fn (Container $app) => new DictationManager($app));
        $this->app->alias(DictationManager::class, 'dictation');

        $this->app->singleton(PromptBuilder::class);
        $this->app->singleton(DictationService::class);

        $this->app->bind(Transcriber::class, fn (Container $app) => $app->make(DictationManager::class)->driver());

        $this->app->bind(TranscriptPostProcessor::class, fn (Container $app) => $this->makePostProcessor($app));

        // Host apps may bind these themselves; config classes are only the fallback.
        $this->app->bindIf(RecordingAuthorizer::class, fn (Container $app) => $app->make(config('dictation.authorizer', OwnerUserAuthorizer::class)), true);
        $this->app->bindIf(OwnerResolver::class, fn (Container $app) => $app->make(config('dictation.owner_resolver', UserOwnerResolver::class)), true);

        if (config('dictation.glossary_provider')) {
            $this->app->bindIf(GlossaryProvider::class, fn (Container $app) => $app->make(config('dictation.glossary_provider')), true);
        }
    }

    public function boot(): void
    {
        $this->loadMigrationsFrom(__DIR__.'/../database/migrations');

        if ($this->app->runningInConsole()) {
            $this->publishes([__DIR__.'/../config/dictation.php' => config_path('dictation.php')], 'dictation-config');
            $this->publishes([__DIR__.'/../database/migrations' => database_path('migrations')], 'dictation-migrations');
            $this->publishes([__DIR__.'/../resources/prompts' => resource_path('vendor/dictation/prompts')], 'dictation-prompts');

            $this->commands([HealthCommand::class, TranscribeCommand::class, RequeueCommand::class]);
        }

        if (config('dictation.routes.enabled')) {
            Route::middleware(config('dictation.routes.middleware', ['web', 'auth']))
                ->prefix(config('dictation.routes.prefix', 'dictation'))
                ->name(config('dictation.routes.name', 'dictation.'))
                ->group(fn () => $this->app->make(DictationManager::class)->routes());
        }
    }

    protected function makePostProcessor(Container $app): TranscriptPostProcessor
    {
        if (! config('dictation.postprocess.enabled')) {
            return new NullPostProcessor;
        }

        $driver = (string) config('dictation.postprocess.driver', 'anthropic');
        $custom = (array) config('dictation.postprocess.drivers', []);

        if ($driver === 'null' || $driver === 'none') {
            return new NullPostProcessor;
        }

        if ($driver === 'anthropic') {
            return new AnthropicPostProcessor($app->make(HttpFactory::class), (array) config('dictation.postprocess.anthropic', []));
        }

        $class = $custom[$driver] ?? (class_exists($driver) ? $driver : null);

        if ($class === null) {
            throw new InvalidArgumentException("Unknown dictation post-processor [{$driver}].");
        }

        $instance = $app->make($class);

        if (! $instance instanceof TranscriptPostProcessor) {
            throw new InvalidArgumentException("[{$class}] must implement ".TranscriptPostProcessor::class.'.');
        }

        return $instance;
    }
}
