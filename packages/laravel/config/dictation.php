<?php

use Ditactic\Dictation\Models\Recording;
use Ditactic\Dictation\Support\OwnerUserAuthorizer;
use Ditactic\Dictation\Support\UserOwnerResolver;

return [

    /*
    |--------------------------------------------------------------------------
    | Transcription driver
    |--------------------------------------------------------------------------
    |
    | Which driver `Dictation::driver()` returns by default.
    |
    |   openai_compatible  POST /v1/audio/transcriptions on the self-hosted
    |                      dictation engine (default) or on any OpenAI-compatible
    |                      API (OpenAI itself, Groq, Speaches, ...). Same code,
    |                      just a different URL/token/model.
    |   fake               Returns a configurable text without any HTTP call.
    |                      Use it in local development and in your test suite
    |                      (`Dictation::fake('...')`).
    |
    */

    'driver' => env('DICTATION_DRIVER', 'openai_compatible'),

    'drivers' => [

        'openai_compatible' => [
            // Base URL of the engine; `/v1/audio/transcriptions` is appended.
            'url' => env('DICTATION_ENGINE_URL', 'http://dictation-engine:8000'),

            // Bearer token. The engine checks it against ASR_API_KEYS; OpenAI
            // expects your API key here.
            'token' => env('DICTATION_ENGINE_TOKEN'),

            // Model name sent as `model`. The engine accepts aliases such as
            // `turbo`, `large-v3`, `small` or a HF repo; OpenAI wants `whisper-1`.
            'model' => env('DICTATION_ENGINE_MODEL', 'turbo'),

            // Seconds. A 5 minute dictation takes 2-4 minutes on an 8 vCPU CPU
            // box, so keep this generous and below `queue.timeout`.
            'timeout' => (int) env('DICTATION_ENGINE_TIMEOUT', 600),
            'connect_timeout' => 10,

            // `verbose_json` returns segments + the engine's `x_ditactic`
            // block (raw text, warnings, processing time). `json` is smaller.
            'verbose' => true,

            // Optional sampling temperature (null = engine default).
            'temperature' => null,

            // Extra multipart fields to send with every request, e.g.
            // ['normalize' => 'true']. Unknown fields are ignored by OpenAI.
            'extra' => [],
        ],

        'fake' => [
            'text' => 'Pacijent se žali na bol u desnom hipohondriju. RR 120/80.',
            'language' => 'bs',
        ],

    ],

    /*
    |--------------------------------------------------------------------------
    | Languages
    |--------------------------------------------------------------------------
    |
    | `language_default` is used when the upload does not say which language
    | was spoken. `auto` lets the engine detect it (restricted to `languages`).
    | The upload endpoint only accepts values from `languages` plus `auto`.
    |
    */

    'language_default' => env('DICTATION_LANGUAGE', 'auto'),

    'languages' => ['bs', 'hr', 'sr'],

    /*
    |--------------------------------------------------------------------------
    | Prompt terms and glossary
    |--------------------------------------------------------------------------
    |
    | `prompt_terms` are sent with every request, both as the Whisper `prompt`
    | and as entries of the engine's `glossary` field. Use it for a short list
    | of terms your users dictate often. Each entry is either a plain string
    | or ['canonical' => 'Amoksicilin', 'variants' => ['amoxicilin'], 'weight' => 2].
    |
    | `glossary_provider` is an optional class implementing
    | Ditactic\Dictation\Contracts\GlossaryProvider that returns per-recording
    | terms (for example the clinic's own procedure names). Bind the contract
    | in your own service provider instead if you need dependency injection.
    |
    */

    'prompt_terms' => [],

    'glossary_provider' => null,

    // Also repeat the glossary terms inside the free-text `prompt`. Off by
    // default: the self-hosted engine takes them as structured `glossary`
    // hotwords, and a comma list in the prompt makes Whisper sprinkle commas
    // into the transcript. Turn on only for backends without glossary support.
    'prompt_include_terms' => (bool) env('DICTATION_PROMPT_INCLUDE_TERMS', false),

    // Hard caps so a misbehaving provider cannot blow up the prompt budget.
    'prompt_max_terms' => 60,
    'prompt_max_chars' => 800,

    /*
    |--------------------------------------------------------------------------
    | Storage
    |--------------------------------------------------------------------------
    |
    | Audio files are written to `Storage::disk(disk)` using `path_template`.
    | Use a PRIVATE disk: the package streams audio through its own endpoint
    | (after authorization) and never relies on public URLs.
    |
    | Template placeholders: {owner} (owner id), {owner_type} (morph alias),
    | {uuid}, {ext} (derived from the detected mime type, never the client
    | file name), {year}, {month}.
    |
    */

    'storage' => [
        'disk' => env('DICTATION_DISK', 'local'),
        'path_template' => '{owner}/{uuid}.{ext}',
    ],

    /*
    |--------------------------------------------------------------------------
    | Upload limits
    |--------------------------------------------------------------------------
    |
    | `allowed_mimes` is matched against the mime type detected from the file
    | CONTENT (Laravel's `mimetypes` rule), so Chrome blobs labelled
    | `video/webm` and iOS files sniffed as `video/mp4` are listed on purpose.
    | `max_size_kb` is the upload size cap (50 MB default); make sure PHP's
    | upload_max_filesize / post_max_size and your proxy allow it too.
    |
    */

    'limits' => [
        'max_size_kb' => (int) env('DICTATION_MAX_SIZE_KB', 51200),
        'max_duration_ms' => (int) env('DICTATION_MAX_DURATION_MS', 600000),
        'allowed_mimes' => [
            'audio/webm', 'video/webm',
            'audio/ogg', 'application/ogg', 'audio/opus',
            'audio/mp4', 'video/mp4', 'audio/x-m4a', 'audio/m4a',
            'audio/aac', 'audio/x-aac',
            'audio/mpeg', 'audio/mp3',
            'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/x-pn-wav',
        ],
        // Max number of keys accepted in the `context` array of an upload.
        'max_context_keys' => 20,
        'max_context_value_length' => 500,
    ],

    /*
    |--------------------------------------------------------------------------
    | Queue
    |--------------------------------------------------------------------------
    |
    | Transcription runs in the TranscribeRecording job. Run a worker for the
    | queue below (`php artisan queue:work --queue=dictation`) and make sure the
    | connection's `retry_after` is larger than `timeout`. Do NOT use the
    | `sync` connection in production: a job takes 30-240 s.
    |
    */

    'queue' => [
        'connection' => env('DICTATION_QUEUE_CONNECTION'),
        'queue' => env('DICTATION_QUEUE', 'dictation'),
        'timeout' => 900,
        'tries' => 2,
        'backoff' => [30, 120],
        // Dispatch only after the surrounding DB transaction commits.
        'after_commit' => true,
    ],

    /*
    |--------------------------------------------------------------------------
    | Post-processing (optional LLM clean-up)
    |--------------------------------------------------------------------------
    |
    | After the engine returns, the transcript can be passed through a
    | TranscriptPostProcessor before it is stored as `transcript`
    | (`transcript_raw` always keeps the engine output). Disabled by default.
    |
    | The bundled `anthropic` processor calls the Messages API with the system
    | prompt in resources/prompts/bhs-medical-cleanup.md (publishable). Any
    | failure falls back to the untouched transcript, never to an error.
    |
    */

    'postprocess' => [
        'enabled' => (bool) env('DICTATION_POSTPROCESS', false),
        'driver' => env('DICTATION_POSTPROCESS_DRIVER', 'anthropic'),

        'anthropic' => [
            'api_key' => env('DICTATION_ANTHROPIC_API_KEY', env('ANTHROPIC_API_KEY')),
            'base_url' => env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com'),
            'model' => env('DICTATION_POSTPROCESS_MODEL', 'claude-haiku-5-5'),
            'max_tokens' => 4096,
            // low|medium|high — clean-up is a light task; null omits the field.
            'effort' => 'low',
            'timeout' => 60,
            // Absolute path to a custom system prompt; null = bundled/published one.
            'prompt' => null,
        ],

        // Map extra driver names to classes implementing TranscriptPostProcessor.
        'drivers' => [],
    ],

    /*
    |--------------------------------------------------------------------------
    | Authorization and ownership
    |--------------------------------------------------------------------------
    |
    | `authorizer` decides who may create/view/update/delete recordings. The
    | default allows a user to manage only recordings whose owner is the user
    | itself. Multi-tenant apps bind their own RecordingAuthorizer (see README).
    |
    | `owner_resolver` returns [owner_type, owner_id] for the current request,
    | e.g. [Partner::class, $user->partner_id]. The owner is the tenant that
    | the storage path and the index scope are keyed by.
    |
    | `recordables` is an allow-list of fully-qualified model classes that may
    | be given as `recordable_type` when no morph map alias matches. Morph map
    | aliases (Relation::morphMap()) are always accepted.
    |
    */

    'authorizer' => OwnerUserAuthorizer::class,

    'owner_resolver' => UserOwnerResolver::class,

    'recordables' => [],

    /*
    |--------------------------------------------------------------------------
    | Routes
    |--------------------------------------------------------------------------
    |
    | Routes are NOT registered automatically. Mount them in your own route
    | group so they inherit your middleware, prefix and names:
    |
    |   Route::middleware(['web', 'auth'])->prefix('dictation')
    |       ->name('dictation.')->group(fn () => Dictation::routes());
    |
    | Set `enabled` to true to let the package register the group below.
    |
    */

    'routes' => [
        'enabled' => false,
        'prefix' => 'dictation',
        'name' => 'dictation.',
        'middleware' => ['web', 'auth'],
    ],

    /*
    |--------------------------------------------------------------------------
    | Model and table
    |--------------------------------------------------------------------------
    */

    'model' => Recording::class,

    'table' => 'dictation_recordings',

];
