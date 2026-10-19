<?php

namespace Ditactic\Dictation\Console;

use Ditactic\Dictation\DictationService;
use Illuminate\Console\Command;
use Throwable;

class TranscribeCommand extends Command
{
    protected $signature = 'dictation:transcribe {uuid : Recording UUID} {--force : Run even if the recording is already done}';

    protected $description = 'Transcribe one recording synchronously (for debugging; bypasses the queue)';

    public function handle(DictationService $service): int
    {
        $recording = $service->findByUuid((string) $this->argument('uuid'));

        if ($recording === null) {
            $this->error('Recording not found.');

            return self::FAILURE;
        }

        if ($recording->isDone() && ! $this->option('force')) {
            $this->warn('Recording is already done. Use --force to transcribe again.');

            return self::SUCCESS;
        }

        $this->line("Transcribing {$recording->uuid} ({$recording->mime}, {$recording->size_bytes} bytes, language {$recording->language_hint})...");

        $started = microtime(true);

        try {
            $service->transcribe($recording);
        } catch (Throwable $e) {
            $service->markFailed($recording, $e);
            $this->error('Failed: '.$e->getMessage());

            return self::FAILURE;
        }

        $elapsed = round(microtime(true) - $started, 1);

        $this->info("Done in {$elapsed}s (engine {$recording->engine_model}, ".($recording->engine_ms ?? '?').' ms, language '.($recording->detected_language ?? '?').').');
        $this->newLine();
        $this->line($recording->transcript ?? '');

        if (! empty($recording->warnings)) {
            $this->newLine();
            $this->warn('Warnings: '.implode(', ', $recording->warnings));
        }

        return self::SUCCESS;
    }
}
