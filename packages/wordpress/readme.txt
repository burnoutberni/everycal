=== EveryCal ===
Contributors: everycal
Tags: events, calendar, activitypub, federation, gutenberg
Requires at least: 6.4
Tested up to: 6.6
Requires PHP: 7.4
Stable tag: 0.1.0
License: AGPL-3.0-only
License URI: https://www.gnu.org/licenses/agpl-3.0.html

Display federated event feeds from any EveryCal server with a Gutenberg block and optional event detail pages on your WordPress site.

== Description ==

EveryCal adds a server-rendered Gutenberg block that can display public events from an EveryCal server.

Key features:

* Gutenberg block (`EveryCal Feed`) with list, grid, and compact layouts.
* Optional account filter to show events from one EveryCal account.
* Plugin-level default server URL for fast editor setup.
* Two-tier cache strategy for feed and event detail performance.
* Optional event detail routing (`/events/@username/event-slug` by default).
* Built-in HTTP debug log viewer for troubleshooting upstream requests.

== Installation ==

1. Upload the plugin folder to `/wp-content/plugins/everycal` (or install from a generated zip).
2. Activate the plugin in **Plugins**.
3. Go to **Settings -> EveryCal** and set a default EveryCal server URL.
4. Edit a post/page, insert the **EveryCal Feed** block, and configure options.

== Frequently Asked Questions ==

= Which URL should I use as the EveryCal server URL? =

Use the base URL of your EveryCal instance, for example `https://events.example.com`.

= How can I show events from one account only? =

Set the block's **Account** field to the EveryCal username. Leave it empty to show all public events from the server.

= Why does the block show "No events found"? =

Check that the server URL is valid, the upstream feed has public events, and your server can make outbound HTTPS requests.

= Why are event detail pages returning 404? =

Save settings once in **Settings -> EveryCal** after changing the base path. This plugin flushes rewrite rules when that path changes.

= What happens if I clear the event base path setting? =

The plugin enforces a non-empty base path. Empty values automatically fall back to `events` so rewrites stay scoped to `/events/@username/event-slug`.

= How do I clear stale cache entries? =

Open **Settings -> EveryCal** and use the **Cached Events** section to clear one cached event or the entire cache.

== Privacy ==

This plugin fetches and caches public event feed data from the configured EveryCal server.

* It does not create visitor accounts or set tracking cookies.
* Optional HTTP debug logs store request metadata in WordPress options for troubleshooting.
* Site administrators can clear logs and cache data from the settings screen.

== Blocks ==

=== EveryCal Feed ===

Renders a server-side event feed from an EveryCal instance.

Block settings include server selection (site default or custom URL), optional account filter, event count, layout, and description length controls.

== Changelog ==

= 0.1.0 =

* Initial release.
* Added the EveryCal Feed Gutenberg block.
* Added plugin settings for server defaults, cache controls, routing, and creator profile links.
* Added cache and HTTP debug tooling in wp-admin.

== Upgrade Notice ==

= 0.1.0 =

Initial public release.
