<?php

declare(strict_types=1);

use Illuminate\Foundation\Testing\RefreshDatabase;
use Vaulter\Sheets\Tests\TestCase;
use Vaulter\Sheets\Tests\WithoutSheetsTestCase;

uses(TestCase::class)->in('Contract');
uses(TestCase::class, RefreshDatabase::class)->in('Feature/SpreadsheetContentTest.php');
uses(WithoutSheetsTestCase::class, RefreshDatabase::class)->in('Feature/SpreadsheetDisabledTest.php');
