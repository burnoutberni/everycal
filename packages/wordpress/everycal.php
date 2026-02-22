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

// Register the Gutenberg block
add_action( 'init', 'everycal_register_block' );

function everycal_register_block() {
    register_block_type( __DIR__ . '/build', array(
        'render_callback' => 'everycal_render_block',
    ) );
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
    $account    = isset( $attributes['account'] ) ? sanitize_text_field( $attributes['account'] ) : '';
    $per_page   = isset( $attributes['limit'] ) ? absint( $attributes['limit'] ) : 10;
    $layout     = isset( $attributes['layout'] ) ? sanitize_text_field( $attributes['layout'] ) : 'list';
    $cache_ttl  = isset( $attributes['cacheTtl'] ) ? absint( $attributes['cacheTtl'] ) : 300; // 5 min default

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

    $events = everycal_get_events( $api_url, $cache_ttl );

    if ( empty( $events ) ) {
        return '<div class="everycal-block everycal-empty"><p>' .
            esc_html__( 'No events found.', 'everycal' ) . '</p></div>';
    }

    // ── Group events: ongoing → future → past ──
    $grouped = everycal_group_events( $events );

    // ── Pagination ──
    $paged     = max( 1, absint( get_query_var( 'paged', 1 ) ) );
    $all_sorted = array_merge( $grouped['upcoming'], $grouped['past'] );
    $total     = count( $all_sorted );
    $pages     = max( 1, (int) ceil( $total / $per_page ) );
    $paged     = min( $paged, $pages );
    $offset    = ( $paged - 1 ) * $per_page;
    $page_events = array_slice( $all_sorted, $offset, $per_page );

    if ( empty( $page_events ) ) {
        return '<div class="everycal-block everycal-empty"><p>' .
            esc_html__( 'No events found.', 'everycal' ) . '</p></div>';
    }

    // Work out which section labels to show on this page.
    $upcoming_count = count( $grouped['upcoming'] );

    // Render
    ob_start();
    echo '<div class="everycal-block everycal-layout-' . esc_attr( $layout ) . '">';

    $rendered = 0;
    foreach ( $page_events as $event ) {
        $global_idx = $offset + $rendered;

        // Section heading: "Upcoming Events" at the start of upcoming, "Past Events" at transition.
        if ( 0 === $global_idx && $upcoming_count > 0 ) {
            echo '<h2 class="everycal-section-heading">' . esc_html__( 'Upcoming Events', 'everycal' ) . '</h2>';
        }
        if ( $global_idx === $upcoming_count && count( $grouped['past'] ) > 0 ) {
            echo '<h2 class="everycal-section-heading">' . esc_html__( 'Past Events', 'everycal' ) . '</h2>';
        }

        everycal_render_event_card( $event );
        $rendered++;
    }

    echo '</div>';

    // Pagination links
    if ( $pages > 1 ) {
        echo '<nav class="everycal-pagination">';
        echo paginate_links( array(
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
function everycal_get_events( $api_url, $ttl = 300 ) {
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
function everycal_render_event_card( $event ) {
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
        $ts  = strtotime( $event['startDate'] );
        $now = time();
        $end = ! empty( $event['endDate'] ) ? strtotime( $event['endDate'] ) : $ts;

        echo '<time class="everycal-event__date" datetime="' . esc_attr( $event['startDate'] ) . '">';

        // Ongoing badge
        if ( $ts <= $now && $end >= $now ) {
            echo '<span class="everycal-event__badge everycal-event__badge--ongoing">'
                 . esc_html__( 'Ongoing', 'everycal' ) . '</span> ';
        }

        echo esc_html( wp_date( get_option( 'date_format' ) . ' ' . get_option( 'time_format' ), $ts ) );

        // Show end date if present
        if ( ! empty( $event['endDate'] ) ) {
            echo ' &ndash; ' . esc_html( wp_date( get_option( 'date_format' ) . ' ' . get_option( 'time_format' ), $end ) );
        }

        echo '</time>';
    }

    // Title — link to local event detail page
    $title = ! empty( $event['title'] ) ? esc_html( $event['title'] ) : '';
    $base_path    = get_option( 'everycal_base_path', 'events' );
    $evt_username = '';
    if ( ! empty( $event['account']['username'] ) ) {
        $evt_username = $event['account']['username'];
    } elseif ( ! empty( $event['account_username'] ) ) {
        $evt_username = $event['account_username'];
    }
    $evt_slug = ! empty( $event['slug'] ) ? $event['slug'] : '';

    if ( $evt_username && $evt_slug ) {
        $detail_url = home_url( '/' . $base_path . '/' . $evt_username . '/' . $evt_slug . '/' );
        echo '<h3 class="everycal-event__title"><a href="' . esc_url( $detail_url ) . '">' . $title . '</a></h3>';
    } elseif ( ! empty( $event['url'] ) ) {
        echo '<h3 class="everycal-event__title"><a href="' . esc_url( $event['url'] ) . '">' . $title . '</a></h3>';
    } else {
        echo '<h3 class="everycal-event__title">' . $title . '</h3>';
    }

    // Description
    if ( ! empty( $event['description'] ) ) {
        echo '<div class="everycal-event__description">' . wp_kses_post( $event['description'] ) . '</div>';
    }

    // Location
    if ( ! empty( $event['location']['name'] ) ) {
        echo '<div class="everycal-event__location">📍 ' . esc_html( $event['location']['name'] ) . '</div>';
    }

    // Tags
    if ( ! empty( $event['tags'] ) ) {
        echo '<div class="everycal-event__tags">';
        foreach ( $event['tags'] as $tag ) {
            echo '<span class="everycal-event__tag">' . esc_html( $tag ) . '</span>';
        }
        echo '</div>';
    }

    echo '</div>'; // content
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
        'account'     => array(
            'username' => $username,
        ),
        'location'    => ! empty( $row['location_name'] ) ? array(
            'name'    => $row['location_name'],
            'address' => $row['location_address'] ?? null,
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
}

function everycal_settings_page() {
    $base = get_option( 'everycal_base_path', 'events' );
    ?>
    <div class="wrap">
        <h1><?php echo esc_html( __( 'EveryCal Settings', 'everycal' ) ); ?></h1>
        <form method="post" action="options.php">
            <?php settings_fields( 'everycal_settings' ); ?>
            <table class="form-table">
                <tr>
                    <th scope="row"><label for="everycal_base_path"><?php echo esc_html( __( 'Event pages base path', 'everycal' ) ); ?></label></th>
                    <td>
                        <code><?php echo esc_html( home_url( '/' ) ); ?></code>
                        <input type="text" id="everycal_base_path" name="everycal_base_path"
                               value="<?php echo esc_attr( $base ); ?>" class="regular-text" />
                        <code>/username/event-slug</code>
                        <p class="description">
                            <?php echo esc_html__( 'Individual event detail pages will be served at this path.', 'everycal' ); ?><br>
                            <?php echo esc_html__( 'After changing this, click Save — permalinks are flushed automatically.', 'everycal' ); ?>
                        </p>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>
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
    // Match: /events/{username}/{slug}
    add_rewrite_rule(
        '^' . preg_quote( $base, '/' ) . '/([^/]+)/([^/]+)/?$',
        'index.php?everycal_event_username=$matches[1]&everycal_event_slug=$matches[2]',
        'top'
    );
}

add_filter( 'query_vars', 'everycal_query_vars' );

function everycal_query_vars( $vars ) {
    $vars[] = 'everycal_event_username';
    $vars[] = 'everycal_event_slug';
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

    // We need a server URL. Try to find it from the first EveryCal block on any page.
    $server_url = everycal_discover_server_url();
    if ( ! $server_url ) {
        status_header( 500 );
        wp_die( esc_html__( 'EveryCal: no server URL configured. Add an EveryCal Feed block to a page first.', 'everycal' ) );
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
        $ts = strtotime( $event['startDate'] );
        echo '<time class="everycal-event__date" datetime="' . esc_attr( $event['startDate'] ) . '">';
        echo esc_html( wp_date( get_option( 'date_format' ) . ' ' . get_option( 'time_format' ), $ts ) );
        if ( ! empty( $event['endDate'] ) ) {
            $te = strtotime( $event['endDate'] );
            echo ' &ndash; ' . esc_html( wp_date( get_option( 'date_format' ) . ' ' . get_option( 'time_format' ), $te ) );
        }
        echo '</time>';
    }

    // Description
    if ( ! empty( $event['description'] ) ) {
        echo '<div class="everycal-single-event__description">' . wp_kses_post( $event['description'] ) . '</div>';
    }

    // Location
    if ( ! empty( $event['location']['name'] ) ) {
        echo '<div class="everycal-single-event__location">📍 ' . esc_html( $event['location']['name'] );
        if ( ! empty( $event['location']['address'] ) ) {
            echo ' — ' . esc_html( $event['location']['address'] );
        }
        echo '</div>';
    }

    // Tags
    if ( ! empty( $event['tags'] ) ) {
        echo '<div class="everycal-event__tags">';
        foreach ( $event['tags'] as $tag ) {
            echo '<span class="everycal-event__tag">' . esc_html( $tag ) . '</span>';
        }
        echo '</div>';
    }

    // Original source link
    if ( ! empty( $event['url'] ) ) {
        echo '<p class="everycal-single-event__source"><a href="' . esc_url( $event['url'] ) . '" target="_blank" rel="noopener">'
             . esc_html__( 'Original event page', 'everycal' ) . ' &rarr;</a></p>';
    }

    echo '</div>';

    // Remove the filter so it doesn't fire again for other content.
    remove_filter( 'the_content', 'everycal_render_single_event_content', 0 );

    return ob_get_clean();
}

/**
 * Discover the server URL from the first EveryCal block found in any published post/page.
 */
function everycal_discover_server_url() {
    $posts = get_posts( array(
        'post_type'   => array( 'post', 'page' ),
        'post_status' => 'publish',
        's'           => '<!-- wp:everycal/feed',
        'numberposts' => 5,
    ) );

    foreach ( $posts as $p ) {
        $blocks = parse_blocks( $p->post_content );
        foreach ( $blocks as $block ) {
            if ( 'everycal/feed' === $block['blockName'] && ! empty( $block['attrs']['serverUrl'] ) ) {
                return $block['attrs']['serverUrl'];
            }
        }
    }

    return '';
}
