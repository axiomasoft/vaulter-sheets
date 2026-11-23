<?php

declare(strict_types=1);

namespace Vaulter\Sheets\Tests;

use Illuminate\Contracts\Auth\Access\Authorizable;
use Illuminate\Foundation\Application;
use Override;
use Vaulter\Collaboration\Contracts\HostUserResolver;
use Vaulter\Collaboration\VaulterCollaborationServiceProvider;
use Vaulter\Testing\Fixtures\TestUser;
use Vaulter\ValueObjects\Access\ActorRef;

abstract class RealtimeTestCase extends TestCase
{
    public const string OWNER_KEY = 'test-sheets-owner-key-with-at-least-32-bytes';

    public TestUser $user;

    private string $keyFile;

    #[Override]
    protected function getPackageProviders($app): array
    {
        return [...parent::getPackageProviders($app), VaulterCollaborationServiceProvider::class];
    }

    /** @param Application $app */
    #[Override]
    protected function defineEnvironment($app): void
    {
        parent::defineEnvironment($app);
        $app['config']->set('vaulter.modules.collaboration', true);
        $app['config']->set('vaulter.modules.sheets-realtime', true);
        $app['config']->set('vaulter-collaboration.hub.issuer', 'http://localhost');
        $app['config']->set('vaulter-collaboration.hub.jwt_keys', ['realtime' => str_repeat('j', 32)]);
        $app['config']->set('vaulter-collaboration.hub.jwt_active_kid', 'realtime');
        $app['config']->set('vaulter-collaboration.hub.webhook_secret', str_repeat('w', 32));
        $app['config']->set('vaulter-sheets.realtime.url', 'ws://localhost:3101');
        $app['config']->set('vaulter-sheets.runtime_command', ['node', dirname(__DIR__, 2).'/runtime/src/cli.ts']);
    }

    #[Override]
    protected function setUp(): void
    {
        parent::setUp();
        $this->keyFile = tempnam(sys_get_temp_dir(), 'sheets-owner-');
        file_put_contents($this->keyFile, self::OWNER_KEY);
        config(['vaulter-sheets.realtime.owner_token_file' => $this->keyFile]);
        $this->user = (new TestUser)->forceFill(['id' => 1]);
        $this->app->instance(HostUserResolver::class, new class($this->user) implements HostUserResolver
        {
            public function __construct(private readonly TestUser $user) {}

            public function find(ActorRef $principal): ?Authorizable
            {
                return match ((string) $principal->id) {
                    '1' => $this->user,
                    '2' => (new TestUser)->forceFill(['id' => 2]),
                    default => null,
                };
            }
        });
    }

    #[Override]
    protected function tearDown(): void
    {
        if (isset($this->keyFile)) {
            unlink($this->keyFile);
        }
        parent::tearDown();
    }
}
