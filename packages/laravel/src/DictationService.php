<?php

namespace Ditactic\Dictation;

use Ditactic\Dictation\Contracts\TranscriptPostProcessor;
use Ditactic\Dictation\DTO\TranscriptionRequest;
use Ditactic\Dictation\Events\RecordingCreated;
use Ditactic\Dictation\Events\TranscriptionCompleted;
use Ditactic\Dictation\Events\TranscriptionFailed;
use Ditactic\Dictation\Exceptions\InvalidUploadException;
use Ditactic\Dictation\Exceptions\TranscriptionException;
use Ditactic\Dictation\Jobs\TranscribeRecording;
use Ditactic\Dictation\Models\Recording;
use Ditactic\Dictation\Support\AudioMime;
use Ditactic\Dictation\Support\PromptBuilder;
use Illuminate\Contracts\Container\Container;
use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use League\Flysystem\Local\LocalFilesystemAdapter;
use Symfony\Component\HttpFoundation\Response;
use Throwable;

class DictationService
{
    public function __construct(
        protected Container $container,
        protected DictationManager $manager,
        protected PromptBuilder $prompts,
    ) {
    }

    // ---------------------------------------------------------------- lookup

    public function find(int|string $id): ?Recording
    {
        return $this->newQuery()->find($id);
    }

    public function findByUuid(string $uuid): ?Recording
    {
        return $this->newQuery()->where('uuid', $uuid)->first();
    }

    public function newQuery()
    {
        $model = $this->modelClass();

        return $model::query();
    }

    /** @return class-string<Recording> */
    public function modelClass(): string
    {
        return config('dictation.model', Recording::class);
    }

    // ---------------------------------------------------------------- create

    /**
     * Store an uploaded file and queue its transcription.
     *
     * @param  array{
     *     owner: array{0: string, 1: int|string},
     *     recordable?: Model|null,
     *     language?: string|null,
     *     duration_ms?: int|null,
     *     context?: array|null,
     *     user_id?: int|string|null,
     * }  $attributes
     *
     * @throws InvalidUploadException
     */
    public function createFromUpload(UploadedFile $file, array $attributes, mixed $user = null): Recording
    {
        if (! $file->isValid()) {
            throw new InvalidUploadException('The upload did not complete.');
        }

        $mime = $this->detectMime($file);
        $extension = AudioMime::extensionFor($mime);

        if ($extension === null || ! AudioMime::isAllowed($mime, config('dictation.limits.allowed_mimes'))) {
            throw new InvalidUploadException('Unsupported audio type'.($mime ? " ({$mime})." : '.'));
        }

        $maxBytes = (int) config('dictation.limits.max_size_kb', 51200) * 1024;
        if ($maxBytes > 0 && $file->getSize() > $maxBytes) {
            throw new InvalidUploadException('The recording is larger than the allowed '.intdiv($maxBytes, 1024).' KB.');
        }

        $maxDuration = (int) config('dictation.limits.max_duration_ms', 0);
        $duration = isset($attributes['duration_ms']) ? (int) $attributes['duration_ms'] : null;
        if ($duration !== null && $maxDuration > 0 && $duration > $maxDuration) {
            throw new InvalidUploadException('The recording is longer than the allowed '.intdiv($maxDuration, 1000).' seconds.', 'duration_ms');
        }

        [$ownerType, $ownerId] = $attributes['owner'] ?? [null, null];
        if (! $ownerType || $ownerId === null || $ownerId === '') {
            throw new InvalidUploadException('A recording owner is required.', 'owner');
        }

        $recordable = $attributes['recordable'] ?? null;
        if ($recordable !== null && ! $recordable instanceof Model) {
            throw new InvalidUploadException('recordable must be an Eloquent model.', 'recordable_type');
        }

        $language = $attributes['language'] ?? config('dictation.language_default', 'auto');
        $uuid = (string) Str::uuid();
        $disk = (string) config('dictation.storage.disk', 'local');
        $path = $this->buildPath($uuid, $extension, $ownerType, $ownerId);

        $stored = Storage::disk($disk)->putFileAs(dirname($path), $file, basename($path), ['visibility' => 'private']);
        if ($stored === false) {
            throw new InvalidUploadException('Could not store the recording.');
        }

        $model = $this->modelClass();

        try {
            $recording = DB::transaction(function () use ($model, $uuid, $ownerType, $ownerId, $recordable, $user, $language, $mime, $file, $duration, $attributes, $disk, $path) {
                /** @var Recording $recording */
                $recording = new $model;
                $recording->fill([
                    'uuid' => $uuid,
                    'owner_type' => $ownerType,
                    'owner_id' => $ownerId,
                    'recordable_type' => $recordable?->getMorphClass(),
                    'recordable_id' => $recordable?->getKey(),
                    'user_id' => $attributes['user_id'] ?? ($user instanceof Model ? $user->getKey() : null),
                    'language_hint' => $language,
                    'status' => Recording::STATUS_PENDING,
                    'disk' => $disk,
                    'path' => $path,
                    'mime' => $mime,
                    'size_bytes' => $file->getSize(),
                    'duration_ms' => $duration,
                    'context' => $this->cleanContext($attributes['context'] ?? null),
                ]);
                $recording->save();

                $this->dispatch($recording);

                return $recording;
            });
        } catch (Throwable $e) {
            Storage::disk($disk)->delete($path);

            throw $e;
        }

        RecordingCreated::dispatch($recording);

        return $recording;
    }

    /** Queue the transcription job (after commit when configured; the job sets queue/connection/afterCommit itself). */
    public function dispatch(Recording $recording): void
    {
        TranscribeRecording::dispatch($recording->getKey());
    }

    // ---------------------------------------------------------------- transcription

    /**
     * Run the engine and the post-processor for a recording, synchronously.
     *
     * @throws TranscriptionException
     */
    public function transcribe(Recording $recording): Recording
    {
        $recording->forceFill([
            'status' => Recording::STATUS_PROCESSING,
            'attempts' => $recording->attempts + 1,
            'error' => null,
        ])->save();

        $temporary = null;

        try {
            [$localPath, $temporary] = $this->localPath($recording);

            $prompt = $this->prompts->build($recording);

            $request = new TranscriptionRequest(
                path: $localPath,
                mime: $recording->mime ?? 'application/octet-stream',
                language: $recording->language_hint ?: config('dictation.language_default', 'auto'),
                prompt: $prompt['prompt'],
                glossary: $prompt['glossary'],
            );

            $result = $this->manager->driver()->transcribe($request);

            $recording->forceFill([
                'transcript_raw' => $result->text,
                'detected_language' => $result->language ?? ($recording->language_hint !== 'auto' ? $recording->language_hint : null),
                'segments' => $result->segments,
                'engine_model' => $result->model,
                'engine_ms' => $result->processingMs,
                'warnings' => $result->warnings,
                'engine_meta' => $result->meta(),
                'duration_ms' => $recording->duration_ms ?? $result->durationMs,
            ]);

            $processor = $this->container->make(TranscriptPostProcessor::class);
            $recording->transcript = $processor->process($result->text, $recording);

            $recording->forceFill([
                'status' => Recording::STATUS_DONE,
                'error' => null,
                'processed_at' => now(),
            ])->save();
        } catch (TranscriptionException $e) {
            throw $e;
        } catch (Throwable $e) {
            throw TranscriptionException::permanent($e->getMessage(), null, $e);
        } finally {
            if ($temporary !== null && is_file($temporary)) {
                @unlink($temporary);
            }
        }

        TranscriptionCompleted::dispatch($recording);

        return $recording;
    }

    /** Called between attempts: keep the recording visible as waiting and remember why. */
    public function markRetrying(Recording $recording, Throwable $e): void
    {
        $recording->forceFill([
            'status' => Recording::STATUS_PENDING,
            'error' => $this->publicError($e),
        ])->save();

        TranscriptionFailed::dispatch($recording, $recording->error, true);
    }

    public function markFailed(Recording $recording, ?Throwable $e): void
    {
        $message = $e ? $this->publicError($e) : 'Transcription failed.';

        if ($recording->isFailed() && $recording->error === $message) {
            return;
        }

        $recording->forceFill([
            'status' => Recording::STATUS_FAILED,
            'error' => $message,
        ])->save();

        TranscriptionFailed::dispatch($recording, $message, false);
    }

    public function retry(Recording $recording): Recording
    {
        $recording->forceFill([
            'status' => Recording::STATUS_PENDING,
            'error' => null,
        ])->save();

        $this->dispatch($recording);

        return $recording;
    }

    // ---------------------------------------------------------------- edits / delete / stream

    public function correct(Recording $recording, ?string $text): Recording
    {
        $text = $text === null ? null : trim($text);

        $recording->forceFill(['transcript_corrected' => $text === '' ? null : $text])->save();

        return $recording;
    }

    public function delete(Recording $recording, bool $force = false): void
    {
        $disk = $this->disk($recording);

        if ($recording->path && $disk->exists($recording->path)) {
            $disk->delete($recording->path);
        }

        $force ? $recording->forceDelete() : $recording->delete();
    }

    /** Response that streams the audio file, private and range-capable when the disk is local. */
    public function streamAudio(Recording $recording): Response
    {
        $disk = $this->disk($recording);

        if (! $recording->path || ! $disk->exists($recording->path)) {
            abort(404, 'Audio file not found.');
        }

        $headers = [
            'Content-Type' => $recording->mime ?: 'application/octet-stream',
            'Cache-Control' => 'private, no-store',
            'Content-Disposition' => 'inline; filename="'.$recording->uuid.'.'.pathinfo($recording->path, PATHINFO_EXTENSION).'"',
            'X-Content-Type-Options' => 'nosniff',
        ];

        if ($this->isLocal($disk)) {
            // BinaryFileResponse is "public" by default; force private + no-store.
            $response = response()->file($disk->path($recording->path), $headers);
            $response->setPrivate();
            $response->headers->addCacheControlDirective('no-store');

            return $response;
        }

        $headers['Content-Length'] = (string) $disk->size($recording->path);

        return $disk->response($recording->path, null, $headers, 'inline');
    }

    // ---------------------------------------------------------------- internals

    public function disk(Recording $recording): Filesystem
    {
        return Storage::disk($recording->disk ?: config('dictation.storage.disk', 'local'));
    }

    protected function isLocal(Filesystem $disk): bool
    {
        return method_exists($disk, 'getAdapter') && $disk->getAdapter() instanceof LocalFilesystemAdapter;
    }

    /** @return array{0: string, 1: string|null} [local path, temporary file to delete or null] */
    protected function localPath(Recording $recording): array
    {
        $disk = $this->disk($recording);

        if (! $disk->exists($recording->path)) {
            throw TranscriptionException::permanent('Audio file is missing from storage.');
        }

        if ($this->isLocal($disk)) {
            return [$disk->path($recording->path), null];
        }

        $extension = pathinfo($recording->path, PATHINFO_EXTENSION) ?: 'bin';
        $temporary = tempnam(sys_get_temp_dir(), 'dictation-');
        $target = $temporary.'.'.$extension;
        @rename($temporary, $target);

        $stream = $disk->readStream($recording->path);
        $out = fopen($target, 'w');
        stream_copy_to_stream($stream, $out);
        fclose($out);
        if (is_resource($stream)) {
            fclose($stream);
        }

        return [$target, $target];
    }

    protected function detectMime(UploadedFile $file): ?string
    {
        $candidates = [$file->getMimeType(), $file->getClientMimeType()];

        foreach ($candidates as $candidate) {
            $normalized = AudioMime::normalize($candidate);
            if ($normalized && AudioMime::extensionFor($normalized)) {
                return $normalized;
            }
        }

        return AudioMime::normalize($candidates[0]);
    }

    protected function buildPath(string $uuid, string $extension, string $ownerType, int|string $ownerId): string
    {
        $template = (string) config('dictation.storage.path_template', '{owner}/{uuid}.{ext}');

        $ownerAlias = class_exists($ownerType) && is_subclass_of($ownerType, Model::class)
            ? (new $ownerType)->getMorphClass()
            : $ownerType;

        $path = strtr($template, [
            '{owner}' => $this->safeSegment((string) $ownerId),
            '{owner_type}' => $this->safeSegment(Str::snake(class_basename($ownerAlias))),
            '{uuid}' => $uuid,
            '{ext}' => $extension,
            '{year}' => now()->format('Y'),
            '{month}' => now()->format('m'),
        ]);

        return ltrim(preg_replace('#/+#', '/', $path), '/');
    }

    protected function safeSegment(string $value): string
    {
        $value = preg_replace('/[^A-Za-z0-9_\-]/', '_', $value) ?? '';

        return $value === '' ? '_' : $value;
    }

    protected function cleanContext(?array $context): ?array
    {
        if ($context === null) {
            return null;
        }

        $maxKeys = (int) config('dictation.limits.max_context_keys', 20);
        $maxLength = (int) config('dictation.limits.max_context_value_length', 500);
        $clean = [];

        foreach ($context as $key => $value) {
            if (count($clean) >= $maxKeys) {
                break;
            }
            if (! is_string($key) && ! is_int($key)) {
                continue;
            }
            if (is_bool($value) || is_int($value) || is_float($value)) {
                $clean[(string) $key] = $value;
            } elseif (is_string($value)) {
                $clean[(string) $key] = mb_substr($value, 0, $maxLength);
            } elseif ($value === null) {
                $clean[(string) $key] = null;
            }
        }

        return $clean === [] ? null : $clean;
    }

    /** A message safe to show to API clients: no stack traces, no internal URLs. */
    protected function publicError(Throwable $e): string
    {
        $message = $e instanceof TranscriptionException || $e instanceof InvalidUploadException
            ? $e->getMessage()
            : (class_basename($e).': '.$e->getMessage());

        $message = preg_replace('#https?://[^\s]+#', '[url]', $message) ?? $message;
        $message = preg_replace('/\s+/', ' ', $message) ?? $message;

        return mb_substr(trim($message), 0, 500);
    }
}
