# EveryCal Hooks Reference

This plugin currently exposes filter hooks only.

## `everycal_http_debug_enabled`

Filter whether EveryCal HTTP debug logging is enabled.

```php
/**
 * @param bool $enabled
 * @return bool
 */
add_filter( 'everycal_http_debug_enabled', function ( $enabled ) {
    return $enabled;
} );
```

## `everycal_http_debug_error_log_enabled`

Filter whether debug lines are also written to PHP `error_log`.

```php
/**
 * @param bool   $enabled
 * @param string $line
 * @param string $url
 * @param string $context
 * @param mixed  $response
 * @param array  $args
 * @return bool
 */
add_filter(
    'everycal_http_debug_error_log_enabled',
    function ( $enabled, $line, $url, $context, $response, $args ) {
        return $enabled;
    },
    10,
    6
);
```

## `everycal_creator_url`

Filter the creator profile URL shown in event cards/event pages.

```php
/**
 * @param string $resolved
 * @param array  $event
 * @param string $server_url
 * @param array  $creator
 * @return string
 */
add_filter( 'everycal_creator_url', function ( $resolved, $event, $server_url, $creator ) {
    if ( ! empty( $creator['username'] ) ) {
        return home_url( '/community/' . rawurlencode( $creator['username'] ) );
    }

    return $resolved;
}, 10, 4 );
```
