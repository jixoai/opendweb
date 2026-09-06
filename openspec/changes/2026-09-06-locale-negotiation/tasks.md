## 1. Negotiation

- [x] 1.1 app.html pre-paint bootstrap: persisted `lang` → honor;
  else navigator.languages match → one redirect (same path + hash) to
  the matched locale; no redirect from non-default pages; loop-proof.
- [x] 1.2 language-switcher persists choice to `lang` (same key).
- [x] 1.3 Headless verification with emulated navigator.languages
  (match → redirect; mismatch → stay; persisted choice → honored);
  builds green in both serving modes; NOTES updated; friction log.
