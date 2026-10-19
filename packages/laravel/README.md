# ditactic/dictation-laravel

Speech-to-text recordings for Laravel 11/12: upload audio, queue the transcription, stream the file back, let the user correct the text. Built for Bosnian/Croatian/Serbian medical dictation and the self-hosted [dictation engine](../../engine/), but the driver speaks the OpenAI transcription API, so any compatible endpoint works.

What you get:

- `dictation_recordings` table + `Recording` model (`uuid`, owner/tenant morph, optional `recordable` morph, raw / cleaned / corrected transcript, segments, warnings, status `pending|processing|done|failed`).
- `TranscribeRecording` queue job (unique per recording, retries with back-off, after-commit dispatch) with `TranscriptionCompleted` / `TranscriptionFailed` events.
- HTTP endpoints you mount in your own route group: upload, list, show, correct, retry, delete, private audio stream with `Range` support.
- Drivers: `openai_compatible` (the engine, OpenAI, Groq, ...) and `fake` for tests (`Dictation::fake()`).
- Optional LLM clean-up step (`AnthropicPostProcessor`, raw `Http` calls, disabled by default).
- Artisan: `dictation:health`, `dictation:transcribe {uuid}`, `dictation:requeue`.

Requirements: PHP 8.2+, Laravel 11 or 12, `fileinfo` extension, a queue worker.

## Install

```bash
composer require ditactic/dictation-laravel

php artisan vendor:publish --tag=dictation-config      # config/dictation.php
php artisan vendor:publish --tag=dictation-migrations  # optional: edit before migrating (uuid owners, FKs)
php artisan migrate
```

Migrations are also loaded straight from the package, so publishing them is only needed when you want to change them (for example `uuidMorphs('owner')`).

Publish the clean-up prompt only if you use the Anthropic post-processor and want to edit it:

```bash
php artisan vendor:publish --tag=dictation-prompts    # resources/vendor/dictation/prompts/bhs-medical-cleanup.md
```

## Configure

`.env`:

```dotenv
DICTATION_DRIVER=openai_compatible          # or fake (local dev without an engine)
DICTATION_ENGINE_URL=http://127.0.0.1:8321  # engine base URL, /v1/audio/transcriptions is appended
DICTATION_ENGINE_TOKEN=change-me            # must match the engine's ASR_API_KEYS
DICTATION_ENGINE_MODEL=turbo                # engine alias / HF repo, or whisper-1 for OpenAI
DICTATION_DISK=local                        # a PRIVATE filesystem disk
DICTATION_QUEUE=dictation
DICTATION_LANGUAGE=auto                     # default language hint: auto|bs|hr|sr

# optional LLM clean-up (off by default)
DICTATION_POSTPROCESS=false
DICTATION_POSTPROCESS_MODEL=claude-haiku-5-5
DICTATION_ANTHROPIC_API_KEY=                # falls back to ANTHROPIC_API_KEY
```

Every option is documented in `config/dictation.php`. The ones you will most likely touch:

| Key | Purpose |
|---|---|
| `storage.disk`, `storage.path_template` | Where audio goes. Template `{owner}/{uuid}.{ext}`; `{owner}` is the owner id, `{ext}` comes from the detected mime type, never from the client file name. |
| `limits.max_size_kb` (50 MB), `limits.max_duration_ms` (10 min), `limits.allowed_mimes` | Upload validation. `allowed_mimes` is matched against the file *content* (Laravel `mimetypes`). |
| `languages`, `language_default` | Accepted `language` values (+ `auto`). |
| `prompt_terms`, `glossary_provider` | Vocabulary hints sent to the engine as `prompt` and `glossary`. |
| `queue.*` | Connection, queue name (`dictation`), `timeout` 900 s, `tries` 2, `backoff [30, 120]`, after-commit dispatch. |
| `authorizer`, `owner_resolver`, `recordables` | Who may do what, who owns a recording, which models may be given as `recordable_type` by class name. |
| `postprocess.*` | Optional transcript clean-up. |

### Queue worker

Transcription takes 30-240 s per recording, so it must never run on the `sync` connection in production. Run a worker that listens on the dictation queue and give it a `retry_after` larger than `queue.timeout`:

```bash
php artisan queue:work --queue=dictation,default --timeout=900
```

If no worker runs, uploads simply stay `pending` (the UI shows "waiting"). `php artisan dictation:requeue --stuck=30` puts recordings that sat in `pending`/`processing` for 30 minutes back on the queue.

## Mount the routes

Routes are not registered automatically. Call `Dictation::routes()` inside your own group so the endpoints inherit your middleware, prefix and route-name prefix:

```php
// routes/web.php (Laravel 11+)
use Ditactic\Dictation\Facades\Dictation;
use Illuminate\Support\Facades\Route;

Route::middleware(['web', 'auth'])
    ->prefix('karton/diktat')
    ->name('partner.carton.dictation.')
    ->group(fn () => Dictation::routes());
```

This registers, relative to the group:

| Method | URI | Name | Authorizer check |
|---|---|---|---|
| `GET` | `/` | `index` | `canView` on each result (owner scope; filter with `?recordable_type=&recordable_id=&status=&limit=`) |
| `POST` | `/` | `store` | `canCreate($user, $input)` |
| `GET` | `/{recording}` | `show` | `canView` |
| `PATCH` | `/{recording}` | `update` | `canUpdate` (body `{ "transcript_corrected": "..." }`, `null` clears) |
| `DELETE` | `/{recording}` | `destroy` | `canDelete` (deletes the file, soft-deletes the row) |
| `GET` | `/{recording}/audio` | `audio` | `canView` (streams the file, `Cache-Control: private, no-store`, supports `Range`) |
| `POST` | `/{recording}/retry` | `retry` | `canUpdate` (re-queues a failed recording; `409` while still processing) |

`{recording}` is the UUID. `Dictation::routes(['only' => [...]])` and `['except' => [...]]` trim the set. If the `audio` route is not mounted, `audio_url` in responses is `null`.

### Upload request

`multipart/form-data`:

| Field | Rules |
|---|---|
| `audio` | required file; mime from `limits.allowed_mimes` (`audio/webm`, `video/webm`, `audio/ogg`, `audio/mp4`, `audio/x-m4a`, `audio/aac`, `audio/mpeg`, `audio/wav`, ...); max `limits.max_size_kb` |
| `language` | optional, one of `languages` or `auto` |
| `duration_ms` | optional int, 0 .. `limits.max_duration_ms` |
| `context[...]` | optional flat array of strings/numbers, max 20 keys. `context[field_label]` is used as a prompt hint and shown back to the UI. |
| `recordable_type`, `recordable_id` | optional: morph-map alias (or an allow-listed class) + id of the model to attach to |

### Response shape

Every endpoint returns `RecordingResource` (wrapped in `data`, Laravel style):

```json
{
  "data": {
    "uuid": "9c1e...",
    "status": "done",
    "language": "bs",
    "detected_language": "bs",
    "duration_ms": 4200,
    "transcript": "Pacijent se žali na bol u desnom hipohondriju. RR 120/80.",
    "transcript_raw": "pacijent se žali na bol u desnom hipohondriju RR 120/80",
    "transcript_corrected": null,
    "final_text": "Pacijent se žali na bol u desnom hipohondriju. RR 120/80.",
    "context": { "question_key": "anamneza", "field_label": "Anamneza" },
    "warnings": [],
    "recordable_type": "carton_entry",
    "recordable_id": 42,
    "created_at": "2026-10-18T10:00:00.000000Z",
    "processed_at": "2026-10-18T10:01:30.000000Z",
    "audio_url": "https://app.example/karton/diktat/9c1e.../audio",
    "error": null
  }
}
```

`transcript_raw` is what the engine returned, `transcript` is after the (optional) post-processor, `transcript_corrected` is the user's edit, `final_text` picks the best of the three. Clients poll `show` until `status` is `done` or `failed`; `error` is a short, user-safe message (no stack traces).

## Bind your authorizer and owner

The package does not know your tenancy model. Implement two small classes and point the config at them (or bind the contracts in a service provider).

```php
// app/Dictation/CartonRecordingAuthorizer.php
namespace App\Dictation;

use App\Models\CartonEntry;
use App\Services\CartonAccess;
use Ditactic\Dictation\Contracts\RecordingAuthorizer;
use Ditactic\Dictation\Models\Recording;

class CartonRecordingAuthorizer implements RecordingAuthorizer
{
    public function __construct(private CartonAccess $access) {}

    public function canCreate($user, array $input): bool
    {
        // $input = validated upload fields + 'recordable' (resolved model or null) + 'owner' ([type, id])
        $entry = $input['recordable'] ?? null;

        return $entry instanceof CartonEntry && $this->access->canEditEntry($user, $entry);
    }

    public function canView($user, Recording $recording): bool
    {
        return $recording->recordable instanceof CartonEntry
            && $this->access->canAccessClient($user, $recording->recordable->client);
    }

    public function canUpdate($user, Recording $recording): bool { return $this->canCreate($user, ['recordable' => $recording->recordable]); }

    public function canDelete($user, Recording $recording): bool { return $this->canUpdate($user, $recording); }
}
```

```php
// app/Dictation/PartnerOwnerResolver.php
namespace App\Dictation;

use App\Models\Partner;
use Ditactic\Dictation\Contracts\OwnerResolver;
use Illuminate\Http\Request;

class PartnerOwnerResolver implements OwnerResolver
{
    public function resolve(Request $request, $user): array
    {
        return [Partner::class, $user->partner_id];   // [owner_type, owner_id]
    }
}
```

```php
// config/dictation.php
'authorizer' => App\Dictation\CartonRecordingAuthorizer::class,
'owner_resolver' => App\Dictation\PartnerOwnerResolver::class,
```

`recordable_type` from the request is resolved through `Relation::getMorphedModel()` (your morph map). Register aliases (`Relation::enforceMorphMap(['carton_entry' => CartonEntry::class])`) or allow-list classes in `config('dictation.recordables')`.

Add the trait to models that recordings attach to:

```php
use Ditactic\Dictation\Concerns\HasRecordings;

class CartonEntry extends Model
{
    use HasRecordings;   // $entry->recordings(), $entry->latestRecording
}
```

Deleting a parent model? Delete its recordings through the service so the files go too:

```php
$entry->recordings->each(fn ($r) => app(DictationService::class)->delete($r));
```

### Glossary provider (optional)

Per-recording vocabulary, e.g. the clinic's own procedure names:

```php
class PartnerGlossaryProvider implements \Ditactic\Dictation\Contracts\GlossaryProvider
{
    public function terms(Recording $recording): array
    {
        return Service::where('partner_id', $recording->owner_id)->pluck('name')->take(40)->all();
        // strings or ['canonical' => 'Botoks', 'variants' => ['botox'], 'weight' => 2]
    }
}
```

Set `glossary_provider` in the config. Terms go to the engine as the `prompt` (comma-separated, after `context.field_label`) and as the `glossary` JSON field.

## Front-end

Use [`@ditactic/dictation-vue`](../vue/) (`<DictationButton>`, `<DictationRecordingList>`, `useDictation()`); point its `endpoints` at the route names above:

```js
import { route } from 'ziggy-js';

const options = {
  http: axiosAdapter(axios),
  endpoints: {
    create: route('partner.carton.dictation.store'),
    show: (uuid) => route('partner.carton.dictation.show', uuid),
    update: (uuid) => route('partner.carton.dictation.update', uuid),
    destroy: (uuid) => route('partner.carton.dictation.destroy', uuid),
    audio: (uuid) => route('partner.carton.dictation.audio', uuid),
  },
  language: 'auto',
};
```

## Events

- `Ditactic\Dictation\Events\RecordingCreated($recording)`
- `Ditactic\Dictation\Events\TranscriptionCompleted($recording)`
- `Ditactic\Dictation\Events\TranscriptionFailed($recording, string $error, bool $willRetry)`

Listen to them to broadcast over Reverb/Pusher instead of polling.

## Post-processing (optional)

Set `DICTATION_POSTPROCESS=true` to pass the engine text through `AnthropicPostProcessor` before it is stored as `transcript` (`transcript_raw` is always kept). It calls the Messages API directly (`x-api-key`, `anthropic-version: 2023-06-01`) with the system prompt from `resources/prompts/bhs-medical-cleanup.md`: fix Latin medical terms, keep the speaker's ekavica/ijekavica, apply spoken punctuation commands, never add facts. Any failure, refusal or implausible answer falls back to the raw text. Plug in your own by implementing `TranscriptPostProcessor` and setting `postprocess.driver` to the class name.

## Artisan

```bash
php artisan dictation:health                   # GET /health and /v1/models on the engine
php artisan dictation:transcribe <uuid>        # run one recording synchronously (debugging)
php artisan dictation:requeue                  # re-queue failed recordings
php artisan dictation:requeue --stuck=30       # ...and pending/processing ones untouched for 30 min
php artisan dictation:requeue --uuid=... --dry-run
```

## Testing your app

```php
use Ditactic\Dictation\Facades\Dictation;

$fake = Dictation::fake('Pacijent navodi bol u leđima.');  // swaps the driver, runs the job synchronously

$this->actingAs($doctor)->post(route('partner.carton.dictation.store'), [
    'audio' => UploadedFile::fake()->create('rec.webm', 100, 'audio/webm'),
    'language' => 'bs',
    'recordable_type' => 'carton_entry',
    'recordable_id' => $entry->id,
])->assertCreated()->assertJsonPath('data.status', 'done');

$fake->assertTranscribed(fn ($request) => $request->language === 'bs');
$fake->failWith('engine down', retryable: false);     // next upload ends in status=failed
```

## Engine

The default driver expects the self-hosted engine from this repository. Minimal `docker-compose`:

```yaml
services:
  dictation-engine:
    image: ghcr.io/dseremet/dictation-engine:cpu
    environment:
      ASR_MODEL: large-v3-turbo
      ASR_COMPUTE_TYPE: int8
      ASR_API_KEYS: ${DICTATION_ENGINE_TOKEN}
      ASR_DEFAULT_LANGUAGE: auto
    volumes:
      - dictation-models:/models
    ports:
      - "127.0.0.1:8321:8000"
    read_only: true
    tmpfs: [/tmp]
volumes:
  dictation-models:
```

See [`engine/README.md`](../../engine/README.md) and [`docs/deploy.md`](../../docs/deploy.md) for sizing (a 5-minute dictation takes 2-4 minutes on 8 vCPUs), GPU images and model management. Pointing the driver at OpenAI instead is a config change: `DICTATION_ENGINE_URL=https://api.openai.com`, `DICTATION_ENGINE_TOKEN=sk-...`, `DICTATION_ENGINE_MODEL=whisper-1`.

## Development

```bash
cd packages/laravel
composer install
composer test        # Orchestra Testbench, SQLite in-memory only
```

## License

MIT
