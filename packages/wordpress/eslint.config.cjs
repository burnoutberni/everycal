const wordpressConfig = require( '@wordpress/scripts/config/eslint.config.cjs' );

module.exports = [
	...wordpressConfig,
	{
		languageOptions: {
			globals: {
				globalThis: 'readonly',
			},
		},
	},
];
