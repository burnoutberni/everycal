# Show on EveryCal button

Reusable, brand-locked embed button for external sites.

## Design spec

- Label is fixed to `Show on EveryCal` for consistency and recognition.
- Shape is a rounded pill with warm amber gradient background.
- Icon uses the EveryCal two-circle mark for instant brand recall.
- Interaction uses subtle lift + sheen (disabled if user prefers reduced motion).
- Opens in a new tab by default with safe link attributes.
- No analytics, no trackers, no network calls from the component itself.

## Usage

```html
<script src="https://YOUR-EVERYCAL-DOMAIN/embed/show-on-everycal.js" defer></script>

<everycal-button href="https://YOUR-EVERYCAL-DOMAIN/@alice/meetup-night"></everycal-button>
```

## Supported attributes

- `href` (required): absolute or relative HTTP(S) URL to the EveryCal page.
- `size` (optional): `sm`, `md` (default), or `lg`.
- `aria-label` (optional): custom accessibility label.

## Examples

```html
<everycal-button
  href="https://everycal.example/@cityclub/sunday-ride"
  size="lg"
  aria-label="Show Sunday Ride event on EveryCal"
></everycal-button>
```

```html
<everycal-button
  href="https://everycal.example/@team"
  size="sm"
></everycal-button>
```

## Notes

- The component is intentionally style-locked to preserve brand consistency.
- If `href` is missing or invalid, button renders disabled.
- Works in modern browsers with Custom Elements support.
