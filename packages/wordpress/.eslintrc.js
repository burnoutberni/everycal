module.exports = {
	extends: [ 'plugin:@wordpress/eslint-plugin/recommended' ],
	globals: {
		globalThis: 'readonly',
	},
	overrides: [
		{
			files: [ '*.test.js', '**/*.test.js' ],
			env: {
				jest: true,
				node: true,
			},
		},
	],
};
