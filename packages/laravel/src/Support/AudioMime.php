<?php

namespace Ditactic\Dictation\Support;

/**
 * Maps upload mime types to the file extension the audio is stored with.
 * The client file name is never trusted.
 */
final class AudioMime
{
    /** @var array<string, string> */
    public const EXTENSIONS = [
        'audio/webm' => 'webm',
        'video/webm' => 'webm',
        'audio/ogg' => 'ogg',
        'application/ogg' => 'ogg',
        'audio/opus' => 'ogg',
        'audio/mp4' => 'm4a',
        'video/mp4' => 'm4a',
        'audio/x-m4a' => 'm4a',
        'audio/m4a' => 'm4a',
        'audio/aac' => 'aac',
        'audio/x-aac' => 'aac',
        'audio/mpeg' => 'mp3',
        'audio/mp3' => 'mp3',
        'audio/wav' => 'wav',
        'audio/x-wav' => 'wav',
        'audio/wave' => 'wav',
        'audio/vnd.wave' => 'wav',
        'audio/x-pn-wav' => 'wav',
    ];

    /** Lower-case the type and strip parameters: `audio/webm;codecs=opus` -> `audio/webm`. */
    public static function normalize(?string $mime): ?string
    {
        if ($mime === null || trim($mime) === '') {
            return null;
        }

        return strtolower(trim(explode(';', $mime, 2)[0]));
    }

    public static function extensionFor(?string $mime): ?string
    {
        $mime = self::normalize($mime);

        return $mime ? (self::EXTENSIONS[$mime] ?? null) : null;
    }

    public static function isAllowed(?string $mime, ?array $allowed = null): bool
    {
        $mime = self::normalize($mime);
        $allowed ??= array_keys(self::EXTENSIONS);

        return $mime !== null && in_array($mime, array_map([self::class, 'normalize'], $allowed), true);
    }
}
