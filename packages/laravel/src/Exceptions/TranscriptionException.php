<?php

namespace Ditactic\Dictation\Exceptions;

use RuntimeException;
use Throwable;

class TranscriptionException extends RuntimeException
{
    public function __construct(
        string $message,
        public readonly bool $retryable = false,
        public readonly ?int $status = null,
        ?Throwable $previous = null,
    ) {
        parent::__construct($message, $status ?? 0, $previous);
    }

    public static function retryable(string $message, ?int $status = null, ?Throwable $previous = null): self
    {
        return new self($message, true, $status, $previous);
    }

    public static function permanent(string $message, ?int $status = null, ?Throwable $previous = null): self
    {
        return new self($message, false, $status, $previous);
    }

    public function isRetryable(): bool
    {
        return $this->retryable;
    }
}
