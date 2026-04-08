<?php
/**
 * Plugin Name: EveryCal
 * Plugin URI:  https://github.com/everycal/everycal
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
add_action( 'admin_post_everycal_clear_http_logs', 'everycal_clear_http_logs_action' );

// Register the Gutenberg block
add_action( 'init', 'everycal_register_block' );
add_filter( 'block_type_metadata', 'everycal_apply_default_server_to_block_metadata' );

function everycal_register_block() {
    register_block_type( __DIR__ . '/build', array(
        'render_callback' => 'everycal_render_block',
    ) );
}

/**
 * Inject plugin-level default EveryCal server URL into block metadata defaults.
 */
function everycal_apply_default_server_to_block_metadata( $metadata ) {
    if ( empty( $metadata['name'] ) || 'everycal/feed' !== $metadata['name'] ) {
        return $metadata;
    }

    $default_server = trim( (string) get_option( 'everycal_default_server_url', '' ) );
    if ( '' === $default_server ) {
        return $metadata;
    }

    if ( ! isset( $metadata['attributes'] ) || ! is_array( $metadata['attributes'] ) ) {
        $metadata['attributes'] = array();
    }
    if ( ! isset( $metadata['attributes']['serverUrl'] ) || ! is_array( $metadata['attributes']['serverUrl'] ) ) {
        $metadata['attributes']['serverUrl'] = array( 'type' => 'string' );
    }

    $metadata['attributes']['serverUrl']['default'] = $default_server;
    return $metadata;
}

/**
 * Server-side render callback for the EveryCal feed block.
 *
 * Fetches events from the configured EveryCal server URL, caches them
 * with a two-tier strategy (persistent store + freshness transient),
 * and renders them grouped: ongoing → future → past, with pagination.
 */
function everycal_render_block( $attributes ) {
    $server_url = isset( $attributes['serverUrl'] ) ? esc_url( $attributes['serverUrl'] ) : '';
    if ( '' === $server_url ) {
        $server_url = esc_url( get_option( 'everycal_default_server_url', '' ) );
    }
    $account    = isset( $attributes['account'] ) ? sanitize_text_field( $attributes['account'] ) : '';
    $per_page   = isset( $attributes['limit'] ) ? absint( $attributes['limit'] ) : 10;
    $layout     = isset( $attributes['layout'] ) ? sanitize_text_field( $attributes['layout'] ) : 'list';
    $grid_columns = isset( $attributes['gridColumns'] ) ? absint( $attributes['gridColumns'] ) : 3;
    $grid_columns = max( 1, min( 6, $grid_columns ) );
    $description_length_mode = isset( $attributes['descriptionLengthMode'] ) ? sanitize_text_field( $attributes['descriptionLengthMode'] ) : 'words';
    if ( ! in_array( $description_length_mode, array( 'full', 'words', 'chars' ), true ) ) {
        $description_length_mode = 'words';
    }
    // Backward compatibility: excerptLength was the old word-count setting.
    $description_word_count = isset( $attributes['descriptionWordCount'] )
        ? absint( $attributes['descriptionWordCount'] )
        : ( isset( $attributes['excerptLength'] ) ? absint( $attributes['excerptLength'] ) : 30 );
    $description_char_count = isset( $attributes['descriptionCharCount'] ) ? absint( $attributes['descriptionCharCount'] ) : 220;
    $cache_ttl_minutes = isset( $attributes['cacheTtl'] ) ? absint( $attributes['cacheTtl'] ) : 1440;
    $cache_ttl         = $cache_ttl_minutes * MINUTE_IN_SECONDS;

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
        $api_url = trailingslashit( $server_url ) . 'api/v1/events?' . http_build_query( array_filter( array(
            'limit' => 200,
        ) ) );
    }

    $events = everycal_get_events( $api_url, $cache_ttl, $server_url );

    if ( empty( $events ) ) {
        return '<div class="everycal-block everycal-empty"><p>' .
            esc_html__( 'No events found.', 'everycal' ) . '</p></div>';
    }

    // ── Group events: ongoing → future → past ──
    $grouped = everycal_group_events( $events );

    // ── Pagination ──
    $paged     = isset( $_GET['everycal_page'] ) ? max( 1, absint( wp_unslash( $_GET['everycal_page'] ) ) ) : 1;
    $all_sorted = $grouped['upcoming'];
    $total     = count( $all_sorted );
    $pages     = max( 1, (int) ceil( $total / $per_page ) );
    $paged     = min( $paged, $pages );
    $offset    = ( $paged - 1 ) * $per_page;
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
        $rendered++;
    }

    echo '</div>';

    // Pagination links
    if ( $pages > 1 ) {
        $base = remove_query_arg( 'everycal_page' );
        $base = add_query_arg( 'everycal_page', '%#%', $base );

        echo '<nav class="everycal-pagination">';
        echo paginate_links( array(
            'base'      => esc_url( $base ),
            'format'    => '',
            'total'     => $pages,
            'current'   => $paged,
            'prev_text' => '&laquo; ' . esc_html__( 'Previous', 'everycal' ),
            'next_text' => esc_html__( 'Next', 'everycal' ) . ' &raquo;',
        ) );
        echo '</nav>';
    }

    return ob_get_clean();
}

/**
 * Two-tier event cache.
 *
 * Tier 1 — Persistent store (wp_option):
 *   All events ever seen, keyed by a composite "account_username:slug" key.
 *   Past events are NEVER removed — they stay for SEO / deep-link purposes.
 *
 * Tier 2 — Freshness flag (transient):
 *   A short-lived transient whose existence means "the store is fresh enough".
 *   When it expires we re-fetch from the API, merge into the store, and reset it.
 *
 * On API failure the persistent store is returned as-is (stale-while-error).
 */
function everycal_get_events( $api_url, $ttl = 300, $server_url = '' ) {
    $store_key = 'everycal_store_' . md5( $api_url );
    $fresh_key = 'everycal_fresh_' . md5( $api_url );

    // Load persistent store (may be empty array on first run).
    $store = get_option( $store_key, array() );

    // If still fresh, return what we have.
    if ( false !== get_transient( $fresh_key ) ) {
        return array_values( $store );
    }

    // Freshness expired — fetch from API.
    $response = wp_remote_get( $api_url, array(
        'timeout' => 10,
        'headers' => array( 'Accept' => 'application/json' ),
    ) );

    if ( is_wp_error( $response ) || 200 !== wp_remote_retrieve_response_code( $response ) ) {
        // API unreachable — serve stale data if we have any, still set a short
        // freshness flag so we don't hammer a down server on every page view.
        if ( ! empty( $store ) ) {
            set_transient( $fresh_key, 1, 60 ); // retry in 1 min
            return array_values( $store );
        }
        return array();
    }

    $body      = wp_remote_retrieve_body( $response );
    $data      = json_decode( $body, true );
    $raw       = isset( $data['events'] ) ? $data['events'] : array();
    $fetched   = array_map( 'everycal_normalise_event', $raw );
    $now       = time();

    // Pre-warm single-event caches so event detail pages can render from feed data
    // without immediately triggering extra by-slug requests.
    foreach ( $fetched as $event ) {
        everycal_prewarm_single_event_cache( $event, $now, $server_url );
    }

    // Build a set of IDs that came back from the API so we know what's "current".
    $api_ids = array();
    foreach ( $fetched as $event ) {
        $key = everycal_event_store_key( $event );
        $api_ids[ $key ] = true;
        // Always overwrite with the latest version from the server.
        $store[ $key ] = $event;
    }

    // Prune: remove events from the store that are NO LONGER in the API response
    // AND are in the future.  Past events stay forever.
    foreach ( $store as $key => $event ) {
        if ( isset( $api_ids[ $key ] ) ) {
            continue; // still in the API → keep
        }
        $start = isset( $event['startDate'] ) ? strtotime( $event['startDate'] ) : 0;
        $end   = ! empty( $event['endDate'] ) ? strtotime( $event['endDate'] ) : $start;
        if ( $end >= $now ) {
            // A future/ongoing event disappeared from the API — remove it
            // (it was probably deleted or made private upstream).
            unset( $store[ $key ] );
        }
        // Past events that disappeared from the API → keep for SEO.
    }

    // Persist and mark fresh.
    update_option( $store_key, $store, false ); // autoload = false (can be large)
    set_transient( $fresh_key, 1, $ttl );

    return array_values( $store );
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
function everycal_prewarm_single_event_cache( $event, $now = null, $server_url = '' ) {
    $username = '';
    if ( ! empty( $event['account']['username'] ) ) {
        $username = (string) $event['account']['username'];
    } elseif ( ! empty( $event['account_username'] ) ) {
        $username = (string) $event['account_username'];
    }

    $slug = ! empty( $event['slug'] ) ? (string) $event['slug'] : '';
    if ( '' === $username || '' === $slug ) {
        return;
    }

    if ( null === $now ) {
        $now = time();
    }

    $store_key = 'everycal_ev_' . md5( $username . ':' . $slug );
    $fresh_key = 'everycal_evf_' . md5( $username . ':' . $slug );

    update_option( $store_key, $event, false );
    everycal_set_cached_event_server_url( $username, $slug, $server_url );

    $start = isset( $event['startDate'] ) ? strtotime( $event['startDate'] ) : 0;
    $end   = ! empty( $event['endDate'] ) ? strtotime( $event['endDate'] ) : $start;
    $ttl   = ( $end >= $now ) ? 300 : DAY_IN_SECONDS;
    set_transient( $fresh_key, 1, $ttl );
}

/**
 * Persist the source server URL for a cached event.
 */
function everycal_set_cached_event_server_url( $username, $slug, $server_url ) {
    $username = is_string( $username ) ? trim( $username ) : '';
    $slug = is_string( $slug ) ? trim( $slug ) : '';
    $server_url = untrailingslashit( esc_url_raw( (string) $server_url ) );

    if ( '' === $username || '' === $slug || '' === $server_url ) {
        return;
    }

    $key = 'everycal_evs_' . md5( $username . ':' . $slug );
    update_option( $key, $server_url, false );
}

/**
 * Read the source server URL for a cached event.
 */
function everycal_get_cached_event_server_url( $username, $slug ) {
    $username = is_string( $username ) ? trim( $username ) : '';
    $slug = is_string( $slug ) ? trim( $slug ) : '';
    if ( '' === $username || '' === $slug ) {
        return '';
    }

    $key = 'everycal_evs_' . md5( $username . ':' . $slug );
    $url = get_option( $key, '' );
    if ( ! is_string( $url ) || '' === $url ) {
        return '';
    }

    return untrailingslashit( esc_url_raw( $url ) );
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
    usort( $current, function ( $a, $b ) {
        return strtotime( $a['startDate'] ) - strtotime( $b['startDate'] );
    } );
    // Future: nearest first
    usort( $future, function ( $a, $b ) {
        return strtotime( $a['startDate'] ) - strtotime( $b['startDate'] );
    } );
    // Past: most recent first
    usort( $past, function ( $a, $b ) {
        return strtotime( $b['startDate'] ) - strtotime( $a['startDate'] );
    } );

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
        $detail_url  = home_url( '/' . $base_path . '/@' . $evt_username . '/' . $evt_slug . '/' );
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
            echo '<div class="everycal-event__date-line">📅 ' . esc_html( $datetime_lines['date'] ) . '</div>';
        }
        if ( ! empty( $datetime_lines['time'] ) ) {
            echo '<div class="everycal-event__time-line">🕒 ' . esc_html( $datetime_lines['time'] ) . '</div>';
        }
        echo '</time>';
    }

    // Creator
    $creator = everycal_get_event_creator( $event );
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
        echo '<div class="everycal-event__location">📍 ';
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
        $aria_label = sprintf(
            /* translators: %s: event title */
            __( 'Open event: %s', 'everycal' ),
            $title ? $title : __( 'event', 'everycal' )
        );
        echo '<a class="everycal-event__card-link" href="' . esc_url( $primary_url ) . '"' . everycal_external_link_attrs( $primary_url ) . ' aria-label="' . esc_attr( $aria_label ) . '"></a>';
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
        'id'          => $row['id'] ?? '',
        'slug'        => $row['slug'] ?? '',
        'title'       => $row['title'] ?? '',
        'description' => $row['description'] ?? '',
        'startDate'   => $row['start_date'] ?? '',
        'endDate'     => $row['end_date'] ?? '',
        'allDay'      => ! empty( $row['all_day'] ),
        'eventTimezone' => $row['event_timezone'] ?? null,
        'startAtUtc'  => $row['start_at_utc'] ?? null,
        'endAtUtc'    => $row['end_at_utc'] ?? null,
        'account'     => array(
            'username'    => $username,
            'displayName' => $row['account_display_name'] ?? null,
            'domain'      => $row['account_domain'] ?? null,
        ),
        'location'    => ! empty( $row['location_name'] ) ? array(
            'name'      => $row['location_name'],
            'address'   => $row['location_address'] ?? null,
            'latitude'  => isset( $row['location_latitude'] ) ? (float) $row['location_latitude'] : null,
            'longitude' => isset( $row['location_longitude'] ) ? (float) $row['location_longitude'] : null,
            'url'       => $row['location_url'] ?? null,
        ) : null,
        'image'       => ! empty( $row['image_url'] ) ? array(
            'url'       => $row['image_url'],
            'mediaType' => $row['image_media_type'] ?? null,
            'alt'       => $row['image_alt'] ?? null,
        ) : null,
        'url'         => $row['url'] ?? '',
        'tags'        => ! empty( $row['tags'] ) ? ( is_array( $row['tags'] ) ? $row['tags'] : explode( ',', $row['tags'] ) ) : array(),
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
    register_setting( 'everycal_settings', 'everycal_base_path', array(
        'type'              => 'string',
        'default'           => 'events',
        'sanitize_callback' => function ( $val ) {
            return trim( $val, '/ ' );
        },
    ) );

    register_setting( 'everycal_settings', 'everycal_creator_url_template', array(
        'type'              => 'string',
        'default'           => '',
        'sanitize_callback' => function ( $val ) {
            return sanitize_text_field( $val );
        },
    ) );

    register_setting( 'everycal_settings', 'everycal_default_server_url', array(
        'type'              => 'string',
        'default'           => '',
        'sanitize_callback' => function ( $val ) {
            return untrailingslashit( esc_url_raw( $val ) );
        },
    ) );

    register_setting( 'everycal_settings', 'everycal_http_debug_manual', array(
        'type'              => 'boolean',
        'default'           => false,
        'sanitize_callback' => function ( $val ) {
            return ! empty( $val );
        },
    ) );

    register_setting( 'everycal_settings', 'everycal_http_debug_additional_servers', array(
        'type'              => 'string',
        'default'           => '',
        'sanitize_callback' => function ( $val ) {
            return implode( ', ', everycal_parse_server_list_option( $val ) );
        },
    ) );
}

function everycal_settings_page() {
    $base = get_option( 'everycal_base_path', 'events' );
    $creator_template = get_option( 'everycal_creator_url_template', '' );
    $default_server_url = get_option( 'everycal_default_server_url', '' );
    $manual_http_debug = (bool) get_option( 'everycal_http_debug_manual', false );
    $http_debug_additional_servers = get_option( 'everycal_http_debug_additional_servers', '' );
    $wp_debug_enabled  = defined( 'WP_DEBUG' ) && WP_DEBUG;
    $http_debug_on     = everycal_http_debug_enabled();
    $known_hosts       = everycal_get_configured_server_hosts();
    $recent_logs       = everycal_get_http_debug_logs( 200 );
    $logs_text         = implode( "\n", $recent_logs );
    $logs_nonce        = wp_create_nonce( 'everycal_http_logs' );
    $logs_cleared      = isset( $_GET['everycal_logs_cleared'] ) && '1' === (string) $_GET['everycal_logs_cleared'];
    ?>
    <div class="wrap">
        <h1><?php echo esc_html( __( 'EveryCal Settings', 'everycal' ) ); ?></h1>
        <?php if ( $logs_cleared ) : ?>
            <div class="notice notice-success is-dismissible"><p><?php echo esc_html__( 'HTTP debug logs cleared.', 'everycal' ); ?></p></div>
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
                            <?php echo esc_html( sprintf( __( 'Current status: %s (WP_DEBUG=%s, manual=%s)', 'everycal' ), $http_debug_on ? 'ON' : 'OFF', $wp_debug_enabled ? 'ON' : 'OFF', $manual_http_debug ? 'ON' : 'OFF' ) ); ?><br>
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

        <script>
        (function() {
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
                    watchBtn.textContent = "Start Auto-refresh";
                    watchBtn.setAttribute("aria-pressed", "false");
                    return;
                }
                refreshLogs();
                timer = setInterval(refreshLogs, 5000);
                watchBtn.textContent = "Stop Auto-refresh";
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
                    copyBtn.textContent = "Copied";
                } catch (e) {
                    copyBtn.textContent = "Copy failed";
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
add_action( 'update_option_everycal_base_path', function () {
    everycal_add_rewrite_rules();
    flush_rewrite_rules();
} );

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
register_activation_hook( __FILE__, function () {
    everycal_add_rewrite_rules();
    flush_rewrite_rules();
} );

register_deactivation_hook( __FILE__, function () {
    flush_rewrite_rules();
} );

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

    $api_url   = trailingslashit( $server_url ) . 'api/v1/events/by-slug/' . urlencode( $username ) . '/' . urlencode( $slug );

    // Two-tier cache for individual events.
    $store_key = 'everycal_ev_' . md5( $username . ':' . $slug );
    $fresh_key = 'everycal_evf_' . md5( $username . ':' . $slug );
    $event     = get_option( $store_key, false );

    if ( false === get_transient( $fresh_key ) ) {
        $response = wp_remote_get( $api_url, array(
            'timeout' => 10,
            'headers' => array( 'Accept' => 'application/json' ),
        ) );

        if ( ! is_wp_error( $response ) && 200 === wp_remote_retrieve_response_code( $response ) ) {
            $event = json_decode( wp_remote_retrieve_body( $response ), true );
            update_option( $store_key, $event, false );
            everycal_set_cached_event_server_url( (string) $username, (string) $slug, $server_url );

            // Future/ongoing events: short TTL. Past events: cache for 24 h.
            $start = isset( $event['startDate'] ) ? strtotime( $event['startDate'] ) : 0;
            $end   = ! empty( $event['endDate'] ) ? strtotime( $event['endDate'] ) : $start;
            $ttl   = ( $end >= time() ) ? 300 : DAY_IN_SECONDS;
            set_transient( $fresh_key, 1, $ttl );
        } elseif ( $event ) {
            // API failed but we have a stored copy — serve stale, retry in 1 min.
            set_transient( $fresh_key, 1, 60 );
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
    $GLOBALS['everycal_single_event'] = $event;
    $GLOBALS['everycal_single_server_url'] = $server_url;

    // Override the page title.
    add_filter( 'document_title_parts', function ( $parts ) use ( $event ) {
        $parts['title'] = $event['title'] ?? 'Event';
        return $parts;
    } );

    // Render using the theme's page.php wrapped around our content.
    add_filter( 'the_content', 'everycal_render_single_event_content', 0 );
    add_filter( 'the_title',   'everycal_override_single_title', 10, 2 );

    // Use a blank page as the base — create a fake page query.
    global $wp_query, $post;
    $post = new WP_Post( (object) array(
        'ID'             => 0,
        'post_title'     => $event['title'] ?? 'Event',
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
    ) );

    $wp_query->posts          = array( $post );
    $wp_query->post           = $post;
    $wp_query->post_count     = 1;
    $wp_query->found_posts    = 1;
    $wp_query->max_num_pages  = 1;
    $wp_query->is_page        = true;
    $wp_query->is_singular    = true;
    $wp_query->is_single      = false;
    $wp_query->is_attachment  = false;
    $wp_query->is_archive     = false;
    $wp_query->is_category    = false;
    $wp_query->is_tag         = false;
    $wp_query->is_tax         = false;
    $wp_query->is_author      = false;
    $wp_query->is_date        = false;
    $wp_query->is_year        = false;
    $wp_query->is_month       = false;
    $wp_query->is_day         = false;
    $wp_query->is_time        = false;
    $wp_query->is_search      = false;
    $wp_query->is_feed        = false;
    $wp_query->is_comment_feed = false;
    $wp_query->is_trackback   = false;
    $wp_query->is_home        = false;
    $wp_query->is_embed       = false;
    $wp_query->is_paged       = false;
    $wp_query->is_admin       = false;
    $wp_query->is_preview     = false;
    $wp_query->is_robots      = false;
    $wp_query->is_posts_page  = false;
    $wp_query->is_post_type_archive = false;
    $wp_query->is_404         = false;

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

    $event = $GLOBALS['everycal_single_event'];
    $base  = get_option( 'everycal_base_path', 'events' );
    $server_url = isset( $GLOBALS['everycal_single_server_url'] ) ? $GLOBALS['everycal_single_server_url'] : '';

    ob_start();
    echo '<div class="everycal-single-event">';

    // Back link
    echo '<p class="everycal-single-event__back"><a href="/' . esc_attr( $base ) . '/">&larr; '
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
            echo '<div class="everycal-event__date-line">📅 ' . esc_html( $datetime_lines['date'] ) . '</div>';
        }
        if ( ! empty( $datetime_lines['time'] ) ) {
            echo '<div class="everycal-event__time-line">🕒 ' . esc_html( $datetime_lines['time'] ) . '</div>';
        }
        echo '</time>';
    }

    // Location
    if ( ! empty( $event['location']['name'] ) ) {
        echo '<div class="everycal-single-event__location">📍 ';
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
                echo '<a href="' . esc_url( $map_links['google'] ) . '"' . everycal_external_link_attrs( $map_links['google'] ) . '>Google Maps</a>, ';
                echo '<a href="' . esc_url( $map_links['apple'] ) . '"' . everycal_external_link_attrs( $map_links['apple'] ) . '>Apple Maps</a>, ';
                echo '<a href="' . esc_url( $map_links['osm'] ) . '"' . everycal_external_link_attrs( $map_links['osm'] ) . '>OSM</a>';
                echo ')';
            }
        }
        echo '</div>';
    }

    // Creator
    $creator = everycal_get_event_creator( $event );
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

    $default_server = trim( (string) get_option( 'everycal_default_server_url', '' ) );
    if ( '' !== $default_server ) {
        return untrailingslashit( esc_url_raw( $default_server ) );
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

    return (bool) apply_filters( 'everycal_http_debug_enabled', $enabled );
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

    $logs[] = $line;
    $max_entries = 500;
    if ( count( $logs ) > $max_entries ) {
        $logs = array_slice( $logs, -1 * $max_entries );
    }

    update_option( 'everycal_http_debug_logs', $logs, false );
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

    wp_send_json_success( array(
        'text'  => implode( "\n", $lines ),
        'count' => count( $lines ),
    ) );
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

/**
 * Log outgoing requests to configured EveryCal hosts.
 */
function everycal_http_api_debug_logger( $response, $context, $class, $args, $url ) {
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
        (string) $url,
        $timeout,
        $status,
        (string) $context
    );

    error_log( $line );
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
            'time' => esc_html__( 'All day', 'everycal' ),
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
        return $dt ?: null;
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
function everycal_get_event_creator( $event ) {
    $username = '';
    $label    = '';
    $domain   = '';

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

    if ( '' === $label ) {
        $label = $username;
    }

    $handle = $username;
    if ( $domain && false === strpos( $username, '@' ) ) {
        $handle = $username . '@' . $domain;
    }

    return array(
        'username' => $username,
        'domain'   => $domain,
        'handle'   => $handle,
        'label'    => $label,
    );
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
        $creator = everycal_get_event_creator( $event );
    }

    if ( empty( $creator['username'] ) ) {
        return '';
    }

    $default_url = '';
    if ( ! empty( $server_url ) ) {
        $default_url = trailingslashit( $server_url ) . '@' . $creator['handle'];
    }

    $resolved = $default_url;
    $template = (string) get_option( 'everycal_creator_url_template', '' );

    if ( '' !== trim( $template ) ) {
        $tokens = array(
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
        $lat = (float) $location['latitude'];
        $lon = (float) $location['longitude'];
        $name = ! empty( $location['name'] ) ? (string) $location['name'] : '';
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
