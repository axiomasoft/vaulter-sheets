<?php

declare(strict_types=1);

use Packman\DevTools\Rector\PackmanRectorSet;
use Rector\CodeQuality\Rector\Catch_\ThrowWithPreviousExceptionRector;
use Rector\CodeQuality\Rector\ClassMethod\LocallyCalledStaticMethodToNonStaticRector;
use Rector\CodeQuality\Rector\Concat\DirnameDirConcatStringToDirectStringPathRector;
use Rector\CodeQuality\Rector\Identical\SimplifyBoolIdenticalTrueRector;
use Rector\CodeQuality\Rector\If_\ExplicitNullableObjectInstanceRector;
use Rector\CodingStyle\Rector\ArrowFunction\ArrowFunctionDelegatingCallToFirstClassCallableRector;
use Rector\Config\RectorConfig;
use Rector\DeadCode\Rector\ClassMethod\RemoveEmptyClassMethodRector;
use Rector\DeadCode\Rector\ClassMethod\RemoveUnusedPublicMethodParameterRector;
use Rector\DeadCode\Rector\FunctionLike\NarrowWideUnionReturnTypeRector;
use Rector\Php80\Rector\Class_\ClassPropertyAssignToConstructorPromotionRector;
use Rector\Php81\Rector\Property\ReadOnlyPropertyRector;
use Rector\Php82\Rector\Class_\ReadOnlyClassRector;
use Rector\Php83\Rector\Class_\ReadOnlyAnonymousClassRector;
use Rector\TypeDeclaration\Rector\ClassMethod\NarrowObjectReturnTypeRector;

// Same rule set and exclusions as the vaulter base repository, so a Rector
// finding means the same thing in every repository of the family.
return static function (RectorConfig $rectorConfig): void {
    $rectorConfig->paths([
        __DIR__.'/packages/sheets/src',
        __DIR__.'/packages/sheets/database',
        __DIR__.'/packages/sheets/tests',
    ]);
    $rectorConfig->importNames(importDocBlockNames: false);
    $rectorConfig->removeUnusedImports();

    PackmanRectorSet::configure($rectorConfig, [
        ReadOnlyClassRector::class,
        ReadOnlyPropertyRector::class,
        ReadOnlyAnonymousClassRector::class,
        LocallyCalledStaticMethodToNonStaticRector::class,
        ExplicitNullableObjectInstanceRector::class,
        RemoveEmptyClassMethodRector::class,
        RemoveUnusedPublicMethodParameterRector::class,
        NarrowObjectReturnTypeRector::class,
        NarrowWideUnionReturnTypeRector::class,
        ThrowWithPreviousExceptionRector::class,
        SimplifyBoolIdenticalTrueRector::class,
        // PluginManifest::resourceRoot rejects paths containing '..' segments.
        DirnameDirConcatStringToDirectStringPathRector::class,
    ]);

    $rectorConfig->ruleWithConfiguration(ClassPropertyAssignToConstructorPromotionRector::class, [
        ClassPropertyAssignToConstructorPromotionRector::RENAME_PROPERTY => false,
    ]);

    $rectorConfig->skip([
        // Pest binds $this to dataset closures, which throws on static first-class callables.
        ArrowFunctionDelegatingCallToFirstClassCallableRector::class => [
            __DIR__.'/packages/sheets/tests/*',
        ],
    ]);
};
