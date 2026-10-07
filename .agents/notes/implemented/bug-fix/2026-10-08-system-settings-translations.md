# Agent Note: Translate system settings labels and tooltips

Status: implemented

## Problem

The redesigned pages/partials/system-config.html contained twelve Chinese-only labels, a default badge and movement tooltips. They appeared in the English interface even when the neighboring accessibility labels were translated.

## Decision

Use translations from pages/js/i18n.js for all new captions, units, badges and title bindings. Reuse the movement keys for title and aria-label and the custom-model key as the switch accessibility label. Provide both Chinese and English entries for the new captions.

## Alternatives considered

Changing the literals to English would break the Chinese interface. Hiding hints would remove useful information. Duplicate translated tooltip strings could drift from the accessibility label.

## Consequences

Both locale catalogs cover the new interface labels. The English render test covers the default badge, text bindings and movement tooltips without contacting a server.

## Verification

- `tests/system-config-view.test.ts::system settings render translated labels and titles in English`

Proved: The pre-fix English render failed the no-Chinese visible text assertion after resolving the existing translations. Output is saved in `.agents/notes-evidence/structured-output-and-settings-red.log`; the same test passes with translated bindings.
