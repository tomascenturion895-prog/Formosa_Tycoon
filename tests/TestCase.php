<?php

namespace Tests;

use Illuminate\Foundation\Testing\TestCase as BaseTestCase;

abstract class TestCase extends BaseTestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        // Las pruebas de ingreso asumen un ritmo fijo; las de eventos lo encienden (ver MatchEventsTest y EconomyServiceTest).
        config(['formosa.events.enabled' => false]);
    }
}
