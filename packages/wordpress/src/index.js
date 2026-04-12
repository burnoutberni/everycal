/**
 * EveryCal Gutenberg Block — Editor component.
 *
 * This block is server-side rendered; the editor shows a preview
 * and settings panel for configuring the feed URL.
 */

import { registerBlockType } from '@wordpress/blocks';
import { InspectorControls, useBlockProps } from '@wordpress/block-editor';
import { useSelect } from '@wordpress/data';
import { useEffect } from '@wordpress/element';
import {
	PanelBody,
	TextControl,
	RangeControl,
	SelectControl,
} from '@wordpress/components';
import { __, sprintf } from '@wordpress/i18n';
import { ServerSideRender } from '@wordpress/server-side-render';

import metadata from './block.json';
import { createInstanceId, deriveServerMode } from './utils';
import './editor.scss';
import './style.scss';

const Edit = ( { attributes, setAttributes, clientId } ) => {
	const {
		serverMode,
		serverUrl,
		account,
		limit,
		layout,
		gridColumns,
		descriptionLengthMode,
		descriptionWordCount,
		descriptionCharCount,
		instanceId,
	} = attributes;

	useEffect( () => {
		if ( typeof instanceId === 'string' && instanceId.trim().length > 0 ) {
			return;
		}

		setAttributes( { instanceId: createInstanceId( clientId ) } );
	}, [ instanceId, clientId, setAttributes ] );

	const defaultServerUrl = useSelect( ( select ) => {
		const blockType = select( 'core/blocks' ).getBlockType( metadata.name );
		const value = blockType?.attributes?.serverUrl?.default;
		return typeof value === 'string' ? value.trim() : '';
	}, [] );
	const configuredDefaultServerUrl =
		typeof globalThis?.everycalBlockConfig?.defaultServerUrl === 'string'
			? globalThis.everycalBlockConfig.defaultServerUrl.trim()
			: '';
	const effectiveDefaultServerUrl =
		configuredDefaultServerUrl || defaultServerUrl;
	const selectedServerMode =
		serverMode === 'default' || serverMode === 'custom'
			? serverMode
			: deriveServerMode( serverUrl );
	const supportsDescription = layout === 'list' || layout === 'grid';
	const isGridLayout = layout === 'grid';
	const hasCustomServer = selectedServerMode === 'custom';
	const blockProps = useBlockProps();

	return (
		<div { ...blockProps }>
			<InspectorControls>
				<PanelBody
					title={ __( 'Feed Settings', 'everycal' ) }
					initialOpen={ true }
				>
					<SelectControl
						label={ __( 'Server source', 'everycal' ) }
						value={ selectedServerMode }
						options={ [
							{
								label: effectiveDefaultServerUrl
									? sprintf(
											// translators: %s is the site default EveryCal server URL.
											__(
												'Site default (%s)',
												'everycal'
											),
											effectiveDefaultServerUrl
									  )
									: __(
											'Site default (not configured)',
											'everycal'
									  ),
								value: 'default',
							},
							{
								label: __( 'Custom URL', 'everycal' ),
								value: 'custom',
							},
						] }
						onChange={ ( val ) => {
							if ( val === 'default' ) {
								setAttributes( {
									serverMode: 'default',
									serverUrl: '',
								} );
								return;
							}
							setAttributes( {
								serverMode: 'custom',
								serverUrl: effectiveDefaultServerUrl
									? effectiveDefaultServerUrl.trim()
									: '',
							} );
						} }
					/>
					{ hasCustomServer && (
						<TextControl
							label={ __( 'EveryCal Server URL', 'everycal' ) }
							help={
								<>
									{ __(
										'e.g. https://events.example.com',
										'everycal'
									) }
									{ hasCustomServer && (
										<>
											{ ' ' }
											<a href="options-general.php?page=everycal">
												{ __(
													'Using a custom server? Add it to Additional HTTP debug servers in EveryCal settings.',
													'everycal'
												) }
											</a>
										</>
									) }
								</>
							}
							placeholder={
								effectiveDefaultServerUrl || undefined
							}
							value={ serverUrl }
							onChange={ ( val ) =>
								setAttributes( { serverUrl: val } )
							}
						/>
					) }
					<TextControl
						label={ __( 'Account (optional)', 'everycal' ) }
						help={ __(
							'Filter events by account username. Leave empty for all public events.',
							'everycal'
						) }
						value={ account }
						onChange={ ( val ) =>
							setAttributes( { account: val } )
						}
					/>
				</PanelBody>

				<PanelBody
					title={ __( 'Style Settings', 'everycal' ) }
					initialOpen={ false }
				>
					<RangeControl
						label={ __( 'Number of events', 'everycal' ) }
						value={ limit }
						onChange={ ( val ) => setAttributes( { limit: val } ) }
						min={ 1 }
						max={ 50 }
					/>
					<SelectControl
						label={ __( 'Layout', 'everycal' ) }
						value={ layout }
						options={ [
							{ label: __( 'List', 'everycal' ), value: 'list' },
							{ label: __( 'Grid', 'everycal' ), value: 'grid' },
							{
								label: __( 'Compact', 'everycal' ),
								value: 'compact',
							},
						] }
						onChange={ ( val ) => setAttributes( { layout: val } ) }
					/>
					{ isGridLayout && (
						<RangeControl
							label={ __( 'Grid columns', 'everycal' ) }
							value={ gridColumns }
							onChange={ ( val ) =>
								setAttributes( { gridColumns: val } )
							}
							min={ 1 }
							max={ 6 }
							step={ 1 }
						/>
					) }
					{ supportsDescription && (
						<>
							<SelectControl
								label={ __( 'Description length', 'everycal' ) }
								value={ descriptionLengthMode }
								options={ [
									{
										label: __( 'Full', 'everycal' ),
										value: 'full',
									},
									{
										label: __( 'Word count', 'everycal' ),
										value: 'words',
									},
									{
										label: __(
											'Character count',
											'everycal'
										),
										value: 'chars',
									},
								] }
								onChange={ ( val ) =>
									setAttributes( {
										descriptionLengthMode: val,
									} )
								}
							/>
							{ descriptionLengthMode === 'words' && (
								<RangeControl
									label={ __(
										'Description length (words)',
										'everycal'
									) }
									value={ descriptionWordCount }
									onChange={ ( val ) =>
										setAttributes( {
											descriptionWordCount: val,
										} )
									}
									min={ 5 }
									max={ 120 }
									step={ 1 }
								/>
							) }
							{ descriptionLengthMode === 'chars' && (
								<RangeControl
									label={ __(
										'Description length (characters)',
										'everycal'
									) }
									value={ descriptionCharCount }
									onChange={ ( val ) =>
										setAttributes( {
											descriptionCharCount: val,
										} )
									}
									min={ 50 }
									max={ 1000 }
									step={ 10 }
								/>
							) }
						</>
					) }
				</PanelBody>
			</InspectorControls>

			<ServerSideRender block="everycal/feed" attributes={ attributes } />
		</div>
	);
};

registerBlockType( metadata.name, {
	edit: Edit,

	// Server-side rendered — no save needed
	save() {
		return null;
	},
} );
