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
		const {
			serverUrl,
			account,
			limit,
			layout,
			gridColumns,
			descriptionLengthMode,
			descriptionWordCount,
			descriptionCharCount,
			cacheTtl,
		} = attributes;
		const supportsDescription = layout === "list" || layout === "grid";
		const isGridLayout = layout === "grid";
		const hasCustomServer = (serverUrl || "").trim().length > 0;
		const blockProps = useBlockProps();

		return (
			<div {...blockProps}>
				<InspectorControls>
					<PanelBody title={__("Feed Settings", "everycal")} initialOpen={true}>
						<TextControl
							label={__("EveryCal Server URL", "everycal")}
							help={
								<>
									{__("e.g. https://events.example.com", "everycal")}
									{hasCustomServer && (
										<>
											{" "}
											<a href="options-general.php?page=everycal">
												{__(
													"Using a custom server? Add it to Additional HTTP debug servers in EveryCal settings.",
													"everycal"
												)}
											</a>
										</>
									)}
								</>
							}
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
							label={__("Cache duration (minutes)", "everycal")}
							help={__(
								"How long to cache fetched events. 1440 = 1 day.",
								"everycal"
							)}
							value={cacheTtl}
							onChange={(val) =>
								setAttributes({ cacheTtl: val })
							}
							min={0}
							max={2880}
							step={1}
						/>
					</PanelBody>

					<PanelBody title={__("Style Settings", "everycal")} initialOpen={false}>
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
						{isGridLayout && (
							<RangeControl
								label={__("Grid columns", "everycal")}
								value={gridColumns}
								onChange={(val) => setAttributes({ gridColumns: val })}
								min={1}
								max={6}
								step={1}
							/>
						)}
						{supportsDescription && (
							<>
								<SelectControl
									label={__("Description length", "everycal")}
									value={descriptionLengthMode}
									options={[
										{ label: __("Full", "everycal"), value: "full" },
										{ label: __("Word count", "everycal"), value: "words" },
										{ label: __("Character count", "everycal"), value: "chars" },
									]}
									onChange={(val) => setAttributes({ descriptionLengthMode: val })}
								/>
								{descriptionLengthMode === "words" && (
									<RangeControl
										label={__("Description length (words)", "everycal")}
										value={descriptionWordCount}
										onChange={(val) => setAttributes({ descriptionWordCount: val })}
										min={5}
										max={120}
										step={1}
									/>
								)}
								{descriptionLengthMode === "chars" && (
									<RangeControl
										label={__("Description length (characters)", "everycal")}
										value={descriptionCharCount}
										onChange={(val) => setAttributes({ descriptionCharCount: val })}
										min={50}
										max={1000}
										step={10}
									/>
								)}
							</>
						)}
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
