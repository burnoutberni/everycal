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
	Notice,
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
		} = attributes;
		const supportsDescription = layout === "list" || layout === "grid";
		const isGridLayout = layout === "grid";
		const hasCustomServer = (serverUrl || "").trim().length > 0;
		const usesDefaultServerFallback = !hasCustomServer;
		const blockProps = useBlockProps();

		return (
			<div {...blockProps}>
				<InspectorControls>
					<PanelBody title={__("Feed Settings", "everycal")} initialOpen={true}>
						{usesDefaultServerFallback && (
							<Notice status="info" isDismissible={false}>
								{__(
									"No per-block server URL is set. This block uses the default EveryCal server URL from plugin settings when available.",
									"everycal"
								)}
							</Notice>
						)}
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

				<ServerSideRender
					block="everycal/feed"
					attributes={attributes}
				/>
			</div>
		);
	},

	// Server-side rendered — no save needed
	save() {
		return null;
	},
});
