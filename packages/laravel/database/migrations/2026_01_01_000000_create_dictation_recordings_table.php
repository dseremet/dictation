<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create($this->table(), function (Blueprint $table) {
            $table->id();
            $table->uuid('uuid')->unique();

            // Tenant (clinic, partner, user, ...). Switch to uuidMorphs() if your owner ids are UUIDs.
            $table->morphs('owner');

            // Optional object the recording is attached to (a patient record entry, a note, ...).
            $table->nullableMorphs('recordable');

            // User who uploaded the recording (no FK on purpose: user tables differ between apps).
            $table->unsignedBigInteger('user_id')->nullable()->index();

            $table->string('language_hint', 8)->nullable();
            $table->string('detected_language', 8)->nullable();

            // pending | processing | done | failed
            $table->string('status', 16)->default('pending')->index();

            $table->string('disk', 64);
            $table->string('path', 512);
            $table->string('mime', 64)->nullable();
            $table->unsignedBigInteger('size_bytes')->nullable();
            $table->unsignedInteger('duration_ms')->nullable();

            $table->text('transcript_raw')->nullable();        // engine output
            $table->text('transcript')->nullable();            // after post-processing
            $table->text('transcript_corrected')->nullable();  // edited by the user

            $table->json('segments')->nullable();
            $table->json('context')->nullable();
            $table->json('warnings')->nullable();
            $table->json('engine_meta')->nullable();

            $table->string('engine_model', 128)->nullable();
            $table->unsignedInteger('engine_ms')->nullable();
            $table->unsignedSmallInteger('attempts')->default(0);
            $table->text('error')->nullable();
            $table->timestamp('processed_at')->nullable();

            $table->timestamps();
            $table->softDeletes();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists($this->table());
    }

    protected function table(): string
    {
        return config('dictation.table', 'dictation_recordings');
    }
};
