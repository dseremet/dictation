<?php

namespace Ditactic\Dictation\Console;

use Ditactic\Dictation\DictationManager;
use Ditactic\Dictation\Drivers\OpenAiCompatibleTranscriber;
use Illuminate\Console\Command;
use Throwable;

class HealthCommand extends Command
{
    protected $signature = 'dictation:health {--driver= : Driver to check (default: configured driver)}';

    protected $description = 'Ping the transcription engine (/health) and list its models (/v1/models)';

    public function handle(DictationManager $manager): int
    {
        $name = $this->option('driver') ?: $manager->getDefaultDriver();
        $this->line("Driver: <info>{$name}</info>");

        try {
            $driver = $manager->driver($name);
        } catch (Throwable $e) {
            $this->error('Could not create driver: '.$e->getMessage());

            return self::FAILURE;
        }

        if (! $driver instanceof OpenAiCompatibleTranscriber) {
            $this->info('This driver has no remote engine to check.');

            return self::SUCCESS;
        }

        $this->line('Endpoint: '.$driver->endpoint());

        $ok = true;

        try {
            $health = $driver->health();
            $this->line('GET /health -> HTTP '.$health['status']);
            $this->line('  '.$this->pretty($health['body']));
            $ok = $ok && $health['status'] === 200;
        } catch (Throwable $e) {
            $this->error('GET /health failed: '.$e->getMessage());
            $ok = false;
        }

        try {
            $models = $driver->models();
            $this->line('GET /v1/models -> HTTP '.$models['status']);
            $body = $models['body'];
            $list = is_array($body) ? ($body['data'] ?? $body) : [];
            foreach ((array) $list as $model) {
                $id = is_array($model) ? ($model['id'] ?? json_encode($model)) : (string) $model;
                $this->line("  - {$id}");
            }
            if ($list === []) {
                $this->line('  '.$this->pretty($body));
            }
        } catch (Throwable $e) {
            $this->warn('GET /v1/models failed: '.$e->getMessage());
        }

        $this->newLine();
        $ok ? $this->info('Engine is reachable.') : $this->error('Engine is not healthy.');

        return $ok ? self::SUCCESS : self::FAILURE;
    }

    protected function pretty(mixed $body): string
    {
        return is_string($body) ? mb_substr($body, 0, 500) : (string) json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
}
