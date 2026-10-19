<?php

namespace Ditactic\Dictation\Tests\Unit;

use Ditactic\Dictation\Support\AudioMime;
use PHPUnit\Framework\TestCase;

class AudioMimeTest extends TestCase
{
    public function test_extension_mapping(): void
    {
        $this->assertSame('webm', AudioMime::extensionFor('audio/webm;codecs=opus'));
        $this->assertSame('webm', AudioMime::extensionFor('VIDEO/WEBM'));
        $this->assertSame('m4a', AudioMime::extensionFor('audio/mp4'));
        $this->assertSame('m4a', AudioMime::extensionFor('audio/x-m4a'));
        $this->assertSame('aac', AudioMime::extensionFor('audio/aac'));
        $this->assertSame('mp3', AudioMime::extensionFor('audio/mpeg'));
        $this->assertSame('wav', AudioMime::extensionFor('audio/x-wav'));
        $this->assertSame('ogg', AudioMime::extensionFor('audio/ogg'));
        $this->assertNull(AudioMime::extensionFor('text/plain'));
        $this->assertNull(AudioMime::extensionFor(null));
        $this->assertNull(AudioMime::extensionFor(''));
    }

    public function test_allowed_list(): void
    {
        $this->assertTrue(AudioMime::isAllowed('audio/webm', ['audio/webm']));
        $this->assertTrue(AudioMime::isAllowed('audio/webm; codecs=opus', ['audio/webm']));
        $this->assertFalse(AudioMime::isAllowed('audio/mpeg', ['audio/webm']));
        $this->assertFalse(AudioMime::isAllowed(null));
    }
}
