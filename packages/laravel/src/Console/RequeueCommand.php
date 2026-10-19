<?php

namespace Ditactic\Dictation\Console;

use Ditactic\Dictation\DictationService;
use Ditactic\Dictation\Models\Recording;
use Illuminate\Console\Command;

class RequeueCommand extends Command
{
    protected $signature = 'dictation:requeue
        {--failed : Re-queue recordings in status failed (default when no other option is given)}
        {--stuck= : Also re-queue pending/processing recordings untouched for this many minutes}
        {--uuid=* : Only these recording UUIDs}
        {--limit=500 : Maximum number of recordings to re-queue}
        {--dry-run : Only list what would be re-queued}';

    protected $description = 'Put failed (or stuck) recordings back on the transcription queue';

    public function handle(DictationService $service): int
    {
        $failed = (bool) $this->option('failed');
        $stuck = $this->option('stuck') !== null ? (int) $this->option('stuck') : null;
        $uuids = array_filter((array) $this->option('uuid'));

        if (! $failed && $stuck === null && $uuids === []) {
            $failed = true;
        }

        $query = $service->newQuery()->orderBy('id');

        if ($uuids !== []) {
            $query->whereIn('uuid', $uuids);
        } else {
            $query->where(function ($q) use ($failed, $stuck) {
                if ($failed) {
                    $q->orWhere('status', Recording::STATUS_FAILED);
                }
                if ($stuck !== null) {
                    $q->orWhere(function ($qq) use ($stuck) {
                        $qq->whereIn('status', [Recording::STATUS_PENDING, Recording::STATUS_PROCESSING])
                            ->where('updated_at', '<', now()->subMinutes($stuck));
                    });
                }
            });
        }

        $recordings = $query->limit((int) $this->option('limit'))->get();

        if ($recordings->isEmpty()) {
            $this->info('Nothing to re-queue.');

            return self::SUCCESS;
        }

        foreach ($recordings as $recording) {
            $this->line(sprintf('%s  %-10s  %s', $recording->uuid, $recording->status, $recording->error ?? ''));

            if (! $this->option('dry-run')) {
                $service->retry($recording);
            }
        }

        $this->newLine();
        $this->info(($this->option('dry-run') ? 'Would re-queue ' : 'Re-queued ').$recordings->count().' recording(s).');

        return self::SUCCESS;
    }
}
