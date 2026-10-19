<?php

namespace Ditactic\Dictation\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\MorphTo;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Str;

/**
 * @property int $id
 * @property string $uuid
 * @property string $owner_type
 * @property int|string $owner_id
 * @property string|null $recordable_type
 * @property int|string|null $recordable_id
 * @property int|string|null $user_id
 * @property string|null $language_hint
 * @property string|null $detected_language
 * @property string $status
 * @property string $disk
 * @property string $path
 * @property string|null $mime
 * @property int|null $size_bytes
 * @property int|null $duration_ms
 * @property string|null $transcript_raw
 * @property string|null $transcript
 * @property string|null $transcript_corrected
 * @property array|null $segments
 * @property array|null $context
 * @property array|null $warnings
 * @property array|null $engine_meta
 * @property string|null $engine_model
 * @property int|null $engine_ms
 * @property int $attempts
 * @property string|null $error
 * @property \Illuminate\Support\Carbon|null $processed_at
 * @property-read string|null $final_text
 */
class Recording extends Model
{
    use SoftDeletes;

    public const STATUS_PENDING = 'pending';

    public const STATUS_PROCESSING = 'processing';

    public const STATUS_DONE = 'done';

    public const STATUS_FAILED = 'failed';

    public const STATUSES = [
        self::STATUS_PENDING,
        self::STATUS_PROCESSING,
        self::STATUS_DONE,
        self::STATUS_FAILED,
    ];

    protected $guarded = [];

    protected $casts = [
        'segments' => 'array',
        'context' => 'array',
        'warnings' => 'array',
        'engine_meta' => 'array',
        'size_bytes' => 'integer',
        'duration_ms' => 'integer',
        'engine_ms' => 'integer',
        'attempts' => 'integer',
        'processed_at' => 'datetime',
    ];

    protected $attributes = [
        'status' => self::STATUS_PENDING,
        'attempts' => 0,
    ];

    public function getTable(): string
    {
        return $this->table ?? config('dictation.table', 'dictation_recordings');
    }

    protected static function booted(): void
    {
        static::creating(function (self $recording) {
            $recording->uuid ??= (string) Str::uuid();
        });
    }

    public function getRouteKeyName(): string
    {
        return 'uuid';
    }

    // ---------------------------------------------------------------- relations

    public function owner(): MorphTo
    {
        return $this->morphTo();
    }

    public function recordable(): MorphTo
    {
        return $this->morphTo();
    }

    public function user(): BelongsTo
    {
        $model = config('auth.providers.users.model') ?? 'App\\Models\\User';

        return $this->belongsTo($model, 'user_id');
    }

    // ---------------------------------------------------------------- scopes

    public function scopeForOwner(Builder $query, Model|string $owner, int|string|null $id = null): Builder
    {
        if ($owner instanceof Model) {
            return $query->where('owner_type', $owner->getMorphClass())->where('owner_id', $owner->getKey());
        }

        return $query->where('owner_type', $owner)->where('owner_id', $id);
    }

    public function scopeForRecordable(Builder $query, Model $recordable): Builder
    {
        return $query
            ->where('recordable_type', $recordable->getMorphClass())
            ->where('recordable_id', $recordable->getKey());
    }

    public function scopeStatus(Builder $query, string ...$status): Builder
    {
        return $query->whereIn('status', $status);
    }

    public function scopeDone(Builder $query): Builder
    {
        return $query->where('status', self::STATUS_DONE);
    }

    public function scopeFailed(Builder $query): Builder
    {
        return $query->where('status', self::STATUS_FAILED);
    }

    public function scopePending(Builder $query): Builder
    {
        return $query->where('status', self::STATUS_PENDING);
    }

    // ---------------------------------------------------------------- accessors / helpers

    /** The text a UI should show: user correction, else post-processed, else raw engine text. */
    protected function finalText(): Attribute
    {
        return Attribute::get(fn () => $this->transcript_corrected ?? $this->transcript ?? $this->transcript_raw);
    }

    public function isPending(): bool
    {
        return $this->status === self::STATUS_PENDING;
    }

    public function isProcessing(): bool
    {
        return $this->status === self::STATUS_PROCESSING;
    }

    public function isDone(): bool
    {
        return $this->status === self::STATUS_DONE;
    }

    public function isFailed(): bool
    {
        return $this->status === self::STATUS_FAILED;
    }

    /** Done or failed: the job will not touch it again. */
    public function isTerminal(): bool
    {
        return $this->isDone() || $this->isFailed();
    }
}
