export function deriveServerMode( value ) {
	const normalizedServerUrl = ( value || '' ).trim();
	if ( normalizedServerUrl.length === 0 ) {
		return 'default';
	}

	return 'custom';
}

export function resolveCustomServerUrl( currentServerUrl, defaultServerUrl ) {
	if ( typeof currentServerUrl === 'string' && currentServerUrl.trim() ) {
		return currentServerUrl.trim();
	}

	if ( typeof defaultServerUrl === 'string' && defaultServerUrl.trim() ) {
		return defaultServerUrl.trim();
	}

	return '';
}

export function createInstanceId( seed, providers = {} ) {
	const normalizedSeed = ( seed || '' )
		.toString()
		.toLowerCase()
		.replace( /[^a-z0-9]/g, '' );

	if ( normalizedSeed.length > 0 ) {
		return `ec${ normalizedSeed.slice( 0, 16 ) }`;
	}

	const randomSuffix = createRandomSuffix( providers );
	return `ec${ randomSuffix }`;
}

function createRandomSuffix( providers = {} ) {
	let cryptoApi = null;
	if ( Object.prototype.hasOwnProperty.call( providers, 'crypto' ) ) {
		cryptoApi = providers.crypto;
	} else if ( typeof globalThis !== 'undefined' && globalThis.crypto ) {
		cryptoApi = globalThis.crypto;
	}
	const random =
		typeof providers.random === 'function' ? providers.random : Math.random;

	if ( cryptoApi && typeof cryptoApi.randomUUID === 'function' ) {
		return cryptoApi.randomUUID().replace( /-/g, '' ).slice( 0, 10 );
	}

	let suffix = '';
	while ( suffix.length < 10 ) {
		suffix += random().toString( 36 ).slice( 2 );
	}

	return suffix.slice( 0, 10 );
}
