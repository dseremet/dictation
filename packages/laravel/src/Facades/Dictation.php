<?php

namespace Ditactic\Dictation\Facades;

use Ditactic\Dictation\DictationManager;
use Illuminate\Support\Facades\Facade;

/**
 * @method static \Ditactic\Dictation\Contracts\Transcriber driver(string|null $driver = null)
 * @method static \Ditactic\Dictation\DTO\TranscriptionResult transcribe(\Ditactic\Dictation\DTO\TranscriptionRequest $request)
 * @method static \Ditactic\Dictation\Drivers\FakeTranscriber fake(string|\Ditactic\Dictation\DTO\TranscriptionResult|\Throwable|\Closure|array|null $response = null)
 * @method static void routes(array $options = [])
 * @method static string|null routeName(string $action)
 * @method static void flushRouteNames()
 * @method static string getDefaultDriver()
 * @method static DictationManager extend(string $driver, \Closure $callback)
 * @method static DictationManager forgetDrivers()
 *
 * @see DictationManager
 */
class Dictation extends Facade
{
    protected static function getFacadeAccessor(): string
    {
        return DictationManager::class;
    }
}
