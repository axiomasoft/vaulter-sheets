<?php

declare(strict_types=1);

use Packman\Attributes\Internal;

arch('every source file declares strict types')
    ->expect('Vaulter\Sheets')
    ->toUseStrictTypes();

arch('production code never depends on the test suite')
    ->expect('Vaulter\Sheets')
    ->not->toUse('Vaulter\Sheets\Tests')
    ->ignoring('Vaulter\Sheets\Tests');

arch('no debugging helpers are left behind')
    ->expect(['dd', 'dump', 'ddd', 'ray', 'var_dump'])
    ->not->toBeUsed();

arch('classes are final')
    ->expect('Vaulter\Sheets')
    ->classes()
    ->toBeFinal()
    ->ignoring('Vaulter\Sheets\Tests');

it('imports no class another Vaulter or Packman package marks #[Internal]', function (): void {
    $root = dirname(__DIR__, 2).'/src/';
    $imports = [];
    $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS));
    foreach ($files as $file) {
        if (!$file instanceof SplFileInfo || $file->getExtension() !== 'php') {
            continue;
        }
        $source = (string) file_get_contents($file->getPathname());
        preg_match_all('/^use\s+((?:Vaulter|Packman)\\\\(?!Sheets\\\\)[A-Za-z0-9_\\\\]+);/m', $source, $matches);
        foreach ($matches[1] as $import) {
            $imports[] = [substr($file->getPathname(), strlen($root)), $import];
        }
    }

    $internal = [];
    foreach ($imports as [$path, $import]) {
        expect(class_exists($import) || interface_exists($import) || enum_exists($import) || trait_exists($import))
            ->toBeTrue("{$path} imports {$import}, which does not exist");
        if (new ReflectionClass($import)->getAttributes(Internal::class) !== []) {
            $internal[] = "{$path} -> {$import}";
        }
    }

    expect($imports)->not->toBeEmpty()
        ->and($internal)->toBeEmpty();
});
