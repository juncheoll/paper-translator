# Paper Translator development

This directory is the new PDF-only Chrome MV3 extension. The sibling MouseTooltipTranslator checkout is a reference and must remain unchanged unless the user explicitly asks to edit it.

- Build with `npm run build`; load **build/** as the unpacked extension. The release ZIP uses **extension/**.
- Run `npm test` for PDF and backend regressions. Live API tests are opt-in and use synthetic text only.
- Python helper tests require the pinned Docling environment: `python -m unittest discover -s tools -p 'test_*.py'`.
- Keep webpack entries explicit. Do not import general web tooltip, subtitle, OCR, TTS, dictionary, or old settings code.
- Translation, embeddings, and Docling have independent settings. Document and query vectors must always use the same embedding configuration and cache identity.
- Only exact owned viewer/settings pages can access API brokers. Read endpoint/key from saved settings; do not accept arbitrary proxy URLs or send credentials through runtime payloads.
- Browser models use an independent offscreen host. Preparing/downloading/deleting models is a settings-page action; inference never downloads automatically.
- Server Docling must not start the local helper. Preserve PDF.js text coordinates and region edits when changing layout handling.
- Local helper uses com.papertranslator.docling and port8876, separate from the original extension's helper. Never stop unrelated services.
- Preserve MIT/PDF.js/runtime notices and bundled licenses. Public PDF.js assets retain upstream licenses and existing modifications documented in THIRD_PARTY_NOTICES.md.
- Package with `npm run package`; never include user settings, tokens, model weights, virtual environments, or node_modules. Do not overwrite an existing ZIP.
- Commit, push, publish, install into a real browser, or deploy remote infrastructure only when the user requests that action.
