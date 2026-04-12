<?php
/**
 * Plugin Name: EveryCal
 * Plugin URI:  https://github.com/burnoutberni/everycal
 * Description: Display federated event feeds from any EveryCal server. Just add the Gutenberg block and point it at a feed URL.
 * Version:     0.1.0
 * Author:      EveryCal Contributors
 * License:     AGPL-3.0-only
 * License URI: https://www.gnu.org/licenses/agpl-3.0.html
 * Text Domain: everycal
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'EVERYCAL_VERSION', '0.1.0' );
define( 'EVERYCAL_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'EVERYCAL_PLUGIN_URL', plugin_dir_url( __FILE__ ) );

// Load translations
add_action( 'init', 'everycal_load_textdomain' );
function everycal_load_textdomain() {
	load_plugin_textdomain(
		'everycal',
		false,
		dirname( plugin_basename( __FILE__ ) ) . '/languages'
	);
}

// Optional HTTP debug logging for EveryCal API calls.
add_action( 'http_api_debug', 'everycal_http_api_debug_logger', 10, 5 );
add_action( 'wp_ajax_everycal_get_http_logs', 'everycal_ajax_get_http_logs' );
add_action( 'wp_ajax_everycal_clear_cached_event', 'everycal_ajax_clear_cached_event' );
add_action( 'wp_ajax_everycal_refresh_cached_event', 'everycal_ajax_refresh_cached_event' );
add_action( 'admin_post_everycal_clear_http_logs', 'everycal_clear_http_logs_action' );
add_action( 'admin_post_everycal_clear_cached_event', 'everycal_clear_cached_event_action' );
add_action( 'admin_post_everycal_clear_all_cache', 'everycal_clear_all_cache_action' );
add_action( 'admin_post_everycal_refresh_cached_event', 'everycal_refresh_cached_event_action' );
add_action( 'enqueue_block_editor_assets', 'everycal_enqueue_block_editor_config' );

// Register the Gutenberg block
add_action( 'init', 'everycal_register_block' );

function everycal_register_block() {
	register_block_type(
		__DIR__ . '/build',
		array(
			'render_callback' => 'everycal_render_block',
		)
	);
}

/**
 * Normalize and validate an EveryCal server URL.
 *
 * Returns an untrailed absolute URL when valid, otherwise an empty string.
 */
function everycal_normalize_server_url( $value ) {
	$url = untrailingslashit( esc_url_raw( trim( (string) $value ) ) );
	if ( '' === $url ) {
		return '';
	}

	$parts  = wp_parse_url( $url );
	$scheme = strtolower( (string) ( $parts['scheme'] ?? '' ) );
	$host   = isset( $parts['host'] ) ? trim( (string) $parts['host'] ) : '';
	if ( ! in_array( $scheme, array( 'http', 'https' ), true ) || '' === $host ) {
		return '';
	}

	return $url;
}

/**
 * Normalize a block instance identifier for query argument usage.
 */
function everycal_normalize_instance_id( $value ) {
	$instance_id = is_scalar( $value ) ? (string) $value : '';
	$instance_id = strtolower( trim( $instance_id ) );
	$instance_id = preg_replace( '/[^a-z0-9_-]/', '', $instance_id );

	if ( ! is_string( $instance_id ) || '' === $instance_id ) {
		return '';
	}

	return substr( $instance_id, 0, 32 );
}

/**
 * Expose EveryCal editor defaults to block JavaScript.
 */
function everycal_enqueue_block_editor_config() {
	$default_server = everycal_normalize_server_url( get_option( 'everycal_default_server_url', '' ) );

	$config = wp_json_encode(
		array(
			'defaultServerUrl' => $default_server,
			'settingsUrl'      => admin_url( 'options-general.php?page=everycal' ),
		)
	);

	if ( false === $config ) {
		return;
	}

	wp_add_inline_script(
		'wp-blocks',
		'window.everycalBlockConfig = Object.assign({}, window.everycalBlockConfig || {}, ' . $config . ');',
		'before'
	);
}

/**
 * Server-side render callback for the EveryCal feed block.
 *
 * Fetches events from the configured EveryCal server URL, caches them
 * with a two-tier strategy (persistent store + freshness transient),
 * and renders them grouped: ongoing → future → past, with pagination.
 */
function everycal_render_block( $attributes ) {
	$server_url = isset( $attributes['serverUrl'] ) ? everycal_normalize_server_url( $attributes['serverUrl'] ) : '';
	if ( '' === $server_url ) {
		$server_url = everycal_normalize_server_url( get_option( 'everycal_default_server_url', '' ) );
	}
	$account                 = isset( $attributes['account'] ) ? sanitize_text_field( $attributes['account'] ) : '';
	$per_page                = isset( $attributes['limit'] ) ? absint( $attributes['limit'] ) : 10;
	$per_page                = max( 1, $per_page );
	$layout                  = isset( $attributes['layout'] ) ? sanitize_text_field( $attributes['layout'] ) : 'list';
	$grid_columns            = isset( $attributes['gridColumns'] ) ? absint( $attributes['gridColumns'] ) : 3;
	$grid_columns            = max( 1, min( 6, $grid_columns ) );
	$description_length_mode = isset( $attributes['descriptionLengthMode'] ) ? sanitize_text_field( $attributes['descriptionLengthMode'] ) : 'words';
	if ( ! in_array( $description_length_mode, array( 'full', 'words', 'chars' ), true ) ) {
		$description_length_mode = 'words';
	}
	// Backward compatibility: excerptLength was the old word-count setting.
	$description_word_count = isset( $attributes['descriptionWordCount'] )
		? absint( $attributes['descriptionWordCount'] )
		: ( isset( $attributes['excerptLength'] ) ? absint( $attributes['excerptLength'] ) : 30 );
	$description_char_count = isset( $attributes['descriptionCharCount'] ) ? absint( $attributes['descriptionCharCount'] ) : 220;
	$cache_ttl              = everycal_get_cache_ttl_seconds();

	if ( empty( $server_url ) ) {
		return '<div class="everycal-block everycal-error">
            <p>' . esc_html__( 'Please configure an EveryCal server URL.', 'everycal' ) . '</p>
        </div>';
	}

	// Build API URL — use the feed endpoint for aggregator accounts (includes reposts),
	// fall back to the events endpoint otherwise.
	if ( ! empty( $account ) ) {
		$api_url = trailingslashit( $server_url ) . 'api/v1/feeds/' . rawurlencode( $account ) . '.json';
	} else {
		$api_url = trailingslashit( $server_url ) . 'api/v1/events?' . http_build_query(
			array_filter(
				array(
					'limit' => 200,
				)
			)
		);
	}

	$events = everycal_get_events( $api_url, $cache_ttl, $server_url );

	if ( empty( $events ) ) {
		return '<div class="everycal-block everycal-empty"><p>' .
			esc_html__( 'No events found.', 'everycal' ) . '</p></div>';
	}

	// ── Group events: ongoing → future → past ──
	$grouped = everycal_group_events( $events );

	// ── Pagination ──
	$instance_id    = isset( $attributes['instanceId'] ) ? everycal_normalize_instance_id( $attributes['instanceId'] ) : '';
	$page_query_arg = ( '' !== $instance_id ) ? 'everycal_page_' . $instance_id : 'everycal_page';
	$paged          = 1;
	if ( isset( $_GET[ $page_query_arg ] ) ) {
		$paged = max( 1, absint( wp_unslash( $_GET[ $page_query_arg ] ) ) );
	} elseif ( 'everycal_page' !== $page_query_arg && isset( $_GET['everycal_page'] ) ) {
		// Backward compatibility for old links while blocks adopt instance IDs.
		$paged = max( 1, absint( wp_unslash( $_GET['everycal_page'] ) ) );
	}
	$all_sorted  = $grouped['upcoming'];
	$total       = count( $all_sorted );
	$pages       = max( 1, (int) ceil( $total / $per_page ) );
	$paged       = min( $paged, $pages );
	$offset      = ( $paged - 1 ) * $per_page;
	$page_events = array_slice( $all_sorted, $offset, $per_page );

	if ( empty( $page_events ) ) {
		return '<div class="everycal-block everycal-empty"><p>' .
			esc_html__( 'No events found.', 'everycal' ) . '</p></div>';
	}

	// Render
	ob_start();
	$wrapper_style = '';
	if ( 'grid' === $layout ) {
		$wrapper_style = ' style="--everycal-grid-columns: ' . esc_attr( (string) $grid_columns ) . ';"';
	}
	echo '<div class="everycal-block everycal-layout-' . esc_attr( $layout ) . '"' . $wrapper_style . '>';

	if ( $total > 0 ) {
		echo '<h2 class="everycal-section-heading">' . esc_html__( 'Upcoming Events', 'everycal' ) . '</h2>';
	}

	$rendered = 0;
	foreach ( $page_events as $event ) {
		everycal_render_event_card( $event, $server_url, $layout, $description_length_mode, $description_word_count, $description_char_count );
		++$rendered;
	}

	echo '</div>';

	// Pagination links
	if ( $pages > 1 ) {
		$base = remove_query_arg( array( $page_query_arg, 'everycal_page' ) );
		$base = add_query_arg( $page_query_arg, '%#%', $base );

		echo '<nav class="everycal-pagination">';
		echo paginate_links(
			array(
				'base'      => $base,
				'format'    => '',
				'total'     => $pages,
				'current'   => $paged,
				'prev_text' => '&laquo; ' . esc_html__( 'Previous', 'everycal' ),
				'next_text' => esc_html__( 'Next', 'everycal' ) . ' &raquo;',
			)
		);
		echo '</nav>';
	}

	return ob_get_clean();
}

/**
 * Two-tier feed cache.
 *
 * Tier 1 — Store payload (expiring cache):
 *   Events keyed by "account_username:slug" from the latest successful fetch.
 *
 * Tier 2 — Freshness flag (expiring cache):
 *   A short-lived flag whose existence means "the store is fresh enough".
 *   When it expires we re-fetch from the API, merge into the store, and reset it.
 *
 * On API failure, stale payloads are served when available.
 */
function everycal_get_events( $api_url, $ttl = null, $server_url = '' ) {
	if ( null === $ttl ) {
		$ttl = everycal_get_cache_ttl_seconds();
	}

	$store_key = 'everycal_store_' . md5( $api_url );
	$fresh_key = 'everycal_fresh_' . md5( $api_url );
	$store_ttl = everycal_get_cache_store_ttl_seconds( $ttl );

	// Load expiring store (may be empty array on first run).
	$store = everycal_cache_get( $store_key, null );
	if ( null === $store ) {
		// Backward compat: migrate legacy persistent option into expiring cache.
		$legacy_store = get_option( $store_key, null );
		if ( is_array( $legacy_store ) ) {
			$store = $legacy_store;
			everycal_cache_set( $store_key, $store, $store_ttl );
			everycal_register_feed_cache_keys( $api_url, $store_key, $fresh_key );
			delete_option( $store_key );
		} else {
			$store = array();
		}
	}

	// If still fresh, return what we have.
	if ( false !== everycal_cache_get( $fresh_key, false ) ) {
		$feed_cache_index   = everycal_get_feed_cache_index();
		$feed_cache_entry   = isset( $feed_cache_index[ $api_url ] ) && is_array( $feed_cache_index[ $api_url ] ) ? $feed_cache_index[ $api_url ] : array();
		$has_matching_entry = isset( $feed_cache_entry['storeKey'], $feed_cache_entry['freshKey'] )
			&& (string) $feed_cache_entry['storeKey'] === $store_key
			&& (string) $feed_cache_entry['freshKey'] === $fresh_key;
		if ( ! $has_matching_entry ) {
			everycal_register_feed_cache_keys( $api_url, $store_key, $fresh_key );
		}

		return array_values( $store );
	}

	// Freshness expired — fetch from API.
	$response = wp_remote_get(
		$api_url,
		array(
			'timeout' => 10,
			'headers' => array( 'Accept' => 'application/json' ),
		)
	);

	if ( is_wp_error( $response ) || 200 !== wp_remote_retrieve_response_code( $response ) ) {
		// API unreachable — serve stale data if we have any, still set a short
		// freshness flag so we don't hammer a down server on every page view.
		if ( ! empty( $store ) ) {
			everycal_cache_set( $fresh_key, 1, 60 ); // retry in 1 min
			return array_values( $store );
		}
		return array();
	}

	$body = wp_remote_retrieve_body( $response );
	$data = json_decode( $body, true );
	if ( JSON_ERROR_NONE !== json_last_error() || ! is_array( $data ) || ! isset( $data['events'] ) || ! is_array( $data['events'] ) ) {
		// Malformed payload — serve stale data if we have any, still set a short
		// freshness flag so we retry soon without hammering every request.
		if ( ! empty( $store ) ) {
			everycal_cache_set( $fresh_key, 1, 60 ); // retry in 1 min
			return array_values( $store );
		}
		return array();
	}

	$raw     = $data['events'];
	$fetched = array_map( 'everycal_normalise_event', $raw );
	$now     = time();

	// Keep feed store limited to the prewarm window.
	$windowed_store             = array();
	$cached_event_index         = everycal_get_cached_event_index();
	$persist_cached_event_index = false;

	// Pre-warm single-event caches so event detail pages can render from feed data
	// without immediately triggering extra by-slug requests.
	foreach ( $fetched as $event ) {
		if ( ! everycal_should_prewarm_event( $event, $now ) ) {
			continue;
		}

		$key = everycal_event_store_key( $event );
		if ( '' === (string) $key ) {
			continue;
		}

		$windowed_store[ $key ]     = $event;
		$persist_cached_event_index = everycal_prewarm_single_event_cache( $event, $now, $server_url, $cached_event_index ) || $persist_cached_event_index;
	}

	if ( $persist_cached_event_index ) {
		everycal_set_cached_event_index( $cached_event_index );
	}

	$store = $windowed_store;

	// Persist and mark fresh.
	everycal_cache_set( $store_key, $store, $store_ttl );
	everycal_cache_set( $fresh_key, 1, $ttl );
	everycal_register_feed_cache_keys( $api_url, $store_key, $fresh_key );

	return array_values( $store );
}

/**
 * Shared cache backend.
 *
 * Uses object cache when available, else falls back to transients.
 */
function everycal_cache_get( $key, $default_value = false ) {
	if ( wp_using_ext_object_cache() ) {
		$found = false;
		$value = wp_cache_get( $key, 'everycal', false, $found );
		if ( $found ) {
			return $value;
		}
		return $default_value;
	}

	$value = get_transient( $key );
	return ( false === $value ) ? $default_value : $value;
}

function everycal_cache_set( $key, $value, $ttl ) {
	$ttl = max( 1, absint( $ttl ) );
	if ( wp_using_ext_object_cache() ) {
		return wp_cache_set( $key, $value, 'everycal', $ttl );
	}
	return set_transient( $key, $value, $ttl );
}

function everycal_cache_delete( $key ) {
	if ( wp_using_ext_object_cache() ) {
		return wp_cache_delete( $key, 'everycal' );
	}
	return delete_transient( $key );
}

/**
 * Cache TTL from plugin settings, in seconds.
 */
function everycal_get_cache_ttl_seconds() {
	$minutes = absint( get_option( 'everycal_cache_ttl_minutes', 1440 ) );
	$minutes = max( 1, $minutes );
	return $minutes * MINUTE_IN_SECONDS;
}

/**
 * Keep stale payloads around longer than freshness to allow stale-on-error.
 */
function everycal_get_cache_store_ttl_seconds( $fresh_ttl ) {
	$fresh_ttl = max( 1, absint( $fresh_ttl ) );
	return max( $fresh_ttl * 2, DAY_IN_SECONDS );
}

/**
 * Freshness TTL for per-event caches.
 */
function everycal_get_event_cache_ttl_seconds() {
	return everycal_get_cache_ttl_seconds();
}

function everycal_get_cached_event_index() {
	$index = get_option( 'everycal_cached_event_index', array() );
	return is_array( $index ) ? $index : array();
}

function everycal_set_cached_event_index( $index ) {
	if ( ! is_array( $index ) ) {
		$index = array();
	}
	update_option( 'everycal_cached_event_index', $index, false );
}

function everycal_merge_cached_event_index_entry( &$index, $event, $server_url = '', $cached_at = null, $fresh_until = null ) {
	if ( ! is_array( $index ) || ! is_array( $event ) ) {
		return false;
	}

	$username = '';
	if ( ! empty( $event['account']['username'] ) ) {
		$username = (string) $event['account']['username'];
	} elseif ( ! empty( $event['account_username'] ) ) {
		$username = (string) $event['account_username'];
	}

	$slug     = ! empty( $event['slug'] ) ? (string) $event['slug'] : '';
	$username = trim( $username );
	$slug     = trim( $slug );
	if ( '' === $username || '' === $slug ) {
		return false;
	}

	if ( null === $cached_at ) {
		$cached_at = time();
	}

	$id                   = $username . ':' . $slug;
	$existing_server_url  = '';
	$existing_fresh_until = 0;
	$existing_event_url   = '';
	$existing_handle      = '';
	if ( isset( $index[ $id ]['serverUrl'] ) && is_string( $index[ $id ]['serverUrl'] ) ) {
		$existing_server_url = everycal_normalize_server_url( $index[ $id ]['serverUrl'] );
	}
	if ( isset( $index[ $id ]['freshUntil'] ) ) {
		$existing_fresh_until = absint( $index[ $id ]['freshUntil'] );
	}
	if ( isset( $index[ $id ]['eventUrl'] ) && is_string( $index[ $id ]['eventUrl'] ) ) {
		$existing_event_url = $index[ $id ]['eventUrl'];
	}
	if ( isset( $index[ $id ]['handle'] ) && is_string( $index[ $id ]['handle'] ) ) {
		$existing_handle = $index[ $id ]['handle'];
	}

	$clean_server_url = everycal_normalize_server_url( $server_url );
	if ( '' === $clean_server_url ) {
		$clean_server_url = $existing_server_url;
	}

	$event_url = '';
	if ( ! empty( $event['url'] ) ) {
		$event_url = esc_url_raw( (string) $event['url'] );
	}
	if ( '' === $event_url ) {
		$event_url = $existing_event_url;
	}

	$resolved_fresh_until = $existing_fresh_until;
	if ( null !== $fresh_until ) {
		$resolved_fresh_until = absint( $fresh_until );
	}

	$creator = everycal_get_event_creator( $event, $clean_server_url );
	$handle  = isset( $creator['handle'] ) ? ltrim( trim( (string) $creator['handle'] ), '@' ) : '';
	if ( '' === $handle ) {
		$handle = $existing_handle;
	}

	$entry = array(
		'id'         => $id,
		'username'   => $username,
		'slug'       => $slug,
		'handle'     => $handle,
		'title'      => isset( $event['title'] ) ? sanitize_text_field( (string) $event['title'] ) : '',
		'startDate'  => isset( $event['startDate'] ) ? (string) $event['startDate'] : '',
		'endDate'    => isset( $event['endDate'] ) ? (string) $event['endDate'] : '',
		'serverUrl'  => $clean_server_url,
		'eventUrl'   => $event_url,
		'cachedAt'   => absint( $cached_at ),
		'freshUntil' => $resolved_fresh_until,
	);

	if ( isset( $index[ $id ] ) && is_array( $index[ $id ] ) && $index[ $id ] === $entry ) {
		return false;
	}

	$index[ $id ] = $entry;
	return true;
}

function everycal_register_cached_event_index_entry( $event, $server_url = '', $cached_at = null, $fresh_until = null ) {
	$index = everycal_get_cached_event_index();
	if ( ! everycal_merge_cached_event_index_entry( $index, $event, $server_url, $cached_at, $fresh_until ) ) {
		return false;
	}

	everycal_set_cached_event_index( $index );
	return true;
}

function everycal_get_feed_cache_index() {
	$index = get_option( 'everycal_feed_cache_index', array() );
	return is_array( $index ) ? $index : array();
}

function everycal_set_feed_cache_index( $index ) {
	if ( ! is_array( $index ) ) {
		$index = array();
	}
	update_option( 'everycal_feed_cache_index', $index, false );
}

function everycal_register_feed_cache_keys( $api_url, $store_key, $fresh_key ) {
	$api_url = is_string( $api_url ) ? trim( $api_url ) : '';
	if ( '' === $api_url ) {
		return;
	}

	$index             = everycal_get_feed_cache_index();
	$index[ $api_url ] = array(
		'apiUrl'   => $api_url,
		'storeKey' => (string) $store_key,
		'freshKey' => (string) $fresh_key,
		'cachedAt' => time(),
	);
	everycal_set_feed_cache_index( $index );
}

function everycal_get_cached_event_cache_keys( $username, $slug ) {
	$username = is_string( $username ) ? trim( $username ) : '';
	$slug     = is_string( $slug ) ? trim( $slug ) : '';
	if ( '' === $username || '' === $slug ) {
		return array();
	}

	$hash = md5( $username . ':' . $slug );
	return array(
		'store'  => 'everycal_ev_' . $hash,
		'fresh'  => 'everycal_evf_' . $hash,
		'server' => 'everycal_evs_' . $hash,
		'id'     => $username . ':' . $slug,
	);
}

function everycal_clear_cached_event( $username, $slug ) {
	$keys = everycal_get_cached_event_cache_keys( $username, $slug );
	if ( empty( $keys ) ) {
		return false;
	}

	everycal_cache_delete( $keys['store'] );
	everycal_cache_delete( $keys['fresh'] );
	everycal_cache_delete( $keys['server'] );
	delete_option( $keys['store'] );
	delete_option( $keys['fresh'] );
	delete_option( $keys['server'] );

	$index = everycal_get_cached_event_index();
	if ( isset( $index[ $keys['id'] ] ) ) {
		unset( $index[ $keys['id'] ] );
		everycal_set_cached_event_index( $index );
	}

	return true;
}

function everycal_get_cached_event_index_entry( $username, $slug ) {
	$username = is_string( $username ) ? trim( $username ) : '';
	$slug     = is_string( $slug ) ? trim( $slug ) : '';
	if ( '' === $username || '' === $slug ) {
		return null;
	}

	$index = everycal_get_cached_event_index();
	$id    = $username . ':' . $slug;
	if ( isset( $index[ $id ] ) && is_array( $index[ $id ] ) ) {
		return $index[ $id ];
	}

	return null;
}

function everycal_build_everycal_event_url( $server_url, $username, $slug, $handle = '' ) {
	$server_url = everycal_normalize_server_url( $server_url );
	$username   = ltrim( trim( (string) $username ), '@' );
	$slug       = trim( (string) $slug );
	$handle     = ltrim( trim( (string) $handle ), '@' );

	if ( '' === $server_url || '' === $slug ) {
		return '';
	}

	$actor = everycal_select_actor_for_server( $server_url, $username, $handle );

	if ( '' === $actor ) {
		return '';
	}

	return trailingslashit( $server_url ) . '@' . $actor . '/' . rawurlencode( $slug );
}

/**
 * Pick username for local actors, full handle for remote actors.
 */
function everycal_select_actor_for_server( $server_url, $username, $handle ) {
	$username    = ltrim( trim( (string) $username ), '@' );
	$handle      = ltrim( trim( (string) $handle ), '@' );
	$server_host = everycal_extract_server_host( $server_url );

	$actor = $username;
	if ( '' === $actor ) {
		$actor = $handle;
	}

	if ( '' !== $handle && false !== strpos( $handle, '@' ) ) {
		$parts         = explode( '@', $handle, 2 );
		$handle_domain = isset( $parts[1] ) ? strtolower( (string) $parts[1] ) : '';
		if ( '' !== $handle_domain && '' !== $server_host && $handle_domain !== $server_host ) {
			$actor = $handle;
		}
	}

	return $actor;
}

function everycal_build_wp_event_detail_url( $base_path, $username, $slug ) {
	$base_path = trim( (string) $base_path, '/ ' );
	$username  = ltrim( trim( (string) $username ), '@' );
	$slug      = trim( (string) $slug );

	if ( '' === $base_path || '' === $username || '' === $slug ) {
		return '';
	}

	return home_url( '/' . $base_path . '/@' . rawurlencode( $username ) . '/' . rawurlencode( $slug ) . '/' );
}

function everycal_refresh_cached_event( $username, $slug ) {
	$username   = is_string( $username ) ? sanitize_text_field( $username ) : '';
	$slug       = is_string( $slug ) ? sanitize_text_field( $slug ) : '';
	$server_url = everycal_discover_server_url( $username, $slug );

	if ( '' === $username || '' === $slug || '' === $server_url ) {
		return array( 'success' => false );
	}

	$api_url  = trailingslashit( $server_url ) . 'api/v1/events/by-slug/' . rawurlencode( $username ) . '/' . rawurlencode( $slug );
	$response = wp_remote_get(
		$api_url,
		array(
			'timeout' => 10,
			'headers' => array( 'Accept' => 'application/json' ),
		)
	);

	if ( is_wp_error( $response ) || 200 !== wp_remote_retrieve_response_code( $response ) ) {
		return array( 'success' => false );
	}

	$event = json_decode( wp_remote_retrieve_body( $response ), true );
	if ( ! is_array( $event ) ) {
		return array( 'success' => false );
	}

	$store_key = 'everycal_ev_' . md5( $username . ':' . $slug );
	$fresh_key = 'everycal_evf_' . md5( $username . ':' . $slug );
	$store_ttl = everycal_get_cache_store_ttl_seconds( everycal_get_cache_ttl_seconds() );

	everycal_cache_set( $store_key, $event, $store_ttl );
	delete_option( $store_key );
	everycal_set_cached_event_server_url( (string) $username, (string) $slug, $server_url );

	$now = time();
	$ttl = everycal_get_event_cache_ttl_seconds();
	everycal_cache_set( $fresh_key, 1, $ttl );

	everycal_register_cached_event_index_entry( $event, $server_url, $now, $now + $ttl );

	return array(
		'success' => true,
		'entry'   => everycal_get_cached_event_index_entry( $username, $slug ),
	);
}

function everycal_get_cached_events_for_admin( $sort = 'cachedAt', $order = 'desc' ) {
	$events = array_values( everycal_get_cached_event_index() );

	$allowed_sorts = array( 'event', 'handle', 'startDate', 'freshUntil', 'cachedAt' );
	if ( ! in_array( $sort, $allowed_sorts, true ) ) {
		$sort = 'cachedAt';
	}

	$order = strtolower( (string) $order );
	if ( ! in_array( $order, array( 'asc', 'desc' ), true ) ) {
		$order = 'desc';
	}

	usort(
		$events,
		function ( $a, $b ) use ( $sort, $order ) {
			$direction = ( 'asc' === $order ) ? 1 : -1;

			if ( 'event' === $sort ) {
				$a_value = strtolower( (string) ( $a['title'] ?? ( ( $a['username'] ?? '' ) . ':' . ( $a['slug'] ?? '' ) ) ) );
				$b_value = strtolower( (string) ( $b['title'] ?? ( ( $b['username'] ?? '' ) . ':' . ( $b['slug'] ?? '' ) ) ) );
				$cmp     = strcmp( $a_value, $b_value );
				return $cmp * $direction;
			}

			if ( 'handle' === $sort ) {
				$a_value = strtolower( (string) ( $a['handle'] ?? ( $a['username'] ?? '' ) ) );
				$b_value = strtolower( (string) ( $b['handle'] ?? ( $b['username'] ?? '' ) ) );
				$cmp     = strcmp( $a_value, $b_value );
				return $cmp * $direction;
			}

			if ( 'startDate' === $sort ) {
				$a_value = ! empty( $a['startDate'] ) ? strtotime( (string) $a['startDate'] ) : 0;
				$b_value = ! empty( $b['startDate'] ) ? strtotime( (string) $b['startDate'] ) : 0;
				$a_value = false === $a_value ? 0 : $a_value;
				$b_value = false === $b_value ? 0 : $b_value;
				return ( $a_value <=> $b_value ) * $direction;
			}

			if ( 'freshUntil' === $sort ) {
				$a_value = isset( $a['freshUntil'] ) ? absint( $a['freshUntil'] ) : 0;
				$b_value = isset( $b['freshUntil'] ) ? absint( $b['freshUntil'] ) : 0;
				return ( $a_value <=> $b_value ) * $direction;
			}

			$a_value = isset( $a['cachedAt'] ) ? absint( $a['cachedAt'] ) : 0;
			$b_value = isset( $b['cachedAt'] ) ? absint( $b['cachedAt'] ) : 0;
			return ( $a_value <=> $b_value ) * $direction;
		}
	);

	return $events;
}

function everycal_clear_all_cache_data() {
	$events = everycal_get_cached_event_index();
	foreach ( $events as $event ) {
		if ( ! is_array( $event ) ) {
			continue;
		}
		$username = isset( $event['username'] ) ? (string) $event['username'] : '';
		$slug     = isset( $event['slug'] ) ? (string) $event['slug'] : '';
		everycal_clear_cached_event( $username, $slug );
	}

	$feeds = everycal_get_feed_cache_index();
	foreach ( $feeds as $feed ) {
		if ( ! is_array( $feed ) ) {
			continue;
		}
		if ( ! empty( $feed['storeKey'] ) ) {
			everycal_cache_delete( (string) $feed['storeKey'] );
			delete_option( (string) $feed['storeKey'] );
		}
		if ( ! empty( $feed['freshKey'] ) ) {
			everycal_cache_delete( (string) $feed['freshKey'] );
			delete_option( (string) $feed['freshKey'] );
		}
	}

	everycal_clear_feed_cache_transient_fallback();

	delete_option( 'everycal_cached_event_index' );
	delete_option( 'everycal_feed_cache_index' );
}

function everycal_clear_feed_cache_transient_fallback() {
	global $wpdb;
	if ( ! isset( $wpdb ) ) {
		return;
	}

	$prefixes = array(
		'_transient_everycal_store_',
		'_transient_timeout_everycal_store_',
		'_transient_everycal_fresh_',
		'_transient_timeout_everycal_fresh_',
		'everycal_store_',
		'everycal_fresh_',
	);

	foreach ( $prefixes as $prefix ) {
		$pattern = $wpdb->esc_like( $prefix ) . '%';
		$wpdb->query(
			$wpdb->prepare(
				"DELETE FROM {$wpdb->options} WHERE option_name LIKE %s",
				$pattern
			)
		);
	}
}

/**
 * Prewarm recent past + all future events.
 */
function everycal_should_prewarm_event( $event, $now = null ) {
	if ( null === $now ) {
		$now = time();
	}

	$past_window_hours = absint( get_option( 'everycal_prewarm_past_hours', 24 ) );
	$past_window_hours = max( 0, $past_window_hours );
	$window_start      = $now - ( $past_window_hours * HOUR_IN_SECONDS );

	$start = isset( $event['startDate'] ) ? strtotime( $event['startDate'] ) : 0;
	$end   = ! empty( $event['endDate'] ) ? strtotime( $event['endDate'] ) : $start;

	return $end >= $window_start;
}

/** Stable key for an event inside the persistent store. */
function everycal_event_store_key( $event ) {
	$username = '';
	if ( ! empty( $event['account']['username'] ) ) {
		$username = $event['account']['username'];
	}
	$slug = ! empty( $event['slug'] ) ? $event['slug'] : '';
	$id   = ! empty( $event['id'] ) ? $event['id'] : '';
	// Prefer username:slug (human-readable), fall back to raw id.
	return ( $username && $slug ) ? $username . ':' . $slug : $id;
}

/**
 * Pre-populate the per-event cache used by virtual event detail pages.
 */
function everycal_prewarm_single_event_cache( $event, $now = null, $server_url = '', &$cached_event_index = null ) {
	$username = '';
	if ( ! empty( $event['account']['username'] ) ) {
		$username = (string) $event['account']['username'];
	} elseif ( ! empty( $event['account_username'] ) ) {
		$username = (string) $event['account_username'];
	}

	$slug = ! empty( $event['slug'] ) ? (string) $event['slug'] : '';
	if ( '' === $username || '' === $slug ) {
		return false;
	}

	if ( null === $now ) {
		$now = time();
	}

	$store_key = 'everycal_ev_' . md5( $username . ':' . $slug );
	$fresh_key = 'everycal_evf_' . md5( $username . ':' . $slug );
	$store_ttl = everycal_get_cache_store_ttl_seconds( everycal_get_cache_ttl_seconds() );

	everycal_cache_set( $store_key, $event, $store_ttl );
	delete_option( $store_key ); // cleanup legacy persistent cache key
	everycal_set_cached_event_server_url( $username, $slug, $server_url );
	$ttl = everycal_get_event_cache_ttl_seconds();
	everycal_cache_set( $fresh_key, 1, $ttl );

	if ( is_array( $cached_event_index ) ) {
		return everycal_merge_cached_event_index_entry( $cached_event_index, $event, $server_url, $now, $now + $ttl );
	}

	return everycal_register_cached_event_index_entry( $event, $server_url, $now, $now + $ttl );
}

/**
 * Persist the source server URL for a cached event.
 */
function everycal_set_cached_event_server_url( $username, $slug, $server_url ) {
	$username   = is_string( $username ) ? trim( $username ) : '';
	$slug       = is_string( $slug ) ? trim( $slug ) : '';
	$server_url = everycal_normalize_server_url( $server_url );

	if ( '' === $username || '' === $slug || '' === $server_url ) {
		return;
	}

	$key = 'everycal_evs_' . md5( $username . ':' . $slug );
	$ttl = everycal_get_cache_store_ttl_seconds( everycal_get_cache_ttl_seconds() );
	everycal_cache_set( $key, $server_url, $ttl );
	delete_option( $key ); // cleanup legacy persistent cache key
}

/**
 * Read the source server URL for a cached event.
 */
function everycal_get_cached_event_server_url( $username, $slug ) {
	$username = is_string( $username ) ? trim( $username ) : '';
	$slug     = is_string( $slug ) ? trim( $slug ) : '';
	if ( '' === $username || '' === $slug ) {
		return '';
	}

	$key = 'everycal_evs_' . md5( $username . ':' . $slug );
	$url = everycal_cache_get( $key, '' );
	if ( '' === $url ) {
		// Backward compat: migrate legacy persistent option into expiring cache.
		$legacy_url = get_option( $key, '' );
		if ( is_string( $legacy_url ) && '' !== $legacy_url ) {
			$ttl = everycal_get_cache_store_ttl_seconds( everycal_get_cache_ttl_seconds() );
			everycal_cache_set( $key, $legacy_url, $ttl );
			delete_option( $key );
			$url = $legacy_url;
		}
	}

	if ( is_string( $url ) && '' !== $url ) {
		$normalized_url = everycal_normalize_server_url( $url );
		if ( '' !== $normalized_url ) {
			return $normalized_url;
		}
	}

	$entry = everycal_get_cached_event_index_entry( $username, $slug );
	if ( is_array( $entry ) && isset( $entry['serverUrl'] ) && is_string( $entry['serverUrl'] ) ) {
		$index_url = everycal_normalize_server_url( $entry['serverUrl'] );
		if ( '' !== $index_url ) {
			$ttl = everycal_get_cache_store_ttl_seconds( everycal_get_cache_ttl_seconds() );
			everycal_cache_set( $key, $index_url, $ttl );
			return $index_url;
		}
	}

	return '';
}

/**
 * Group events the same way the web app does:
 *  1. Ongoing (start <= now, end >= now) — sorted by start ascending
 *  2. Future  (start > now)             — sorted by start ascending
 *  3. Past    (everything else)         — sorted by start descending (most recent first)
 *
 * Returns [ 'upcoming' => [...ongoing, ...future], 'past' => [...] ].
 */
function everycal_group_events( $events ) {
	$now     = time();
	$current = array();
	$future  = array();
	$past    = array();

	foreach ( $events as $e ) {
		$start = isset( $e['startDate'] ) ? strtotime( $e['startDate'] ) : 0;
		$end   = ! empty( $e['endDate'] ) ? strtotime( $e['endDate'] ) : $start;

		if ( $start <= $now && $end >= $now ) {
			$current[] = $e;
		} elseif ( $start > $now ) {
			$future[] = $e;
		} else {
			$past[] = $e;
		}
	}

	// Current: start ascending
	usort(
		$current,
		function ( $a, $b ) {
			return strtotime( $a['startDate'] ) - strtotime( $b['startDate'] );
		}
	);
	// Future: nearest first
	usort(
		$future,
		function ( $a, $b ) {
			return strtotime( $a['startDate'] ) - strtotime( $b['startDate'] );
		}
	);
	// Past: most recent first
	usort(
		$past,
		function ( $a, $b ) {
			return strtotime( $b['startDate'] ) - strtotime( $a['startDate'] );
		}
	);

	return array(
		'upcoming' => array_merge( $current, $future ),
		'past'     => $past,
	);
}

/**
 * Render a single event card (shared between the block and pagination).
 */
function everycal_render_event_card( $event, $server_url = '', $layout = 'list', $description_length_mode = 'words', $description_word_count = 30, $description_char_count = 220 ) {
	$base_path    = get_option( 'everycal_base_path', 'events' );
	$evt_username = '';
	if ( ! empty( $event['account']['username'] ) ) {
		$evt_username = $event['account']['username'];
	} elseif ( ! empty( $event['account_username'] ) ) {
		$evt_username = $event['account_username'];
	}
	$evt_slug    = ! empty( $event['slug'] ) ? $event['slug'] : '';
	$detail_url  = '';
	$primary_url = '';

	if ( $evt_username && $evt_slug ) {
		$detail_url  = everycal_build_wp_event_detail_url( $base_path, $evt_username, $evt_slug );
		$primary_url = $detail_url;
	} elseif ( ! empty( $event['url'] ) ) {
		$primary_url = $event['url'];
	}

	echo '<article class="everycal-event">';

	// Header image
	if ( ! empty( $event['image']['url'] ) ) {
		echo '<div class="everycal-event__image">';
		echo '<img src="' . esc_url( $event['image']['url'] ) . '"';
		if ( ! empty( $event['image']['alt'] ) ) {
			echo ' alt="' . esc_attr( $event['image']['alt'] ) . '"';
		}
		echo ' loading="lazy" />';
		echo '</div>';
	}

	echo '<div class="everycal-event__content">';

	// Date
	if ( ! empty( $event['startDate'] ) ) {
		$start_ts = strtotime( $event['startDate'] );
		$end_ts   = ! empty( $event['endDate'] ) ? strtotime( $event['endDate'] ) : $start_ts;
		$now      = time();

		echo '<time class="everycal-event__date" datetime="' . esc_attr( $event['startDate'] ) . '">';

		// Ongoing badge
		if ( $start_ts <= $now && $end_ts >= $now ) {
			echo '<span class="everycal-event__badge everycal-event__badge--ongoing">'
				. esc_html__( 'Ongoing', 'everycal' ) . '</span> ';
		}

		$datetime_lines = everycal_get_event_datetime_lines( $event );
		if ( ! empty( $datetime_lines['date'] ) ) {
			echo '<span class="everycal-event__date-line" style="display:block;"><span aria-hidden="true">📅 </span>' . esc_html( $datetime_lines['date'] ) . '</span>';
		}
		if ( ! empty( $datetime_lines['time'] ) ) {
			echo '<span class="everycal-event__time-line" style="display:block;"><span aria-hidden="true">🕒 </span>' . esc_html( $datetime_lines['time'] ) . '</span>';
		}
		echo '</time>';
	}

	// Creator
	$creator = everycal_get_event_creator( $event, $server_url );
	if ( ! empty( $creator['label'] ) ) {
		$creator_url = everycal_resolve_creator_url( $event, $server_url, $creator );
		echo '<div class="everycal-event__creator">';
		echo esc_html__( 'By', 'everycal' ) . ' ';
		if ( $creator_url ) {
			echo '<a href="' . esc_url( $creator_url ) . '"' . everycal_external_link_attrs( $creator_url ) . '>' . esc_html( $creator['label'] ) . '</a>';
		} else {
			echo esc_html( $creator['label'] );
		}
		echo '</div>';
	}

	// Title — link to local event detail page
	$title = ! empty( $event['title'] ) ? $event['title'] : '';

	if ( $detail_url ) {
		echo '<h3 class="everycal-event__title"><a href="' . esc_url( $detail_url ) . '">' . esc_html( $title ) . '</a></h3>';
	} elseif ( ! empty( $event['url'] ) ) {
		echo '<h3 class="everycal-event__title"><a href="' . esc_url( $event['url'] ) . '"' . everycal_external_link_attrs( $event['url'] ) . '>' . esc_html( $title ) . '</a></h3>';
	} else {
		echo '<h3 class="everycal-event__title">' . esc_html( $title ) . '</h3>';
	}

	// Description
	if ( everycal_layout_supports_description( $layout ) && ! empty( $event['description'] ) ) {
		$preview = everycal_get_event_description_preview( $event['description'], $description_length_mode, $description_word_count, $description_char_count );
		if ( '' !== $preview ) {
			echo '<div class="everycal-event__description">' . esc_html( $preview ) . '</div>';
		}
	}

	// Location
	if ( ! empty( $event['location']['name'] ) ) {
		echo '<div class="everycal-event__location"><span aria-hidden="true">📍 </span>';
		if ( ! empty( $event['location']['url'] ) ) {
			echo '<a href="' . esc_url( $event['location']['url'] ) . '"' . everycal_external_link_attrs( $event['location']['url'] ) . '>' . esc_html( $event['location']['name'] ) . '</a>';
		} else {
			echo esc_html( $event['location']['name'] );
		}
		echo '</div>';
	}

	// Tags
	if ( ! empty( $event['tags'] ) ) {
		echo '<div class="everycal-event__tags">';
		foreach ( $event['tags'] as $tag ) {
			$tag_url = everycal_resolve_tag_url( $tag, $server_url );
			if ( $tag_url ) {
				echo '<a class="everycal-event__tag" href="' . esc_url( $tag_url ) . '"' . everycal_external_link_attrs( $tag_url ) . '>' . esc_html( $tag ) . '</a>';
			} else {
				echo '<span class="everycal-event__tag">' . esc_html( $tag ) . '</span>';
			}
		}
		echo '</div>';
	}

	echo '</div>'; // content

	if ( 'grid' === $layout && $primary_url ) {
		echo '<a class="everycal-event__card-link" href="' . esc_url( $primary_url ) . '"' . everycal_external_link_attrs( $primary_url ) . ' tabindex="-1" aria-hidden="true"></a>';
	}

	echo '</article>';
}

/**
 * Normalise a raw feed-endpoint row (snake_case) into the camelCase shape
 * that the rest of the plugin expects.  Already-normalised rows pass through.
 */
function everycal_normalise_event( $row ) {
	// If it already has camelCase keys, return as-is.
	if ( isset( $row['startDate'] ) ) {
		return $row;
	}

	$username = '';
	if ( ! empty( $row['account_username'] ) ) {
		$username = $row['account_username'];
	} elseif ( ! empty( $row['repost_username'] ) ) {
		$username = $row['repost_username'];
	}

	return array(
		'id'            => $row['id'] ?? '',
		'slug'          => $row['slug'] ?? '',
		'title'         => $row['title'] ?? '',
		'description'   => $row['description'] ?? '',
		'startDate'     => $row['start_date'] ?? '',
		'endDate'       => $row['end_date'] ?? '',
		'allDay'        => ! empty( $row['all_day'] ),
		'eventTimezone' => $row['event_timezone'] ?? null,
		'startAtUtc'    => $row['start_at_utc'] ?? null,
		'endAtUtc'      => $row['end_at_utc'] ?? null,
		'account'       => array(
			'username'    => $username,
			'displayName' => $row['account_display_name'] ?? null,
			'domain'      => $row['account_domain'] ?? null,
		),
		'location'      => ! empty( $row['location_name'] ) ? array(
			'name'      => $row['location_name'],
			'address'   => $row['location_address'] ?? null,
			'latitude'  => isset( $row['location_latitude'] ) ? (float) $row['location_latitude'] : null,
			'longitude' => isset( $row['location_longitude'] ) ? (float) $row['location_longitude'] : null,
			'url'       => $row['location_url'] ?? null,
		) : null,
		'image'         => ! empty( $row['image_url'] ) ? array(
			'url'       => $row['image_url'],
			'mediaType' => $row['image_media_type'] ?? null,
			'alt'       => $row['image_alt'] ?? null,
		) : null,
		'url'           => $row['url'] ?? '',
		'tags'          => ! empty( $row['tags'] ) ? ( is_array( $row['tags'] ) ? $row['tags'] : explode( ',', $row['tags'] ) ) : array(),
	);
}

/**
 * Enqueue frontend styles.
 */
add_action( 'wp_enqueue_scripts', 'everycal_enqueue_styles' );

function everycal_enqueue_styles() {
	if ( has_block( 'everycal/feed' ) || get_query_var( 'everycal_event_slug' ) ) {
		wp_enqueue_style(
			'everycal-frontend',
			EVERYCAL_PLUGIN_URL . 'build/style-index.css',
			array(),
			EVERYCAL_VERSION
		);
	}
}

/* ------------------------------------------------------------------ */
/*  Settings page                                                      */
/* ------------------------------------------------------------------ */

add_action( 'admin_menu', 'everycal_admin_menu' );
add_action( 'admin_init', 'everycal_register_settings' );

function everycal_admin_menu() {
	add_options_page(
		__( 'EveryCal Settings', 'everycal' ),
		__( 'EveryCal', 'everycal' ),
		'manage_options',
		'everycal',
		'everycal_settings_page'
	);
}

function everycal_register_settings() {
	register_setting(
		'everycal_settings',
		'everycal_base_path',
		array(
			'type'              => 'string',
			'default'           => 'events',
			'sanitize_callback' => function ( $val ) {
				return trim( $val, '/ ' );
			},
		)
	);

	register_setting(
		'everycal_settings',
		'everycal_creator_url_template',
		array(
			'type'              => 'string',
			'default'           => '',
			'sanitize_callback' => function ( $val ) {
				return sanitize_text_field( $val );
			},
		)
	);

	register_setting(
		'everycal_settings',
		'everycal_default_server_url',
		array(
			'type'              => 'string',
			'default'           => '',
			'sanitize_callback' => function ( $val ) {
				return everycal_normalize_server_url( $val );
			},
		)
	);

	register_setting(
		'everycal_settings',
		'everycal_cache_ttl_minutes',
		array(
			'type'              => 'integer',
			'default'           => 1440,
			'sanitize_callback' => function ( $val ) {
				$minutes = absint( $val );
				return max( 1, min( 10080, $minutes ) );
			},
		)
	);

	register_setting(
		'everycal_settings',
		'everycal_prewarm_past_hours',
		array(
			'type'              => 'integer',
			'default'           => 24,
			'sanitize_callback' => function ( $val ) {
				$hours = absint( $val );
				return min( 8760, $hours );
			},
		)
	);

	register_setting(
		'everycal_settings',
		'everycal_http_debug_manual',
		array(
			'type'              => 'boolean',
			'default'           => false,
			'sanitize_callback' => function ( $val ) {
				return ! empty( $val );
			},
		)
	);

	register_setting(
		'everycal_settings',
		'everycal_http_debug_additional_servers',
		array(
			'type'              => 'string',
			'default'           => '',
			'sanitize_callback' => function ( $val ) {
				return implode( ', ', everycal_parse_server_list_option( $val ) );
			},
		)
	);
}

function everycal_settings_page() {
	$base                          = get_option( 'everycal_base_path', 'events' );
	$creator_template              = get_option( 'everycal_creator_url_template', '' );
	$default_server_url            = get_option( 'everycal_default_server_url', '' );
	$cache_ttl_minutes             = absint( get_option( 'everycal_cache_ttl_minutes', 1440 ) );
	$prewarm_past_hours            = absint( get_option( 'everycal_prewarm_past_hours', 24 ) );
	$manual_http_debug             = (bool) get_option( 'everycal_http_debug_manual', false );
	$http_debug_additional_servers = get_option( 'everycal_http_debug_additional_servers', '' );
	$wp_debug_enabled              = defined( 'WP_DEBUG' ) && WP_DEBUG;
	$http_debug_on                 = everycal_http_debug_enabled();
	$known_hosts                   = everycal_get_configured_server_hosts();
	$recent_logs                   = everycal_get_http_debug_logs( 200 );
	$logs_text                     = implode( "\n", $recent_logs );
	$logs_nonce                    = wp_create_nonce( 'everycal_http_logs' );
	$logs_cleared                  = isset( $_GET['everycal_logs_cleared'] ) && '1' === (string) $_GET['everycal_logs_cleared'];
	$cache_action                  = isset( $_GET['everycal_cache_cleared'] ) ? sanitize_key( wp_unslash( $_GET['everycal_cache_cleared'] ) ) : '';
	$cache_event                   = isset( $_GET['everycal_cache_event'] ) ? sanitize_text_field( wp_unslash( $_GET['everycal_cache_event'] ) ) : '';
	$cached_events                 = everycal_get_cached_events_for_admin();
	?>
	<div class="wrap">
		<h1><?php echo esc_html( __( 'EveryCal Settings', 'everycal' ) ); ?></h1>
		<?php if ( $logs_cleared ) : ?>
			<div class="notice notice-success is-dismissible"><p><?php echo esc_html__( 'HTTP debug logs cleared.', 'everycal' ); ?></p></div>
		<?php endif; ?>
		<?php if ( 'event' === $cache_action ) : ?>
			<?php /* translators: %s is the cache event label. */ ?>
			<div class="notice notice-success is-dismissible"><p><?php echo esc_html( sprintf( __( 'Cleared cached event: %s', 'everycal' ), $cache_event ) ); ?></p></div>
		<?php elseif ( 'all' === $cache_action ) : ?>
			<div class="notice notice-success is-dismissible"><p><?php echo esc_html__( 'Cleared all EveryCal caches (event + feed).', 'everycal' ); ?></p></div>
		<?php elseif ( 'refreshed' === $cache_action ) : ?>
			<?php /* translators: %s is the cache event label. */ ?>
			<div class="notice notice-success is-dismissible"><p><?php echo esc_html( sprintf( __( 'Refreshed cached event: %s', 'everycal' ), $cache_event ) ); ?></p></div>
		<?php elseif ( 'refresh_failed' === $cache_action ) : ?>
			<?php /* translators: %s is the cache event label. */ ?>
			<div class="notice notice-error is-dismissible"><p><?php echo esc_html( sprintf( __( 'Failed to refresh cached event: %s', 'everycal' ), $cache_event ) ); ?></p></div>
		<?php endif; ?>
		<form method="post" action="options.php">
			<?php settings_fields( 'everycal_settings' ); ?>
			<table class="form-table">
				<tr>
					<th scope="row"><label for="everycal_default_server_url"><?php echo esc_html( __( 'Default EveryCal server URL', 'everycal' ) ); ?></label></th>
					<td>
						<input type="url" id="everycal_default_server_url" name="everycal_default_server_url"
								value="<?php echo esc_attr( $default_server_url ); ?>" class="regular-text" placeholder="https://events.example.com" />
						<p class="description">
							<?php echo esc_html__( 'Used as the default server for new EveryCal blocks. Existing blocks can still override this per block.', 'everycal' ); ?><br>
							<?php echo esc_html__( 'Also used as fallback when a block has no server URL configured.', 'everycal' ); ?>
						</p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="everycal_cache_ttl_minutes"><?php echo esc_html( __( 'Cache freshness (minutes)', 'everycal' ) ); ?></label></th>
					<td>
						<input type="number" min="1" max="10080" id="everycal_cache_ttl_minutes" name="everycal_cache_ttl_minutes"
								value="<?php echo esc_attr( (string) $cache_ttl_minutes ); ?>" class="small-text" />
						<p class="description">
							<?php echo esc_html__( 'How often EveryCal feed data is refreshed from the upstream server. Default: 1440 (24 hours).', 'everycal' ); ?><br>
							<?php echo esc_html__( 'This is plugin-wide and also controls single-event cache freshness.', 'everycal' ); ?>
						</p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="everycal_prewarm_past_hours"><?php echo esc_html( __( 'Prewarm past window (hours)', 'everycal' ) ); ?></label></th>
					<td>
						<input type="number" min="0" max="8760" id="everycal_prewarm_past_hours" name="everycal_prewarm_past_hours"
								value="<?php echo esc_attr( (string) $prewarm_past_hours ); ?>" class="small-text" />
						<p class="description">
							<?php echo esc_html__( 'Keep/pre-warm caches for events that ended within this many past hours, plus all future events. Events outside this window are dropped from feed cache and need to be fetched from EveryCal just-in-time. Default: 24.', 'everycal' ); ?>
						</p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="everycal_base_path"><?php echo esc_html( __( 'Event pages base path', 'everycal' ) ); ?></label></th>
					<td>
						<code><?php echo esc_html( home_url( '/' ) ); ?></code>
						<input type="text" id="everycal_base_path" name="everycal_base_path"
								value="<?php echo esc_attr( $base ); ?>" class="regular-text" />
						<code>/@username/event-slug</code>
						<p class="description">
							<?php echo esc_html__( 'Individual event detail pages will be served at this path.', 'everycal' ); ?><br>
							<?php echo esc_html__( 'After changing this, click Save — permalinks are flushed automatically.', 'everycal' ); ?>
						</p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="everycal_creator_url_template"><?php echo esc_html( __( 'Creator profile URL template', 'everycal' ) ); ?></label></th>
					<td>
						<input type="text" id="everycal_creator_url_template" name="everycal_creator_url_template"
								value="<?php echo esc_attr( $creator_template ); ?>" class="regular-text" />
						<p class="description">
							<?php echo esc_html__( 'Optional. Leave empty to link creators to the EveryCal instance profile.', 'everycal' ); ?><br>
							<?php echo esc_html__( 'You can use: {username}, {domain}, {handle}, {server_url}. Relative paths are resolved on this WordPress site.', 'everycal' ); ?>
						</p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="everycal_http_debug_manual"><?php echo esc_html( __( 'HTTP debug logging', 'everycal' ) ); ?></label></th>
					<td>
						<label for="everycal_http_debug_manual">
							<input type="hidden" name="everycal_http_debug_manual" value="0" />
							<input type="checkbox" id="everycal_http_debug_manual" name="everycal_http_debug_manual" value="1" <?php checked( $manual_http_debug ); ?> />
							<?php echo esc_html__( 'Enable EveryCal HTTP debug logging even when WP_DEBUG is off.', 'everycal' ); ?>
						</label>
						<p class="description">
							<?php echo esc_html__( 'Logging is always enabled automatically when WP_DEBUG is true.', 'everycal' ); ?><br>
							<?php
							$status_on  = __( 'ON', 'everycal' );
							$status_off = __( 'OFF', 'everycal' );
							/* translators: 1: current status, 2: WP_DEBUG status, 3: manual logging status. */
							echo esc_html( sprintf( __( 'Current status: %1$s (WP_DEBUG=%2$s, manual=%3$s)', 'everycal' ), $http_debug_on ? $status_on : $status_off, $wp_debug_enabled ? $status_on : $status_off, $manual_http_debug ? $status_on : $status_off ) );
							?>
							<br>
							<?php echo esc_html__( 'Requests are filtered to hosts from Default EveryCal server URL and Additional HTTP debug servers.', 'everycal' ); ?>
						</p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="everycal_http_debug_additional_servers"><?php echo esc_html( __( 'Additional HTTP debug servers', 'everycal' ) ); ?></label></th>
					<td>
						<input type="text" id="everycal_http_debug_additional_servers" name="everycal_http_debug_additional_servers"
								value="<?php echo esc_attr( $http_debug_additional_servers ); ?>" class="regular-text" />
						<p class="description">
							<?php echo esc_html__( 'Optional comma-separated list of server URLs or hostnames to include in HTTP debug logging.', 'everycal' ); ?><br>
							<?php echo esc_html__( 'Example: events.example.com, https://calendar.example.org', 'everycal' ); ?>
						</p>
						<div style="margin-top:8px;display:flex;align-items:flex-start;gap:6px;flex-wrap:wrap;">
							<strong style="font-size:12px;line-height:24px;"><?php echo esc_html__( 'Active debug hosts:', 'everycal' ); ?></strong>
							<?php if ( ! empty( $known_hosts ) ) : ?>
								<?php foreach ( $known_hosts as $host ) : ?>
									<code style="padding:2px 8px;border:1px solid #dcdcde;border-radius:999px;background:#f6f7f7;"><?php echo esc_html( $host ); ?></code>
								<?php endforeach; ?>
							<?php else : ?>
								<span class="description" style="line-height:24px;"><?php echo esc_html__( 'none configured', 'everycal' ); ?></span>
							<?php endif; ?>
						</div>
					</td>
				</tr>
			</table>
			<?php submit_button(); ?>
		</form>

		<details id="everycal-http-logs-panel" style="margin-top: 1.25rem;">
			<summary style="cursor: pointer; font-weight: 600;"><?php echo esc_html__( 'HTTP Debug Log Viewer', 'everycal' ); ?></summary>
			<div style="margin-top: 0.75rem;">
				<p class="description">
					<?php echo esc_html__( 'Shows recent EveryCal HTTP requests captured by this plugin. Use Auto-refresh to watch requests live while browsing the site.', 'everycal' ); ?>
				</p>
				<p>
					<strong><?php echo esc_html__( 'Tracked hosts:', 'everycal' ); ?></strong>
					<?php echo ! empty( $known_hosts ) ? esc_html( implode( ', ', $known_hosts ) ) : esc_html__( 'none discovered yet', 'everycal' ); ?>
				</p>
				<p>
					<button type="button" class="button" id="everycal-http-refresh"><?php echo esc_html__( 'Refresh', 'everycal' ); ?></button>
					<button type="button" class="button" id="everycal-http-watch" aria-pressed="false"><?php echo esc_html__( 'Start Auto-refresh', 'everycal' ); ?></button>
					<button type="button" class="button" id="everycal-http-copy"><?php echo esc_html__( 'Copy Logs', 'everycal' ); ?></button>
				</p>
				<textarea id="everycal-http-log-viewer" class="large-text code" rows="18" readonly><?php echo esc_textarea( $logs_text ); ?></textarea>
				<div style="margin-top:8px;">
					<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline;">
						<input type="hidden" name="action" value="everycal_clear_http_logs" />
						<?php wp_nonce_field( 'everycal_clear_http_logs' ); ?>
						<button type="submit" class="button button-secondary"><?php echo esc_html__( 'Clear Logs', 'everycal' ); ?></button>
					</form>
				</div>
			</div>
		</details>

		<details id="everycal-cache-events-panel" style="margin-top: 1.25rem;">
			<summary style="cursor: pointer; font-weight: 600;"><?php echo esc_html__( 'Cached Events', 'everycal' ); ?> (<span id="everycal-cache-count"><?php echo esc_html( (string) count( $cached_events ) ); ?></span>)</summary>
			<div style="margin-top: 0.75rem;">
				<div id="everycal-cache-action-feedback" style="margin-bottom:8px;"></div>
				<p class="description"><?php echo esc_html__( 'Review and clear per-event caches. Use Clear Entire Cache to also wipe feed cache entries.', 'everycal' ); ?></p>
				<div style="margin-bottom: 12px;">
					<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline;">
						<input type="hidden" name="action" value="everycal_clear_all_cache" />
						<?php wp_nonce_field( 'everycal_clear_all_cache' ); ?>
						<button type="submit" class="button button-secondary" onclick="return window.confirm('<?php echo esc_js( __( 'Clear all EveryCal cache data? This removes event and feed caches.', 'everycal' ) ); ?>');"><?php echo esc_html__( 'Clear Entire Cache', 'everycal' ); ?></button>
					</form>
				</div>
				<?php if ( empty( $cached_events ) ) : ?>
					<p><?php echo esc_html__( 'No cached events indexed yet.', 'everycal' ); ?></p>
				<?php else : ?>
					<p class="description" id="everycal-cache-sort-status" style="margin-bottom:8px;"><?php echo esc_html__( 'Sorted by Cached At (newest first).', 'everycal' ); ?></p>
					<table class="widefat striped" id="everycal-cached-events-table" style="max-width: 1100px;" data-sort="cachedAt" data-order="desc">
						<thead>
							<tr>
								<th scope="col" aria-sort="none"><button type="button" class="button-link" data-everycal-sort="event"><?php echo esc_html__( 'Event', 'everycal' ); ?> <span aria-hidden="true">↕</span></button></th>
								<th scope="col" aria-sort="none"><button type="button" class="button-link" data-everycal-sort="startDate"><?php echo esc_html__( 'Start', 'everycal' ); ?> <span aria-hidden="true">↕</span></button></th>
								<th scope="col" aria-sort="none"><button type="button" class="button-link" data-everycal-sort="handle"><?php echo esc_html__( 'Handle', 'everycal' ); ?> <span aria-hidden="true">↕</span></button></th>
								<th scope="col" aria-sort="none"><button type="button" class="button-link" data-everycal-sort="freshUntil"><?php echo esc_html__( 'Cached Until', 'everycal' ); ?> <span aria-hidden="true">↕</span></button></th>
								<th scope="col" aria-sort="none"><button type="button" class="button-link" data-everycal-sort="cachedAt"><?php echo esc_html__( 'Cached At', 'everycal' ); ?> <span aria-hidden="true">↕</span></button></th>
								<th><?php echo esc_html__( 'Action', 'everycal' ); ?></th>
							</tr>
						</thead>
						<tbody>
							<?php foreach ( $cached_events as $cached_event ) : ?>
								<?php
								$event_username    = isset( $cached_event['username'] ) ? (string) $cached_event['username'] : '';
								$event_slug        = isset( $cached_event['slug'] ) ? (string) $cached_event['slug'] : '';
								$event_id          = '@' . $event_username . '/' . $event_slug;
								$event_title       = isset( $cached_event['title'] ) ? (string) $cached_event['title'] : '';
								$event_start       = isset( $cached_event['startDate'] ) ? (string) $cached_event['startDate'] : '';
								$event_server      = isset( $cached_event['serverUrl'] ) ? (string) $cached_event['serverUrl'] : '';
								$event_url         = isset( $cached_event['eventUrl'] ) ? (string) $cached_event['eventUrl'] : '';
								$event_cached_at   = isset( $cached_event['cachedAt'] ) ? absint( $cached_event['cachedAt'] ) : 0;
								$event_fresh_until = isset( $cached_event['freshUntil'] ) ? absint( $cached_event['freshUntil'] ) : 0;
								$event_start_ts    = ( '' !== $event_start && false !== strtotime( $event_start ) ) ? strtotime( $event_start ) : 0;
								$event_sort_label  = strtolower( (string) ( '' !== $event_title ? $event_title : $event_id ) );
								$event_handle      = isset( $cached_event['handle'] ) ? ltrim( trim( (string) $cached_event['handle'] ), '@' ) : '';
								if ( '' === $event_handle ) {
									$event_handle = (string) $event_username;
								}
								$event_handle_sort  = strtolower( $event_handle );
								$wp_event_url       = everycal_build_wp_event_detail_url( $base, $event_username, $event_slug );
								$everycal_event_url = everycal_build_everycal_event_url( $event_server, $event_username, $event_slug, $event_handle );
								?>
								<tr data-event-username="<?php echo esc_attr( $event_username ); ?>" data-event-slug="<?php echo esc_attr( $event_slug ); ?>" data-sort-event="<?php echo esc_attr( $event_sort_label ); ?>" data-sort-handle="<?php echo esc_attr( $event_handle_sort ); ?>" data-sort-startdate="<?php echo esc_attr( (string) $event_start_ts ); ?>" data-sort-freshuntil="<?php echo esc_attr( (string) $event_fresh_until ); ?>" data-sort-cachedat="<?php echo esc_attr( (string) $event_cached_at ); ?>">
									<td>
										<strong data-role="event-title"><?php echo esc_html( '' !== $event_title ? $event_title : $event_id ); ?></strong><br />
										<code><?php echo esc_html( $event_id ); ?></code>
										<div style="margin-top:4px;display:flex;gap:8px;flex-wrap:wrap;">
											<a data-role="wp-link" href="<?php echo esc_url( $wp_event_url ); ?>" target="_blank" rel="noopener noreferrer"><?php echo esc_html__( 'View on WordPress', 'everycal' ); ?></a>
											<?php if ( '' !== $everycal_event_url ) : ?>
												<span class="description" aria-hidden="true">|</span>
												<a data-role="everycal-link" href="<?php echo esc_url( $everycal_event_url ); ?>" target="_blank" rel="noopener noreferrer"><?php echo esc_html__( 'View on EveryCal', 'everycal' ); ?></a>
											<?php endif; ?>
										</div>
									</td>
									<td>
										<?php if ( '' !== $event_start && false !== strtotime( $event_start ) ) : ?>
											<?php echo esc_html( wp_date( 'Y-m-d H:i', strtotime( $event_start ) ) ); ?>
										<?php else : ?>
											<span class="description">—</span>
										<?php endif; ?>
									</td>
									<td>
										<?php if ( '' !== $event_handle ) : ?>
											<code data-role="event-handle">@<?php echo esc_html( $event_handle ); ?></code>
										<?php else : ?>
											<span class="description" data-role="event-handle">—</span>
										<?php endif; ?>
									</td>
									<td>
										<?php if ( $event_fresh_until > 0 ) : ?>
											<span data-role="fresh-until"><?php echo esc_html( wp_date( 'Y-m-d H:i:s', $event_fresh_until ) ); ?></span>
											<?php if ( $event_fresh_until < time() ) : ?>
												<br /><span class="description" data-role="fresh-expired"><?php echo esc_html__( 'expired', 'everycal' ); ?></span>
											<?php endif; ?>
										<?php else : ?>
											<span class="description" data-role="fresh-until">—</span>
										<?php endif; ?>
									</td>
									<td>
										<?php if ( $event_cached_at > 0 ) : ?>
											<span data-role="cached-at"><?php echo esc_html( wp_date( 'Y-m-d H:i:s', $event_cached_at ) ); ?></span>
										<?php else : ?>
											<span class="description" data-role="cached-at">—</span>
										<?php endif; ?>
									</td>
									<td>
										<div style="display:flex;gap:6px;flex-wrap:nowrap;align-items:center;">
											<form class="everycal-cache-row-action" method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
												<input type="hidden" name="action" value="everycal_refresh_cached_event" />
												<input type="hidden" name="username" value="<?php echo esc_attr( $event_username ); ?>" />
												<input type="hidden" name="slug" value="<?php echo esc_attr( $event_slug ); ?>" />
												<?php wp_nonce_field( 'everycal_refresh_cached_event' ); ?>
												<button type="submit" class="button button-primary button-small" style="display:inline-flex;align-items:center;gap:4px;">
													<span class="dashicons dashicons-update" style="font-size:14px;width:14px;height:14px;line-height:14px;" aria-hidden="true"></span>
													<span><?php echo esc_html__( 'Refresh', 'everycal' ); ?></span>
												</button>
											</form>
											<form class="everycal-cache-row-action" method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
												<input type="hidden" name="action" value="everycal_clear_cached_event" />
												<input type="hidden" name="username" value="<?php echo esc_attr( $event_username ); ?>" />
												<input type="hidden" name="slug" value="<?php echo esc_attr( $event_slug ); ?>" />
												<?php wp_nonce_field( 'everycal_clear_cached_event' ); ?>
												<button type="submit" class="button button-secondary button-small"><?php echo esc_html__( 'Clear', 'everycal' ); ?></button>
											</form>
										</div>
									</td>
								</tr>
							<?php endforeach; ?>
						</tbody>
					</table>
				<?php endif; ?>
			</div>
		</details>

		<script>
		(function() {
			const i18n = 
			<?php
			echo wp_json_encode(
				array(
					'event'                => __( 'Event', 'everycal' ),
					'handle'               => __( 'Handle', 'everycal' ),
					'start'                => __( 'Start', 'everycal' ),
					'cachedUntil'          => __( 'Cached Until', 'everycal' ),
					'cachedAt'             => __( 'Cached At', 'everycal' ),
					'ascending'            => __( 'ascending', 'everycal' ),
					'descending'           => __( 'descending', 'everycal' ),
					'oldestEarliestFirst'  => __( 'oldest/earliest first', 'everycal' ),
					'newestLatestFirst'    => __( 'newest/latest first', 'everycal' ),
					/* translators: 1: current sort field label, 2: current sort direction, 3: opposite sort direction. */
					'sortedBy'             => __( 'Sorted by %1$s (%2$s, %3$s).', 'everycal' ),
					'noCachedEvents'       => __( 'No cached events indexed yet.', 'everycal' ),
					'requestFailed'        => __( 'Request failed', 'everycal' ),
					'expired'              => __( 'expired', 'everycal' ),
					/* translators: 1: account username, 2: event slug. */
					'clearedCachedEvent'   => __( 'Cleared cached event: @%1$s/%2$s', 'everycal' ),
					/* translators: 1: account username, 2: event slug. */
					'refreshedCachedEvent' => __( 'Refreshed cached event: @%1$s/%2$s', 'everycal' ),
					/* translators: 1: account username, 2: event slug. */
					'actionFailedFor'      => __( 'Action failed for @%1$s/%2$s.', 'everycal' ),
					'startAutoRefresh'     => __( 'Start Auto-refresh', 'everycal' ),
					'stopAutoRefresh'      => __( 'Stop Auto-refresh', 'everycal' ),
					'copied'               => __( 'Copied', 'everycal' ),
					'copyFailed'           => __( 'Copy failed', 'everycal' ),
				)
			);
			?>
							;
			const cachePanel = document.getElementById("everycal-cache-events-panel");
			const cacheTable = document.getElementById("everycal-cached-events-table");
			const sortStatus = document.getElementById("everycal-cache-sort-status");
			const cacheCount = document.getElementById("everycal-cache-count");
			const cacheFeedback = document.getElementById("everycal-cache-action-feedback");

			function format(template, values) {
				return String(template || "").replace(/%([0-9]+)\$s/g, function(_, index) {
					const i = parseInt(index, 10) - 1;
					return values[i] !== undefined ? String(values[i]) : "";
				});
			}

			if (cachePanel) {
				const panelStateKey = "everycal_cache_panel_open";
				try {
					if (window.localStorage && window.localStorage.getItem(panelStateKey) === "1") {
						cachePanel.open = true;
					}
				} catch (e) {
					// no-op
				}

				cachePanel.addEventListener("toggle", function () {
					try {
						if (!window.localStorage) return;
						window.localStorage.setItem(panelStateKey, cachePanel.open ? "1" : "0");
					} catch (e) {
						// no-op
					}
				});
			}

			if (cacheTable) {
				const tbody = cacheTable.querySelector("tbody");
				const headers = Array.from(cacheTable.querySelectorAll("button[data-everycal-sort]"));
				const labelByKey = {
					event: i18n.event,
					handle: i18n.handle,
					startDate: i18n.start,
					freshUntil: i18n.cachedUntil,
					cachedAt: i18n.cachedAt
				};

				function updateSortStatus(sortKey, order) {
					if (!sortStatus) return;
					const direction = order === "asc" ? i18n.ascending : i18n.descending;
					const directionLong = order === "asc" ? i18n.oldestEarliestFirst : i18n.newestLatestFirst;
					const label = labelByKey[sortKey] || i18n.cachedAt;
					sortStatus.textContent = format(i18n.sortedBy, [label, directionLong, direction]);
				}

				function updateHeaderIndicators(sortKey, order) {
					const ths = Array.from(cacheTable.querySelectorAll("thead th[aria-sort]"));
					ths.forEach(function (th) {
						th.setAttribute("aria-sort", "none");
					});

					headers.forEach(function (btn) {
						const span = btn.querySelector("span");
						if (!span) return;
						if (btn.getAttribute("data-everycal-sort") === sortKey) {
							span.textContent = order === "asc" ? "↑" : "↓";
							const th = btn.closest("th");
							if (th) {
								th.setAttribute("aria-sort", order === "asc" ? "ascending" : "descending");
							}
						} else {
							span.textContent = "↕";
						}
					});
				}

				function sortRows(sortKey, order) {
					if (!tbody) return;
					const rows = Array.from(tbody.querySelectorAll("tr"));
					const isNumeric = sortKey !== "event" && sortKey !== "handle";
					const direction = order === "asc" ? 1 : -1;

					rows.sort(function (a, b) {
						const aRaw = a.getAttribute("data-sort-" + sortKey.toLowerCase()) || "";
						const bRaw = b.getAttribute("data-sort-" + sortKey.toLowerCase()) || "";

						if (isNumeric) {
							const aNum = parseInt(aRaw, 10) || 0;
							const bNum = parseInt(bRaw, 10) || 0;
							return (aNum - bNum) * direction;
						}

						return aRaw.localeCompare(bRaw) * direction;
					});

					rows.forEach(function (row) {
						tbody.appendChild(row);
					});

					cacheTable.setAttribute("data-sort", sortKey);
					cacheTable.setAttribute("data-order", order);
					updateHeaderIndicators(sortKey, order);
					updateSortStatus(sortKey, order);
				}

				function getRowCount() {
					if (!tbody) return 0;
					return tbody.querySelectorAll("tr").length;
				}

				function updateCount() {
					if (!cacheCount) return;
					cacheCount.textContent = String(getRowCount());
				}

				function setFeedback(message, isError) {
					if (!cacheFeedback) return;
					cacheFeedback.textContent = message;
					cacheFeedback.className = isError ? "notice notice-error inline" : "notice notice-success inline";
				}

				function updateEmptyState() {
					if (!tbody || !cacheTable) return;
					const hasRows = getRowCount() > 0;
					let empty = document.getElementById("everycal-cache-empty");
					if (!hasRows) {
						cacheTable.style.display = "none";
						if (!empty) {
							empty = document.createElement("p");
							empty.id = "everycal-cache-empty";
							empty.textContent = i18n.noCachedEvents;
							cacheTable.parentNode.insertBefore(empty, cacheTable.nextSibling);
						}
					} else {
						cacheTable.style.display = "table";
						if (empty && empty.parentNode) empty.parentNode.removeChild(empty);
					}
				}

				async function submitRowAction(form) {
					const formData = new FormData(form);
					const action = String(formData.get("action") || "");
					if (!action) return;

					const submitBtn = form.querySelector("button[type=submit]");
					if (submitBtn) submitBtn.disabled = true;

					try {
						const response = await fetch(ajaxurl, {
							method: "POST",
							credentials: "same-origin",
							body: formData,
						});
						const payload = await response.json();
						if (!payload || !payload.success) {
							throw new Error((payload && payload.data && payload.data.message) ? payload.data.message : i18n.requestFailed);
						}

						const data = payload.data || {};
						const username = String(formData.get("username") || "");
						const slug = String(formData.get("slug") || "");
						const row = Array.from(tbody.querySelectorAll("tr")).find(function (tr) {
							return tr.getAttribute("data-event-username") === username && tr.getAttribute("data-event-slug") === slug;
						});
						if (!row) return;

						if (action === "everycal_clear_cached_event") {
							row.remove();
							updateCount();
							updateEmptyState();
							setFeedback(
								format(i18n.clearedCachedEvent, [username, slug]),
								false
							);
							const sortKey = cacheTable.getAttribute("data-sort") || "cachedAt";
							const order = cacheTable.getAttribute("data-order") || "desc";
							sortRows(sortKey, order);
							return;
						}

						if (action === "everycal_refresh_cached_event" && data.entry) {
							const entry = data.entry;
							const titleNode = row.querySelector('[data-role="event-title"]');
							const handleNode = row.querySelector('[data-role="event-handle"]');
							const cachedAtNode = row.querySelector('[data-role="cached-at"]');
							const freshUntilNode = row.querySelector('[data-role="fresh-until"]');
							const wpLink = row.querySelector('[data-role="wp-link"]');
							const everycalLink = row.querySelector('[data-role="everycal-link"]');

							const displayTitle = entry.title && entry.title.length ? entry.title : ("@" + username + "/" + slug);
							const handleDisplay = entry.handle && entry.handle.length ? ("@" + entry.handle.replace(/^@+/, "")) : "—";

							row.setAttribute("data-sort-event", String(displayTitle).toLowerCase());
							row.setAttribute("data-sort-handle", String((entry.handle || username || "")).toLowerCase());
							row.setAttribute("data-sort-startdate", String(entry.startTs || 0));
							row.setAttribute("data-sort-freshuntil", String(entry.freshUntil || 0));
							row.setAttribute("data-sort-cachedat", String(entry.cachedAt || 0));

							if (titleNode) titleNode.textContent = displayTitle;
							if (handleNode) handleNode.textContent = handleDisplay;
							if (cachedAtNode) cachedAtNode.textContent = entry.cachedAtText || "—";
							if (freshUntilNode) freshUntilNode.textContent = entry.freshUntilText || "—";

							const existingExpired = row.querySelector('[data-role="fresh-expired"]');
							if (existingExpired && existingExpired.parentNode) {
								const parent = existingExpired.parentNode;
								const prev = existingExpired.previousSibling;
								if (prev && prev.nodeName === "BR") {
									parent.removeChild(prev);
								}
								parent.removeChild(existingExpired);
							}
							if (entry.freshExpired && freshUntilNode && freshUntilNode.parentNode) {
								freshUntilNode.parentNode.appendChild(document.createElement("br"));
								const expired = document.createElement("span");
								expired.className = "description";
								expired.setAttribute("data-role", "fresh-expired");
								expired.textContent = i18n.expired;
								freshUntilNode.parentNode.appendChild(expired);
							}

							if (wpLink && entry.wpEventUrl) wpLink.setAttribute("href", entry.wpEventUrl);
							if (everycalLink && entry.everycalEventUrl) everycalLink.setAttribute("href", entry.everycalEventUrl);

							setFeedback(
								format(i18n.refreshedCachedEvent, [username, slug]),
								false
							);
							const sortKey = cacheTable.getAttribute("data-sort") || "cachedAt";
							const order = cacheTable.getAttribute("data-order") || "desc";
							sortRows(sortKey, order);
						}
					} catch (err) {
						setFeedback(
							format(i18n.actionFailedFor, [
								String(formData.get("username") || ""),
								String(formData.get("slug") || "")
							]),
							true
						);
					} finally {
						if (submitBtn) submitBtn.disabled = false;
					}
				}

				headers.forEach(function (btn) {
					btn.addEventListener("click", function () {
						const sortKey = btn.getAttribute("data-everycal-sort") || "cachedAt";
						const currentSort = cacheTable.getAttribute("data-sort") || "cachedAt";
						const currentOrder = cacheTable.getAttribute("data-order") || "desc";
						const nextOrder = (sortKey === currentSort && currentOrder === "asc") ? "desc" : "asc";
						sortRows(sortKey, nextOrder);
					});
				});

				updateHeaderIndicators("cachedAt", "desc");
				updateSortStatus("cachedAt", "desc");
				updateCount();
				updateEmptyState();

				const rowForms = Array.from(document.querySelectorAll("form.everycal-cache-row-action"));
				rowForms.forEach(function (form) {
					form.addEventListener("submit", function (e) {
						e.preventDefault();
						submitRowAction(form);
					});
				});
			}

			const viewer = document.getElementById("everycal-http-log-viewer");
			const refreshBtn = document.getElementById("everycal-http-refresh");
			const watchBtn = document.getElementById("everycal-http-watch");
			const copyBtn = document.getElementById("everycal-http-copy");
			if (!viewer || !refreshBtn || !watchBtn || !copyBtn) return;

			const nonce = <?php echo wp_json_encode( $logs_nonce ); ?>;
			let timer = null;

			async function refreshLogs() {
				try {
					const params = new URLSearchParams({
						action: "everycal_get_http_logs",
						nonce,
						limit: "200"
					});
					const res = await fetch(ajaxurl + "?" + params.toString(), { credentials: "same-origin" });
					const payload = await res.json();
					if (!payload || !payload.success || !payload.data) return;
					viewer.value = payload.data.text || "";
					viewer.scrollTop = viewer.scrollHeight;
				} catch (e) {
					// no-op
				}
			}

			refreshBtn.addEventListener("click", refreshLogs);

			watchBtn.addEventListener("click", function () {
				if (timer) {
					clearInterval(timer);
					timer = null;
					watchBtn.textContent = i18n.startAutoRefresh;
					watchBtn.setAttribute("aria-pressed", "false");
					return;
				}
				refreshLogs();
				timer = setInterval(refreshLogs, 5000);
				watchBtn.textContent = i18n.stopAutoRefresh;
				watchBtn.setAttribute("aria-pressed", "true");
			});

			copyBtn.addEventListener("click", async function () {
				const text = viewer.value || "";
				if (!text) return;
				const original = copyBtn.textContent;
				try {
					if (navigator.clipboard && navigator.clipboard.writeText) {
						await navigator.clipboard.writeText(text);
					} else {
						viewer.focus();
						viewer.select();
						document.execCommand("copy");
					}
					copyBtn.textContent = i18n.copied;
				} catch (e) {
					copyBtn.textContent = i18n.copyFailed;
				}
				setTimeout(function () {
					copyBtn.textContent = original;
				}, 1200);
			});
		})();
		</script>
	</div>
	<?php
}

// Flush rewrite rules whenever the base path option changes.
add_action(
	'update_option_everycal_base_path',
	function () {
		everycal_add_rewrite_rules();
		flush_rewrite_rules();
	}
);

/* ------------------------------------------------------------------ */
/*  Virtual event-detail pages via rewrite rules                       */
/* ------------------------------------------------------------------ */

add_action( 'init', 'everycal_add_rewrite_rules' );

function everycal_add_rewrite_rules() {
	$base = get_option( 'everycal_base_path', 'events' );
	// Match: /events/@{username}/{slug}
	add_rewrite_rule(
		'^' . preg_quote( $base, '/' ) . '/@([^/]+)/([^/]+)/?$',
		'index.php?everycal_event_username=$matches[1]&everycal_event_slug=$matches[2]',
		'top'
	);
}

add_filter( 'query_vars', 'everycal_query_vars' );

function everycal_query_vars( $vars ) {
	$vars[] = 'everycal_event_username';
	$vars[] = 'everycal_event_slug';
	$vars[] = 'everycal_page';
	return $vars;
}

// Flush rules on activation so the rewrite is registered immediately.
register_activation_hook(
	__FILE__,
	function () {
		everycal_add_rewrite_rules();
		flush_rewrite_rules();
	}
);

register_deactivation_hook(
	__FILE__,
	function () {
		flush_rewrite_rules();
	}
);

add_action( 'admin_bar_menu', 'everycal_customize_event_admin_bar', 999 );

function everycal_is_virtual_event_page() {
	return (bool) ( get_query_var( 'everycal_event_username' ) && get_query_var( 'everycal_event_slug' ) );
}

function everycal_customize_event_admin_bar( $wp_admin_bar ) {
	if ( ! is_admin_bar_showing() || is_admin() || ! everycal_is_virtual_event_page() ) {
		return;
	}

	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}

	$username = (string) get_query_var( 'everycal_event_username' );
	$slug     = (string) get_query_var( 'everycal_event_slug' );
	$entry    = everycal_get_cached_event_index_entry( $username, $slug );

	$fresh_until = isset( $entry['freshUntil'] ) ? absint( $entry['freshUntil'] ) : 0;
	if ( $fresh_until > 0 ) {
		$until_label = sprintf(
			/* translators: %s: cache expiration date/time. */
			__( 'Cached until %s', 'everycal' ),
			wp_date( get_option( 'date_format' ) . ' ' . get_option( 'time_format' ), $fresh_until )
		);
	} else {
		$until_label = __( 'Cache status unavailable', 'everycal' );
	}

	$event_label = '@' . $username . '/' . $slug;
	$redirect_to = remove_query_arg( array( 'everycal_cache_cleared', 'everycal_cache_event' ) );

	$refresh_url = add_query_arg(
		array(
			'action'      => 'everycal_refresh_cached_event',
			'username'    => $username,
			'slug'        => $slug,
			'redirect_to' => $redirect_to,
		),
		admin_url( 'admin-post.php' )
	);
	$refresh_url = wp_nonce_url( $refresh_url, 'everycal_refresh_cached_event' );

	$wp_admin_bar->remove_node( 'edit' );

	$wp_admin_bar->add_node(
		array(
			'id'    => 'everycal-cache',
			'title' => '<span class="ab-icon dashicons dashicons-database-view" aria-hidden="true"></span><span class="ab-label">' . esc_html__( 'Cached', 'everycal' ) . '</span>',
			'href'  => false,
			'meta'  => array(
				'title' => $event_label,
			),
		)
	);

	$wp_admin_bar->add_node(
		array(
			'id'     => 'everycal-cache-until',
			'parent' => 'everycal-cache',
			'title'  => esc_html( $until_label ),
			'href'   => false,
		)
	);

	$wp_admin_bar->add_node(
		array(
			'id'     => 'everycal-cache-refresh',
			'parent' => 'everycal-cache',
			'title'  => '<span aria-hidden="true">↻ </span>' . esc_html__( 'Refresh now', 'everycal' ),
			'href'   => esc_url( $refresh_url ),
		)
	);
}

function everycal_get_cache_action_redirect_url() {
	$requested = isset( $_REQUEST['redirect_to'] ) ? sanitize_text_field( wp_unslash( $_REQUEST['redirect_to'] ) ) : '';
	if ( '' !== $requested ) {
		$validated = wp_validate_redirect( rawurldecode( $requested ), false );
		if ( false !== $validated ) {
			return $validated;
		}
	}

	return admin_url( 'options-general.php?page=everycal' );
}

/* ------------------------------------------------------------------ */
/*  Intercept the template for virtual event pages                     */
/* ------------------------------------------------------------------ */

add_filter( 'template_include', 'everycal_event_template' );

function everycal_event_template( $template ) {
	$username = get_query_var( 'everycal_event_username' );
	$slug     = get_query_var( 'everycal_event_slug' );

	if ( ! $username || ! $slug ) {
		return $template;
	}

	// Resolve server URL from locally cached feed data first, then fallback to default.
	$server_url = everycal_discover_server_url( $username, $slug );
	if ( ! $server_url ) {
		status_header( 500 );
		wp_die( esc_html__( 'EveryCal: no server URL configured. Set a default EveryCal server URL in plugin settings.', 'everycal' ) );
	}

	$api_url = trailingslashit( $server_url ) . 'api/v1/events/by-slug/' . rawurlencode( $username ) . '/' . rawurlencode( $slug );

	// Two-tier cache for individual events.
	$store_key = 'everycal_ev_' . md5( $username . ':' . $slug );
	$fresh_key = 'everycal_evf_' . md5( $username . ':' . $slug );
	$event     = everycal_cache_get( $store_key, false );
	if ( false === $event ) {
		// Backward compat: migrate legacy persistent option into expiring cache.
		$legacy_event = get_option( $store_key, false );
		if ( false !== $legacy_event ) {
			$store_ttl = everycal_get_cache_store_ttl_seconds( everycal_get_cache_ttl_seconds() );
			everycal_cache_set( $store_key, $legacy_event, $store_ttl );
			delete_option( $store_key );
			$event = $legacy_event;
		}
	}

	if ( false === everycal_cache_get( $fresh_key, false ) ) {
		$response = wp_remote_get(
			$api_url,
			array(
				'timeout' => 10,
				'headers' => array( 'Accept' => 'application/json' ),
			)
		);

		if ( ! is_wp_error( $response ) && 200 === wp_remote_retrieve_response_code( $response ) ) {
			$event     = json_decode( wp_remote_retrieve_body( $response ), true );
			$store_ttl = everycal_get_cache_store_ttl_seconds( everycal_get_cache_ttl_seconds() );
			everycal_cache_set( $store_key, $event, $store_ttl );
			delete_option( $store_key );
			everycal_set_cached_event_server_url( (string) $username, (string) $slug, $server_url );

			$ttl = everycal_get_event_cache_ttl_seconds();
			everycal_cache_set( $fresh_key, 1, $ttl );
			everycal_register_cached_event_index_entry( $event, $server_url, time(), time() + $ttl );
		} elseif ( $event ) {
			// API failed but we have a stored copy — serve stale, retry in 1 min.
			everycal_cache_set( $fresh_key, 1, 60 );
		} else {
			// No stored copy and API failed — 404.
			status_header( 404 );
			return get_404_template();
		}
	}

	if ( ! $event ) {
		status_header( 404 );
		return get_404_template();
	}

	// Inject into a global so the template can use it.
	$GLOBALS['everycal_single_event']      = $event;
	$GLOBALS['everycal_single_server_url'] = $server_url;

	// Override the page title.
	add_filter(
		'document_title_parts',
		function ( $parts ) use ( $event ) {
			$parts['title'] = $event['title'] ?? __( 'Event', 'everycal' );
			return $parts;
		}
	);

	// Render using the theme's page.php wrapped around our content.
	add_filter( 'the_content', 'everycal_render_single_event_content', 0 );
	add_filter( 'the_title', 'everycal_override_single_title', 10, 2 );

	// Use a blank page as the base — create a fake page query.
	global $wp_query, $post;
	$post = new WP_Post(
		(object) array(
			'ID'             => 0,
			'post_title'     => $event['title'] ?? __( 'Event', 'everycal' ),
			'post_name'      => $slug,
			'post_content'   => '',
			'post_excerpt'   => '',
			'post_status'    => 'publish',
			'post_type'      => 'page',
			'post_author'    => 0,
			'post_parent'    => 0,
			'post_date'      => current_time( 'mysql' ),
			'post_date_gmt'  => current_time( 'mysql', 1 ),
			'comment_status' => 'closed',
			'ping_status'    => 'closed',
			'comment_count'  => 0,
			'filter'         => 'raw',
		)
	);

	$wp_query->posts                = array( $post );
	$wp_query->post                 = $post;
	$wp_query->post_count           = 1;
	$wp_query->found_posts          = 1;
	$wp_query->max_num_pages        = 1;
	$wp_query->is_page              = true;
	$wp_query->is_singular          = true;
	$wp_query->is_single            = false;
	$wp_query->is_attachment        = false;
	$wp_query->is_archive           = false;
	$wp_query->is_category          = false;
	$wp_query->is_tag               = false;
	$wp_query->is_tax               = false;
	$wp_query->is_author            = false;
	$wp_query->is_date              = false;
	$wp_query->is_year              = false;
	$wp_query->is_month             = false;
	$wp_query->is_day               = false;
	$wp_query->is_time              = false;
	$wp_query->is_search            = false;
	$wp_query->is_feed              = false;
	$wp_query->is_comment_feed      = false;
	$wp_query->is_trackback         = false;
	$wp_query->is_home              = false;
	$wp_query->is_embed             = false;
	$wp_query->is_paged             = false;
	$wp_query->is_admin             = false;
	$wp_query->is_preview           = false;
	$wp_query->is_robots            = false;
	$wp_query->is_posts_page        = false;
	$wp_query->is_post_type_archive = false;
	$wp_query->is_404               = false;

	// Tell WordPress about the post data so template tags work.
	setup_postdata( $post );

	// Return the theme's page template.
	return get_page_template();
}

function everycal_override_single_title( $title, $post_id = null ) {
	if ( isset( $GLOBALS['everycal_single_event'] ) && ( -1 === $post_id || 0 === $post_id ) ) {
		return esc_html( $GLOBALS['everycal_single_event']['title'] ?? $title );
	}
	return $title;
}

function everycal_render_single_event_content( $content ) {
	if ( ! isset( $GLOBALS['everycal_single_event'] ) ) {
		return $content;
	}

	$event      = $GLOBALS['everycal_single_event'];
	$base       = trim( (string) get_option( 'everycal_base_path', 'events' ), '/ ' );
	$back_url   = '' === $base ? home_url( '/' ) : home_url( '/' . $base . '/' );
	$server_url = isset( $GLOBALS['everycal_single_server_url'] ) ? $GLOBALS['everycal_single_server_url'] : '';

	ob_start();
	echo '<div class="everycal-single-event">';

	// Back link
	echo '<p class="everycal-single-event__back"><a href="' . esc_url( $back_url ) . '">&larr; '
		. esc_html__( 'All events', 'everycal' ) . '</a></p>';

	// Image
	if ( ! empty( $event['image']['url'] ) ) {
		echo '<div class="everycal-single-event__image">';
		echo '<img src="' . esc_url( $event['image']['url'] ) . '"';
		if ( ! empty( $event['image']['alt'] ) ) {
			echo ' alt="' . esc_attr( $event['image']['alt'] ) . '"';
		}
		echo ' loading="lazy" style="max-width:100%;height:auto;border-radius:8px;" />';
		echo '</div>';
	}

	// Date
	if ( ! empty( $event['startDate'] ) ) {
		echo '<time class="everycal-event__date" datetime="' . esc_attr( $event['startDate'] ) . '">';
		$datetime_lines = everycal_get_event_datetime_lines( $event );
		if ( ! empty( $datetime_lines['date'] ) ) {
			echo '<span class="everycal-event__date-line" style="display:block;"><span aria-hidden="true">📅 </span>' . esc_html( $datetime_lines['date'] ) . '</span>';
		}
		if ( ! empty( $datetime_lines['time'] ) ) {
			echo '<span class="everycal-event__time-line" style="display:block;"><span aria-hidden="true">🕒 </span>' . esc_html( $datetime_lines['time'] ) . '</span>';
		}
		echo '</time>';
	}

	// Location
	if ( ! empty( $event['location']['name'] ) ) {
		echo '<div class="everycal-single-event__location"><span aria-hidden="true">📍 </span>';
		if ( ! empty( $event['location']['url'] ) ) {
			echo '<a href="' . esc_url( $event['location']['url'] ) . '"' . everycal_external_link_attrs( $event['location']['url'] ) . '>' . esc_html( $event['location']['name'] ) . '</a>';
		} else {
			echo esc_html( $event['location']['name'] );
		}
		if ( ! empty( $event['location']['address'] ) ) {
			echo ' — ' . esc_html( $event['location']['address'] );
			$map_links = everycal_get_location_map_links( $event['location'] );
			if ( ! empty( $map_links ) ) {
				echo ' (';
				echo '<a href="' . esc_url( $map_links['google'] ) . '"' . everycal_external_link_attrs( $map_links['google'] ) . '>' . esc_html__( 'Google Maps', 'everycal' ) . '</a>, ';
				echo '<a href="' . esc_url( $map_links['apple'] ) . '"' . everycal_external_link_attrs( $map_links['apple'] ) . '>' . esc_html__( 'Apple Maps', 'everycal' ) . '</a>, ';
				echo '<a href="' . esc_url( $map_links['osm'] ) . '"' . everycal_external_link_attrs( $map_links['osm'] ) . '>' . esc_html__( 'OSM', 'everycal' ) . '</a>';
				echo ')';
			}
		}
		echo '</div>';
	}

	// Creator
	$creator = everycal_get_event_creator( $event, $server_url );
	if ( ! empty( $creator['label'] ) ) {
		$creator_url = everycal_resolve_creator_url( $event, $server_url, $creator );
		echo '<p class="everycal-single-event__creator">';
		echo esc_html__( 'By', 'everycal' ) . ' ';
		if ( $creator_url ) {
			echo '<a href="' . esc_url( $creator_url ) . '"' . everycal_external_link_attrs( $creator_url ) . '>' . esc_html( $creator['label'] ) . '</a>';
		} else {
			echo esc_html( $creator['label'] );
		}
		echo '</p>';
	}

	// Description
	if ( ! empty( $event['description'] ) ) {
		echo '<div class="everycal-single-event__description">' . wp_kses_post( $event['description'] ) . '</div>';
	}

	// Tags
	if ( ! empty( $event['tags'] ) ) {
		echo '<div class="everycal-event__tags">';
		foreach ( $event['tags'] as $tag ) {
			$tag_url = everycal_resolve_tag_url( $tag, $server_url );
			if ( $tag_url ) {
				echo '<a class="everycal-event__tag" href="' . esc_url( $tag_url ) . '"' . everycal_external_link_attrs( $tag_url ) . '>' . esc_html( $tag ) . '</a>';
			} else {
				echo '<span class="everycal-event__tag">' . esc_html( $tag ) . '</span>';
			}
		}
		echo '</div>';
	}

	// Original source link
	if ( ! empty( $event['url'] ) ) {
		echo '<p class="everycal-single-event__source"><a href="' . esc_url( $event['url'] ) . '"' . everycal_external_link_attrs( $event['url'] ) . '>'
			. esc_html__( 'Original event page', 'everycal' ) . ' &rarr;</a></p>';
	}

	echo '</div>';

	// Remove the filter so it doesn't fire again for other content.
	remove_filter( 'the_content', 'everycal_render_single_event_content', 0 );

	return ob_get_clean();
}

/**
 * Discover the server URL for an event.
 */
function everycal_discover_server_url( $username = '', $slug = '' ) {
	$cached = everycal_get_cached_event_server_url( $username, $slug );
	if ( '' !== $cached ) {
		return $cached;
	}

	$default_server = everycal_normalize_server_url( get_option( 'everycal_default_server_url', '' ) );
	if ( '' !== $default_server ) {
		return $default_server;
	}

	return '';
}

/**
 * Parse a comma-separated list of server URLs/hosts.
 */
function everycal_parse_server_list_option( $value ) {
	if ( ! is_string( $value ) || '' === trim( $value ) ) {
		return array();
	}

	$items = array();
	$parts = preg_split( '/[\r\n,]+/', $value );

	foreach ( $parts as $part ) {
		$entry = trim( (string) $part );
		if ( '' === $entry ) {
			continue;
		}

		$host = everycal_extract_server_host( $entry );
		if ( '' === $host ) {
			continue;
		}

		if ( preg_match( '#^https?://#i', $entry ) ) {
			$entry = untrailingslashit( esc_url_raw( $entry ) );
		} else {
			$entry = $host;
		}

		$items[] = $entry;
	}

	return array_values( array_unique( $items ) );
}

/**
 * Extract a hostname from a server URL or hostname string.
 */
function everycal_extract_server_host( $value ) {
	if ( ! is_string( $value ) || '' === trim( $value ) ) {
		return '';
	}

	$candidate = trim( $value );
	if ( ! preg_match( '#^https?://#i', $candidate ) ) {
		$candidate = 'https://' . ltrim( $candidate, '/' );
	}

	$host = wp_parse_url( $candidate, PHP_URL_HOST );
	if ( empty( $host ) ) {
		return '';
	}

	return strtolower( (string) $host );
}

/**
 * Return configured EveryCal hosts for request filtering.
 */
function everycal_get_configured_server_hosts() {
	$hosts = array();

	$default_server = trim( (string) get_option( 'everycal_default_server_url', '' ) );
	if ( '' !== $default_server ) {
		$default_host = everycal_extract_server_host( $default_server );
		if ( '' !== $default_host ) {
			$hosts[] = $default_host;
		}
	}

	$additional = get_option( 'everycal_http_debug_additional_servers', '' );
	foreach ( everycal_parse_server_list_option( $additional ) as $entry ) {
		$host = everycal_extract_server_host( $entry );
		if ( '' !== $host ) {
			$hosts[] = $host;
		}
	}

	return array_values( array_unique( $hosts ) );
}

/**
 * Whether EveryCal HTTP debug logging is enabled.
 */
function everycal_http_debug_enabled() {
	$manual  = (bool) get_option( 'everycal_http_debug_manual', false );
	$enabled = ( defined( 'WP_DEBUG' ) && WP_DEBUG ) || $manual;

	if ( defined( 'EVERYCAL_HTTP_DEBUG' ) ) {
		$enabled = (bool) EVERYCAL_HTTP_DEBUG;
	}

	/**
	 * Filters whether EveryCal HTTP debug logging is enabled.
	 *
	 * @param bool $enabled Whether debug logging is enabled.
	 */
	return (bool) apply_filters( 'everycal_http_debug_enabled', $enabled );
}

/**
 * Whether EveryCal HTTP debug lines should also be sent to PHP error_log.
 */
function everycal_http_debug_error_log_enabled( $line = '', $url = '', $context = '', $response = null, $args = array() ) {
	$enabled = defined( 'WP_DEBUG_LOG' ) && WP_DEBUG_LOG;

	/**
	 * Filters whether EveryCal HTTP debug lines should be written to PHP error_log.
	 *
	 * @param bool  $enabled  Whether writing to error_log is enabled.
	 * @param string $line    Formatted log line.
	 * @param string $url     Request URL.
	 * @param string $context Debug context from the HTTP API.
	 * @param mixed  $response HTTP API response value.
	 * @param array  $args    Request arguments passed to wp_remote_get/wp_remote_request.
	 */
	return (bool) apply_filters(
		'everycal_http_debug_error_log_enabled',
		$enabled,
		$line,
		$url,
		$context,
		$response,
		$args
	);
}

/**
 * Return recent HTTP debug log lines.
 */
function everycal_get_http_debug_logs( $limit = 200 ) {
	$logs = get_option( 'everycal_http_debug_logs', array() );
	if ( ! is_array( $logs ) ) {
		return array();
	}

	$limit = max( 1, absint( $limit ) );
	return array_slice( $logs, -1 * $limit );
}

/**
 * Append a line to the plugin's rolling HTTP debug log buffer.
 */
function everycal_append_http_debug_log( $line ) {
	if ( ! is_string( $line ) || '' === trim( $line ) ) {
		return;
	}

	$logs = get_option( 'everycal_http_debug_logs', array() );
	if ( ! is_array( $logs ) ) {
		$logs = array();
	}

	$logs[]      = $line;
	$max_entries = 500;
	if ( count( $logs ) > $max_entries ) {
		$logs = array_slice( $logs, -1 * $max_entries );
	}

	update_option( 'everycal_http_debug_logs', $logs, false );
}

/**
 * Sanitize URLs for log output.
 *
 * Removes control characters and strips query/fragment parts.
 */
function everycal_sanitize_url_for_log( $url ) {
	$url = is_string( $url ) ? trim( $url ) : '';
	if ( '' === $url ) {
		return '';
	}

	$url = preg_replace( '/[\x00-\x1F\x7F]+/', '', $url );
	if ( ! is_string( $url ) || '' === $url ) {
		return '';
	}

	$parts = wp_parse_url( $url );
	if ( ! is_array( $parts ) ) {
		return preg_replace( '/[?#].*$/', '', $url );
	}

	$scheme = isset( $parts['scheme'] ) ? strtolower( (string) $parts['scheme'] ) : '';
	$host   = isset( $parts['host'] ) ? strtolower( (string) $parts['host'] ) : '';
	$path   = isset( $parts['path'] ) ? (string) $parts['path'] : '';
	$port   = isset( $parts['port'] ) ? absint( $parts['port'] ) : 0;

	$sanitized = '';
	if ( '' !== $scheme ) {
		$sanitized .= $scheme . '://';
	}
	$sanitized .= $host;
	if ( $port > 0 ) {
		$sanitized .= ':' . $port;
	}
	$sanitized .= $path;

	if ( '' === $sanitized ) {
		return preg_replace( '/[?#].*$/', '', $url );
	}

	return $sanitized;
}

/**
 * AJAX endpoint for log viewer polling.
 */
function everycal_ajax_get_http_logs() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_send_json_error( array( 'message' => 'forbidden' ), 403 );
	}
	check_ajax_referer( 'everycal_http_logs', 'nonce' );

	$limit = isset( $_GET['limit'] ) ? absint( wp_unslash( $_GET['limit'] ) ) : 200;
	$lines = everycal_get_http_debug_logs( $limit );

	wp_send_json_success(
		array(
			'text'  => implode( "\n", $lines ),
			'count' => count( $lines ),
		)
	);
}

function everycal_ajax_clear_cached_event() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_send_json_error( array( 'message' => 'forbidden' ), 403 );
	}

	check_ajax_referer( 'everycal_clear_cached_event' );

	$username = isset( $_POST['username'] ) ? sanitize_text_field( wp_unslash( $_POST['username'] ) ) : '';
	$slug     = isset( $_POST['slug'] ) ? sanitize_text_field( wp_unslash( $_POST['slug'] ) ) : '';
	$ok       = everycal_clear_cached_event( $username, $slug );

	if ( ! $ok ) {
		wp_send_json_error( array( 'message' => 'invalid_event' ), 400 );
	}

	wp_send_json_success(
		array(
			'event' => '@' . $username . '/' . $slug,
		)
	);
}

function everycal_ajax_refresh_cached_event() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_send_json_error( array( 'message' => 'forbidden' ), 403 );
	}

	check_ajax_referer( 'everycal_refresh_cached_event' );

	$username = isset( $_POST['username'] ) ? sanitize_text_field( wp_unslash( $_POST['username'] ) ) : '';
	$slug     = isset( $_POST['slug'] ) ? sanitize_text_field( wp_unslash( $_POST['slug'] ) ) : '';

	$result = everycal_refresh_cached_event( $username, $slug );
	if ( empty( $result['success'] ) || empty( $result['entry'] ) || ! is_array( $result['entry'] ) ) {
		wp_send_json_error( array( 'message' => 'refresh_failed' ), 400 );
	}

	$entry             = $result['entry'];
	$base              = get_option( 'everycal_base_path', 'events' );
	$entry_username    = isset( $entry['username'] ) ? (string) $entry['username'] : $username;
	$entry_slug        = isset( $entry['slug'] ) ? (string) $entry['slug'] : $slug;
	$entry_handle      = isset( $entry['handle'] ) ? ltrim( trim( (string) $entry['handle'] ), '@' ) : $entry_username;
	$entry_server      = isset( $entry['serverUrl'] ) ? (string) $entry['serverUrl'] : '';
	$entry_title       = isset( $entry['title'] ) ? (string) $entry['title'] : '';
	$entry_start       = isset( $entry['startDate'] ) ? (string) $entry['startDate'] : '';
	$entry_start_ts    = ( '' !== $entry_start && false !== strtotime( $entry_start ) ) ? strtotime( $entry_start ) : 0;
	$entry_cached_at   = isset( $entry['cachedAt'] ) ? absint( $entry['cachedAt'] ) : 0;
	$entry_fresh_until = isset( $entry['freshUntil'] ) ? absint( $entry['freshUntil'] ) : 0;

	wp_send_json_success(
		array(
			'event' => '@' . $entry_username . '/' . $entry_slug,
			'entry' => array(
				'username'         => $entry_username,
				'slug'             => $entry_slug,
				'handle'           => $entry_handle,
				'title'            => $entry_title,
				'startTs'          => $entry_start_ts,
				'cachedAt'         => $entry_cached_at,
				'freshUntil'       => $entry_fresh_until,
				'cachedAtText'     => $entry_cached_at > 0 ? wp_date( 'Y-m-d H:i:s', $entry_cached_at ) : '—',
				'freshUntilText'   => $entry_fresh_until > 0 ? wp_date( 'Y-m-d H:i:s', $entry_fresh_until ) : '—',
				'freshExpired'     => $entry_fresh_until > 0 && $entry_fresh_until < time(),
				'wpEventUrl'       => everycal_build_wp_event_detail_url( $base, $entry_username, $entry_slug ),
				'everycalEventUrl' => everycal_build_everycal_event_url( $entry_server, $entry_username, $entry_slug, $entry_handle ),
			),
		)
	);
}

/**
 * Clear saved HTTP debug logs.
 */
function everycal_clear_http_logs_action() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_die( esc_html__( 'You are not allowed to do this.', 'everycal' ) );
	}

	check_admin_referer( 'everycal_clear_http_logs' );
	delete_option( 'everycal_http_debug_logs' );

	$redirect = add_query_arg( 'everycal_logs_cleared', '1', admin_url( 'options-general.php?page=everycal' ) );
	wp_safe_redirect( $redirect );
	exit;
}

function everycal_clear_cached_event_action() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_die( esc_html__( 'You are not allowed to do this.', 'everycal' ) );
	}

	check_admin_referer( 'everycal_clear_cached_event' );

	$username = isset( $_REQUEST['username'] ) ? sanitize_text_field( wp_unslash( $_REQUEST['username'] ) ) : '';
	$slug     = isset( $_REQUEST['slug'] ) ? sanitize_text_field( wp_unslash( $_REQUEST['slug'] ) ) : '';

	everycal_clear_cached_event( $username, $slug );

	$event_label = '@' . $username . '/' . $slug;
	$redirect    = add_query_arg(
		array(
			'everycal_cache_cleared' => 'event',
			'everycal_cache_event'   => $event_label,
		),
		everycal_get_cache_action_redirect_url()
	);

	wp_safe_redirect( $redirect );
	exit;
}

function everycal_clear_all_cache_action() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_die( esc_html__( 'You are not allowed to do this.', 'everycal' ) );
	}

	check_admin_referer( 'everycal_clear_all_cache' );
	everycal_clear_all_cache_data();

	$redirect = add_query_arg(
		'everycal_cache_cleared',
		'all',
		everycal_get_cache_action_redirect_url()
	);

	wp_safe_redirect( $redirect );
	exit;
}

function everycal_refresh_cached_event_action() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_die( esc_html__( 'You are not allowed to do this.', 'everycal' ) );
	}

	check_admin_referer( 'everycal_refresh_cached_event' );

	$username    = isset( $_REQUEST['username'] ) ? sanitize_text_field( wp_unslash( $_REQUEST['username'] ) ) : '';
	$slug        = isset( $_REQUEST['slug'] ) ? sanitize_text_field( wp_unslash( $_REQUEST['slug'] ) ) : '';
	$event_label = '@' . $username . '/' . $slug;

	$result  = everycal_refresh_cached_event( $username, $slug );
	$success = ! empty( $result['success'] );

	$redirect = add_query_arg(
		array(
			'everycal_cache_cleared' => $success ? 'refreshed' : 'refresh_failed',
			'everycal_cache_event'   => $event_label,
		),
		everycal_get_cache_action_redirect_url()
	);

	wp_safe_redirect( $redirect );
	exit;
}

/**
 * Log outgoing requests to configured EveryCal hosts.
 */
function everycal_http_api_debug_logger( $response, $context, $class_name, $args, $url ) {
	unset( $class_name );
	if ( ! everycal_http_debug_enabled() ) {
		return;
	}

	$host = wp_parse_url( (string) $url, PHP_URL_HOST );
	if ( empty( $host ) ) {
		return;
	}

	$allowed_hosts = everycal_get_configured_server_hosts();
	if ( empty( $allowed_hosts ) || ! in_array( strtolower( (string) $host ), $allowed_hosts, true ) ) {
		return;
	}

	$method  = isset( $args['method'] ) ? strtoupper( (string) $args['method'] ) : 'GET';
	$timeout = isset( $args['timeout'] ) ? (string) $args['timeout'] : '';
	$status  = 'n/a';

	if ( is_wp_error( $response ) ) {
		$status = 'WP_Error: ' . $response->get_error_message();
	} elseif ( is_array( $response ) ) {
		$status = (string) wp_remote_retrieve_response_code( $response );
	}

	$line = sprintf(
		'[EveryCal HTTP] %s %s | timeout=%s | status=%s | context=%s',
		$method,
		everycal_sanitize_url_for_log( $url ),
		$timeout,
		$status,
		(string) $context
	);

	if ( everycal_http_debug_error_log_enabled( $line, $url, $context, $response, $args ) ) {
		error_log( $line );
	}
	everycal_append_http_debug_log( '[' . wp_date( 'Y-m-d H:i:s' ) . '] ' . $line );
}

/**
 * Build a long-form date label matching EveryCal card/OG style.
 */
function everycal_format_event_datetime( $event ) {
	$lines = everycal_get_event_datetime_lines( $event );
	if ( ! empty( $lines['date'] ) && ! empty( $lines['time'] ) ) {
		return $lines['date'] . ' · ' . $lines['time'];
	}
	if ( ! empty( $lines['date'] ) ) {
		return $lines['date'];
	}
	return $lines['time'];
}

/**
 * Build separate date/time lines for display.
 */
function everycal_get_event_datetime_lines( $event ) {
	if ( empty( $event['startDate'] ) ) {
		return array(
			'date' => '',
			'time' => '',
		);
	}

	$all_day = ! empty( $event['allDay'] );
	$tz_name = 'UTC';

	if ( ! $all_day && ! empty( $event['eventTimezone'] ) && is_string( $event['eventTimezone'] ) ) {
		$tz_name = $event['eventTimezone'];
	}

	try {
		$tz = new DateTimeZone( $tz_name );
	} catch ( Exception $e ) {
		$tz = new DateTimeZone( 'UTC' );
	}

	$start = everycal_parse_event_datetime( $event['startDate'], $all_day );
	if ( ! $start ) {
		return array(
			'date' => '',
			'time' => '',
		);
	}

	$end = ! empty( $event['endDate'] ) ? everycal_parse_event_datetime( $event['endDate'], $all_day ) : null;

	$date_fmt = 'l, F j, Y';
	$time_fmt = 'g:i A';

	$start_date = wp_date( $date_fmt, $start->getTimestamp(), $all_day ? new DateTimeZone( 'UTC' ) : $tz );

	if ( $all_day ) {
		$date_line = $start_date;
		if ( $end ) {
			$end_date = wp_date( $date_fmt, $end->getTimestamp(), new DateTimeZone( 'UTC' ) );
			if ( $start_date !== $end_date ) {
				$date_line = $start_date . ' – ' . $end_date;
			}
		}

		return array(
			'date' => $date_line,
			'time' => __( 'All day', 'everycal' ),
		);
	}

	$start_time = wp_date( $time_fmt, $start->getTimestamp(), $tz );
	if ( ! $end ) {
		return array(
			'date' => $start_date,
			'time' => $start_time,
		);
	}

	$start_day = wp_date( 'Y-m-d', $start->getTimestamp(), $tz );
	$end_day   = wp_date( 'Y-m-d', $end->getTimestamp(), $tz );
	$end_time  = wp_date( $time_fmt, $end->getTimestamp(), $tz );

	if ( $start_day === $end_day ) {
		return array(
			'date' => $start_date,
			'time' => $start_time . ' – ' . $end_time,
		);
	}

	$end_date = wp_date( $date_fmt, $end->getTimestamp(), $tz );
	return array(
		'date' => $start_date . ' – ' . $end_date,
		'time' => $start_time . ' – ' . $end_time,
	);
}

/**
 * Parse an event datetime string into a DateTimeImmutable.
 */
function everycal_parse_event_datetime( $value, $all_day = false ) {
	if ( ! is_string( $value ) || '' === trim( $value ) ) {
		return null;
	}

	if ( $all_day && preg_match( '/^\d{4}-\d{2}-\d{2}$/', $value ) ) {
		$dt = DateTimeImmutable::createFromFormat( '!Y-m-d', $value, new DateTimeZone( 'UTC' ) );
		if ( false === $dt ) {
			return null;
		}

		return $dt;
	}

	try {
		return new DateTimeImmutable( $value );
	} catch ( Exception $e ) {
		return null;
	}
}

/**
 * Build a plain-text description excerpt for event cards.
 */
function everycal_get_event_description_preview( $description, $mode = 'words', $word_limit = 30, $char_limit = 220 ) {
	if ( ! is_string( $description ) || '' === trim( $description ) ) {
		return '';
	}

	$text = wp_strip_all_tags( $description, true );
	$text = trim( preg_replace( '/\s+/', ' ', $text ) );

	if ( '' === $text ) {
		return '';
	}

	if ( 'full' === $mode ) {
		return $text;
	}

	if ( 'chars' === $mode ) {
		$char_limit = max( 1, absint( $char_limit ) );
		if ( function_exists( 'wp_html_excerpt' ) ) {
			return wp_html_excerpt( $text, $char_limit, '…' );
		}
		if ( function_exists( 'mb_strlen' ) && function_exists( 'mb_substr' ) ) {
			if ( mb_strlen( $text, 'UTF-8' ) <= $char_limit ) {
				return $text;
			}
			return mb_substr( $text, 0, $char_limit, 'UTF-8' ) . '…';
		}
		if ( strlen( $text ) <= $char_limit ) {
			return $text;
		}
		return substr( $text, 0, $char_limit ) . '…';
	}

	$word_limit = max( 1, absint( $word_limit ) );
	return wp_trim_words( $text, $word_limit, '…' );
}

/**
 * Whether a layout displays the event description.
 */
function everycal_layout_supports_description( $layout ) {
	return in_array( $layout, array( 'list', 'grid' ), true );
}

/**
 * Extract creator identity from the event object.
 */
function everycal_get_event_creator( $event, $server_url = '' ) {
	$username = '';
	$label    = '';
	$domain   = '';
	$handle   = '';

	if ( ! empty( $event['account']['username'] ) ) {
		$username = (string) $event['account']['username'];
	} elseif ( ! empty( $event['account_username'] ) ) {
		$username = (string) $event['account_username'];
	}

	if ( ! empty( $event['account']['displayName'] ) ) {
		$label = (string) $event['account']['displayName'];
	} elseif ( ! empty( $event['account_display_name'] ) ) {
		$label = (string) $event['account_display_name'];
	}

	if ( ! empty( $event['account']['domain'] ) ) {
		$domain = (string) $event['account']['domain'];
	} elseif ( ! empty( $event['account_domain'] ) ) {
		$domain = (string) $event['account_domain'];
	}

	if ( ! empty( $event['account']['handle'] ) ) {
		$handle = (string) $event['account']['handle'];
	} elseif ( ! empty( $event['account_handle'] ) ) {
		$handle = (string) $event['account_handle'];
	}

	$username = ltrim( trim( $username ), '@' );
	$domain   = strtolower( trim( $domain ) );
	$handle   = ltrim( trim( $handle ), '@' );

	if ( '' !== $handle && false !== strpos( $handle, '@' ) ) {
		$parts = explode( '@', $handle, 2 );
		if ( '' === $username && ! empty( $parts[0] ) ) {
			$username = (string) $parts[0];
		}
		if ( '' === $domain && ! empty( $parts[1] ) ) {
			$domain = strtolower( (string) $parts[1] );
		}
	}

	if ( '' !== $username && false !== strpos( $username, '@' ) ) {
		$parts    = explode( '@', $username, 2 );
		$username = (string) $parts[0];
		if ( '' === $domain && ! empty( $parts[1] ) ) {
			$domain = strtolower( (string) $parts[1] );
		}
	}

	if ( '' === $domain ) {
		$url_handle = everycal_extract_handle_from_event_url( isset( $event['url'] ) ? (string) $event['url'] : '' );
		if ( '' !== $url_handle && false !== strpos( $url_handle, '@' ) ) {
			$parts = explode( '@', $url_handle, 2 );
			if ( '' === $username && ! empty( $parts[0] ) ) {
				$username = (string) $parts[0];
			}
			if ( ! empty( $parts[1] ) ) {
				$domain = strtolower( (string) $parts[1] );
			}
		}
	}

	if ( '' === $domain ) {
		$server_host = everycal_extract_server_host( $server_url );
		if ( '' !== $server_host ) {
			$domain = $server_host;
		}
	}

	if ( '' === $label ) {
		$label = $username;
	}

	if ( '' === $handle ) {
		$handle = $username;
		if ( $domain && false === strpos( $username, '@' ) ) {
			$handle = $username . '@' . $domain;
		}
	}

	return array(
		'username' => $username,
		'domain'   => $domain,
		'handle'   => $handle,
		'label'    => $label,
	);
}

/**
 * Best-effort extraction of @user@domain from an event URL path.
 */
function everycal_extract_handle_from_event_url( $url ) {
	$url = is_string( $url ) ? trim( $url ) : '';
	if ( '' === $url ) {
		return '';
	}

	$path = (string) wp_parse_url( $url, PHP_URL_PATH );
	if ( '' === $path ) {
		return '';
	}

	if ( preg_match( '#/@([^/@]+@[^/]+)/#', $path, $matches ) ) {
		return ltrim( (string) $matches[1], '@' );
	}

	return '';
}

/**
 * Resolve creator profile URL.
 *
 * By default this points to the EveryCal profile on the configured server URL.
 * Set "everycal_creator_url_template" or use the "everycal_creator_url" filter
 * to map creators to local WordPress author/profile pages.
 */
function everycal_resolve_creator_url( $event, $server_url, $creator = null ) {
	if ( null === $creator ) {
		$creator = everycal_get_event_creator( $event, $server_url );
	}

	if ( empty( $creator['username'] ) ) {
		return '';
	}

	$default_url = '';
	if ( ! empty( $server_url ) ) {
		$actor = everycal_select_actor_for_server( $server_url, $creator['username'], $creator['handle'] );
		if ( '' !== $actor ) {
			$default_url = trailingslashit( $server_url ) . '@' . $actor;
		}
	}

	$resolved = $default_url;
	$template = (string) get_option( 'everycal_creator_url_template', '' );

	if ( '' !== trim( $template ) ) {
		$tokens    = array(
			'{username}'   => $creator['username'],
			'{domain}'     => $creator['domain'],
			'{handle}'     => $creator['handle'],
			'{server_url}' => untrailingslashit( (string) $server_url ),
		);
		$candidate = strtr( $template, $tokens );

		if ( preg_match( '#^https?://#i', $candidate ) ) {
			$resolved = $candidate;
		} elseif ( '' !== $candidate ) {
			$resolved = home_url( '/' . ltrim( $candidate, '/' ) );
		}
	}

	/**
	 * Filters the resolved creator profile URL shown in event cards and event pages.
	 *
	 * @param string $resolved   The resolved URL before filtering.
	 * @param array  $event      Normalized event payload.
	 * @param string $server_url EveryCal server URL used for the request.
	 * @param array  $creator    Normalized creator payload.
	 */
	$filtered = apply_filters( 'everycal_creator_url', $resolved, $event, $server_url, $creator );
	return is_string( $filtered ) ? $filtered : $resolved;
}

/**
 * Resolve a tag URL on the EveryCal instance.
 */
function everycal_resolve_tag_url( $tag, $server_url ) {
	$tag = is_string( $tag ) ? trim( $tag ) : '';
	if ( '' === $tag || '' === $server_url ) {
		return '';
	}

	$base = trailingslashit( $server_url );
	return add_query_arg( 'tags', $tag, $base );
}

/**
 * Add target/rel attributes for links that leave the current site.
 */
function everycal_external_link_attrs( $url ) {
	$url = is_string( $url ) ? trim( $url ) : '';
	if ( '' === $url ) {
		return '';
	}

	$target_host = wp_parse_url( $url, PHP_URL_HOST );
	$home_host   = wp_parse_url( home_url( '/' ), PHP_URL_HOST );

	if ( empty( $target_host ) || empty( $home_host ) ) {
		return '';
	}

	if ( strtolower( (string) $target_host ) === strtolower( (string) $home_host ) ) {
		return '';
	}

	return ' target="_blank" rel="noopener noreferrer"';
}

/**
 * Build location links in the same shape as EveryCal event page.
 */
function everycal_get_location_map_links( $location ) {
	if ( empty( $location['address'] ) ) {
		return array();
	}

	$address = trim( (string) $location['address'] );
	if ( '' === $address ) {
		return array();
	}

	$has_coords = isset( $location['latitude'], $location['longitude'] )
		&& is_numeric( $location['latitude'] )
		&& is_numeric( $location['longitude'] );

	if ( $has_coords ) {
		$lat   = (float) $location['latitude'];
		$lon   = (float) $location['longitude'];
		$name  = ! empty( $location['name'] ) ? (string) $location['name'] : '';
		$label = trim( $name . ', ' . $address, ', ' );

		return array(
			'google' => 'https://www.google.com/maps/search/?api=1&query=' . rawurlencode( $address ),
			'apple'  => 'https://maps.apple.com/?ll=' . rawurlencode( (string) $lat ) . ',' . rawurlencode( (string) $lon )
				. ( '' !== $label ? '&q=' . rawurlencode( $label ) : '' ),
			'osm'    => 'https://www.openstreetmap.org/?mlat=' . rawurlencode( (string) $lat )
				. '&mlon=' . rawurlencode( (string) $lon )
				. '&marker=' . rawurlencode( (string) $lat ) . ',' . rawurlencode( (string) $lon )
				. '#map=17/' . rawurlencode( (string) $lat ) . '/' . rawurlencode( (string) $lon ),
		);
	}

	return array(
		'google' => 'https://www.google.com/maps/search/?api=1&query=' . rawurlencode( $address ),
		'apple'  => 'https://maps.apple.com/?q=' . rawurlencode( $address ),
		'osm'    => 'https://www.openstreetmap.org/search?query=' . rawurlencode( $address ),
	);
}
