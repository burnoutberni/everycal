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
 * in a transient, and renders them as HTML.
 */
function everycal_render_block( $attributes ) {
    $server_url = isset( $attributes['serverUrl'] ) ? esc_url( $attributes['serverUrl'] ) : '';
    $account    = isset( $attributes['account'] ) ? sanitize_text_field( $attributes['account'] ) : '';
    $limit      = isset( $attributes['limit'] ) ? absint( $attributes['limit'] ) : 10;
    $layout     = isset( $attributes['layout'] ) ? sanitize_text_field( $attributes['layout'] ) : 'list';
    $cache_ttl  = isset( $attributes['cacheTtl'] ) ? absint( $attributes['cacheTtl'] ) : 300; // 5 min default

    if ( empty( $server_url ) ) {
        return '<div class="everycal-block everycal-error">
            <p>' . esc_html__( 'Please configure an EveryCal server URL.', 'everycal' ) . '</p>
        </div>';
    }

    // Build API URL
    $api_url = trailingslashit( $server_url ) . 'api/v1/events?' . http_build_query( array_filter( array(
        'account' => $account,
        'limit'   => $limit,
        'from'    => gmdate( 'c' ), // only future events
    ) ) );

    // Check transient cache
    $cache_key = 'everycal_' . md5( $api_url );
    $events    = get_transient( $cache_key );

    if ( false === $events ) {
        $response = wp_remote_get( $api_url, array(
            'timeout' => 10,
            'headers' => array( 'Accept' => 'application/json' ),
        ) );

        if ( is_wp_error( $response ) ) {
            return '<div class="everycal-block everycal-error"><p>' .
                esc_html__( 'Could not fetch events.', 'everycal' ) . '</p></div>';
        }

        $body   = wp_remote_retrieve_body( $response );
        $data   = json_decode( $body, true );
        $events = isset( $data['events'] ) ? $data['events'] : array();

        set_transient( $cache_key, $events, $cache_ttl );
    }

    if ( empty( $events ) ) {
        return '<div class="everycal-block everycal-empty"><p>' .
            esc_html__( 'No upcoming events.', 'everycal' ) . '</p></div>';
    }

    // Render
    ob_start();
    echo '<div class="everycal-block everycal-layout-' . esc_attr( $layout ) . '">';

    foreach ( $events as $event ) {
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
            $ts = strtotime( $event['startDate'] );
            echo '<time class="everycal-event__date" datetime="' . esc_attr( $event['startDate'] ) . '">';
            echo esc_html( wp_date( get_option( 'date_format' ) . ' ' . get_option( 'time_format' ), $ts ) );
            echo '</time>';
        }

        // Title
        $title = ! empty( $event['title'] ) ? esc_html( $event['title'] ) : '';
        if ( ! empty( $event['url'] ) ) {
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

    echo '</div>';
    return ob_get_clean();
}

/**
 * Enqueue frontend styles.
 */
add_action( 'wp_enqueue_scripts', 'everycal_enqueue_styles' );

function everycal_enqueue_styles() {
    if ( has_block( 'everycal/feed' ) ) {
        wp_enqueue_style(
            'everycal-frontend',
            EVERYCAL_PLUGIN_URL . 'build/style-index.css',
            array(),
            EVERYCAL_VERSION
        );
    }
}
