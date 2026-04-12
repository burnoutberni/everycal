import {
	createInstanceId,
	deriveServerMode,
	resolveCustomServerUrl,
} from './utils';

describe( 'deriveServerMode', () => {
	it( 'returns default for an empty string', () => {
		expect( deriveServerMode( '' ) ).toBe( 'default' );
	} );

	it( 'returns default for whitespace-only strings', () => {
		expect( deriveServerMode( '   ' ) ).toBe( 'default' );
	} );

	it( 'returns custom for non-empty values', () => {
		expect( deriveServerMode( 'https://events.example.com' ) ).toBe(
			'custom'
		);
	} );
} );

describe( 'createInstanceId', () => {
	afterEach( () => {
		jest.restoreAllMocks();
	} );

	it( 'creates a deterministic id from a seed', () => {
		expect(
			createInstanceId( '4f8e17af-5f90-4d4a-87b6-955d3d5cf8bd' )
		).toBe( 'ec4f8e17af5f904d4a' );
	} );

	it( 'uses crypto.randomUUID when available', () => {
		const randomUUID = jest
			.fn()
			.mockReturnValue( '12345678-90ab-cdef-1234-567890abcdef' );

		const result = createInstanceId( undefined, {
			crypto: { randomUUID },
		} );
		expect( result ).toBe( 'ec1234567890' );
		expect( randomUUID ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'falls back to a fixed-length random id when crypto is missing', () => {
		const random = jest.fn().mockReturnValue( 0.5 );

		const result = createInstanceId( undefined, {
			crypto: undefined,
			random,
		} );

		expect( result ).toBe( 'eci000000000' );
		expect( result ).toMatch( /^ec[a-z0-9]{10}$/ );
		expect( random ).toHaveBeenCalled();
	} );

	it( 'returns a non-empty fixed-width suffix when random returns zero', () => {
		const random = jest.fn().mockReturnValue( 0 );

		const result = createInstanceId( undefined, {
			crypto: undefined,
			random,
		} );

		expect( result ).toBe( 'ec0000000000' );
		expect( random ).toHaveBeenCalledTimes( 1 );
	} );
} );

describe( 'resolveCustomServerUrl', () => {
	it( 'preserves an existing custom URL', () => {
		expect(
			resolveCustomServerUrl(
				' https://custom.example.com ',
				'https://default.example.com'
			)
		).toBe( 'https://custom.example.com' );
	} );

	it( 'prefills from the default URL when current is empty', () => {
		expect(
			resolveCustomServerUrl( '', ' https://default.example.com ' )
		).toBe( 'https://default.example.com' );
	} );

	it( 'returns empty when both current and default are empty', () => {
		expect( resolveCustomServerUrl( '   ', '' ) ).toBe( '' );
	} );
} );
