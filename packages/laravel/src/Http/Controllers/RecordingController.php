<?php

namespace Ditactic\Dictation\Http\Controllers;

use Ditactic\Dictation\Contracts\OwnerResolver;
use Ditactic\Dictation\Contracts\RecordingAuthorizer;
use Ditactic\Dictation\DictationService;
use Ditactic\Dictation\Exceptions\InvalidUploadException;
use Ditactic\Dictation\Http\Requests\StoreRecordingRequest;
use Ditactic\Dictation\Http\Requests\UpdateRecordingRequest;
use Ditactic\Dictation\Http\Resources\RecordingResource;
use Ditactic\Dictation\Models\Recording;
use Ditactic\Dictation\Support\RecordableResolver;
use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;
use Illuminate\Routing\Controller;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\Response;

class RecordingController extends Controller
{
    public function __construct(
        protected DictationService $service,
        protected RecordingAuthorizer $authorizer,
        protected OwnerResolver $owners,
    ) {
    }

    /**
     * GET /  List recordings for a recordable (`?recordable_type=&recordable_id=`)
     * or, without those, the recent recordings of the current owner.
     */
    public function index(Request $request): AnonymousResourceCollection
    {
        $validated = $request->validate([
            'recordable_type' => ['sometimes', 'nullable', 'string', 'max:191', 'required_with:recordable_id'],
            'recordable_id' => ['sometimes', 'nullable', 'string', 'max:64', 'required_with:recordable_type'],
            'status' => ['sometimes', 'nullable', 'string', 'in:'.implode(',', Recording::STATUSES)],
            'limit' => ['sometimes', 'integer', 'min:1', 'max:200'],
        ]);

        $user = $request->user();
        [$ownerType, $ownerId] = $this->owners->resolve($request, $user);

        $query = $this->service->newQuery()->forOwner($ownerType, $ownerId)->latest('id');

        if (! empty($validated['recordable_type'])) {
            $recordable = $this->resolveRecordable($validated['recordable_type'], $validated['recordable_id'] ?? null);
            $query->forRecordable($recordable);
        }

        if (! empty($validated['status'])) {
            $query->status($validated['status']);
        }

        $recordings = $query->limit((int) ($validated['limit'] ?? 50))->get()
            ->filter(fn (Recording $recording) => $this->authorizer->canView($user, $recording))
            ->values();

        return RecordingResource::collection($recordings);
    }

    /** POST /  Upload a recording and queue its transcription. */
    public function store(StoreRecordingRequest $request): JsonResponse
    {
        $validated = $request->validated();
        $user = $request->user();

        $recordable = null;
        if (! empty($validated['recordable_type'])) {
            $recordable = $this->resolveRecordable($validated['recordable_type'], $validated['recordable_id'] ?? null);
        }

        $owner = $this->owners->resolve($request, $user);

        $input = $validated + ['recordable' => $recordable, 'owner' => $owner];

        if (! $this->authorizer->canCreate($user, $input)) {
            throw new AuthorizationException('You are not allowed to add recordings here.');
        }

        try {
            $recording = $this->service->createFromUpload($request->file('audio'), [
                'owner' => $owner,
                'recordable' => $recordable,
                'language' => $validated['language'] ?? null,
                'duration_ms' => $validated['duration_ms'] ?? null,
                'context' => $validated['context'] ?? null,
            ], $user);
        } catch (InvalidUploadException $e) {
            throw $e->toValidationException();
        }

        return (new RecordingResource($recording->refresh()))
            ->response()
            ->setStatusCode(Response::HTTP_CREATED);
    }

    /** GET /{recording} */
    public function show(Request $request, string $recording): RecordingResource
    {
        $model = $this->findOrFail($recording);

        $this->authorize($this->authorizer->canView($request->user(), $model));

        return new RecordingResource($model);
    }

    /** PATCH /{recording}  Store the user's corrected transcript (null clears it). */
    public function update(UpdateRecordingRequest $request, string $recording): RecordingResource
    {
        $model = $this->findOrFail($recording);

        $this->authorize($this->authorizer->canUpdate($request->user(), $model));

        $this->service->correct($model, $request->validated()['transcript_corrected']);

        return new RecordingResource($model->refresh());
    }

    /** DELETE /{recording} */
    public function destroy(Request $request, string $recording): Response
    {
        $model = $this->findOrFail($recording);

        $this->authorize($this->authorizer->canDelete($request->user(), $model));

        $this->service->delete($model);

        return response()->noContent();
    }

    /** GET /{recording}/audio  Stream the audio file (private, no-store). */
    public function audio(Request $request, string $recording): Response
    {
        $model = $this->findOrFail($recording);

        $this->authorize($this->authorizer->canView($request->user(), $model));

        return $this->service->streamAudio($model);
    }

    /** POST /{recording}/retry  Re-queue a failed (or stuck) recording. */
    public function retry(Request $request, string $recording): JsonResponse
    {
        $model = $this->findOrFail($recording);

        $this->authorize($this->authorizer->canUpdate($request->user(), $model));

        if ($model->isDone()) {
            return (new RecordingResource($model))->response()->setStatusCode(Response::HTTP_OK);
        }

        if ($model->isProcessing() && $model->updated_at?->gt(now()->subSeconds((int) config('dictation.queue.timeout', 900)))) {
            throw ValidationException::withMessages(['status' => ['The recording is still being processed.']])->status(Response::HTTP_CONFLICT);
        }

        $this->service->retry($model);

        return (new RecordingResource($model->refresh()))
            ->response()
            ->setStatusCode(Response::HTTP_ACCEPTED);
    }

    // ---------------------------------------------------------------- helpers

    protected function findOrFail(string $uuid): Recording
    {
        $recording = $this->service->findByUuid($uuid);

        if ($recording === null) {
            abort(404, 'Recording not found.');
        }

        return $recording;
    }

    protected function authorize(bool $allowed): void
    {
        if (! $allowed) {
            throw new AuthorizationException('You are not allowed to access this recording.');
        }
    }

    protected function resolveRecordable(string $type, int|string|null $id): \Illuminate\Database\Eloquent\Model
    {
        if (RecordableResolver::classFor($type) === null) {
            throw ValidationException::withMessages(['recordable_type' => ['Unknown recordable type.']]);
        }

        $model = RecordableResolver::find($type, $id);

        if ($model === null) {
            throw ValidationException::withMessages(['recordable_id' => ['The recordable was not found.']]);
        }

        return $model;
    }
}
