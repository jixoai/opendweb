## ADDED Requirements

### Requirement: Browser language negotiation on the default surface

Default-locale pages SHALL negotiate the visitor language before first
paint: an explicit persisted choice wins; otherwise the first
navigator.languages match among available locales redirects once to the
same page under its locale prefix. Non-default pages never redirect.

#### Scenario: zh browser lands on zh

- **WHEN** a browser with zh preference loads the default-locale page
- **THEN** it is redirected (path + hash preserved) to the `/zh/`
  mirror before content paints.

#### Scenario: explicit choice beats detection

- **WHEN** the visitor has persisted a language choice via the switcher
- **THEN** no detection redirect occurs.
