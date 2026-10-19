<?php

namespace Ditactic\Dictation\Events;

use Ditactic\Dictation\Models\Recording;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

class TranscriptionCompleted
{
    use Dispatchable;
    use SerializesModels;

    public function __construct(public Recording $recording)
    {
    }
}
