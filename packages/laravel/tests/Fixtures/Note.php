<?php

namespace Ditactic\Dictation\Tests\Fixtures;

use Ditactic\Dictation\Concerns\HasRecordings;
use Illuminate\Database\Eloquent\Model;

class Note extends Model
{
    use HasRecordings;

    protected $table = 'notes';

    protected $guarded = [];
}
