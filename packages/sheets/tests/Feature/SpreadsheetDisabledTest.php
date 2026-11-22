<?php

declare(strict_types=1);

use Vaulter\Drive\Facades\Vaulter;
use Vaulter\Drive\Testing\Drive\DriveTestHelpers;
use Vaulter\Drive\Testing\Http\V1;
use Vaulter\Testing\Fixtures\TestUser;

beforeEach(function (): void {
    $this->actingAs((new TestUser)->forceFill(['id' => 1]));
});

it('rejects a spreadsheet create when VaulterSheetsServiceProvider is not registered', function (): void {
    $drive = Vaulter::drive(DriveTestHelpers::host())->model()->getKey();

    $this->postJson(V1::url('drives/'.$drive.'/documents'), [
        'name' => 'Budget.xlsx',
        'type' => 'vaulter/spreadsheet',
    ])
        ->assertStatus(422)
        ->assertJsonPath('code', 'unknown_document_type');
});
