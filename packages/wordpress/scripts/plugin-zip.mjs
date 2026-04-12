import { access, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify( execFile );

const scriptDir = path.dirname( fileURLToPath( import.meta.url ) );
const packageDir = path.resolve( scriptDir, '..' );
const packageJsonPath = path.join( packageDir, 'package.json' );

const packageJson = JSON.parse( await readFile( packageJsonPath, 'utf8' ) );
const version = packageJson.version;

if ( ! version ) {
	throw new Error( 'Could not determine plugin version from package.json.' );
}

const pluginSlug = 'everycal';
const outputZipName = `${ pluginSlug }-${ version }.zip`;
const outputZipPath = path.join( packageDir, outputZipName );
const requiredEntries = [ 'everycal.php', 'readme.txt', 'build', 'languages' ];

for ( const entry of requiredEntries ) {
	const entryPath = path.join( packageDir, entry );
	try {
		await access( entryPath, constants.F_OK );
	} catch {
		throw new Error( `Missing required plugin artifact: ${ entry }` );
	}
}

const tempRoot = await mkdtemp( path.join( tmpdir(), 'everycal-plugin-zip-' ) );
const tempPluginDir = path.join( tempRoot, pluginSlug );

try {
	await mkdir( tempPluginDir, { recursive: true } );

	for ( const entry of requiredEntries ) {
		await cp( path.join( packageDir, entry ), path.join( tempPluginDir, entry ), {
			recursive: true,
		} );
	}

	await rm( outputZipPath, { force: true } );

	await execFileAsync( 'zip', [ '-rq', outputZipPath, pluginSlug ], {
		cwd: tempRoot,
	} );

	console.log( `Created ${ outputZipName }` );
	console.log( `Path: ${ outputZipPath }` );
} finally {
	await rm( tempRoot, { recursive: true, force: true } );
}
