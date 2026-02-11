/**
 * EveryCal Gutenberg Block — Editor component.
 *
 * This block is server-side rendered; the editor shows a preview
 * and settings panel for configuring the feed URL.
 */

import { registerBlockType } from "@wordpress/blocks";
import { InspectorControls, useBlockProps } from "@wordpress/block-editor";
import {
	PanelBody,
	TextControl,
	RangeControl,
	SelectControl,
} from "@wordpress/components";
import { __ } from "@wordpress/i18n";
import { ServerSideRender } from "@wordpress/server-side-render";

import metadata from "./block.json";
import "./editor.scss";
import "./style.scss";

registerBlockType(metadata.name, {
	edit({ attributes, setAttributes }) {
		const { serverUrl, account, limit, layout, cacheTtl } = attributes;
		const blockProps = useBlockProps();

		return (
			<div {...blockProps}>
				<InspectorControls>
					<PanelBody
						title={__("Feed Settings", "everycal")}
						initialOpen={true}
					>
						<TextControl
							label={__("EveryCal Server URL", "everycal")}
							help={__(
								"e.g. https://events.example.com",
								"everycal"
							)}
							value={serverUrl}
							onChange={(val) =>
								setAttributes({ serverUrl: val })
							}
						/>
						<TextControl
							label={__("Account (optional)", "everycal")}
							help={__(
								"Filter events by account username. Leave empty for all public events.",
								"everycal"
							)}
							value={account}
							onChange={(val) =>
								setAttributes({ account: val })
							}
						/>
						<RangeControl
							label={__("Number of events", "everycal")}
							value={limit}
							onChange={(val) => setAttributes({ limit: val })}
							min={1}
							max={50}
						/>
						<SelectControl
							label={__("Layout", "everycal")}
							value={layout}
							options={[
								{
									label: __("List", "everycal"),
									value: "list",
								},
								{
									label: __("Grid", "everycal"),
									value: "grid",
								},
								{
									label: __("Compact", "everycal"),
									value: "compact",
								},
							]}
							onChange={(val) => setAttributes({ layout: val })}
						/>
						<RangeControl
							label={__("Cache duration (seconds)", "everycal")}
							help={__(
								"How long to cache fetched events. 300 = 5 minutes.",
								"everycal"
							)}
							value={cacheTtl}
							onChange={(val) =>
								setAttributes({ cacheTtl: val })
							}
							min={0}
							max={3600}
							step={60}
						/>
					</PanelBody>
				</InspectorControls>

				{serverUrl ? (
					<ServerSideRender
						block="everycal/feed"
						attributes={attributes}
					/>
				) : (
					<div className="everycal-placeholder">
						<span className="dashicons dashicons-calendar-alt"></span>
						<p>
							{__(
								"Configure an EveryCal server URL in the block settings to display events.",
								"everycal"
							)}
						</p>
					</div>
				)}
			</div>
		);
	},

	// Server-side rendered — no save needed
	save() {
		return null;
	},
});
