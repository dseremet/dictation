<?php

namespace Ditactic\Dictation\Exceptions;

use Illuminate\Validation\ValidationException;
use InvalidArgumentException;

class InvalidUploadException extends InvalidArgumentException
{
    public function __construct(string $message, public readonly string $field = 'audio')
    {
        parent::__construct($message);
    }

    public function toValidationException(): ValidationException
    {
        return ValidationException::withMessages([$this->field => [$this->getMessage()]]);
    }
}
