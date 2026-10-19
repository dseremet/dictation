<?php

namespace Ditactic\Dictation\Tests\Feature;

use Ditactic\Dictation\Facades\Dictation;
use Ditactic\Dictation\Tests\TestCase;
use Illuminate\Support\Facades\Route;

class RoutesTest extends TestCase
{
    public function test_routes_are_registered_inside_the_callers_group(): void
    {
        foreach (['index', 'store', 'show', 'update', 'destroy', 'audio', 'retry'] as $action) {
            $this->assertTrue(Route::has("dictation.{$action}"), $action);
            $this->assertSame("dictation.{$action}", Dictation::routeName($action));
        }

        $this->assertSame('api/dictation', Route::getRoutes()->getByName('dictation.store')->uri());
        $this->assertSame('api/dictation/{recording}/audio', Route::getRoutes()->getByName('dictation.audio')->uri());
        $this->assertContains('auth', Route::getRoutes()->getByName('dictation.audio')->middleware());
        $this->assertSame(['POST'], Route::getRoutes()->getByName('dictation.retry')->methods());
    }

    public function test_route_names_are_recovered_by_action_when_routes_came_from_cache(): void
    {
        // Simulates routes loaded from the route cache, where routes() never ran in this process.
        Dictation::flushRouteNames();

        $this->assertSame('dictation.audio', Dictation::routeName('audio'));
        $this->assertSame('dictation.show', Dictation::routeName('show'));
        $this->assertNull(Dictation::routeName('nope'));
    }

    public function test_only_and_except_options(): void
    {
        Route::prefix('x')->name('x.')->group(fn () => Dictation::routes(['only' => ['store', 'show']]));
        Route::prefix('y')->name('y.')->group(fn () => Dictation::routes(['except' => ['destroy']]));

        $this->assertTrue(Route::has('x.store'));
        $this->assertTrue(Route::has('x.show'));
        $this->assertFalse(Route::has('x.audio'));
        $this->assertTrue(Route::has('y.audio'));
        $this->assertFalse(Route::has('y.destroy'));
    }
}
