<?php

namespace Ditactic\Dictation\Jobs;

use Ditactic\Dictation\DictationService;
use Ditactic\Dictation\Exceptions\TranscriptionException;
use Ditactic\Dictation\Models\Recording;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Throwable;

class TranscribeRecording implements ShouldBeUnique, ShouldQueue
{
    use Dispatchable;
    use InteractsWithQueue;
    use Queueable;
    use SerializesModels;

    public int $tries;

    public int $timeout;

    /** @var int|array<int, int> */
    public int|array $backoff;

    public int $uniqueFor;

    public function __construct(public int|string $recordingId)
    {
        $this->tries = max(1, (int) config('dictation.queue.tries', 2));
        $this->timeout = (int) config('dictation.queue.timeout', 900);
        $this->backoff = config('dictation.queue.backoff', [30, 120]);
        $this->uniqueFor = $this->timeout + 60;
        $this->afterCommit = (bool) config('dictation.queue.after_commit', true);

        $this->onQueue(config('dictation.queue.queue', 'dictation'));

        if ($connection = config('dictation.queue.connection')) {
            $this->onConnection($connection);
        }
    }

    public function uniqueId(): string
    {
        return (string) $this->recordingId;
    }

    public function handle(DictationService $service): void
    {
        $recording = $service->find($this->recordingId);

        if ($recording === null || $recording->isDone()) {
            return;
        }

        try {
            $service->transcribe($recording);
        } catch (TranscriptionException $e) {
            $exhausted = $this->attempts() >= $this->tries;

            if (! $e->isRetryable() || $exhausted) {
                $this->failNow($e);

                return;
            }

            $service->markRetrying($recording, $e);

            throw $e;
        } catch (Throwable $e) {
            $this->failNow($e);
        }
    }

    /** Mark the job failed; falls back to calling failed() directly when there is no queue job (dispatchSync, tests). */
    protected function failNow(Throwable $e): void
    {
        if ($this->job) {
            $this->fail($e);

            return;
        }

        $this->failed($e);
    }

    public function failed(?Throwable $exception): void
    {
        $recording = app(DictationService::class)->find($this->recordingId);

        if ($recording !== null) {
            app(DictationService::class)->markFailed($recording, $exception);
        }
    }

    public function tags(): array
    {
        return ['dictation', 'recording:'.$this->recordingId];
    }
}
