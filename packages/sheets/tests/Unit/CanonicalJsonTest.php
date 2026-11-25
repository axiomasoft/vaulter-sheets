<?php

declare(strict_types=1);

use Symfony\Component\Process\Process;
use Vaulter\Sheets\Runtime\CanonicalJson;
use Vaulter\Sheets\Runtime\StrictJson;
use Vaulter\Sheets\Runtime\WireException;

// Command, evidence and checkpoint hashes are computed by PHP (CanonicalJson) and by
// the Node runtime (canonicalize() in packages/runtime/src/protocol.ts). Both must
// produce RFC 8785 output byte for byte, or the two sides disagree on every ETag.

it('renders numbers like ECMAScript Number::toString', function (float|int $number, string $expected): void {
    expect(CanonicalJson::encode($number))->toBe($expected);
})->with([
    'zero' => [0.0, '0'],
    'negative zero' => [-0.0, '0'],
    'integral double' => [100.0, '100'],
    'one tenth' => [0.1, '0.1'],
    'shortest round trip' => [0.30000000000000004, '0.30000000000000004'],
    'needs all 17 digits' => [2.0000000000000004, '2.0000000000000004'],
    'smallest plain fraction' => [0.000001, '0.000001'],
    'first exponent below' => [0.0000001, '1e-7'],
    'largest plain integer' => [1e20, '100000000000000000000'],
    'plain with trailing zeros' => [123456789012345680000.0, '123456789012345680000'],
    'first exponent above' => [1e21, '1e+21'],
    'mantissa with fraction' => [1.5e300, '1.5e+300'],
    'largest double' => [1.7976931348623157e308, '1.7976931348623157e+308'],
    'smallest subnormal' => [5e-324, '5e-324'],
    'negative' => [-1.25, '-1.25'],
    'safe integer' => [9007199254740991, '9007199254740991'],
    'negative safe integer' => [-9007199254740991, '-9007199254740991'],
]);

it('refuses values that have no canonical JSON form', function (mixed $value): void {
    expect(fn (): string => CanonicalJson::encode($value))->toThrow(WireException::class);
})->with([
    'integer above 2^53-1' => [9007199254740992],
    'NaN' => [NAN],
    'infinity' => [INF],
    'associative array' => [['a' => 1]],
]);

it('orders object keys by UTF-16 code units, not by code points or bytes', function (): void {
    // U+1F600 is the surrogate pair D83D DE00 and sorts before U+FB33 in UTF-16,
    // although its code point and its UTF-8 bytes are larger.
    $object = (object) ["\u{FB33}" => 5, "\u{1F600}" => 4, "\u{20AC}" => 1, '1' => 3, "\r" => 2];

    expect(CanonicalJson::encode($object))->toBe("{\"\\r\":2,\"1\":3,\"\u{20AC}\":1,\"\u{1F600}\":4,\"\u{FB33}\":5}");
});

it('escapes strings like JSON.stringify', function (): void {
    expect(CanonicalJson::encode("\u{2028}/\u{1F}<\"\\\u{E9}"))->toBe("\"\u{2028}/\\u001f<\\\"\\\\\u{E9}\"");
});

it('hashes the same document identically in PHP and in the Node runtime', function (): void {
    $document = '{"b":[1e21,1e-7,0.000001,-0,5e-324,1.7976931348623157e308,0.1,100,123456789012345680000,9007199254740994],'
        .'"\u20ac":1,"\r":2,"1":3,"\ud83d\ude00":4,"\ufb33":5,"s":"\u2028/\u001f<\"","n":{"z":null,"a":[true,false,{}]}}';
    $script = implode("\n", [
        "import {canonicalize} from './packages/runtime/src/protocol.ts';",
        "let input = '';",
        'for await (const chunk of process.stdin) input += chunk;',
        'process.stdout.write(canonicalize(JSON.parse(input)));',
    ]);
    $node = new Process(['node', '--input-type=module', '-e', $script], dirname(__DIR__, 4), null, $document, 30);
    $node->mustRun();

    expect(CanonicalJson::encode(StrictJson::decode($document)))->toBe($node->getOutput());
});
